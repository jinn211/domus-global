import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';
import { supabase } from './lib/supabase.js';
import { carpeta, archivosEn, renombrar, subir } from './lib/drive.js';
import { alertar, avisarDevs } from './lib/alertas.js';

/**
 * Copia diaria de los comprobantes a Google Drive.
 *
 * Supabase Storage es el original; esto es la segunda copia. Si mañana se pierde
 * el proyecto de Supabase, los comprobantes de las empresas siguen existiendo.
 *
 * El destino no es un depósito: es donde alguien de contabilidad va a buscar un
 * comprobante contra una línea del banco. De ahí las tres decisiones de abajo.
 *
 * 1. CARPETAS POR EMPRESA Y MES. Cerrar un mes es abrir una carpeta, no juntar
 *    pedazos de varias.
 *
 * 2. EL NOMBRE DICE TODO LO QUE SE BUSCA. En Storage los archivos se llaman
 *    `0914ef5e-049a-...jpg`, que como respaldo no sirve de nada. Acá quedan:
 *
 *      2026-08-04 · TIH S.A. · USD 44,17 · A-1234 · Julio Fitipaldo · 900eba99.pdf
 *
 *    Fecha primero para que ordene solo. Después lo que se cruza contra el
 *    banco: proveedor, monto, número de factura. Y quién la subió.
 *
 * 3. LAS QUE NADIE MIRÓ SE MARCAN. Una factura que quedó cargada con lo que
 *    dedujo el modelo lleva `SIN CONFIRMAR` en el nombre. Contabilidad tiene que
 *    poder distinguir de un vistazo lo verificado de lo inferido, sin abrir nada.
 */

const RAIZ = 'Facturas Domus';
const HUERFANOS = '_sin registrar';
const CADA_MS = 6 * 3600_000;
const DATA_DIR = process.env.CIERRE_DATA_DIR || '/app/data';
const ESTADO = path.join(DATA_DIR, 'respaldo.json');

interface Estado { ultima?: string }
const leer = (): Estado => { try { return JSON.parse(fs.readFileSync(ESTADO, 'utf8')); } catch { return {}; } };
const guardar = (e: Estado) => { fs.mkdirSync(DATA_DIR, { recursive: true }); fs.writeFileSync(ESTADO, JSON.stringify(e, null, 2)); };

/** Drive no acepta `/` en los nombres; el resto lo dejamos legible. */
const limpiar = (s: string) => s.replace(/[/\\]/g, '-').replace(/\s+/g, ' ').trim();

const plata = (m: unknown, mon: unknown) =>
  `${mon ?? 'UYU'} ${Number(m ?? 0).toLocaleString('es-UY', { minimumFractionDigits: 2 })}`;

/**
 * De dónde salió la factura, en criollo.
 * Por WhatsApp `reporter` es el teléfono (se cruza con employees); por mail es
 * el From entero ("Julio Fitipaldo <julio@...>"), del que sacamos el nombre.
 */
function quienLaSubio(reporter: string | null, porTelefono: Map<string, string>): string {
  if (!reporter) return 'sin remitente';
  const porNombre = porTelefono.get(reporter);
  if (porNombre) return porNombre;
  const m = reporter.match(/^\s*"?([^"<]+?)"?\s*</);
  if (m) return m[1].trim();
  return reporter.replace(/[<>]/g, '').trim();
}

interface Copiado { subidos: number; yaEstaban: number; renombrados: number; fallados: string[]; huerfanos: number }

export async function respaldar(): Promise<Copiado> {
  // 1. Todo lo que hay en Storage
  const objetos: string[] = [];
  const { data: raices } = await supabase.storage.from('facturas').list('', { limit: 1000 });
  for (const co of (raices ?? []).filter((x) => !x.id)) {
    for (const anio of ['2025', '2026', '2027']) {
      const { data: meses } = await supabase.storage.from('facturas').list(`${co.name}/${anio}`, { limit: 1000 });
      for (const m of (meses ?? []).filter((x) => !x.id)) {
        const { data: archivos } = await supabase.storage.from('facturas').list(`${co.name}/${anio}/${m.name}`, { limit: 1000 });
        for (const a of (archivos ?? []).filter((x) => x.id)) objetos.push(`${co.name}/${anio}/${m.name}/${a.name}`);
      }
    }
  }

  // 2. Metadata, para poder ponerles un nombre que sirva
  const { data: facturas, error } = await supabase
    .from('invoices')
    .select('archivo_url,empresa_emisora,monto,moneda,fecha,nro_factura,created_at,reporter,confirmacion,companies(nombre)')
    .not('archivo_url', 'is', null);
  if (error) throw new Error('no pude leer las facturas: ' + error.message);

  const { data: empleados } = await supabase.from('employees').select('phone,nombre');
  const porTelefono = new Map((empleados ?? []).map((e: any) => [e.phone, e.nombre]));
  const porArchivo = new Map<string, any>();
  for (const f of facturas ?? []) porArchivo.set(f.archivo_url as string, f);

  // 3. Carpetas en Drive, con caché para no pedir lo mismo N veces
  const raizId = await carpeta(RAIZ);
  const cacheCarpeta = new Map<string, string>();
  const cacheContenido = new Map<string, { id: string; name: string }[]>();

  async function destino(ruta: string[]) {
    const clave = ruta.join('/');
    let id = cacheCarpeta.get(clave);
    if (!id) {
      id = raizId;
      for (let i = 0; i < ruta.length; i++) {
        const sub = ruta.slice(0, i + 1).join('/');
        let hijo = cacheCarpeta.get(sub);
        if (!hijo) { hijo = await carpeta(ruta[i], id); cacheCarpeta.set(sub, hijo); }
        id = hijo;
      }
      cacheCarpeta.set(clave, id);
    }
    let contenido = cacheContenido.get(clave);
    if (!contenido) { contenido = await archivosEn(id); cacheContenido.set(clave, contenido); }
    return { id, contenido };
  }

  const r: Copiado = { subidos: 0, yaEstaban: 0, renombrados: 0, fallados: [], huerfanos: 0 };

  for (const obj of objetos) {
    const f = porArchivo.get(obj);
    const uuid = obj.split('/').pop()!.slice(0, 8);
    const ext = obj.slice(obj.lastIndexOf('.')) || '.bin';

    // Un archivo sin factura asociada es un gasto que nadie rindió. Se respalda
    // igual, aparte, para que no se pierda mientras se decide qué hacer.
    const ruta = f
      ? [limpiar((f.companies as any)?.nombre ?? 'Sin empresa'), String(f.fecha ?? f.created_at).slice(0, 7)]
      : [HUERFANOS];

    const nombre = f
      ? limpiar([
          String(f.fecha ?? f.created_at).slice(0, 10),
          f.empresa_emisora || 'sin proveedor',
          plata(f.monto, f.moneda),
          f.nro_factura || null,
          quienLaSubio(f.reporter, porTelefono),
          f.confirmacion === 'confirmada' ? null : 'SIN CONFIRMAR',
          uuid,
        ].filter(Boolean).join(' · ')).slice(0, 200) + ext
      : limpiar(obj.replace(/\//g, '_'));

    if (!f) r.huerfanos++;

    try {
      const { id, contenido } = await destino(ruta);

      // Anti-duplicados por el UUID, no por el nombre entero: el nombre cambia
      // cuando cambian los datos (el vigilante corrige una fecha, alguien
      // confirma la factura) y compararlo entero volvería a subirla.
      const ya = contenido.find((x) => x.name.includes(uuid));
      if (ya) {
        if (ya.name !== nombre) {
          await renombrar(ya.id, nombre);
          ya.name = nombre;
          r.renombrados++;
        } else {
          r.yaEstaban++;
        }
        continue;
      }

      const { data: blob, error: e1 } = await supabase.storage.from('facturas').download(obj);
      if (e1 || !blob) throw new Error('no pude bajarlo de Storage: ' + (e1?.message ?? 'vacío'));

      await subir(nombre, id, Buffer.from(await blob.arrayBuffer()), blob.type || 'application/octet-stream');
      contenido.push({ id: '', name: nombre });
      r.subidos++;
    } catch (e) {
      r.fallados.push(`${obj}: ${(e as Error).message}`);
      // Si Drive rechaza el token va a fallar con todos: cortamos acá en vez de
      // machacar la API una vez por archivo con el mismo error.
      if (/OAuth|invalid_grant|401|403/i.test((e as Error).message)) break;
    }
  }

  return r;
}

async function correrYAvisar(): Promise<void> {
  try {
    const r = await respaldar();
    guardar({ ultima: new Date().toISOString() });
    console.log(`[respaldo] ${r.subidos} nuevos, ${r.renombrados} renombrados, ${r.yaEstaban} sin cambios, ${r.fallados.length} fallaron`);

    // Solo molesta cuando hay algo que contar.
    if (r.fallados.length) {
      const lineas = [
        `⚠️ *Respaldo a Drive* — ${r.subidos} copiados, *${r.fallados.length} fallaron*`,
        '',
        ...r.fallados.slice(0, 5).map((f) => `• ${f.slice(0, 140)}`),
      ];
      if (r.fallados.length > 5) lineas.push(`_...y ${r.fallados.length - 5} más_`);
      await avisarDevs(lineas.join('\n'));
    } else if (r.subidos > 0) {
      await avisarDevs(
        `✅ *Respaldo a Drive* — ${r.subidos} comprobante(s) nuevo(s).\n` +
          `Total resguardado: ${r.subidos + r.yaEstaban + r.renombrados}.` +
          (r.huerfanos ? `\n\n⚠️ ${r.huerfanos} sin factura asociada, en "${HUERFANOS}".` : ''),
      );
    }
  } catch (e) {
    console.error('[respaldo] falló:', (e as Error).message);
    await alertar('respaldo diario de comprobantes a Drive', e);
  }
}

export function initRespaldo(): void {
  if (!config.DRIVE_CLIENT_ID || !config.DRIVE_CLIENT_SECRET || !config.DRIVE_REFRESH_TOKEN) {
    console.log('[respaldo] sin credenciales de Drive, no arranca');
    return;
  }
  console.log('[respaldo] activo (copia a Drive una vez por día)');
  const tick = async () => {
    const u = leer().ultima;
    const horas = u ? (Date.now() - new Date(u).getTime()) / 3600_000 : Infinity;
    if (horas >= 24) await correrYAvisar();
  };
  setTimeout(() => void tick(), 3 * 60_000);
  setInterval(() => void tick(), CADA_MS);
}
