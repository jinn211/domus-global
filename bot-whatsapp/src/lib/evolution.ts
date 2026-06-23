import { config } from '../config.js';

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
}
