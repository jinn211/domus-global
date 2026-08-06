import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';
import { supabase } from './lib/supabase.js';
import { carpeta, nombresEn, subir } from './lib/drive.js';
import { alertar, avisarDevs } from './lib/alertas.js';

/**
 * Copia diaria de los comprobantes a Google Drive.
 *
 * Supabase Storage es el original; esto es la segunda copia. Si mañana se pierde
 * el proyecto de Supabase, los comprobantes de las empresas siguen existiendo.
 *
 * Dos decisiones que valen la pena entender:
 *
 * 1. NO lleva registro local de lo copiado. En cada corrida pregunta a Drive qué
 *    hay y sube solo lo que falta. Un archivo de control se pierde al recrear el
 *    contenedor y entonces duplica todo; el destino nunca miente.
 *
 * 2. RENOMBRA los archivos. En Storage se llaman `0914ef5e-049a-...jpg`, que
 *    como respaldo no sirve de nada: 92 archivos que nadie sabe qué son. Acá
 *    quedan como `2026-08-04 · La Perdiz · UYU 1.234,00 · 0914ef5e.jpg`. El
 *    pedacito de UUID al final no es decorativo: garantiza que dos gastos
 *    iguales del mismo día no colisionen, y es lo que hace estable la
 *    comparación con lo que ya está en Drive.
 */

const RAIZ = 'Facturas Domus';
const HUERFANOS = '_sin registrar';
const CADA_MS = 6 * 3600_000; // revisa 4 veces al día si ya toca
const DATA_DIR = process.env.CIERRE_DATA_DIR || '/app/data';
const ESTADO = path.join(DATA_DIR, 'respaldo.json');

interface Estado { ultima?: string }
const leer = (): Estado => { try { return JSON.parse(fs.readFileSync(ESTADO, 'utf8')); } catch { return {}; } };
const guardar = (e: Estado) => { fs.mkdirSync(DATA_DIR, { recursive: true }); fs.writeFileSync(ESTADO, JSON.stringify(e, null, 2)); };

/** Drive no acepta `/` en los nombres; el resto lo dejamos legible. */
const limpiar = (s: string) => s.replace(/[/\\]/g, '-').replace(/\s+/g, ' ').trim().slice(0, 120);

const plata = (m: unknown, mon: unknown) =>
  `${mon ?? 'UYU'} ${Number(m ?? 0).toLocaleString('es-UY', { minimumFractionDigits: 2 })}`;

interface Copiado { subidos: number; yaEstaban: number; fallados: string[]; huerfanos: number }

export async function respaldar(): Promise<Copiado> {
  // 1. Todo lo que hay en Storage
  const objetos: { name: string; size: number }[] = [];
  const { data: raices } = await supabase.storage.from('facturas').list('', { limit: 1000 });
  for (const co of (raices ?? []).filter((x) => !x.id)) {
    for (const anio of ['2025', '2026', '2027']) {
      const { data: meses } = await supabase.storage.from('facturas').list(`${co.name}/${anio}`, { limit: 1000 });
      for (const m of (meses ?? []).filter((x) => !x.id)) {
        const { data: archivos } = await supabase.storage.from('facturas').list(`${co.name}/${anio}/${m.name}`, { limit: 1000 });
        for (const a of (archivos ?? []).filter((x) => x.id)) {
          objetos.push({ name: `${co.name}/${anio}/${m.name}/${a.name}`, size: (a.metadata as any)?.size ?? 0 });
        }
      }
    }
  }

  // 2. Metadata de las facturas, para poder ponerles un nombre que sirva
  const { data: facturas, error } = await supabase
    .from('invoices')
    .select('archivo_url,empresa_emisora,monto,moneda,fecha,created_at,company_id,companies(nombre)')
    .not('archivo_url', 'is', null);
  if (error) throw new Error('no pude leer las facturas: ' + error.message);

  const porArchivo = new Map<string, any>();
  for (const f of facturas ?? []) porArchivo.set(f.archivo_url as string, f);

  // 3. Carpeta raíz en Drive, y caché de subcarpetas para no pedirlas de más
  const raizId = await carpeta(RAIZ);
  const cacheCarpeta = new Map<string, string>();
  const cacheNombres = new Map<string, Set<string>>();

  async function destino(ruta: string[]): Promise<{ id: string; existentes: Set<string> }> {
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
    }
    let existentes = cacheNombres.get(clave);
    if (!existentes) { existentes = await nombresEn(id); cacheNombres.set(clave, existentes); }
    return { id, existentes };
  }

  const r: Copiado = { subidos: 0, yaEstaban: 0, fallados: [], huerfanos: 0 };

  for (const obj of objetos) {
    const f = porArchivo.get(obj.name);
    const corto = obj.name.split('/').pop()!.slice(0, 8);
    const ext = obj.name.slice(obj.name.lastIndexOf('.')) || '.bin';

    // Un archivo sin factura asociada es un gasto que nadie rindió. Se respalda
    // igual, aparte, para que no se pierda mientras se decide qué hacer.
    const ruta = f
      ? [limpiar((f.companies as any)?.nombre ?? 'Sin empresa'), String(f.fecha ?? f.created_at).slice(0, 7)]
      : [HUERFANOS];
    const nombre = f
      ? limpiar(`${String(f.fecha ?? f.created_at).slice(0, 10)} · ${f.empresa_emisora ?? 'sin proveedor'} · ${plata(f.monto, f.moneda)} · ${corto}`) + ext
      : limpiar(obj.name.replace(/\//g, '_'));
    if (!f) r.huerfanos++;

    try {
      const { id, existentes } = await destino(ruta);
      if (existentes.has(nombre)) { r.yaEstaban++; continue; }

      const { data: blob, error: e1 } = await supabase.storage.from('facturas').download(obj.name);
      if (e1 || !blob) throw new Error('no pude bajarlo de Storage: ' + (e1?.message ?? 'vacío'));

      const buf = Buffer.from(await blob.arrayBuffer());
      await subir(nombre, id, buf, blob.type || 'application/octet-stream');
      existentes.add(nombre); // por si el mismo nombre sale dos veces en la corrida
      r.subidos++;
    } catch (e) {
      r.fallados.push(`${obj.name}: ${(e as Error).message}`);
      // Si Drive rechaza el token, va a fallar con todos: cortamos acá en vez de
      // machacar la API 92 veces con el mismo error.
      if (/OAuth|invalid_grant|401|403/i.test((e as Error).message)) break;
    }
  }

  return r;
}

async function correrYAvisar(): Promise<void> {
  try {
    const r = await respaldar();
    guardar({ ultima: new Date().toISOString() });
    console.log(`[respaldo] ${r.subidos} nuevos, ${r.yaEstaban} ya estaban, ${r.fallados.length} fallaron`);

    // Solo molesta cuando hay algo que contar: si copió de más o si algo falló.
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
        `✅ *Respaldo a Drive* — ${r.subidos} comprobante(s) nuevo(s) copiados.\n` +
          `Total resguardado: ${r.subidos + r.yaEstaban}.` +
          (r.huerfanos ? `\n\n⚠️ ${r.huerfanos} sin factura asociada, quedaron en "${HUERFANOS}".` : ''),
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
  setTimeout(() => void tick(), 3 * 60_000); // a los 3 min de arrancar, sin trabar el boot
  setInterval(() => void tick(), CADA_MS);
}
