import { supabase } from '../lib/supabase.js';

/**
 * Consulta de "mis facturas".
 *
 * SEGURIDAD: el teléfono NO es un parámetro de la tool — sale del contexto del
 * mensaje entrante (ctx.phone). Así el modelo no puede pedir (ni el empleado
 * inducirlo a pedir) las facturas de otra persona: cada uno ve sólo lo que
 * registró él.
 */
export interface ConsultarCtx {
  phone: string;
}

export interface ConsultarInput {
  periodo?: string; // 'YYYY-MM'; omitido = las últimas registradas
}

export const consultarFacturasSchema = {
  type: 'object',
  properties: {
    periodo: {
      type: 'string',
      description:
        'Filtra por el mes DE LA FACTURA (la fecha del ticket), en formato YYYY-MM. OJO: no es el mes en que se registró — un ticket del 30/06 cargado el 02/07 cuenta como 2026-06. Para "¿qué registré?" o "¿quedó guardada?" OMITILO: así devuelve las últimas registradas sin importar el mes. Usalo sólo si el empleado pregunta explícitamente por los gastos de un mes concreto.',
    },
  },
  required: [],
  additionalProperties: false,
} as const;

const LIMITE = 25;

function fmtMonto(monto: number | string | null, moneda: string | null): string {
  const n = Number(monto ?? 0);
  const s = n.toLocaleString('es-UY', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return `${moneda ?? 'UYU'} ${s}`;
}

/**
 * Devuelve, en texto plano para el modelo, las facturas que registró ESTE teléfono.
 * El modelo se encarga de presentarlas; acá garantizamos los datos y el alcance.
 */
export async function consultarMisFacturas(
  ctx: ConsultarCtx,
  input: ConsultarInput,
): Promise<string> {
  const periodo = (input.periodo ?? '').trim();
  if (periodo && !/^\d{4}-\d{2}$/.test(periodo)) {
    return `ERROR: periodo "${periodo}" inválido. Usá el formato YYYY-MM (ej: 2026-07).`;
  }

  let q = supabase
    .from('invoices')
    .select('empresa_emisora, monto, moneda, fecha, created_at, categories(nombre)')
    .eq('reporter', ctx.phone)
    .order('created_at', { ascending: false })
    .limit(LIMITE);
  if (periodo) q = q.eq('periodo', periodo);

  const { data, error } = await q;
  if (error) {
    console.error('[consultar] error:', error);
    return 'ERROR: no pude consultar las facturas en este momento. Pedile al empleado que reintente en un rato.';
  }
  if (!data?.length) {
    return periodo
      ? `SIN RESULTADOS: no hay facturas registradas por este empleado en ${periodo}.`
      : 'SIN RESULTADOS: este empleado todavía no tiene ninguna factura registrada.';
  }

  const lineas = data.map((r: any) => {
    const cat = Array.isArray(r.categories) ? r.categories[0]?.nombre : r.categories?.nombre;
    const fecha = r.fecha ?? String(r.created_at).slice(0, 10);
    return `- ${r.empresa_emisora} | ${fmtMonto(r.monto, r.moneda)} | ${fecha}${cat ? ` | ${cat}` : ''}`;
  });

  const total = data.length === LIMITE ? `las últimas ${LIMITE}` : `${data.length}`;
  return (
    `OK — facturas registradas por este empleado${periodo ? ` en ${periodo}` : ''} (${total}), de la más nueva a la más vieja:\n` +
    lineas.join('\n')
  );
}
