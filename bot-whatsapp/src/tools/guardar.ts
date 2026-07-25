import { createHash } from 'node:crypto';
import { supabase, type Category, type Company } from '../lib/supabase.js';

/** Hay clave real de dedup solo si aparece el RUT del emisor o el nº de comprobante. */
export function tieneClaveDedup(
  rutEmisor: string | null | undefined,
  nroFactura: string | null | undefined,
): boolean {
  return Boolean((rutEmisor ?? '').trim() || (nroFactura ?? '').trim());
}

/**
 * Hash de deduplicación: MISMA fórmula que el flujo de mail (rut|nro|monto),
 * para que un duplicado se detecte también entre canales (mail ↔ WhatsApp).
 *
 * Devuelve null cuando el ticket no trae NINGUNA clave real (ni RUT ni nº). Sin
 * clave, el hash sería md5('||<monto>') — idéntico para dos tickets distintos del
 * mismo importe. Como `invoices.hash_dedupe` tiene índice UNIQUE, escribir ese
 * hash hacía que la base rechazara el segundo gasto legítimo (dos cafés de $180
 * de comercios distintos) y se perdiera. En Postgres NULL nunca colisiona con
 * NULL, así que null = "esta factura no participa del dedup".
 */
export function dedupeHash(
  rutEmisor: string | null | undefined,
  nroFactura: string | null | undefined,
  monto: number,
): string | null {
  if (!tieneClaveDedup(rutEmisor, nroFactura)) return null;
  const hp = [(rutEmisor ?? '').toLowerCase(), nroFactura ?? '', String(monto)].join('|');
  return createHash('md5').update(hp).digest('hex');
}

/** ¿Ya existe una factura con este hash? Sin hash (sin clave real) nunca es duplicado. */
export async function existeDuplicado(hash: string | null): Promise<boolean> {
  if (!hash) return false;
  const { data } = await supabase
    .from('invoices')
    .select('id')
    .eq('hash_dedupe', hash)
    .maybeSingle();
  return Boolean(data);
}

// Categorías donde la descripción del gasto es obligatoria (no se infiere del
// ticket): la empresa/proveedor solo no alcanza para entender qué fue el gasto.
export const CATEGORIAS_DESCRIPCION_OBLIGATORIA = new Set([
  'Plataformas - Gastos directos',
  'Gastos de Eventos',
  'Viajes',
  'Otros',
]);

export interface GuardarCtx {
  companyId: string;
  phone: string;
  categories: Category[];
  ocrText: string; // OCR de la ventana (para datos_extra)
  archivoUrl: string | null; // path ya subido a Storage al llegar la foto
  /** Empresas del holding elegibles: sólo se pasan cuando hay que preguntar cuál es. */
  companiesElegibles?: Company[];
  /** true si NO se pudo identificar la empresa y el admin tiene que indicarla. */
  empresaDesconocida?: boolean;
}

export interface GuardarInput {
  empresa_emisora: string;
  rut_emisor?: string;
  monto: number;
  moneda?: string;
  fecha?: string; // YYYY-MM-DD
  nro_factura?: string;
  categoria: string; // nombre de la categoría
  descripcion?: string;
  /** Empresa del holding a la que imputar el gasto (sólo cuando no se pudo deducir). */
  empresa_holding?: string;
}

/** JSON Schema de la tool (lo que ve el modelo). */
export const guardarFacturaSchema = {
  type: 'object',
  properties: {
    empresa_emisora: { type: 'string', description: 'Proveedor que emite la factura (ej: Shell, Devoto, Tienda Inglesa).' },
    rut_emisor: { type: 'string', description: 'RUT del emisor, si aparece.' },
    monto: { type: 'number', description: 'Monto total del gasto.' },
    moneda: { type: 'string', description: 'Moneda del ticket: UYU, USD, ARS, EUR, CLP o BRL. Default UYU.' },
    fecha: { type: 'string', description: 'Fecha de la factura en formato YYYY-MM-DD.' },
    nro_factura: { type: 'string', description: 'Número de comprobante, si aparece.' },
    categoria: { type: 'string', description: 'Una de las categorías válidas (nombre exacto).' },
    descripcion: { type: 'string', description: 'Detalle u observaciones del gasto.' },
    empresa_holding: {
      type: 'string',
      description:
        'Empresa DEL HOLDING a la que se imputa el gasto (nombre exacto de la lista). Completar SOLO cuando el sistema avisó que no pudo identificarla y el admin la indicó. No confundir con empresa_emisora (el proveedor).',
    },
  },
  required: ['empresa_emisora', 'monto', 'categoria'],
  additionalProperties: false,
} as const;

function extFromMime(mime?: string): string {
  switch ((mime ?? '').toLowerCase()) {
    case 'image/png': return 'png';
    case 'image/webp': return 'webp';
    case 'application/pdf': return 'pdf';
    default: return 'jpg';
  }
}

/** Ejecuta el guardado: sube el archivo a Storage e inserta la fila en invoices. */
export async function guardarFactura(ctx: GuardarCtx, input: GuardarInput): Promise<string> {
  const categoria = ctx.categories.find(
    (c) => c.nombre.toLowerCase() === (input.categoria ?? '').toLowerCase(),
  );
  if (!categoria) {
    return `ERROR: categoría "${input.categoria}" no es válida. Opciones: ${ctx.categories.map((c) => c.nombre).join(', ')}.`;
  }
  if (CATEGORIAS_DESCRIPCION_OBLIGATORIA.has(categoria.nombre) && !input.descripcion?.trim()) {
    return `ERROR: la categoría "${categoria.nombre}" requiere una descripción del gasto. Preguntale al empleado qué descripción poner y volvé a llamar la tool con ese dato.`;
  }

  // Empresa del holding: normalmente sale sola (del RUT/dominio de la factura o
  // de la whitelist del empleado). Cuando NO se pudo identificar, el admin tiene
  // que indicarla: nunca la guardamos en "No Identificado" a sus espaldas.
  let companyId = ctx.companyId;
  if (ctx.empresaDesconocida) {
    const elegibles = ctx.companiesElegibles ?? [];
    const pedida = (input.empresa_holding ?? '').trim();
    if (!pedida) {
      return (
        `ERROR: no se pudo identificar a qué empresa del holding pertenece esta factura. ` +
        `Preguntale al admin a cuál imputarla y volvé a llamar la tool con ese nombre en 'empresa_holding'. ` +
        `Opciones: ${elegibles.map((c) => c.nombre).join(', ')}.`
      );
    }
    const match = elegibles.find((c) => c.nombre.toLowerCase() === pedida.toLowerCase());
    if (!match) {
      return (
        `ERROR: "${pedida}" no es una empresa válida del holding. ` +
        `Pedile al admin que elija una de: ${elegibles.map((c) => c.nombre).join(', ')}.`
      );
    }
    companyId = match.id;
    console.log(`[admin] empresa indicada manualmente: ${match.nombre}`);
  }

  // Anti-duplicados: si esta factura (por rut/nº/monto) ya está registrada, no
  // la guardamos de nuevo. `dedupeHash` devuelve null cuando no hay clave real
  // (RUT o nº), y entonces ni chequeamos ni escribimos hash: así dos tickets
  // distintos del mismo importe no colisionan en el índice UNIQUE.
  const hash = dedupeHash(input.rut_emisor, input.nro_factura, input.monto);
  if (await existeDuplicado(hash)) {
    return `DUPLICADO: la factura de ${input.empresa_emisora} por ${input.moneda ?? 'UYU'} ${input.monto}${input.nro_factura ? ` (N° ${input.nro_factura})` : ''} ya había sido registrada antes. Avisale al usuario que es una factura repetida y que la verifique. NO la guardes de nuevo ni reintentes.`;
  }

  const { data, error } = await supabase
    .from('invoices')
    .insert({
      company_id: companyId,
      empresa_emisora: input.empresa_emisora,
      rut_emisor: input.rut_emisor ?? null,
      monto: input.monto,
      moneda: input.moneda ?? 'UYU',
      fecha: input.fecha ?? null,
      nro_factura: input.nro_factura ?? null,
      categoria_id: categoria.id,
      fuente: 'whatsapp',
      reporter: ctx.phone,
      archivo_url: ctx.archivoUrl,
      estado_conciliacion: 'pendiente',
      hash_dedupe: hash,
      datos_extra: { ocr: ctx.ocrText, descripcion: input.descripcion ?? null },
    })
    .select('id')
    .single();

  if (error) return `ERROR guardando la factura: ${error.message}`;
  return `OK: factura guardada (id ${data.id}) — ${input.empresa_emisora}, ${input.moneda ?? 'UYU'} ${input.monto}, categoría ${categoria.nombre}.`;
}
