import fs from 'node:fs';
import path from 'node:path';
import { supabase, getCategories, NO_IDENTIFICADO_ID } from './lib/supabase.js';
import { sendTextSafe } from './lib/evolution.js';
import { extractWithHaiku } from './email-processor.js';
import { dedupeHash, existeDuplicado } from './tools/guardar.js';

/**
 * Revisión periódica de datos (cada 3 días).
 *
 * Complementa a `lib/alertas.ts`: aquél avisa cuando algo SE ROMPE (una excepción),
 * éste busca lo que quedó MAL SIN ROMPERSE — una fecha imposible, una factura sin
 * categoría, un archivo que nunca se asoció a nada. Nada de eso lanza un error,
 * así que sin este barrido nadie se entera nunca.
 *
 * Reglas (deliberadas, ver el criterio en el resumen que manda):
 *  - NUNCA toca `monto` ni `moneda`. Si detecta algo raro lo REPORTA con la
 *    corrección propuesta: un número mal en plata se propaga a la conciliación
 *    contra el banco y esa decisión la toma una persona.
 *  - NUNCA borra una factura.
 *  - Sólo corrige cuando el OCR guardado lo prueba.
 *  - Cada corrección queda registrada en `datos_extra.correccion_automatica`.
 *  - Tope de correcciones por corrida: si algo estuviera mal en el criterio, no
 *    arrasa con toda la base.
 */

const DATA_DIR = process.env.CIERRE_DATA_DIR || '/app/data';
const ESTADO_FILE = path.join(DATA_DIR, 'vigilante.json');
const CADA_DIAS = 3;
const CHEQUEO_MS = 6 * 3600_000; // revisa cada 6h si ya toca correr
const MAX_CORRECCIONES = 20;
/** Destinatarios del resumen. Mismos que las alertas: se configuran por env. */
const DEVS = (process.env.ALERTAS_PHONES ?? '').split(',').map((p) => p.trim()).filter(Boolean);
/** Simulación: recorre y arma el resumen, pero no escribe nada. Para probar cambios de criterio. */
const DRY = process.env.VIGILANTE_DRY === '1';

interface Estado { ultima_corrida?: string }

function leerEstado(): Estado {
  try { return JSON.parse(fs.readFileSync(ESTADO_FILE, 'utf8')); } catch { return {}; }
}
function guardarEstado(e: Estado): void {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(ESTADO_FILE, JSON.stringify(e, null, 2));
}

const fmtMonto = (m: unknown, mon: unknown) =>
  `${mon ?? 'UYU'} ${Number(m ?? 0).toLocaleString('es-UY', { minimumFractionDigits: 2 })}`;

/** Deja constancia auditable de cada cambio automático. */
async function corregir(
  id: string,
  campo: string,
  antes: unknown,
  despues: unknown,
  motivo: string,
  patch: Record<string, unknown>,
): Promise<boolean> {
  if (DRY) { console.log("[vigilante][simulacion] corregiria " + campo + " de " + id + ": " + antes + " -> " + despues); return true; }
  const { data: f } = await supabase.from('invoices').select('datos_extra').eq('id', id).maybeSingle();
  const de = (f as any)?.datos_extra ?? {};
  de.correccion_automatica = [
    ...(de.correccion_automatica ?? []),
    { campo, antes, despues, motivo, cuando: new Date().toISOString(), por: 'vigilante' },
  ];
  const { error } = await supabase.from('invoices').update({ ...patch, datos_extra: de }).eq('id', id);
  if (error) {
    console.error(`[vigilante] no pude corregir ${campo} de ${id}:`, error.message);
    return false;
  }
  console.log(`[vigilante] corregido ${campo} de ${id}: ${antes} → ${despues}`);
  return true;
}

export async function revisar(): Promise<string> {
  const hoy = new Date().toISOString().slice(0, 10);
  const categories = await getCategories();
  const arreglado: string[] = [];
  const paraRevisar: string[] = [];
  let presupuesto = MAX_CORRECCIONES;

  const { data: inv, error } = await supabase
    .from('invoices')
    .select('id,empresa_emisora,rut_emisor,nro_factura,monto,moneda,fecha,company_id,categoria_id,archivo_url,hash_dedupe,reporter,created_at,datos_extra');
  if (error) throw new Error('no pude leer las facturas: ' + error.message);
  const facturas = inv ?? [];

  // ── 1. Fechas imposibles (futuras) ────────────────────────────────────────
  // Una factura no puede ser del futuro. Suele pasar cuando el modelo agarra el
  // "próximo cobro" o el vencimiento en vez de la fecha de emisión.
  for (const f of facturas.filter((x: any) => x.fecha && x.fecha > hoy)) {
    if (presupuesto <= 0) break;
    const ocr = (f as any).datos_extra?.ocr;
    if (!ocr) { paraRevisar.push(`${f.empresa_emisora}: fecha ${f.fecha} (futura) y sin OCR para verificar`); continue; }
    let nueva: string | null = null;
    try { nueva = (await extractWithHaiku(ocr, categories)).fecha; } catch { /* sin dato */ }
    if (nueva && nueva !== f.fecha && nueva <= hoy) {
      if (await corregir(f.id, 'fecha', f.fecha, nueva, 'la fecha guardada era futura; se releyó del ticket', { fecha: nueva })) {
        arreglado.push(`Fecha: ${f.empresa_emisora} ${f.fecha} → ${nueva}`);
        presupuesto--;
      }
    } else {
      paraRevisar.push(`${f.empresa_emisora}: fecha ${f.fecha} es futura y el ticket no da otra clara`);
    }
  }

  // ── 2. Sin categoría ──────────────────────────────────────────────────────
  // Misma lógica que usa el bot a las 24h: la sugerencia guardada, o "Otros".
  for (const f of facturas.filter((x: any) => !x.categoria_id)) {
    if (presupuesto <= 0) break;
    const sug = (f as any).datos_extra?.flujo?.sugerencia;
    const cat = (sug && categories.find((c) => c.nombre.toLowerCase() === String(sug).toLowerCase()))
      || categories.find((c) => c.nombre === 'Otros');
    if (!cat) continue;
    if (await corregir(f.id, 'categoria', null, cat.nombre, sug ? 'se aplicó la categoría sugerida al extraer' : 'sin categoría tras el plazo; queda en Otros', { categoria_id: cat.id })) {
      arreglado.push(`Categoría: ${f.empresa_emisora} → ${cat.nombre}`);
      presupuesto--;
    }
  }

  // ── 3. Hash de deduplicación faltante ─────────────────────────────────────
  // Sin hash, el anti-duplicados no protege a esa factura.
  for (const f of facturas.filter((x: any) => !x.hash_dedupe && (x.rut_emisor || x.nro_factura))) {
    if (presupuesto <= 0) break;
    const h = dedupeHash(f.rut_emisor, f.nro_factura, Number(f.monto));
    if (!h || (await existeDuplicado(h))) continue; // ya lo tiene otra: no piso el índice UNIQUE
    if (await corregir(f.id, 'hash_dedupe', null, 'calculado', 'faltaba el hash: la factura no estaba protegida contra duplicados', { hash_dedupe: h })) {
      arreglado.push(`Anti-duplicados activado: ${f.empresa_emisora}`);
      presupuesto--;
    }
  }

  // ── 4. Empresa sin identificar ────────────────────────────────────────────
  // Sólo si el OCR trae un RUT de 12 dígitos que coincide con una empresa real.
  const { data: empresas } = await supabase.from('companies').select('id,nombre,rut').not('rut', 'is', null);
  for (const f of facturas.filter((x: any) => x.company_id === NO_IDENTIFICADO_ID)) {
    if (presupuesto <= 0) break;
    const ocr = String((f as any).datos_extra?.ocr ?? '');
    const ruts: string[] = ocr.match(/\b\d{12}\b/g) ?? [];
    const match = (empresas ?? []).find((e: any) => ruts.includes(String(e.rut)));
    if (match) {
      if (await corregir(f.id, 'empresa', 'No Identificado', match.nombre, `el ticket trae el RUT ${match.rut}`, { company_id: match.id })) {
        arreglado.push(`Empresa: ${f.empresa_emisora} → ${match.nombre}`);
        presupuesto--;
      }
    } else {
      paraRevisar.push(`${f.empresa_emisora} (${fmtMonto(f.monto, f.moneda)}): sin empresa identificada, el ticket no trae un RUT conocido`);
    }
  }

  // ── 5. SOLO REPORTAR: plata ───────────────────────────────────────────────
  for (const f of facturas.filter((x: any) => Number(x.monto) <= 0)) {
    paraRevisar.push(`*Plata:* ${f.empresa_emisora} quedó en ${fmtMonto(f.monto, f.moneda)}. Revisar el ticket.`);
  }
  for (const f of facturas) {
    const ocr = String((f as any).datos_extra?.ocr ?? '');
    if (f.moneda !== 'ARS' && /CUIT|C\.U\.I\.T|RESPONSABLE INSCRIPTO|Ciudad Aut[oó]noma/i.test(ocr)) {
      paraRevisar.push(`*Plata:* ${f.empresa_emisora} ${fmtMonto(f.monto, f.moneda)} — el ticket tiene marcas argentinas (CUIT/IVA 21%). ¿Debería ser ARS?`);
    }
  }

  // ── 6. SOLO REPORTAR: posibles duplicados ─────────────────────────────────
  const porClave: Record<string, any[]> = {};
  for (const f of facturas) {
    const k = `${f.empresa_emisora}|${f.monto}|${f.fecha}`;
    (porClave[k] ??= []).push(f);
  }
  for (const [k, lista] of Object.entries(porClave)) {
    if (lista.length > 1) {
      const [emp, monto] = k.split('|');
      paraRevisar.push(`Posible duplicado: ${lista.length} facturas iguales de ${emp} por ${monto}`);
    }
  }

  // ── 7. SOLO REPORTAR: archivos huérfanos ──────────────────────────────────
  // Foto que se subió pero nunca quedó asociada a una factura = gasto sin rendir.
  const enUso = new Set(facturas.filter((f: any) => f.archivo_url).map((f: any) => f.archivo_url));
  const carpetas = new Set<string>();
  const { data: raiz } = await supabase.storage.from('facturas').list('', { limit: 1000 });
  for (const c of raiz ?? []) if (!c.id) carpetas.add(c.name);
  let huerfanos = 0, huerfanosBytes = 0;
  for (const co of carpetas) {
    for (const anio of ['2025', '2026', '2027']) {
      const { data: meses } = await supabase.storage.from('facturas').list(`${co}/${anio}`, { limit: 1000 });
      for (const m of meses ?? []) {
        if (m.id) continue;
        const { data: archivos } = await supabase.storage.from('facturas').list(`${co}/${anio}/${m.name}`, { limit: 1000 });
        for (const a of archivos ?? []) {
          if (!a.id) continue;
          if (!enUso.has(`${co}/${anio}/${m.name}/${a.name}`)) {
            huerfanos++;
            huerfanosBytes += (a.metadata as any)?.size ?? 0;
          }
        }
      }
    }
  }
  if (huerfanos > 0) {
    paraRevisar.push(`${huerfanos} foto(s) subidas que nunca se registraron (${(huerfanosBytes / 1048576).toFixed(1)} MB). Son gastos que nadie rindió.`);
  }

  // ── 8. SOLO REPORTAR: conversaciones trabadas ─────────────────────────────
  const { data: sesiones } = await supabase.from('wa_sessions').select('phone,pending');
  for (const s of (sesiones ?? []) as any[]) {
    const at = s.pending?.recibido_at;
    if (!s.pending?.archivo_url || !at) continue;
    const hs = (Date.now() - new Date(at).getTime()) / 3600_000;
    if (hs > 48) paraRevisar.push(`${s.phone} tiene una factura sin confirmar hace ${Math.round(hs / 24)} días`);
  }

  // ── Resumen ───────────────────────────────────────────────────────────────
  const partes = [`🔍 *Revisión del bot de gastos* — ${new Date().toLocaleDateString('es-UY')}`, ''];
  partes.push(`${facturas.length} facturas en total.`);
  if (arreglado.length) {
    partes.push('', `*✅ Arreglado (${arreglado.length}):*`, ...arreglado.map((a) => `• ${a}`));
  }
  if (paraRevisar.length) {
    partes.push('', `*⚠️ Para revisar ustedes (${paraRevisar.length}):*`, ...paraRevisar.slice(0, 12).map((r) => `• ${r}`));
    if (paraRevisar.length > 12) partes.push(`_...y ${paraRevisar.length - 12} más_`);
  }
  if (!arreglado.length && !paraRevisar.length) partes.push('', '✅ Sin novedad: no encontré nada para corregir ni revisar.');
  if (presupuesto <= 0) partes.push('', `_Llegué al tope de ${MAX_CORRECCIONES} correcciones; el resto va en la próxima._`);

  return partes.join('\n');
}

async function correrYAvisar(): Promise<void> {
  try {
    const resumen = await revisar();
    for (const t of DEVS) await sendTextSafe(t, resumen);
    guardarEstado({ ultima_corrida: new Date().toISOString() });
    console.log('[vigilante] revisión enviada');
  } catch (e) {
    console.error('[vigilante] la revisión falló:', (e as Error).message);
    for (const t of DEVS) {
      await sendTextSafe(t, `⚠️ *Revisión del bot* — no pude completarla.\n\nMotivo: ${(e as Error).message}`);
    }
    // no guardo la fecha: se reintenta en el próximo chequeo
  }
}

export function initVigilante(): void {
  console.log(`[vigilante] activo (revisa cada ${CADA_DIAS} días)`);
  const tick = async () => {
    const ultima = leerEstado().ultima_corrida;
    const dias = ultima ? (Date.now() - new Date(ultima).getTime()) / 86_400_000 : Infinity;
    if (dias >= CADA_DIAS) await correrYAvisar();
  };
  // La fecha se guarda en disco: si el contenedor se reinicia (deploy), no se
  // pierde el ciclo ni se dispara de más.
  setTimeout(() => void tick(), 60_000); // 1 min tras arrancar, sin trabar el boot
  setInterval(() => void tick(), CHEQUEO_MS);
}
