import express from 'express';
import { config } from './config.js';
import { normalizeJid, downloadMediaBase64, sendText, sendTextSafe } from './lib/evolution.js';
import { logInteraction } from './lib/interactions.js';
import { withPhoneLock } from './lib/lock.js';
import {
  getEmployeeByPhone,
  getCategories,
  getCompanyById,
  getCompaniesElegibles,
  loadSession,
  saveSession,
  uploadFactura,
  NO_IDENTIFICADO_ID,
  type WaPending,
  type WaMediaItem,
  type Company,
} from './lib/supabase.js';
import { ocr } from './lib/mistral.js';
import { runAgent } from './agent.js';
import { initEmailPoller, extractWithHaiku, resolveCompany } from './email-processor.js';
import { handleCompletionReply, cerrarOReanudarMail } from './completion.js';
import { isAdminPhone } from './admins.js';
import { runQueuedPhoto, initWhatsappDraftSweep } from './whatsapp-drafts.js';
import { initVigilante } from './vigilante.js';
import { initCierrePoller } from './lib/cierre.js';
import { alertar } from './lib/alertas.js';

const app = express();
app.use(express.json({ limit: '25mb' }));

app.get('/', (_req, res) => {
  res.send('Domus bot OK');
});

app.post('/webhook', (req, res) => {
  if (config.WEBHOOK_TOKEN && req.query.token !== config.WEBHOOK_TOKEN) {
    res.sendStatus(401);
    return;
  }
  res.sendStatus(200);
  const phone = parseEvent(req.body)?.phone;
  const job = phone
    ? withPhoneLock(phone, () => handleEvent(req.body))
    : handleEvent(req.body);
  job.catch((e) => {
    console.error('handleEvent error:', e);
    void alertar('procesando un mensaje de WhatsApp', e, { telefono: phone ?? '?' });
  });
});

interface ParsedMsg {
  id: string;
  phone: string;
  fromMe: boolean;
  type: string;
  text: string;
  mime?: string;
  rawMessage: unknown;
}

/**
 * Anti-reproceso: si Evolution reintenga el webhook (blip de red, timeout), el
 * mismo mensaje llegaría dos veces y se procesaría dos veces — dos OCR, dos
 * uploads y una foto repetida en la cola. Recordamos los IDs ya vistos.
 * Cota simple: al llegar al tope, se descarta la mitad más vieja (los IDs viejos
 * ya no se reintentan).
 */
const MAX_VISTOS = 2000;
const mensajesVistos = new Set<string>();
function yaProcesado(id: string): boolean {
  if (!id) return false;
  if (mensajesVistos.has(id)) return true;
  if (mensajesVistos.size >= MAX_VISTOS) {
    for (const viejo of [...mensajesVistos].slice(0, Math.floor(MAX_VISTOS / 2))) {
      mensajesVistos.delete(viejo);
    }
  }
  mensajesVistos.add(id);
  return false;
}

/**
 * WhatsApp envuelve el mensaje real cuando es efímero, "ver una vez" o un
 * documento con caption. Sin desenvolver, la foto de adentro no se ve.
 */
function unwrapMessage(m: any): any {
  let cur = m ?? {};
  for (let i = 0; i < 4; i++) {
    const inner =
      cur.ephemeralMessage?.message ??
      cur.viewOnceMessage?.message ??
      cur.viewOnceMessageV2?.message ??
      cur.viewOnceMessageV2Extension?.message ??
      cur.documentWithCaptionMessage?.message;
    if (!inner) break;
    cur = inner;
  }
  return cur;
}

/**
 * Tipo real del mensaje. NO se puede usar Object.keys(m)[0]: WhatsApp suele
 * anteponer metadata (messageContextInfo), y entonces una foto se tomaba como
 * texto y nunca se le hacía OCR.
 */
function detectType(m: any): string {
  if (m.imageMessage) return 'imageMessage';
  if (m.documentMessage) return 'documentMessage';
  if (m.audioMessage) return 'audioMessage';
  if (m.videoMessage) return 'videoMessage';
  if (m.stickerMessage) return 'stickerMessage';
  if (m.conversation) return 'conversation';
  if (m.extendedTextMessage) return 'extendedTextMessage';
  const keys = Object.keys(m).filter(
    (k) => k !== 'messageContextInfo' && k !== 'senderKeyDistributionMessage',
  );
  return keys[0] ?? 'unknown';
}

function parseEvent(body: any): ParsedMsg | null {
  const data = body?.data ?? body;
  const msg = Array.isArray(data?.messages) ? data.messages[0] : data;
  if (!msg?.key) return null;
  const m = unwrapMessage(msg.message);
  const type = detectType(m);
  const text =
    m.conversation ??
    m.extendedTextMessage?.text ??
    m.imageMessage?.caption ??
    m.documentMessage?.caption ??
    '';
  const mime = m.imageMessage?.mimetype ?? m.documentMessage?.mimetype;
  return {
    id: msg.key.id ?? '',
    phone: normalizeJid(msg.key.remoteJid ?? ''),
    fromMe: Boolean(msg.key.fromMe),
    type,
    text,
    mime,
    rawMessage: msg,
  };
}

async function handleEvent(body: any): Promise<void> {
  const parsed = parseEvent(body);
  if (!parsed || parsed.fromMe || !parsed.phone) return;

  if (yaProcesado(parsed.id)) {
    console.log('[webhook] mensaje repetido ignorado: ' + parsed.id);
    return;
  }

  const esFoto = parsed.type === 'imageMessage' || parsed.type === 'documentMessage';
  void logInteraction({
    direction: 'in',
    channel: 'whatsapp',
    contact: parsed.phone,
    kind: esFoto ? 'foto' : 'texto',
    meta: { admin: isAdminPhone(parsed.phone) },
  });

  console.log('[auth] phone recibido:', parsed.phone);
  const employee = await getEmployeeByPhone(parsed.phone);
  if (!employee) {
    await sendText(
      parsed.phone,
      'Este número no está autorizado para registrar gastos. Contactá a administración.',
    );
    return;
  }

  const isMedia = parsed.type === 'imageMessage' || parsed.type === 'documentMessage';
  const esAdmin = isAdminPhone(parsed.phone);

  const [categories, session] = await Promise.all([
    getCategories(),
    loadSession(parsed.phone),
  ]);

  // ── Modo COMPLETAR factura (esperando categoría desde un mail) ──────────────
  const enModoCompletar = Boolean(session?.draft_invoice_id);

  if (enModoCompletar && !isMedia && parsed.text) {
    const reply = await handleCompletionReply(parsed.phone, parsed.text, session!, categories);
    await sendText(parsed.phone, reply);
    console.log('[completar] respuesta a ' + parsed.phone + ': ' + reply.slice(0, 80));
    return;
  }

  // Si llega una FOTO mientras hay una factura de mail esperando categoría: la
  // foto (gasto nuevo) tiene prioridad, pero la pregunta del mail NO se pierde:
  // la guardamos en `cola_facturas` de la sesión de la foto y se retoma sola
  // cuando la foto queda resuelta (ver cerrarOReanudarMail).
  const mailEnEspera: string[] = enModoCompletar && isMedia
    ? [session!.draft_invoice_id as string, ...(session!.pending?.cola_facturas ?? [])]
    : [];

  let pending: WaPending | null = isMedia ? null : (session?.pending ?? null);
  let archivoUrl: string | null = pending?.archivo_url ?? null;
  let windowOcr: string = pending?.ocr ?? '';
  let ocrText = '';
  let companyId = employee.company_id;
  let companyNombre = employee.company_nombre;
  let empresaDesconocida = false;
  let companiesElegibles: Company[] = [];

  if (isMedia) {
    const base64 = await downloadMediaBase64(parsed.rawMessage);
    if (base64) {
      try {
        ocrText = await ocr(base64, parsed.mime ?? 'image/jpeg');
      } catch (e) {
        console.error('OCR error:', e);
        ocrText = '';
      }
      archivoUrl = await uploadFactura(base64, parsed.mime, employee.company_id);
    }
    windowOcr = ocrText;

    // Empresa de ESTA foto. Empleado: la suya. Admin: sale de la factura.
    // Si no se puede deducir, se le pregunta al admin: nunca la mandamos a
    // "No Identificado" en silencio, ni la imputamos a la empresa del admin.
    if (esAdmin && ocrText) {
      try {
        const inv = await extractWithHaiku(ocrText, categories);
        const c = await resolveCompany({
          rut_receptor: inv.rut_receptor,
          empresa_receptor: inv.empresa_receptor,
          email_receptor: inv.email_receptor,
        });
        companyId = c.id;
        companyNombre = c.nombre;
        console.log(`[admin] empresa de la factura: ${c.nombre} (${c.via})`);
      } catch (e) {
        // Si falla la resolución NO podemos asumir la empresa del admin (imputaría
        // el gasto a la empresa equivocada, en silencio): la marcamos como
        // desconocida y más abajo se le pregunta.
        console.error('[admin] no pude resolver empresa de la factura:', e);
        companyId = NO_IDENTIFICADO_ID;
        companyNombre = 'No Identificado';
      }
    }

    // Si ya hay una factura esperando respuesta, encolar esta foto (una por una).
    if (!enModoCompletar && session?.pending?.archivo_url) {
      const cola: WaMediaItem[] = [
        ...(session.pending.cola_media ?? []),
        { archivo_url: archivoUrl, ocr: ocrText, company_id: companyId, company_nombre: companyNombre },
      ];
      await saveSession({ ...session, pending: { ...session.pending, cola_media: cola } });
      const posActual = session.pending.lote_pos ?? 1;
      await sendText(
        parsed.phone,
        `📥 Recibida (van ${posActual + cola.length} facturas). Las registro de a una: seguimos con la *factura ${posActual}* y después voy con las demás.`,
      );
      console.log('[cola-media] encolada para ' + parsed.phone + ' (cola=' + cola.length + ')');
      return;
    }

    pending = {
      archivo_url: archivoUrl,
      ocr: ocrText,
      recibido_at: new Date().toISOString(),
      lote_pos: 1,
      // Si había una pregunta de mail abierta, viaja con la foto para retomarse
      // apenas ésta se resuelva.
      ...(mailEnEspera.length ? { cola_facturas: mailEnEspera } : {}),
    };
  } else if (!parsed.text) {
    await sendText(parsed.phone, 'Mandame una *foto* del ticket o factura para registrar el gasto 📸');
    return;
  } else if (esAdmin && session?.company_id) {
    // Follow-up de texto de un admin: mantener la empresa de la conversación.
    const c = await getCompanyById(session.company_id);
    if (c) {
      companyId = c.id;
      companyNombre = c.nombre;
    }
  }

  // ¿Hay que preguntarle la empresa al admin? Se deriva del company_id resuelto,
  // así vale igual en el turno de la foto y en el de texto donde él la responde
  // (ahí el company_id viene de la sesión, que quedó en "No Identificado").
  empresaDesconocida = esAdmin && companyId === NO_IDENTIFICADO_ID;
  if (empresaDesconocida) {
    companiesElegibles = await getCompaniesElegibles();
    console.log('[admin] empresa sin identificar → se le pregunta al admin');
  }

  console.log('[msg] ' + parsed.phone + ' type=' + parsed.type + ' media=' + isMedia + ' admin=' + esAdmin + ' empresa=' + companyNombre);

  const employeeForAgent = { ...employee, company_id: companyId, company_nombre: companyNombre };

  // Fotos de WhatsApp que quedaron en cola (sólo en turnos de texto de seguimiento).
  const colaMedia: WaMediaItem[] =
    !isMedia && session?.pending?.cola_media ? session.pending.cola_media : [];

  const lotePos = pending?.lote_pos ?? session?.pending?.lote_pos ?? 1;

  // Facturas de mail esperando categoría que viajan con esta ventana.
  const colaFacturas = mailEnEspera.length
    ? mailEnEspera
    : (pending?.cola_facturas ?? session?.pending?.cola_facturas ?? []);

  const windowHistory = isMedia ? [] : (session?.history ?? []);
  const { reply, newHistory, saved, duplicado } = await runAgent({
    employee: employeeForAgent,
    phone: parsed.phone,
    categories,
    history: windowHistory,
    userText: parsed.text,
    ocrText,
    windowOcr,
    archivoUrl,
    hasImage: isMedia,
    colaPendiente: colaMedia.length,
    lotePos,
    empresaDesconocida,
    companiesElegibles,
  });

  // Safe: si Evolution está caído no queremos perder el estado (la factura ya
  // pudo quedar guardada). Avisar es secundario; persistir es lo crítico.
  await sendTextSafe(parsed.phone, reply);
  console.log('[reply] ' + parsed.phone + ': ' + reply.slice(0, 80));

  // Una factura duplicada también está RESUELTA: no hay nada más que hacer con
  // ella. Si sólo avanzáramos con `saved`, la cola quedaba trabada hasta el
  // barrido de las 24h, repreguntando por una factura ya registrada.
  const resuelto = saved || duplicado;

  if (resuelto) {
    if (colaMedia.length > 0) {
      console.log('[cola-media] avanzo: ' + colaMedia.length + ' en cola para ' + parsed.phone);
      await runQueuedPhoto(
        parsed.phone, employee, categories, colaMedia[0], colaMedia.slice(1), lotePos + 1, colaFacturas,
        // el lote conserva su vencimiento original (no se reinicia por foto)
        session?.pending?.recibido_at,
      );
    } else {
      await cerrarOReanudarMail(parsed.phone, colaFacturas, categories);
      console.log('[window] cerrada tras resolver: ' + parsed.phone);
    }
  } else {
    await saveSession({
      phone: parsed.phone,
      company_id: companyId,
      history: newHistory,
      draft_invoice_id: null,
      pending: pending
        ? { ...pending, cola_media: colaMedia, ...(colaFacturas.length ? { cola_facturas: colaFacturas } : {}) }
        : pending,
    });
  }
}

app.listen(config.PORT, () => {
  console.log(`Domus bot escuchando en :${config.PORT}`);
  initEmailPoller();
  initCierrePoller();
  initWhatsappDraftSweep();
  initVigilante();
});
