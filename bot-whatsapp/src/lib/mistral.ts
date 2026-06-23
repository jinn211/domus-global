import { config } from '../config.js';

const IMAGE_MIMES = ['image/jpeg', 'image/jpg', 'image/png', 'image/webp'];

/**
 * Corre Mistral OCR sobre un archivo en base64.
 * Devuelve el texto (markdown) extraído, o '' si no se pudo leer nada.
 * El agente decide qué hacer con '' (pedir otra foto).
 */
export async function ocr(base64: string, mime: string): Promise<string> {
  const isImage = IMAGE_MIMES.includes(mime.toLowerCase());
  const document = isImage
    ? { type: 'image_url', image_url: `data:${mime};base64,${base64}` }
    : { type: 'document_url', document_url: `data:application/pdf;base64,${base64}` };

  const res = await fetch('https://api.mistral.ai/v1/ocr', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${config.MISTRAL_API_KEY}`,
    },
    body: JSON.stringify({ model: 'mistral-ocr-latest', document }),
  });
  if (!res.ok) {
    throw new Error(`Mistral OCR ${res.status}: ${await res.text()}`);
  }
  const data = (await res.json()) as { pages?: Array<{ markdown?: string }> };
  return (data.pages ?? [])
    .map((p) => p.markdown ?? '')
    .join('\n\n')
    .trim();
}
