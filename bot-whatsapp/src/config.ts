import 'dotenv/config';
import { z } from 'zod';

const schema = z.object({
  PORT: z.coerce.number().default(3000),
  WEBHOOK_TOKEN: z.string().optional(),

  ANTHROPIC_API_KEY: z.string().min(1),
  // Modelo del AGENTE conversacional (el que habla con el empleado). Prioriza
  // fiabilidad para no alucinar guardados. En producción: Sonnet 5.
  ANTHROPIC_MODEL: z.string().default('claude-haiku-4-5'),
  // Modelo para tareas de EXTRACCIÓN/CLASIFICACIÓN internas (OCR→JSON, resolver
  // empresa, texto→categoría). No conversa, no decide guardados: Haiku alcanza y
  // es ~3x más barato y rápido. Se puede overridear por env si hace falta.
  ANTHROPIC_MODEL_EXTRACCION: z.string().default('claude-haiku-4-5-20251001'),

  SUPABASE_URL: z.string().url(),
  SUPABASE_SERVICE_ROLE_KEY: z.string().min(1),

  EVOLUTION_URL: z.string().url(),
  EVOLUTION_API_KEY: z.string().min(1),
  EVOLUTION_INSTANCE: z.string().min(1),

  MISTRAL_API_KEY: z.string().min(1),

  // Gmail — opcionales: si no están, el poller de email no arranca
  GMAIL_CLIENT_ID: z.string().optional(),
  GMAIL_CLIENT_SECRET: z.string().optional(),
  GMAIL_REFRESH_TOKEN: z.string().optional(),
});

export const config = schema.parse(process.env);
export type Config = z.infer<typeof schema>;
