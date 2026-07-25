import Anthropic from '@anthropic-ai/sdk';
import { config } from './config.js';
import { sendText } from './lib/evolution.js';
import {
  supabase,
  getCategories,
  loadSession,
  saveSession,
  clearSession,
  type Category,
  type WaSession,
} from './lib/supabase.js';
import { CATEGORIAS_DESCRIPCION_OBLIGATORIA } from './tools/guardar.js';

const anthropic = new Anthropic({ apiKey: config.ANTHROPIC_API_KEY });

function norm(s: string): string {
  return (s || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]/g, '');
}

interface InvoiceBrief {
  empresa_emisora: string;
  monto: number | null;
  moneda: string;
  fecha: string | null;
  company_nombre: string;
  sugerencia: string | null;
}

async function getBrief(invoiceId: string): Promise<InvoiceBrief | null> {
  const { data } = await supabase
    .from('invoices')
    .select('empresa_emisora, monto, moneda, fecha, datos_extra, companies(nombre)')
    .eq('id', invoiceId)
    .maybeSingle();
  if (!data) return null;
  const companies = (data as any).companies;
  const company_nombre = Array.isArray(companies) ? companies[0]?.nombre : companies?.nombre;
  const flujo = ((data as any).datos_extra || {}).flujo || {};
  return {
    empresa_emisora: (data as any).empresa_emisora || 'proveedor',
    monto: (data as any).monto,
    moneda: (data as any).moneda || 'UYU',
    fecha: (data as any).fecha || null,
    company_nombre: company_nombre || 'la empresa',
    sugerencia: flujo.sugerencia || null,
  };
}

/** Texto de la pregunta para una factura. */
export async function buildQuestion(invoiceId: string, categories: Category[]): Promise<string> {
  const b = await getBrief(invoiceId);
  const opciones = categories
    .map((c, i) => `${i + 1}. ${c.nombre}${c.descripcion ? ` _(${c.descripcion})_` : ''}`)
    .join('\n');
  if (!b) {
    return `🧾 *Nueva factura para categorizar*\n\n¿En qué categoría va?\n\nRespondé con el número o el nombre:\n${opciones}`;
  }
  const lineas = [`🧾 *Nueva factura para categorizar*`, ``, `🏢 ${b.company_nombre}`, `🏪 ${b.empresa_emisora}`];
  if (b.monto != null) lineas.push(`💵 ${b.moneda} ${b.monto}`);
  if (b.fecha) lineas.push(`📅 ${b.fecha}`);
  lineas.push(``);
  lineas.push(`¿En qué categoría va?${b.sugerencia ? ` _(te sugiero *${b.sugerencia}*)_` : ''}`);
  lineas.push(``);
  lineas.push(`Respondé con el número o el nombre:`);
  lineas.push(opciones);
  return lineas.join('\n');
}

/** Envía la pregunta de una factura puntual a un teléfono. */
export async function sendQuestion(invoiceId: string, phone: string, categories: Category[]): Promise<void> {
  const text = await buildQuestion(invoiceId, categories);
  await sendText(phone, text);
}

/**
 * Encola una factura para preguntar su categoría por WhatsApp.
 * Si ya hay una conversación de categorización abierta, la agrega a la cola;
 * si no, abre la conversación y manda la pregunta.
 */
export async function enqueueQuestion(
  phone: string,
  invoiceId: string,
  categories: Category[],
): Promise<void> {
  const session = await loadSession(phone);
  if (session?.draft_invoice_id) {
    const cola = session.pending?.cola_facturas ?? [];
    cola.push(invoiceId);
    await saveSession({
      ...session,
      pending: {
        archivo_url: session.pending?.archivo_url ?? null,
        ocr: session.pending?.ocr ?? '',
        cola_facturas: cola,
      },
    });
    console.log(`[completar] encolada ${invoiceId} para ${phone} (cola=${cola.length})`);
    return;
  }
  await saveSession({
    phone,
    company_id: null,
    history: [],
    draft_invoice_id: invoiceId,
    pending: { archivo_url: null, ocr: '', cola_facturas: [] },
  });
  await sendQuestion(invoiceId, phone, categories);
  console.log(`[completar] pregunta enviada a ${phone} por ${invoiceId}`);
}

function matchCategoria(text: string, categories: Category[]): Category | null {
  // Respuesta por número (1..N), según el orden de la lista
  const numMatch = (text || '').trim().match(/^(\d{1,2})$/);
  if (numMatch) {
    const idx = parseInt(numMatch[1], 10) - 1;
    if (idx >= 0 && idx < categories.length) return categories[idx];
  }
  const n = norm(text);
  if (!n) return null;
  for (const c of categories) {
    const cn = norm(c.nombre);
    if (cn && (n.includes(cn) || (cn.includes(n) && n.length >= 4))) return c;
  }
  for (const c of categories) {
    const first = norm(c.nombre.split(/[\/ ]/)[0]);
    if (first.length >= 4 && n.includes(first)) return c;
  }
  return null;
}

/**
 * ¿El empleado está corrigiendo la categoría en vez de dar la descripción?
 *
 * A propósito es CONSERVADORA: ante la duda devuelve null y el texto se toma como
 * descripción. Una descripción legítima puede nombrar una categoría sin querer
 * cambiarla ("almuerzo con el cliente del viaje a Salto"), y perder esa
 * descripción sería peor que no detectar una corrección. Sólo acepta señales
 * inequívocas: un número solo, el nombre exacto de una categoría, o una negación
 * explícita ("no, va en Viajes").
 */
function esCorreccionCategoria(text: string, categories: Category[]): Category | null {
  const t = (text ?? '').trim();
  if (!t) return null;

  // "2" → la categoría 2 de la lista
  const num = t.match(/^(\d{1,2})$/);
  if (num) {
    const idx = parseInt(num[1], 10) - 1;
    return idx >= 0 && idx < categories.length ? categories[idx] : null;
  }

  // "Viajes" (el nombre exacto, o la primera palabra: "Representación")
  const n = norm(t);
  for (const c of categories) {
    if (norm(c.nombre) === n) return c;
    const primera = norm(c.nombre.split(/[\/ ]/)[0]);
    if (primera.length >= 4 && primera === n) return c;
  }

  // "no, es Viajes" / "mejor Representación" / "cambiala a Otros" / "ponelo en Viajes"
  // (las palabras cortas piden \b para no pegar dentro de otra; los verbos van por
  // raíz, porque se conjugan: "cambiala", "corregila", "ponelo".)
  if (/^(no|nop|negativo|mejor)\b/i.test(t) || /^(cambi|corregi|corrige|pone|va en |es de |seria)/i.test(t)) {
    return matchCategoria(t, categories);
  }

  return null;
}

/** Usa Haiku para mapear texto libre → categoría, o repreguntar. */
async function classify(
  userText: string,
  brief: InvoiceBrief | null,
  categories: Category[],
  history: Anthropic.MessageParam[],
): Promise<{ categoria: Category | null; mensaje: string }> {
  const lista = categories
    .map((c) => `"${c.nombre}"${c.descripcion ? ` (incluye: ${c.descripcion})` : ''}`)
    .join('; ');
  const ctx = brief
    ? `Factura de ${brief.empresa_emisora} por ${brief.moneda} ${brief.monto} (${brief.company_nombre}).`
    : '';
  const res = await anthropic.messages.create({
    model: config.ANTHROPIC_MODEL_EXTRACCION, // texto→categoría: Haiku alcanza
    max_tokens: 300,
    system:
      `Estás ayudando a clasificar un gasto en UNA categoría. ${ctx}\n` +
      `Categorías válidas (usá el nombre EXACTO): ${lista}.\n` +
      `Devolvé SOLO un JSON: {"categoria": "<nombre exacto o null>", "mensaje": "<respuesta breve>"}.\n` +
      `Si el usuario indica claramente una categoría, poné su nombre exacto y un mensaje de confirmación corto.\n` +
      `Si es ambiguo, categoria=null y mensaje = una repregunta de una línea pidiendo que elija una de la lista.`,
    messages: [...history, { role: 'user', content: userText }],
  });
  const text = res.content
    .filter((b): b is Anthropic.TextBlock => b.type === 'text')
    .map((b) => b.text)
    .join('');
  let parsed: { categoria?: string | null; mensaje?: string } = {};
  try {
    const s = text.indexOf('{');
    const e = text.lastIndexOf('}');
    if (s >= 0 && e > s) parsed = JSON.parse(text.substring(s, e + 1));
  } catch (_) {}
  const cat = parsed.categoria ? matchCategoria(parsed.categoria, categories) : null;
  return { categoria: cat, mensaje: parsed.mensaje || 'No te entendí. ¿En qué categoría va?' };
}

/**
 * Procesa una respuesta de WhatsApp cuando hay una factura esperando categoría.
 * Devuelve el texto a responder. Si confirma, completa la factura y avanza la cola.
 */
export async function handleCompletionReply(
  phone: string,
  userText: string,
  session: WaSession,
  categories: Category[],
): Promise<string> {
  const invoiceId = session.draft_invoice_id!;
  const brief = await getBrief(invoiceId);

  // 0) Ya elegimos categoría y falta la descripción. Ojo: el empleado puede estar
  //    CORRIGIENDO la categoría en vez de describir ("no, mejor Viajes", "2").
  //    Sólo lo tomamos como corrección si es inequívoco (ver esCorreccionCategoria):
  //    una descripción legítima como "viaje a Punta del Este" no debe confundirse.
  const catPendiente = session.pending?.categoria_pendiente;
  if (catPendiente) {
    const desc = (userText ?? '').trim();

    const correccion = esCorreccionCategoria(desc, categories);
    if (correccion && correccion.nombre !== catPendiente) {
      if (CATEGORIAS_DESCRIPCION_OBLIGATORIA.has(correccion.nombre)) {
        await saveSession({
          ...session,
          pending: { ...session.pending!, categoria_pendiente: correccion.nombre },
        });
        console.log(`[completar] ${invoiceId}: categoría corregida a ${correccion.nombre}, pido descripción`);
        return `Cambio hecho: *${correccion.nombre}*. Para esa categoría necesito una descripción breve del gasto: ¿qué pongo?`;
      }
      console.log(`[completar] ${invoiceId}: categoría corregida a ${correccion.nombre} (sin descripción obligatoria)`);
      return await completarFactura(phone, invoiceId, correccion, null, brief, session, categories);
    }

    const cat = categories.find((c) => c.nombre === catPendiente);
    if (cat && desc) {
      return await completarFactura(phone, invoiceId, cat, desc, brief, session, categories);
    }
    return `Necesito una descripción breve del gasto para la categoría *${catPendiente}*. ¿Qué pongo?`;
  }

  // 1) match directo, si no Haiku
  let cat = matchCategoria(userText, categories);
  let mensaje = '';
  if (!cat) {
    const r = await classify(userText, brief, categories, session.history ?? []);
    cat = r.categoria;
    mensaje = r.mensaje;
  }

  // 2) no resolvió → repregunta, guarda historial
  if (!cat) {
    const history: Anthropic.MessageParam[] = [
      ...(session.history ?? []),
      { role: 'user' as const, content: userText },
      { role: 'assistant' as const, content: mensaje },
    ].slice(-10);
    await saveSession({ ...session, history });
    return mensaje;
  }

  // 3) resolvió la categoría, pero si exige descripción no podemos cerrar todavía.
  if (CATEGORIAS_DESCRIPCION_OBLIGATORIA.has(cat.nombre)) {
    await saveSession({
      ...session,
      pending: {
        archivo_url: session.pending?.archivo_url ?? null,
        ocr: session.pending?.ocr ?? '',
        cola_facturas: session.pending?.cola_facturas ?? [],
        categoria_pendiente: cat.nombre,
      },
    });
    console.log(`[completar] ${invoiceId} → ${cat.nombre}: pido descripción a ${phone}`);
    return `Anoté *${cat.nombre}*. Para esa categoría necesito una descripción breve del gasto: ¿qué pongo?`;
  }

  return await completarFactura(phone, invoiceId, cat, null, brief, session, categories);
}

/** Escribe la categoría (y descripción) en la factura y avanza la cola de mails. */
async function completarFactura(
  phone: string,
  invoiceId: string,
  cat: Category,
  descripcion: string | null,
  brief: InvoiceBrief | null,
  session: WaSession,
  categories: Category[],
): Promise<string> {
  const { data: inv } = await supabase
    .from('invoices')
    .select('datos_extra')
    .eq('id', invoiceId)
    .maybeSingle();
  const datosExtra = ((inv as any)?.datos_extra) || {};
  datosExtra.flujo = { ...(datosExtra.flujo || {}), estado: 'completado', completado_at: new Date().toISOString() };
  if (descripcion) datosExtra.descripcion = descripcion;

  const { error } = await supabase
    .from('invoices')
    .update({ categoria_id: cat.id, estado_conciliacion: 'pendiente', datos_extra: datosExtra })
    .eq('id', invoiceId);

  if (error) {
    console.error('[completar] error actualizando factura ' + invoiceId + ':', error);
    return 'Perdón, tuve un problema técnico y no pude guardar la categoría. ¿Podés reintentar en un momento?';
  }

  let reply = `✅ Registrado: ${brief?.empresa_emisora ?? 'factura'}` +
    (brief?.monto != null ? `, ${brief.moneda} ${brief.monto}` : '') +
    `, *${cat.nombre}*.`;

  // Avanza la cola de facturas de mail esperando categoría.
  const cola = [...(session.pending?.cola_facturas ?? [])];
  if (cola.length > 0) {
    const next = cola.shift()!;
    await saveSession({
      phone,
      company_id: null,
      history: [],
      draft_invoice_id: next,
      pending: { archivo_url: null, ocr: '', cola_facturas: cola },
    });
    reply += `\n\n` + (await buildQuestion(next, categories));
  } else {
    await clearSession(phone);
  }
  return reply;
}

/**
 * Cierra la ventana de una foto ya resuelta. Si mientras se procesaba la foto
 * había facturas de mail esperando categoría (guardadas en `cola_facturas`),
 * retoma esa conversación en vez de cerrar.
 *
 * Antes esto se hacía pisando la sesión de la foto apenas llegaba: la foto se
 * perdía y el "sí" del empleado terminaba aplicándose a la factura del mail.
 */
export async function cerrarOReanudarMail(
  phone: string,
  colaFacturas: string[] | undefined,
  categories: Category[],
): Promise<void> {
  const cola = [...(colaFacturas ?? [])];
  if (cola.length === 0) {
    await clearSession(phone);
    return;
  }
  const next = cola.shift()!;
  await saveSession({
    phone,
    company_id: null,
    history: [],
    draft_invoice_id: next,
    pending: { archivo_url: null, ocr: '', cola_facturas: cola },
  });
  await sendQuestion(next, phone, categories);
  console.log(`[completar] retomada pregunta de mail pendiente para ${phone} (${cola.length} más en cola)`);
}

const RECORDATORIO_HORAS = 2;
const AUTOCATEGORIZAR_HORAS = 24;

function bucket(m: Map<string, any[]>, key: string, value: any): void {
  const arr = m.get(key);
  if (arr) arr.push(value);
  else m.set(key, [value]);
}

/**
 * Barrido de facturas de mail sin categorizar (estado 'esperando_info'), igual
 * que el de WhatsApp: recordatorio a las 2h y auto-categorización a las 24h.
 * Agrupa por teléfono → un solo mensaje por persona (no uno por factura).
 */
export async function sweepTimeouts(): Promise<void> {
  const { data } = await supabase
    .from('invoices')
    .select('id, empresa_emisora, monto, moneda, datos_extra')
    // 'sin_contacto' = llegó por mail de un remitente que no está en SENDERS, así
    // que no hubo a quién preguntarle la categoría. Antes esas facturas no las
    // barría nadie y quedaban SIN CATEGORÍA para siempre (y así se colaban al
    // paquete del cierre). Ahora entran al mismo ciclo: se auto-categorizan a las
    // 24h. Como no tienen consulta_phone, caen en autocatSinPhone (sin aviso).
    .in('datos_extra->flujo->>estado', ['esperando_info', 'sin_contacto']);
  if (!data?.length) return;

  const now = Date.now();
  const recordar = new Map<string, any[]>(); // phone → facturas para recordar (2-24h)
  const autocat = new Map<string, any[]>(); // phone → facturas a auto-categorizar (>24h)
  const autocatSinPhone: any[] = [];

  for (const row of data as any[]) {
    const flujo = row.datos_extra?.flujo || {};
    const at = flujo.consulta_at;
    if (!at) continue;
    const horas = (now - new Date(at).getTime()) / 3_600_000;
    const phone: string | undefined = flujo.consulta_phone;

    if (horas >= AUTOCATEGORIZAR_HORAS) {
      if (phone) bucket(autocat, phone, row);
      else autocatSinPhone.push(row);
    } else if (horas >= RECORDATORIO_HORAS && !flujo.recordatorio_enviado && phone) {
      bucket(recordar, phone, row);
    }
  }

  const hayAutocat = autocat.size > 0 || autocatSinPhone.length > 0;
  const categories = hayAutocat ? await getCategories() : [];

  // ── Auto-categorizar (>24h): actualiza cada factura, un solo aviso por teléfono
  for (const [phone, lista] of autocat) {
    const detalles = [];
    for (const row of lista) detalles.push(await aplicarAutocat(row, categories));
    if (lista.length === 1) {
      const d = detalles[0];
      await sendText(
        phone,
        `⏰ No recibí la categoría a tiempo, así que registré la factura de ${d.empresa}${d.montoTxt} con la categoría *${d.categoria}*.\n\nSi está mal, avisale a administración para corregirla.`,
      ).catch((e) => console.error('[completar] error aviso auto-cat:', e));
    } else {
      await sendText(
        phone,
        `⏰ No recibí respuesta a tiempo, así que registré automáticamente *${lista.length} facturas* con la categoría que estimé. Revisalas con administración por las dudas.`,
      ).catch((e) => console.error('[completar] error aviso auto-cat:', e));
    }
    console.log(`[completar] auto-categorizadas ${lista.length} para ${phone}`);
  }
  for (const row of autocatSinPhone) await aplicarAutocat(row, categories);

  // ── Recordatorios (2-24h): marca todas, un solo mensaje por teléfono
  for (const [phone, lista] of recordar) {
    for (const row of lista) {
      const de = row.datos_extra || {};
      de.flujo = { ...(de.flujo || {}), recordatorio_enviado: true };
      await supabase.from('invoices').update({ datos_extra: de }).eq('id', row.id);
    }
    const msg =
      lista.length === 1
        ? `⏰ Todavía tenés una factura sin categorizar (${lista[0].empresa_emisora}${lista[0].monto ? `, ${lista[0].moneda} ${lista[0].monto}` : ''}). Respondeme con la categoría — si no, en 24 horas la registro con la categoría que estimé.`
        : `⏰ Tenés *${lista.length} facturas* sin categorizar esperando tu respuesta. Respondé cada una con su categoría — si no, en 24 horas las registro con la categoría que estimé.`;
    await sendText(phone, msg).catch((e) => console.error('[completar] error recordatorio:', e));
    console.log(`[completar] recordatorio (${lista.length}) enviado a ${phone}`);
  }
}

/** Asigna categoría automática (la sugerida, o 'Otros') a una factura. Devuelve datos para el aviso. */
async function aplicarAutocat(
  row: any,
  categories: Category[],
): Promise<{ empresa: string; montoTxt: string; categoria: string }> {
  const flujo = row.datos_extra?.flujo || {};
  const sug: string | null = flujo.sugerencia ?? null;
  const categoria =
    (sug && categories.find((c) => c.nombre.toLowerCase() === sug.toLowerCase())) ||
    categories.find((c) => c.nombre === 'Otros') ||
    null;

  const de = row.datos_extra || {};
  de.flujo = {
    ...flujo,
    estado: 'auto_categorizado',
    motivo: 'sin_respuesta_24h',
    categorizado_at: new Date().toISOString(),
  };
  await supabase
    .from('invoices')
    .update({ categoria_id: categoria?.id ?? null, datos_extra: de })
    .eq('id', row.id);

  console.log(`[completar] auto-categorizada factura ${row.id} → ${categoria?.nombre ?? 'Otros'}`);
  return {
    empresa: row.empresa_emisora,
    montoTxt: row.monto ? `, ${row.moneda} ${row.monto}` : '',
    categoria: categoria?.nombre ?? 'Otros',
  };
}
