import { config } from '../config.js';
import { logInteraction } from './interactions.js';

const base = config.EVOLUTION_URL.replace(/\/$/, '');

const headers = {
  'Content-Type': 'application/json',
  apikey: config.EVOLUTION_API_KEY,
};

/** "59899123456@s.whatsapp.net" -> "59899123456" */
export function normalizeJid(jid: string): string {
  return (jid || '').split('@')[0].split(':')[0].replace(/\D/g, '');
}

/** Descarga el media de un mensaje (imagen/PDF) y devuelve su base64. */
export async function downloadMediaBase64(rawMessage: unknown): Promise<string> {
  const res = await fetch(
    `${base}/chat/getBase64FromMediaMessage/${config.EVOLUTION_INSTANCE}`,
    {
      method: 'POST',
      headers,
      body: JSON.stringify({ message: rawMessage, convertToMp4: false }),
    },
  );
  if (!res.ok) {
    throw new Error(`Evolution getBase64 ${res.status}: ${await res.text()}`);
  }
  const data = (await res.json()) as { base64?: string; data?: string };
  return data.base64 ?? data.data ?? '';
}

/** Envía un mensaje de texto por WhatsApp. */
export async function sendText(number: string, text: string): Promise<void> {
  // Evolution rechaza el texto vacío con 400 "Text is required". Si el modelo
  // devolvió vacío (pasa tras un tool_use sin texto final), mandamos un fallback
  // en vez de tirar una excepción que corta el resto del flujo (colas incluidas).
  const body = (text ?? '').trim();
  if (!body) {
    console.warn('[evolution] sendText con texto vacío para ' + number + ' — uso fallback');
    text = 'Listo. ¿Necesitás registrar algo más?';
  } else {
    text = body;
  }

  const res = await fetch(
    `${base}/message/sendText/${config.EVOLUTION_INSTANCE}`,
    {
      method: 'POST',
      headers,
      body: JSON.stringify({ number, text }),
    },
  );
  if (!res.ok) {
    throw new Error(`Evolution sendText ${res.status}: ${await res.text()}`);
  }
  void logInteraction({ direction: 'out', channel: 'whatsapp', contact: normalizeJid(number), kind: 'texto', meta: { len: text.length } });
}

/**
 * Igual que sendText pero NUNCA lanza: devuelve true/false.
 *
 * Avisar es secundario; persistir el estado es lo crítico. Si Evolution está
 * caído, un throw acá cortaba el handler ANTES de guardar la sesión: la factura
 * quedaba registrada pero la ventana sin cerrar, y la foto huérfana en Storage.
 * Preferimos que el empleado se quede sin el mensaje a corromper el estado.
 */
export async function sendTextSafe(number: string, text: string): Promise<boolean> {
  try {
    await sendText(number, text);
    return true;
  } catch (e) {
    console.error('[evolution] no pude enviar a ' + number + ':', e);
    return false;
  }
}
