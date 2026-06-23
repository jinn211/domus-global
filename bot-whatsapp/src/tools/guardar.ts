import { supabase, type Category } from '../lib/supabase.js';

export interface GuardarCtx {
  companyId: string;
  phone: string;
  categories: Category[];
  ocrText: string; // OCR de la ventana (para datos_extra)
  archivoUrl: string | null; // path ya subido a Storage al llegar la foto
}

export interface GuardarInput {
  empresa_emisora: string;
  rut_emisor?: string;
  rut_receptor?: string;
  monto: number;
  moneda?: string;
  fecha?: string; // YYYY-MM-DD
  nro_factura?: string;
  categoria: string; // nombre de la categoría
  descripcion?: string;
}

/** JSON Schema de la tool (lo que ve el modelo). */
export const guardarFacturaSchema = {
  type: 'object',
  properties: {
    empresa_emisora: { type: 'string', description: 'Proveedor que emite la factura (ej: Shell, Devoto, Tienda Inglesa).' },
    rut_emisor: { type: 'string', description: 'RUT del emisor, si aparece.' },
    rut_receptor: { type: 'string', description: 'RUT de la empresa receptora/cliente, si aparece en el documento.' },
    monto: { type: 'number', description: 'Monto total del gasto.' },
    moneda: { type: 'string', description: 'Moneda: UYU o USD. Default UYU.' },
    fecha: { type: 'string', description: 'Fecha de la factura en formato YYYY-MM-DD.' },
    nro_factura: { type: 'string', description: 'Número de comprobante, si aparece.' },
    categoria: { type: 'string', description: 'Una de las categorías válidas (nombre exacto).' },
    descripcion: { type: 'string', description: 'Detalle u observaciones del gasto.' },
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

  const { data, error } = await supabase
    .from('invoices')
    .insert({
      company_id: ctx.companyId,
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
      datos_extra: { ocr: ctx.ocrText, descripcion: input.descripcion ?? null },
    })
    .select('id')
    .single();

  if (error) return `ERROR guardando la factura: ${error.message}`;

  if (input.rut_receptor) {
    await supabase
      .from('companies')
      .update({ rut: input.rut_receptor })
      .eq('id', ctx.companyId)
      .is('rut', null);
  }

  return `OK: factura guardada (id ${data.id}) — ${input.empresa_emisora}, ${input.moneda ?? 'UYU'} ${input.monto}, categoría ${categoria.nombre}.`;
}
