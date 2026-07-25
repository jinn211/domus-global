import { appendFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';

// Log durable de interacciones (una línea JSON por evento). Vive en un volumen
// montado para sobrevivir a los redeploys. Sirve para reportes exactos de uso.
const FILE = process.env.INTERACTIONS_FILE || '/app/data/interactions.jsonl';

let dirReady = false;
async function ensureDir(): Promise<void> {
  if (dirReady) return;
  try {
    await mkdir(dirname(FILE), { recursive: true });
  } catch {
    /* ya existe o no se puede; se reporta al escribir */
  }
  dirReady = true;
}

export interface Interaction {
  direction: 'in' | 'out';
  channel: 'whatsapp' | 'email';
  contact: string; // teléfono o email
  kind?: string; // texto | foto | pregunta | recordatorio | duplicado | etc.
  meta?: Record<string, unknown>;
}

/** Registra una interacción. Nunca lanza: si falla, solo loguea. */
export async function logInteraction(e: Interaction): Promise<void> {
  try {
    await ensureDir();
    await appendFile(FILE, JSON.stringify({ ts: new Date().toISOString(), ...e }) + '\n');
  } catch (err) {
    console.error('[interactions] no pude escribir:', err);
  }
}
