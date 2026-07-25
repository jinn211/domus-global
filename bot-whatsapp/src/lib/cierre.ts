import fs from 'fs';
import path from 'path';
import JSZip from 'jszip';
import { config } from '../config.js';
import { supabase } from './supabase.js';
import { sendText } from './evolution.js';
import { alertar } from './alertas.js';

// ── Persistencia de cierres ──────────────────────────────────────────────────
const DATA_DIR = process.env.CIERRE_DATA_DIR || '/app/data';
const CIERRES_FILE = path.join(DATA_DIR, 'cierres.json');

export interface Recipient { nombre: string; phone: string; email: string; }
export interface Cierre {
  id: string;
  company_id: string;
  company_nombre: string;
  desde: string;            // ISO — inicio del período (created_at >=)
  hasta: string;            // ISO — fin del período (created_at <=)
  recipients: Recipient[];
  started_at: string;       // ISO
  grace_until: string;      // ISO — cuándo vence la ventana de gracia
  estado: 'gracia' | 'enviado' | 'error';
  reconciliation_file?: string | null; // nombre de archivo en DATA_DIR (xlsx de conciliación)
  enviado_at?: string;
  /** Corte real usado al finalizar: `hasta` + lo que llegó en la ventana de gracia. */
  cutoff_at?: string;
  /** Intentos fallidos de finalización (para reintentar en vez de morir al primer error). */
  intentos?: number;
}

function loadCierres(): Cierre[] {
  try {
    return JSON.parse(fs.readFileSync(CIERRES_FILE, 'utf8'));
  } catch (e) {
    // Archivo inexistente = todavía no hay cierres, normal.
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return [];
    // JSON corrupto: si devolviéramos [] el próximo saveCierres PISA el archivo y
    // se pierden todos los cierres en curso. Preferimos fallar ruidoso.
    console.error('[cierre] cierres.json ilegible, se aborta para no perderlo:', (e as Error).message);
    throw e;
  }
}
function saveCierres(list: Cierre[]): void {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(CIERRES_FILE, JSON.stringify(list, null, 2));
}
function upsertCierre(c: Cierre): void {
  const list = loadCierres();
  const i = list.findIndex((x) => x.id === c.id);
  if (i >= 0) list[i] = c; else list.push(c);
  saveCierres(list);
}

// ── Gmail: enviar con adjuntos ───────────────────────────────────────────────
async function gmailToken(): Promise<string> {
  if (!config.GMAIL_CLIENT_ID || !config.GMAIL_CLIENT_SECRET || !config.GMAIL_REFRESH_TOKEN) {
    throw new Error('Gmail no configurado (faltan GMAIL_*)');
  }
  const r = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: config.GMAIL_CLIENT_ID,
      client_secret: config.GMAIL_CLIENT_SECRET,
      refresh_token: config.GMAIL_REFRESH_TOKEN,
      grant_type: 'refresh_token',
    }),
  });
  const j = (await r.json()) as { access_token?: string };
  if (!j.access_token) throw new Error('gmail token: ' + JSON.stringify(j));
  return j.access_token;
}

interface Attachment { name: string; mime: string; buffer: Buffer; }

async function sendGmail(to: string[], subject: string, body: string, attachments: Attachment[]): Promise<string> {
  const B = 'CIERREBOUNDARY';
  const parts: string[] = [
    `To: ${to.join(', ')}`,
    `Subject: ${subject}`,
    `MIME-Version: 1.0`,
    `Content-Type: multipart/mixed; boundary="${B}"`,
    ``,
    `--${B}`,
    `Content-Type: text/plain; charset="UTF-8"`,
    `Content-Transfer-Encoding: 7bit`,
    ``,
    body,
  ];
  for (const a of attachments) {
    // sin el "!": un adjunto vacío haría match() === null y tiraba TypeError
    const b64 = (a.buffer.toString('base64').match(/.{1,76}/g) ?? []).join('\r\n');
    parts.push(
      `--${B}`,
      `Content-Type: ${a.mime}; name="${a.name}"`,
      `Content-Disposition: attachment; filename="${a.name}"`,
      `Content-Transfer-Encoding: base64`,
      ``,
      b64,
    );
  }
  parts.push(`--${B}--`, ``);
  const raw = Buffer.from(parts.join('\r\n')).toString('base64')
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  const token = await gmailToken();
  const res = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/messages/send', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
    body: JSON.stringify({ raw }),
  });
  const jr = (await res.json()) as { id?: string; error?: unknown };
  if (!res.ok) throw new Error('gmail send: ' + JSON.stringify(jr));
  return jr.id ?? '';
}

// ── Armar ZIP + índice CSV de las facturas del período ───────────────────────
function slug(s: string): string {
  return (s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^A-Za-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 36);
}
function loc(t: string): string {
  return new Date(new Date(t).getTime() - 3 * 3600e3).toISOString().slice(0, 10);
}

interface PeriodResult { zip: Buffer; csv: Buffer; count: number; }

/**
 * @param corte límite superior real. Al finalizar se pasa el momento del envío,
 * NO `c.hasta`: si filtráramos por `hasta`, todo lo que el empleado sube durante
 * la ventana de gracia (que por definición ocurre DESPUÉS de `hasta`) quedaría
 * afuera del paquete — justo lo que la gracia existe para recuperar.
 */
async function buildPeriodPackage(c: Cierre, corte?: string): Promise<PeriodResult> {
  const hastaEfectivo = corte ?? c.hasta;
  const { data: invs, error } = await supabase
    .from('invoices')
    .select('id,created_at,fuente,reporter,empresa_emisora,monto,moneda,fecha,archivo_url,categories(nombre)')
    .eq('company_id', c.company_id)
    .gte('created_at', c.desde)
    .lte('created_at', hastaEfectivo)
    .order('created_at', { ascending: true });
  if (error) throw new Error('query invoices: ' + error.message);
  const rows = invs ?? [];

  // mapa reporter -> nombre empleado
  const { data: emps } = await supabase.from('employees').select('nombre,phone');
  const nameByPhone: Record<string, string> = {};
  (emps ?? []).forEach((e: any) => { nameByPhone[e.phone] = e.nombre; });

  const zip = new JSZip();
  const csvLines = ['#,Fecha,Empleado,Canal,Empresa emisora,Monto,Moneda,Categoria,Archivo'];
  let n = 0;
  for (const inv of rows as any[]) {
    n++;
    const ext = (inv.archivo_url || '').split('.').pop() || 'bin';
    const empleado = nameByPhone[inv.reporter] ||
      (String(inv.reporter).includes('@') ? String(inv.reporter).replace(/.*<|>.*/g, '') : inv.reporter);
    const fname = `${String(n).padStart(2, '0')}_${inv.fecha || loc(inv.created_at)}_${slug(inv.empresa_emisora)}_${inv.moneda}${String(inv.monto).replace('.', '-')}.${ext}`;
    // descargar el archivo del storage
    try {
      const { data: blob, error: dErr } = await supabase.storage.from('facturas').download(inv.archivo_url);
      if (dErr || !blob) throw dErr || new Error('sin blob');
      const buf = Buffer.from(await blob.arrayBuffer());
      zip.file('facturas/' + fname, buf);
    } catch (e) {
      console.error('[cierre] no pude bajar', inv.archivo_url, (e as Error).message);
    }
    const cat = inv.categories?.nombre || '(sin categoria)';
    const esc = (v: any) => `"${String(v ?? '').replace(/"/g, '""')}"`;
    csvLines.push([n, inv.fecha || loc(inv.created_at), empleado, inv.fuente, inv.empresa_emisora, inv.monto, inv.moneda, cat, fname].map(esc).join(','));
  }
  const zipBuf = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
  const csvBuf = Buffer.from('﻿' + csvLines.join('\n'), 'utf8'); // BOM para Excel
  return { zip: zipBuf, csv: csvBuf, count: n };
}

// ── Envío final (automático al vencer la gracia) ─────────────────────────────
export async function finalizeCierre(c: Cierre): Promise<void> {
  console.log(`[cierre] finalizando ${c.id} (${c.company_nombre})`);
  // Corte = ahora, para incluir lo subido durante la ventana de gracia.
  const corte = new Date().toISOString();
  const pkg = await buildPeriodPackage(c, corte);
  const emps = c.company_nombre;
  const attachments: Attachment[] = [
    { name: `Facturas_${slug(emps)}.zip`, mime: 'application/zip', buffer: pkg.zip },
    { name: `Indice_${slug(emps)}.csv`, mime: 'text/csv', buffer: pkg.csv },
  ];
  if (c.reconciliation_file) {
    const p = path.join(DATA_DIR, c.reconciliation_file);
    if (fs.existsSync(p)) {
      attachments.push({ name: c.reconciliation_file, mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', buffer: fs.readFileSync(p) });
    }
  }
  // Gmail rechaza mensajes de más de 25 MB. Si el ZIP no entra, en vez de que
  // falle el envío entero lo subimos a Storage y mandamos un link firmado.
  const LIMITE_MAIL = 20 * 1024 * 1024; // margen: base64 infla ~33%
  let linkZip: string | null = null;
  const pesa = () => attachments.reduce((s, a) => s + a.buffer.length, 0);
  if (pesa() > LIMITE_MAIL) {
    const zipPath = `cierres/${c.id}/${attachments[0].name}`;
    const { error: upErr } = await supabase.storage
      .from('facturas')
      .upload(zipPath, pkg.zip, { contentType: 'application/zip', upsert: true });
    if (!upErr) {
      const { data: signed } = await supabase.storage
        .from('facturas')
        .createSignedUrl(zipPath, 30 * 24 * 3600); // 30 días
      linkZip = signed?.signedUrl ?? null;
    }
    if (linkZip) {
      attachments.shift(); // saco el ZIP de los adjuntos; va por link
      console.log(`[cierre] ZIP de ${(pkg.zip.length / 1048576).toFixed(1)} MB enviado por link`);
    } else {
      console.error('[cierre] ZIP grande y no pude generar link; intento adjuntarlo igual');
    }
  }

  const subject = `Cierre ${emps} — facturas del período (${loc(c.desde)} a ${loc(corte)})`;
  const body = [
    'Hola,',
    '',
    `Cierre de ${emps} finalizado (venció la ventana de gracia).`,
    `Período: ${loc(c.desde)} a ${loc(c.hasta)} — incluye lo subido durante la gracia (hasta ${loc(corte)}).`,
    '',
    `Adjunto:`,
    linkZip
      ? `  • Facturas (${pkg.count} comprobantes) — por tamaño van en este link (vence en 30 días):\r\n    ${linkZip}`
      : `  • ${attachments[0].name} — ${pkg.count} comprobantes`,
    `  • Índice CSV — fecha, empleado, empresa, monto, categoría`,
    c.reconciliation_file ? `  • ${c.reconciliation_file} — conciliación contra el estado de cuenta` : '',
    '',
    'Enviado automáticamente por el bot de facturas.',
  ].filter(Boolean).join('\r\n');

  const emails = c.recipients.map((r) => r.email).filter(Boolean);
  if (emails.length === 0) throw new Error('el cierre no tiene ningún email de destino');
  const mailId = await sendGmail(emails, subject, body, attachments);
  console.log(`[cierre] mail enviado id=${mailId} a ${emails.join(', ')}`);

  const wtext = `📦 *Cierre ${emps} — enviado*\n\nVenció la ventana de gracia. Te mandé por mail ${linkZip ? `el link al ZIP` : `el ZIP`} con ${pkg.count} facturas del período + el índice${c.reconciliation_file ? ' + la conciliación' : ''}.`;
  for (const r of c.recipients) {
    await sendText(r.phone, wtext).catch((e) => console.error('[cierre] wa aviso final', r.phone, e.message));
  }

  c.estado = 'enviado';
  c.enviado_at = new Date().toISOString();
  c.cutoff_at = corte;
  upsertCierre(c);
  console.log(`[cierre] ${c.id} marcado enviado`);
}

// ── Poller: revisa cierres con gracia vencida ────────────────────────────────
const MAX_INTENTOS = 5;

export async function checkPendingCierres(): Promise<void> {
  const now = Date.now();
  for (const c of loadCierres()) {
    if (c.estado === 'gracia' && new Date(c.grace_until).getTime() <= now) {
      await finalizeCierre(c).catch((e) => {
        // Antes, CUALQUIER fallo (un timeout de Gmail, un corte de red) marcaba
        // el cierre como 'error' para siempre y no se enviaba nunca más. Ahora
        // se reintenta en los próximos barridos y sólo se da por perdido al 5º.
        c.intentos = (c.intentos ?? 0) + 1;
        if (c.intentos >= MAX_INTENTOS) {
          c.estado = 'error';
          console.error(`[cierre] ${c.id} FALLÓ definitivo tras ${c.intentos} intentos:`, e.message);
          void alertar('envio del cierre mensual', e, { cierre: c.id, empresa: c.company_nombre });
        } else {
          console.error(`[cierre] ${c.id} falló (intento ${c.intentos}/${MAX_INTENTOS}), reintento en 30 min:`, e.message);
        }
        upsertCierre(c);
      });
    }
  }
}

export function initCierrePoller(): void {
  console.log('[cierre] poller iniciado (cada 30 min)');
  checkPendingCierres().catch((e) => console.error('[cierre] check inicial', e.message));
  setInterval(() => {
    checkPendingCierres().catch((e) => console.error('[cierre] check', e.message));
  }, 30 * 60_000);
}

// ── Kickoff: arranca un cierre (lo llamo yo con la conciliación ya hecha) ─────
export interface FaltanteMsg { phone: string; nombre: string; mensaje: string; }
export interface StartCierreOpts {
  company_id: string;
  company_nombre: string;
  desde: string;
  hasta: string;
  recipients: Recipient[];
  faltantes: FaltanteMsg[];
  reconciliation_file?: string | null;
  graceDays?: number;
}

export async function startCierre(opts: StartCierreOpts): Promise<Cierre> {
  const graceDays = opts.graceDays ?? 3;
  const now = new Date();
  const cierre: Cierre = {
    // El id incluye el PERÍODO, no la fecha de hoy: si no, dos cierres de la
    // misma empresa lanzados el mismo día (p. ej. poniéndose al día con junio y
    // julio) compartían id y el segundo borraba al primero en silencio.
    // Con el período adentro, re-lanzar el MISMO período sí lo pisa (idempotente,
    // que es lo deseado) y períodos distintos conviven.
    id: 'cierre_' + opts.company_nombre.replace(/[^A-Za-z0-9]/g, '') +
        '_' + opts.desde.slice(0, 10) + '_' + opts.hasta.slice(0, 10),
    company_id: opts.company_id,
    company_nombre: opts.company_nombre,
    desde: opts.desde,
    hasta: opts.hasta,
    recipients: opts.recipients,
    started_at: now.toISOString(),
    grace_until: new Date(now.getTime() + graceDays * 24 * 3600e3).toISOString(),
    estado: 'gracia',
    reconciliation_file: opts.reconciliation_file ?? null,
  };

  // 1. avisos "última oportunidad" a empleados con faltantes
  let avisados = 0;
  for (const f of opts.faltantes) {
    try { await sendText(f.phone, f.mensaje); avisados++; }
    catch (e) { console.error('[cierre] wa empleado', f.phone, (e as Error).message); }
    await new Promise((r) => setTimeout(r, 1200));
  }

  // 2. aviso a los destinatarios (Agustín + Juani) de que arrancó
  const inicio = `🔔 *Cierre ${opts.company_nombre} — iniciado*\n\n` +
    `Se avisó a ${avisados} empleado(s) con comprobantes faltantes (última oportunidad).\n` +
    `Ventana de gracia: ${graceDays} días. El ${new Date(cierre.grace_until).toLocaleDateString('es-UY')} se envía el paquete final automáticamente.`;
  for (const r of opts.recipients) {
    await sendText(r.phone, inicio).catch((e) => console.error('[cierre] wa aviso inicio', r.phone, e.message));
  }

  upsertCierre(cierre);
  console.log(`[cierre] iniciado ${cierre.id} — gracia hasta ${cierre.grace_until}`);
  return cierre;
}
