import express from 'express';
import { config } from './config.js';
import { normalizeJid, downloadMediaBase64, sendText } from './lib/evolution.js';
import {
  getEmployeeByPhone,
  getCategories,
  loadSession,
  saveSession,
  clearSession,
  uploadFactura,
  type WaPending,
} from './lib/supabase.js';
import { ocr } from './lib/mistral.js';
import { runAgent } from './agent.js';

const app = express();
app.use(express.json({ limit: '25mb' }));

app.get('/', (_req, res) => {
  res.send('Domus bot OK');
});

app.post('/webhook', (req, res) => {
  // Token opcional para validar el origen
  if (config.WEBHOOK_TOKEN && req.query.token !== config.WEBHOOK_TOKEN) {
    res.sendStatus(401);
    return;
  }
  res.sendStatus(200); // ack rápido; procesamos en segundo plano
  handleEvent(req.body).catch((e) => console.error('handleEvent error:', e));
});

interface ParsedMsg {
  phone: string;
  fromMe: boolean;
  type: string;
  text: string;
  mime?: string;
  rawMessage: unknown;
}

function parseEvent(body: any): ParsedMsg | null {
  const data = body?.data ?? body;
  const msg = Array.isArray(data?.messages) ? data.messages[0] : data;
  if (!msg?.key) return null;
  const m = msg.message ?? {};
  const type = Object.keys(m)[0] ?? 'unknown';
  const text =
    m.conversation ??
    m.extendedTextMessage?.text ??
    m.imageMessage?.caption ??
    m.documentMessage?.caption ??
    '';
  const mime = m.imageMessage?.mimetype ?? m.documentMessage?.mimetype;
  return {
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

  const [categories, session] = await Promise.all([
    getCategories(),
    loadSession(parsed.phone),
  ]);

  // Contexto de la ventana (archivo + OCR) que persiste entre mensajes.
  let pending: WaPending | null = isMedia ? null : (session?.pending ?? null);
  let archivoUrl: string | null = pending?.archivo_url ?? null;
  let windowOcr: string = pending?.ocr ?? '';
  let ocrText = ''; // OCR de ESTE mensaje (sólo en fotos)

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
    pending = { archivo_url: archivoUrl, ocr: ocrText };
  } else if (!parsed.text) {
    await sendText(parsed.phone, 'Mandame una *foto* del ticket o factura para registrar el gasto 📸');
    return;
  }

  console.log('[msg] ' + parsed.phone + ' type=' + parsed.type + ' media=' + isMedia + ' ocr=' + ocrText.length + 'c');

  // Una foto abre una "ventana" nueva (contexto limpio). El texto continúa la ventana actual.
  const windowHistory = isMedia ? [] : (session?.history ?? []);
  const { reply, newHistory, saved } = await runAgent({
    employee,
    phone: parsed.phone,
    categories,
    history: windowHistory,
    userText: parsed.text,
    ocrText,
    windowOcr,
    archivoUrl,
    hasImage: isMedia,
  });

  await sendText(parsed.phone, reply);
  console.log('[reply] ' + parsed.phone + ': ' + reply.slice(0, 80));

  if (saved) {
    // Se guardó la factura → cerrar la ventana (borrar el contexto).
    await clearSession(parsed.phone);
    console.log('[window] cerrada tras guardar: ' + parsed.phone);
  } else {
    await saveSession({
      phone: parsed.phone,
      company_id: employee.company_id,
      history: newHistory,
      draft_invoice_id: null,
      pending,
    });
  }
}

app.listen(config.PORT, () => {
  console.log(`Domus bot escuchando en :${config.PORT}`);
});
