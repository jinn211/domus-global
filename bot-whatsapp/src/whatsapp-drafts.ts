import { sendText } from './lib/evolution.js';
import { withPhoneLock } from './lib/lock.js';
import {
  supabase,
  getCategories,
  loadSession,
  saveSession,
  type Category,
  type Employee,
  type WaMediaItem,
  type WaSession,
} from './lib/supabase.js';
import { runAgent } from './agent.js';
import { extractWithHaiku } from './email-processor.js';
import { cerrarOReanudarMail } from './completion.js';
import { dedupeHash, existeDuplicado } from './tools/guardar.js';
import { alertar } from './lib/alertas.js';

const RECORDATORIO_HORAS = 2;
const AUTOGUARDADO_HORAS = 24;
const INTERVALO_SWEEP_MS = 10 * 60_000;

/**
 * Procesa la siguiente foto de la cola: corre el agente sobre su OCR ya hecho y
 * manda la pregunta. Si el agente guardara en el acto, avanza al resto; si no,
 * deja la sesión esperando la respuesta con el resto de la cola preservada.
 */
export async function runQueuedPhoto(
  phone: string,
  employee: Employee,
  categories: Category[],
  item: WaMediaItem,
  rest: WaMediaItem[],
  lotePos = 1,
  colaFacturas: string[] = [],
  /**
   * Momento en que llegó la PRIMERA foto del lote. Todas comparten vencimiento:
   * si a cada foto de la cola se le reiniciaba el reloj, un lote de 11 tardaba
   * 11 días en cerrarse. Si no se pasa, se toma "ahora" (lote nuevo de una foto).
   */
  recibidoAt?: string,
): Promise<void> {
  const employeeForAgent = {
    ...employee,
    company_id: item.company_id,
    company_nombre: item.company_nombre,
  };
  const { reply, newHistory, saved, duplicado } = await runAgent({
    employee: employeeForAgent,
    phone,
    categories,
    history: [],
    userText: '',
    ocrText: item.ocr,
    windowOcr: item.ocr,
    archivoUrl: item.archivo_url,
    hasImage: true,
    colaPendiente: rest.length,
    lotePos,
  });

  await sendText(phone, reply);
  console.log('[cola-media] pregunta de la siguiente enviada a ' + phone + ' (' + rest.length + ' restantes)');

  const vencimientoLote = recibidoAt ?? new Date().toISOString();

  if (saved || duplicado) {
    if (rest.length > 0) {
      await runQueuedPhoto(phone, employee, categories, rest[0], rest.slice(1), lotePos + 1, colaFacturas, vencimientoLote);
    } else {
      await cerrarOReanudarMail(phone, colaFacturas, categories);
    }
  } else {
    await saveSession({
      phone,
      company_id: item.company_id,
      history: newHistory,
      draft_invoice_id: null,
      pending: {
        archivo_url: item.archivo_url,
        ocr: item.ocr,
        cola_media: rest,
        // hereda el vencimiento del lote: NO se reinicia por foto
        recibido_at: vencimientoLote,
        lote_pos: lotePos,
        ...(colaFacturas.length ? { cola_facturas: colaFacturas } : {}),
      },
    });
  }
}

/** Recordatorio a las 2hs y guardado automático a las 24hs de fotos de WhatsApp sin confirmar. */
export function initWhatsappDraftSweep(): void {
  sweepWhatsappDrafts().catch((e) => console.error('[wa-draft] sweep inicial error:', e));
  setInterval(() => {
    sweepWhatsappDrafts().catch((e) => { console.error('[wa-draft] sweep error:', e); void alertar('barrido de fotos sin confirmar (auto-guardado 24h)', e); });
  }, INTERVALO_SWEEP_MS);
}

async function sweepWhatsappDrafts(): Promise<void> {
  const { data, error } = await supabase
    .from('wa_sessions')
    .select('phone, company_id, history, draft_invoice_id, pending')
    .not('pending->>archivo_url', 'is', null);
  if (error) {
    console.error('[wa-draft] error leyendo sesiones:', error);
    return;
  }
  const sessions = (data ?? []) as WaSession[];
  if (!sessions.length) return;

  const categories = await getCategories();
  const now = Date.now();

  for (const s of sessions) {
    const recibidoAt = s.pending?.recibido_at;
    if (!recibidoAt) continue; // sesión previa al feature, sin marca de tiempo confiable
    const horas = (now - new Date(recibidoAt).getTime()) / 3_600_000;
    if (horas < RECORDATORIO_HORAS) continue;

    // Bajo el lock del teléfono: si el empleado está respondiendo justo ahora, se
    // espera. Sin esto el barrido podía auto-guardar una factura que el empleado
    // estaba confirmando (doble registro) o revivir una sesión recién cerrada.
    await withPhoneLock(s.phone, async () => {
      // Releer adentro del lock: el estado pudo cambiar mientras esperábamos.
      const fresca = await loadSession(s.phone);
      if (!fresca?.pending?.archivo_url) return; // ya la resolvió el empleado
      const at = fresca.pending.recibido_at;
      if (!at) return;
      const hs = (Date.now() - new Date(at).getTime()) / 3_600_000;

      if (hs >= AUTOGUARDADO_HORAS) {
        await autoGuardar(fresca, categories);
      } else if (hs >= RECORDATORIO_HORAS && !fresca.pending.recordatorio_enviado) {
        await sendText(
          fresca.phone,
          '⏰ Todavía no confirmaste la factura que mandaste. Respondeme para completarla — si no, en 24 horas la guardo automáticamente con lo que pude leer del ticket.',
        );
        await saveSession({ ...fresca, pending: { ...fresca.pending, recordatorio_enviado: true } });
        console.log('[wa-draft] recordatorio enviado a ' + fresca.phone);
      }
    }).catch((e) => console.error('[wa-draft] error procesando ' + s.phone + ':', e));
  }
}

/** Guarda automáticamente UNA foto con lo que se pudo leer del OCR. */
async function guardarUnaAuto(
  companyId: string | null,
  phone: string,
  ocrText: string,
  archivoUrl: string | null,
  categories: Category[],
): Promise<{ estado: 'guardada' | 'duplicada' | 'error'; resumen: string }> {
  let extracted: Awaited<ReturnType<typeof extractWithHaiku>> | null = null;
  try {
    extracted = await extractWithHaiku(ocrText, categories);
  } catch (e) {
    console.error('[wa-draft] error extrayendo con Haiku:', e);
  }

  const categoria =
    (extracted?.categoria &&
      categories.find((c) => c.nombre.toLowerCase() === extracted!.categoria!.toLowerCase())) ||
    categories.find((c) => c.nombre === 'Otros') ||
    null;

  const proveedor = extracted?.empresa_emisora || 'proveedor no identificado';
  const monto = extracted?.monto || 0;
  const montoTxt = monto ? `${extracted?.moneda ?? 'UYU'} ${monto}` : 'monto no legible';

  // Anti-duplicados (hash null = sin clave real → no participa del dedup).
  const hash = dedupeHash(extracted?.rut_emisor, extracted?.nro_factura, monto);
  if (await existeDuplicado(hash)) {
    console.log('[wa-draft] duplicado, no se auto-guardó: ' + proveedor);
    return { estado: 'duplicada', resumen: `${proveedor}, ${montoTxt} (ya estaba registrada)` };
  }

  const { data, error } = await supabase
    .from('invoices')
    .insert({
      company_id: companyId,
      empresa_emisora: extracted?.empresa_emisora || 'Desconocido',
      rut_emisor: extracted?.rut_emisor ?? null,
      monto,
      moneda: extracted?.moneda || 'UYU',
      fecha: extracted?.fecha ?? null,
      nro_factura: extracted?.nro_factura ?? null,
      categoria_id: categoria?.id ?? null,
      fuente: 'whatsapp',
      reporter: phone,
      archivo_url: archivoUrl,
      estado_conciliacion: 'pendiente',
      hash_dedupe: hash,
      datos_extra: {
        ocr: ocrText,
        descripcion: 'Guardado automático: el empleado no confirmó dentro de las 24 horas. Verificar los datos.',
        flujo: { estado: 'auto_guardado', motivo: 'sin_respuesta_24h', guardado_at: new Date().toISOString() },
      },
    })
    .select('id')
    .single();

  if (error) {
    console.error('[wa-draft] error guardando automáticamente:', error);
    return { estado: 'error', resumen: `${proveedor}, ${montoTxt}` };
  }
  console.log('[wa-draft] auto-guardado ' + data?.id + ' (' + proveedor + ') para ' + phone);
  return { estado: 'guardada', resumen: `${proveedor}, ${montoTxt}, ${categoria?.nombre ?? 'Otros'}` };
}

/**
 * Vencieron las 24h: guarda automáticamente TODO el lote de una vez.
 *
 * Antes se guardaba sólo la foto pendiente y la cola avanzaba preguntando de
 * nuevo, lo que reiniciaba el reloj para cada foto: un lote de 11 fotos tardaba
 * 11 DÍAS en cerrarse y en la práctica quedaba colgado (pasó el 23/07: 11 fotos
 * quedaron sin registrar). Ahora el lote entero comparte vencimiento y se cierra
 * junto, con un solo aviso al empleado.
 */
async function autoGuardar(s: WaSession, categories: Category[]): Promise<void> {
  const items = [
    { ocr: s.pending?.ocr ?? '', archivo_url: s.pending?.archivo_url ?? null, company_id: s.company_id },
    ...(s.pending?.cola_media ?? []).map((m) => ({ ocr: m.ocr, archivo_url: m.archivo_url, company_id: m.company_id })),
  ];
  console.log(`[wa-draft] venció el plazo: auto-guardando ${items.length} factura(s) de ${s.phone}`);

  const guardadas: string[] = [];
  const duplicadas: string[] = [];
  const fallidas: typeof items = [];
  for (const it of items) {
    const r = await guardarUnaAuto(it.company_id ?? s.company_id, s.phone, it.ocr, it.archivo_url, categories);
    if (r.estado === 'guardada') guardadas.push(r.resumen);
    else if (r.estado === 'duplicada') duplicadas.push(r.resumen);
    else fallidas.push(it);
  }

  // Un solo mensaje por lote (antes era uno por factura).
  const partes: string[] = ['⏰ No recibí confirmación a tiempo, así que registré con lo que pude leer de los tickets:'];
  if (guardadas.length) partes.push('', ...guardadas.map((g) => `• ${g}`));
  if (duplicadas.length) partes.push('', `⚠️ ${duplicadas.length === 1 ? 'Una ya estaba registrada' : `${duplicadas.length} ya estaban registradas`}, no las dupliqué.`);
  if (guardadas.length || duplicadas.length) {
    partes.push('', 'Si algo está mal, avisale a administración para corregirlo.');
    await sendText(s.phone, partes.join('\n')).catch((e) =>
      console.error('[wa-draft] error avisando auto-guardado:', e));
  }

  // Las que fallaron quedan pendientes para el próximo barrido, conservando el
  // vencimiento original (no se les reinicia el reloj).
  if (fallidas.length) {
    console.error(`[wa-draft] ${fallidas.length} factura(s) no se pudieron guardar, quedan para reintentar`);
    await saveSession({
      phone: s.phone,
      company_id: s.company_id,
      history: [],
      draft_invoice_id: null,
      pending: {
        archivo_url: fallidas[0].archivo_url,
        ocr: fallidas[0].ocr,
        cola_media: fallidas.slice(1).map((f) => ({
          archivo_url: f.archivo_url, ocr: f.ocr,
          company_id: f.company_id ?? s.company_id ?? '', company_nombre: null,
        })),
        recibido_at: s.pending?.recibido_at,
        recordatorio_enviado: true,
        lote_pos: 1,
        ...(s.pending?.cola_facturas?.length ? { cola_facturas: s.pending.cola_facturas } : {}),
      },
    });
    return;
  }

  await cerrarOReanudarMail(s.phone, s.pending?.cola_facturas ?? [], categories);
}
