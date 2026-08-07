import Anthropic from '@anthropic-ai/sdk';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';
import { GmailClient } from './lib/gmail.js';
import { ocr } from './lib/mistral.js';
import { sendText } from './lib/evolution.js';
import { logInteraction } from './lib/interactions.js';
import { supabase, getCategories, type Category } from './lib/supabase.js';
import { enqueueQuestion, sweepTimeouts } from './completion.js';
import { isAdminEmail } from './admins.js';
import { dedupeHash, existeDuplicado } from './tools/guardar.js';
import { alertar } from './lib/alertas.js';

const anthropic = new Anthropic({ apiKey: config.ANTHROPIC_API_KEY });

function fechaHoyUY(): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Montevideo' }).format(new Date());
}

// ── Mapeo email remitente → teléfono de WhatsApp a consultar ─────────────────
// Cuando una factura no trae categoría en el mail, se le pregunta por WhatsApp
// a la persona asociada a este email.
const SENDERS_FILE = path.join(process.env.CIERRE_DATA_DIR || '/app/data', 'remitentes.json');

/**
 * Mapa mail → teléfono de quien reporta el gasto.
 *
 * Vive FUERA del código (en `data/`, que no se versiona) porque son mails
 * corporativos y celulares personales, y el repo es público. Ver
 * `remitentes.example.json` para el formato.
 *
 * Si el archivo falta, el bot arranca igual pero no puede atribuir las facturas
 * que llegan por mail: quedan en 'sin_contacto' y nadie las completa. Es una
 * falla silenciosa, así que además de loguear se avisa a los devs.
 */
function cargarRemitentes(): Record<string, string> {
  try {
    const mapa = JSON.parse(fs.readFileSync(SENDERS_FILE, 'utf8')) as Record<string, string>;
    console.log('[email] ' + Object.keys(mapa).length + ' remitentes conocidos cargados');
    return mapa;
  } catch (e) {
    console.error('[email] no pude leer ' + SENDERS_FILE + ':', (e as Error).message);
    void alertar('carga de remitentes conocidos', e, { archivo: SENDERS_FILE });
    return {};
  }
}

const SENDERS: Record<string, string> = cargarRemitentes();

// Remitentes cuyas facturas se guardan SIN preguntar categoría (no hay a quién preguntarle;
// ej. casillas de administración de una empresa). Se usa la categoría sugerida por el LLM.
const AUTO_SENDERS_FILE = path.join(process.env.CIERRE_DATA_DIR || '/app/data', 'remitentes_auto.json');
function cargarAutoRemitentes(): Set<string> {
  try {
    const arr = JSON.parse(fs.readFileSync(AUTO_SENDERS_FILE, 'utf8')) as string[];
    console.log('[email] ' + arr.length + ' remitentes auto (guardan sin preguntar) cargados');
    return new Set(arr.map((x) => x.toLowerCase()));
  } catch {
    return new Set();
  }
}
const AUTO_SENDERS: Set<string> = cargarAutoRemitentes();

/** Extrae el email del header From: "Nombre <mail@x.com>" → "mail@x.com" */
function extractSenderEmail(from: string): string | null {
  const m = (from || '').match(/<([^>]+)>/) || (from || '').match(/([^\s<>]+@[^\s<>]+)/);
  return m ? m[1].toLowerCase().trim() : null;
}

/** Busca una categoría nombrada en el asunto o cuerpo del mail. */
function detectCategoryInEmail(
  subject: string,
  body: string,
  categories: Category[],
): Category | null {
  const hay = (subject + ' ' + body)
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '');
  for (const c of categories) {
    const full = c.nombre.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
    const first = full.split(/[\/ ]/)[0];
    if ((full.length >= 4 && hay.includes(full)) || (first.length >= 4 && hay.includes(first))) {
      return c;
    }
  }
  return null;
}

const NO_ID_COMPANY = '9ecf5160-11f5-434e-945f-38078d0076bf';

// ── Diccionario de empresas del holding ──────────────────────────────────────
// Fuente de verdad para identificar a qué empresa pertenece cada factura.
// aliases: tokens distintivos (marca comercial + nombre legal) que pueden
// aparecer en el nombre del receptor o en el email. Normalizados (minúscula, sin
// acentos ni símbolos).
interface CompanyDict {
  id: string;
  nombre: string;
  rut: string;
  dominios: string[];
  aliases: string[];
}

const COMPANIES: CompanyDict[] = [
  { id: 'e9a6fb3a-1cad-4b61-ba1a-004be879294b', nombre: 'NUBLIT SA',            rut: '216943400014', dominios: ['nublit.com'],                  aliases: ['nublit'] },
  { id: '85ffbf22-ba77-4c58-a1f8-f096948a583e', nombre: 'UDISEL SA',            rut: '219746900019', dominios: [],                            aliases: ['udisel'] },
  { id: '229375ce-363f-4ba2-9f55-e1a04cb80395', nombre: 'GARFORTIN SA',         rut: '218234170013', dominios: ['thinkupsoft.com'],             aliases: ['garfortin', 'thinkup'] },
  { id: 'a7df3ef6-64a2-432f-8c35-05d32b1e3c6e', nombre: 'FIZEDOL SA',           rut: '218296770014', dominios: ['iugo.com.uy'],                 aliases: ['fizedol', 'iugo'] },
  { id: '8181d7d1-884b-42cd-b76c-d6b5b08a6410', nombre: 'COREFONE SA',          rut: '216517160012', dominios: ['corefone.us', 'corefone.com'], aliases: ['corefone'] },
  { id: '9f99a1fd-9ab9-4591-a3b2-29b6920b22a7', nombre: 'MOSEYA SA',            rut: '218363810019', dominios: ['boomit.com.uy', 'boomit.us'],  aliases: ['moseya', 'boomit'] },
  { id: '4b4103c6-0b06-4e09-b041-6153d676923d', nombre: 'SUNKLAY SA',           rut: '218909060016', dominios: ['hepicmarketing.com'],         aliases: ['sunklay', 'hepic'] },
  { id: '0a724447-151c-4065-8237-3ac0507ab60c', nombre: 'MILBOW SA',            rut: '218902430012', dominios: ['sabyk.com'],                   aliases: ['milbow', 'sabyk'] },
  { id: '099c57f0-9527-4dd7-b2dc-3274dfbcccf5', nombre: 'PPRM SRL',             rut: '217641860010', dominios: ['quintadisciplina.com'],        aliases: ['pprm', 'quintadisciplina'] },
  { id: 'a4d1a229-25cc-4bf9-98e2-1f8669180cf7', nombre: 'QDC TECH SRL',         rut: '219157900014', dominios: ['qdc.com.uy'],                  aliases: ['qdctech', 'qdc'] },
  { id: '51ce9945-8202-4606-ad14-1744eeb96318', nombre: 'GALNUS SA',            rut: '219113300011', dominios: ['delfoslabs.com'],             aliases: ['galnus', 'delfos'] },
  { id: '8b3c7e7e-ddf7-455e-b593-08320d9fe6df', nombre: 'PROINTERNACIONAL SRL', rut: '215904850014', dominios: ['prointernacional.com'],        aliases: ['prointernacional'] },
  { id: '6e9013d0-fd1a-44cc-b360-b7f41d0972a9', nombre: 'PULMANY SA',           rut: '218926630011', dominios: [],                            aliases: ['pulmany'] },
  { id: '836f86ab-ab80-4342-ac34-b4ced50f798a', nombre: 'YALFER SA',            rut: '218902980012', dominios: ['domus.global'],               aliases: ['yalfer'] },
  { id: 'c9aa2792-a88d-42c3-8b8b-48e0844010ac', nombre: 'PELTERS SA',           rut: '219746780013', dominios: [],                            aliases: ['pelters', 'kunko'] },
  { id: 'dcdfed09-f3eb-4b81-9feb-b5f10afa061c', nombre: 'DAINARVIS COMPANY SA', rut: '218278370018', dominios: [],                            aliases: ['dainarvis', 'astroselling'] },
  { id: '773f0859-76a0-4050-b395-70df2eef5671', nombre: 'NOMER COMPANY SA',     rut: '219592220013', dominios: [],                            aliases: ['nomer', 'agrolabs'] },
  { id: 'fa6bfffa-7191-420e-80e8-fc6434dfdd48', nombre: 'GABREY SA',            rut: '220561840013', dominios: [],                            aliases: ['gabrey', 'cerezo'] },
];

// Dominios de correo genéricos que NO sirven para identificar empresa.
const GENERIC_DOMAINS = new Set([
  'gmail.com', 'googlemail.com', 'hotmail.com', 'outlook.com', 'live.com',
  'yahoo.com', 'yahoo.com.ar', 'icloud.com', 'me.com', 'proton.me', 'protonmail.com',
]);

function normalize(s: string): string {
  return (s || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '') // saca acentos
    .replace(/[^a-z0-9]/g, '');      // solo alfanumérico
}

function extractDomain(email: string | null): string | null {
  if (!email) return null;
  const m = email.match(/@([a-z0-9.\-]+)/i);
  if (!m) return null;
  const dom = m[1].toLowerCase().replace(/[.>,;\s]+$/, '');
  return GENERIC_DOMAINS.has(dom) ? null : dom;
}

export let gmail: GmailClient | null = null;

export function initEmailPoller(): void {
  // Barrido de facturas de mail sin categorizar (recordatorio 2h / auto 24h).
  // Corre siempre y con timer propio, independiente de que lleguen mails nuevos.
  sweepTimeouts().catch((e) => console.error('[email] sweep inicial error:', e));
  setInterval(() => {
    sweepTimeouts().catch((e) => { console.error('[email] sweep error:', e); void alertar('barrido de facturas sin categoria', e); });
  }, 10 * 60_000);

  if (
    !config.GMAIL_CLIENT_ID ||
    !config.GMAIL_CLIENT_SECRET ||
    !config.GMAIL_REFRESH_TOKEN
  ) {
    console.log('[email] credenciales Gmail no configuradas, poller desactivado');
    return;
  }
  gmail = new GmailClient(
    config.GMAIL_CLIENT_ID,
    config.GMAIL_CLIENT_SECRET,
    config.GMAIL_REFRESH_TOKEN,
  );
  console.log('[email] poller iniciado (cada 60s)');
  processEmails().catch((e) => { console.error('[email] error inicial:', e); void alertar('poller de email (arranque)', e); });
  setInterval(() => {
    processEmails().catch((e) => { console.error('[email] error en poller:', e); void alertar('poller de email', e); });
  }, 60_000);
}

// ── Procesamiento de todos los emails no leídos ──────────────────────────────

export async function processEmails(): Promise<void> {
  if (!gmail) return;
  const ids = await gmail.listUnreadWithAttachments();
  if (!ids.length) return;
  console.log(`[email] ${ids.length} email(s) sin leer con adjunto`);

  const categories = await getCategories();

  for (const id of ids) {
    try {
      await processMessage(id, categories);
    } catch (e) {
      console.error(`[email] error procesando mensaje ${id}:`, e);
    }
  }
}

// ── Procesamiento de un email ────────────────────────────────────────────────

async function processMessage(messageId: string, categories: Category[]): Promise<void> {
  const msg = await gmail!.getMessage(messageId);
  const from = gmail!.getHeader(msg, 'From');
  const subject = gmail!.getHeader(msg, 'Subject');
  const body = gmail!.getBodyText(msg);
  console.log(`[email] procesando: "${subject}" de ${from}`);
  void logInteraction({
    direction: 'in',
    channel: 'email',
    contact: extractSenderEmail(from) ?? from,
    kind: 'mail',
    meta: { subject },
  });

  const parts = gmail!.getAttachmentParts(msg);
  if (!parts.length) {
    console.log('[email] sin adjuntos válidos, marcando como leído');
    await gmail!.markAsRead(messageId);
    return;
  }

  for (const part of parts) {
    try {
      const mime = part.mimeType.toLowerCase();
      const base64 = await gmail!.downloadAttachment(messageId, part.body.attachmentId!);

      let invoiceData: InvoiceData;

      if (mime.includes('xml') || part.filename.toLowerCase().endsWith('.xml')) {
        const xmlContent = Buffer.from(base64, 'base64').toString('utf-8');
        invoiceData = extractFromXml(xmlContent);
        console.log('[email] XML e-CFE parseado:', invoiceData.empresa_emisora);
      } else {
        const ocrText = await ocr(base64, mime.includes('pdf') ? 'application/pdf' : mime);
        console.log('[email] OCR completado, chars:', ocrText.length);
        invoiceData = await extractWithHaiku(ocrText, categories);
        console.log('[email] Haiku extrajo:', invoiceData.empresa_emisora, invoiceData.monto);
      }

      const company = await findCompany(invoiceData, from, isAdminEmail(extractSenderEmail(from)));
      console.log('[email] empresa:', company.nombre, '(' + company.via + ')');

      const dup = await isDuplicate(invoiceData.rut_emisor, invoiceData.nro_factura, invoiceData.monto);
      if (dup) {
        console.log('[email] duplicado, saltando');
        // Avisar por WhatsApp a quien la mandó
        const senderEmailDup = extractSenderEmail(from);
        const phoneDup = senderEmailDup ? SENDERS[senderEmailDup] : undefined;
        if (phoneDup) {
          const nro = invoiceData.nro_factura ? `N° ${invoiceData.nro_factura}` : '(sin número)';
          const montoTxt = invoiceData.monto ? `${invoiceData.moneda} ${invoiceData.monto}` : '';
          await sendText(
            phoneDup,
            `⚠️ *Factura repetida*\n\n` +
              `La factura ${nro} de *${invoiceData.empresa_emisora}*${montoTxt ? ' por ' + montoTxt : ''} ya había sido registrada antes, así que no la volví a cargar.\n\n` +
              `Si la enviaste por error, ignorá este mensaje. Si creés que es un gasto distinto, verificá con administración.`,
          ).catch((e) => console.error('[email] error avisando duplicado:', e));
          console.log('[email] aviso de duplicado enviado a ' + phoneDup);
        }
        continue;
      }

      const archivePath = await uploadToStorage(base64, mime, company.id);

      // ¿La categoría viene escrita en el asunto/cuerpo del mail?
      const catEmail = detectCategoryInEmail(subject, body, categories);

      if (catEmail) {
        await saveInvoice(invoiceData, company.id, from, archivePath, categories, {
          categoriaName: catEmail.nombre,
        });
        console.log(`[email] ✅ guardada con categoría del mail: ${catEmail.nombre} — ${invoiceData.empresa_emisora}`);
        continue;
      }

      // No hay categoría → buscar el WhatsApp del remitente y preguntarle
      const senderEmail = extractSenderEmail(from);
      const phone = senderEmail ? SENDERS[senderEmail] : undefined;
      const noAsk = senderEmail ? AUTO_SENDERS.has(senderEmail.toLowerCase()) : false;

      if (noAsk) {
        const sug = invoiceData.categoria
          ? categories.find((c) => c.nombre.toLowerCase() === String(invoiceData.categoria).toLowerCase())
          : undefined;
        await saveInvoice(invoiceData, company.id, from, archivePath, categories, {
          categoriaName: sug ? sug.nombre : null,
          flujo: { estado: 'auto_remitente', remitente: senderEmail, consulta_at: new Date().toISOString() },
        });
        console.log(`[email] 📥 remitente auto ${senderEmail} → guardada sin preguntar (categoría: ${sug ? sug.nombre : 'sin categoría'})`);
      } else if (phone) {
        const flujo = {
          estado: 'esperando_info',
          consulta_phone: phone,
          consulta_at: new Date().toISOString(),
          sugerencia: invoiceData.categoria,
        };
        const id = await saveInvoice(invoiceData, company.id, from, archivePath, categories, {
          categoriaName: null,
          flujo,
        });
        if (id) {
          await enqueueQuestion(phone, id, categories);
          console.log(`[email] ⏳ esperando categoría — pregunté a ${phone} (${invoiceData.empresa_emisora})`);
        }
      } else {
        await saveInvoice(invoiceData, company.id, from, archivePath, categories, {
          categoriaName: null,
          flujo: { estado: 'sin_contacto', consulta_at: new Date().toISOString() },
        });
        console.log(`[email] ⚠️ sin WhatsApp asociado a "${senderEmail ?? from}" → pendiente sin categoría`);
      }
    } catch (e) {
      console.error('[email] error en adjunto:', e);
    }
  }

  await gmail!.markAsRead(messageId);
}

// ── Tipos ────────────────────────────────────────────────────────────────────

interface InvoiceData {
  empresa_emisora: string;
  rut_emisor: string | null;
  empresa_receptor: string | null;
  rut_receptor: string | null;
  email_receptor: string | null;
  monto: number;
  moneda: string;
  fecha: string | null;
  nro_factura: string | null;
  categoria: string | null;
  ocr_text?: string;
}

// ── Parseo XML e-CFE ─────────────────────────────────────────────────────────

function getTag(xml: string, tag: string): string {
  const s = xml.indexOf(`<${tag}`);
  if (s < 0) return '';
  const cs = xml.indexOf('>', s) + 1;
  const e = xml.indexOf(`</${tag}>`, cs);
  return e < 0 ? '' : xml.substring(cs, e).trim();
}

function extractFromXml(xml: string): InvoiceData {
  const enc = getTag(xml, 'Encabezado') || xml;
  const em = getTag(enc, 'Emisor');
  const rec = getTag(enc, 'Receptor');
  const tot = getTag(enc, 'Totales');
  const id = getTag(enc, 'IdDoc');

  const fechaRaw = getTag(id, 'FchEmis');
  const montoRaw = parseFloat(getTag(tot, 'MntTotal')) || 0;
  const mon = getTag(tot, 'TpoMoneda');

  return {
    empresa_emisora: getTag(em, 'RznSoc') || 'Desconocido',
    rut_emisor: getTag(em, 'RUTEmisor') || null,
    empresa_receptor: getTag(rec, 'RznSoc') || null,
    rut_receptor: getTag(rec, 'RUTRecep') || null,
    email_receptor: getTag(rec, 'CorreoRecep') || null,
    monto: montoRaw,
    moneda: mon || 'UYU',
    fecha: fechaRaw || null,
    nro_factura: getTag(id, 'NroCFE') || null,
    categoria: null,
  };
}

// ── Extracción con Haiku ─────────────────────────────────────────────────────

export async function extractWithHaiku(ocrText: string, categories: Category[]): Promise<InvoiceData> {
  const catList = categories
    .map((c) => `"${c.nombre}"${c.descripcion ? ` (incluye: ${c.descripcion})` : ''}`)
    .join('; ');
  const res = await anthropic.messages.create({
    model: config.ANTHROPIC_MODEL_EXTRACCION, // OCR→JSON: Haiku alcanza
    max_tokens: 512,
    messages: [
      {
        role: 'user',
        content: `Extraé los datos de esta factura y devolvé SOLO un JSON válido con estos campos:
- empresa_emisora (string): nombre del proveedor que EMITE la factura
- rut_emisor (string|null): RUT del emisor si aparece
- empresa_receptor (string|null): nombre de la empresa que RECIBE la factura (el "Bill to" / "Facturar a")
- rut_receptor (string|null): RUT uruguayo del receptor (12 dígitos). Null si no hay o si es claramente inválido
- email_receptor (string|null): email del receptor / cuenta facturada (el que aparece en el bloque "Bill to" o "Account billed")
- monto (number): el TOTAL FINAL a pagar, con impuestos/IVA incluidos (el importe que se debita en la tarjeta). Tomalo de la línea "TOTAL" / "Total a pagar" / "Importe total". NUNCA el subtotal, el neto, "imp. neto gravado" ni el importe sin IVA. Si hay varios, quedate con el rotulado TOTAL (con descuentos el total es MENOR que el subtotal: no elijas por tamaño).
- moneda (string): "UYU", "USD", "ARS", "EUR", "CLP" o "BRL" según el ticket. Pistas: CUIT / CABA / "Buenos Aires" / "IVA RESPONSABLE INSCRIPTO" / alícuota 21% → "ARS"; RUT uruguayo → "UYU"
- fecha (string|null): fecha en formato YYYY-MM-DD. OJO: un e-Factura/e-Ticket uruguayo (DGI) suele traer VARIAS fechas y no todas son la fecha de la compra. La correcta es "Fecha emisión"/"Fecha de emisión", normalmente en la tabla principal junto a Vencimiento/Moneda/Forma de pago. IGNORÁ cualquier fecha en el pie de verificación DGI cerca de CAE/Serie/Rango/C.S. — ahí puede aparecer "Fecha emisor" (campo distinto, metadata del certificado, NO la fecha de la compra) o "Fecha de vencimiento" (vencimiento del rango de comprobantes, tampoco es la fecha de la compra). Si dudás, priorizá la fecha de la tabla con Vencimiento/Moneda/Forma de pago.
  CONTEXTO: hoy es ${fechaHoyUY()}. Estas facturas llegan casi siempre de los últimos días. Si la fecha que ibas a usar te da muy lejos de hoy (meses o años, pasado o futuro), es señal de que agarraste el campo equivocado — buscá otra fecha en el documento más cercana a hoy — o el OCR malinterpretó un dígito. Ante la duda entre dos fechas candidatas, preferí la más cercana a hoy. No es una regla absoluta: si el documento indica con SU PROPIA etiqueta clara ("Fecha emisión") una fecha de hace algunas semanas, confiá en esa etiqueta igual.
- nro_factura (string|null): número de comprobante
- categoria (string|null): el NOMBRE EXACTO de la más apropiada entre: ${catList}. Usá la guía "(incluye: ...)" para elegir bien (ej.: una comida/almuerzo/restaurante es "Representación"). "Otros" sólo si no encaja en ninguna.

Texto OCR:
${ocrText.slice(0, 4000)}`,
      },
    ],
  });

  const text = res.content
    .filter((b): b is Anthropic.TextBlock => b.type === 'text')
    .map((b) => b.text)
    .join('');

  let extracted: Partial<InvoiceData> = {};
  try {
    const s = text.indexOf('{');
    const e = text.lastIndexOf('}');
    if (s >= 0 && e > s) extracted = JSON.parse(text.substring(s, e + 1));
  } catch (_) {}

  return {
    empresa_emisora: extracted.empresa_emisora || 'Desconocido',
    rut_emisor: extracted.rut_emisor ?? null,
    empresa_receptor: extracted.empresa_receptor ?? null,
    rut_receptor: extracted.rut_receptor ?? null,
    email_receptor: extracted.email_receptor ?? null,
    monto: Number(extracted.monto) || 0,
    moneda: extracted.moneda || 'UYU',
    fecha: extracted.fecha ?? null,
    nro_factura: extracted.nro_factura ?? null,
    categoria: extracted.categoria ?? null,
    ocr_text: ocrText.slice(0, 3000),
  };
}

// ── Búsqueda de empresa (cascada de 4 capas) ─────────────────────────────────

interface CompanyMatch {
  id: string;
  nombre: string;
  via: string;
}

function isValidUyRut(rut: string | null): boolean {
  return !!rut && /^\d{12}$/.test(rut.replace(/\D/g, '')) && rut.replace(/\D/g, '').length === 12;
}

/** Resuelve la empresa de una factura por sus datos (sin remitente). Para WhatsApp admin. */
export async function resolveCompany(inv: {
  rut_receptor: string | null;
  empresa_receptor: string | null;
  email_receptor: string | null;
}): Promise<{ id: string; nombre: string; via: string }> {
  return findCompany(inv as InvoiceData, null, true);
}

async function findCompany(
  inv: InvoiceData,
  senderEmail: string | null,
  esAdmin = false,
): Promise<CompanyMatch> {
  const rut = inv.rut_receptor ? inv.rut_receptor.replace(/\D/g, '') : null;

  // 1. Por RUT válido (12 dígitos) — verdad legal de a quién está facturada
  if (isValidUyRut(rut)) {
    const byRut = COMPANIES.find((c) => c.rut === rut);
    if (byRut) return { id: byRut.id, nombre: byRut.nombre, via: 'RUT' };
    // RUT válido pero no en el diccionario → buscar en DB (empresas nuevas)
    const { data } = await supabase.from('companies').select('id, nombre').eq('rut', rut).maybeSingle();
    if (data) return { id: data.id, nombre: data.nombre, via: 'RUT/db' };
  }

  // 2. Por dominio del REMITENTE (quién reenvía la factura)
  //    Los ADMIN cargan facturas de cualquier empresa → NO se usa su remitente.
  //    Los correos genéricos (gmail, etc.) se ignoran automáticamente.
  if (!esAdmin) {
    const senderDomain = extractDomain(senderEmail);
    if (senderDomain) {
      const bySender = COMPANIES.find((c) => c.dominios.some((d) => senderDomain === d || senderDomain.endsWith('.' + d)));
      if (bySender) {
        await learnRut(bySender.id, rut);
        return { id: bySender.id, nombre: bySender.nombre, via: 'remitente:' + senderDomain };
      }
    }
  }

  // 3. Por dominio de email del receptor (dentro de la factura)
  const domain = extractDomain(inv.email_receptor);
  if (domain) {
    const byDomain = COMPANIES.find((c) => c.dominios.some((d) => domain === d || domain.endsWith('.' + d)));
    if (byDomain) {
      await learnRut(byDomain.id, rut);
      return { id: byDomain.id, nombre: byDomain.nombre, via: 'dominio:' + domain };
    }
  }

  // 4. Por alias (marca/nombre legal) en nombre del receptor o email
  const haystack = normalize((inv.empresa_receptor || '') + ' ' + (inv.email_receptor || ''));
  if (haystack.length >= 3) {
    for (const c of COMPANIES) {
      const hit = c.aliases.find((a) => haystack.includes(a));
      if (hit) {
        await learnRut(c.id, rut);
        return { id: c.id, nombre: c.nombre, via: 'alias:' + hit };
      }
    }
  }

  // 5. Fallback: nombre legal en DB (empresas fuera del diccionario)
  if (inv.empresa_receptor) {
    const term = inv.empresa_receptor.split(/\s+/)[0].replace(/[^a-zA-ZáéíóúñÑ]/g, '');
    if (term.length >= 3) {
      const { data } = await supabase.from('companies').select('id, nombre').ilike('nombre', `%${term}%`).maybeSingle();
      if (data) return { id: data.id, nombre: data.nombre, via: 'nombre/db' };
    }
  }

  return { id: NO_ID_COMPANY, nombre: 'No Identificado', via: 'sin match' };
}

/** Si la empresa no tenía RUT cargado y la factura trae uno válido, lo aprende. */
async function learnRut(companyId: string, rut: string | null): Promise<void> {
  if (!isValidUyRut(rut)) return;
  try {
    const { data } = await supabase.from('companies').select('rut').eq('id', companyId).maybeSingle();
    if (data && !data.rut) {
      await supabase.from('companies').update({ rut }).eq('id', companyId);
      console.log(`[email] RUT aprendido: ${companyId} → ${rut}`);
    }
  } catch (_) {}
}

// ── Deduplicación ────────────────────────────────────────────────────────────

/**
 * Usa el mismo hash que el flujo de WhatsApp (tools/guardar.ts) para que un
 * duplicado se detecte entre canales. Sin clave real (ni RUT ni nº) el hash es
 * null y la factura NO se considera duplicada: antes, dos facturas distintas del
 * mismo importe sin RUT compartían hash y la segunda se descartaba en silencio.
 */
async function isDuplicate(
  rut_emisor: string | null,
  nro_factura: string | null,
  monto: number,
): Promise<boolean> {
  return existeDuplicado(dedupeHash(rut_emisor, nro_factura, monto));
}

// ── Upload a Storage ─────────────────────────────────────────────────────────

function extFromMime(mime: string): string {
  if (mime.includes('pdf')) return 'pdf';
  if (mime.includes('xml')) return 'xml';
  if (mime.includes('png')) return 'png';
  if (mime.includes('webp')) return 'webp';
  return 'jpg';
}

async function uploadToStorage(
  base64: string,
  mime: string,
  companyId: string,
): Promise<string | null> {
  try {
    const now = new Date();
    const yyyy = now.getFullYear();
    const mm = String(now.getMonth() + 1).padStart(2, '0');
    const path = `${companyId}/${yyyy}/${mm}/${randomUUID()}.${extFromMime(mime)}`;
    const buffer = Buffer.from(base64, 'base64');
    const { error } = await supabase.storage
      .from('facturas')
      .upload(path, buffer, { contentType: mime, upsert: false });
    if (error) throw error;
    return path;
  } catch (e) {
    console.error('[email] upload error:', e);
    return null;
  }
}

// ── Insertar factura ─────────────────────────────────────────────────────────

interface SaveOpts {
  categoriaName?: string | null;
  flujo?: Record<string, unknown> | null;
  /** 'confirmada' solo si una persona valido los datos. Por defecto, inferida. */
  confirmacion?: 'confirmada' | 'inferida';
}

async function saveInvoice(
  inv: InvoiceData,
  companyId: string,
  from: string,
  archivePath: string | null,
  categories: Category[],
  opts: SaveOpts = {},
): Promise<string | null> {
  const catName = opts.categoriaName ?? null;
  const categoria = catName
    ? categories.find((c) => c.nombre.toLowerCase() === catName.toLowerCase())
    : null;

  // null cuando no hay clave real (ni RUT ni nº): así no colisiona en el índice
  // UNIQUE con otra factura distinta del mismo importe. Ver dedupeHash.
  const hash = dedupeHash(inv.rut_emisor, inv.nro_factura, inv.monto);

  const datos_extra: Record<string, unknown> = { ocr: inv.ocr_text ?? null };
  if (opts.flujo) datos_extra.flujo = opts.flujo;

  const { data, error } = await supabase
    .from('invoices')
    .insert({
      company_id: companyId,
      empresa_emisora: inv.empresa_emisora,
      rut_emisor: inv.rut_emisor,
      monto: inv.monto,
      moneda: inv.moneda,
      fecha: inv.fecha,
      nro_factura: inv.nro_factura,
      categoria_id: categoria?.id ?? null,
      fuente: 'email',
      reporter: from,
      archivo_url: archivePath,
      estado_conciliacion: 'pendiente',
      confirmacion: opts.confirmacion ?? 'inferida',
      hash_dedupe: hash,
      datos_extra,
    })
    .select('id')
    .single();

  if (error) throw new Error(`Error guardando factura: ${error.message}`);
  return data?.id ?? null;
}
