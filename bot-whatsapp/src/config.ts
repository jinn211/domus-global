import 'dotenv/config';
import { z } from 'zod';

const schema = z.object({
  PORT: z.coerce.number().default(3000),
  WEBHOOK_TOKEN: z.string().optional(),

  ANTHROPIC_API_KEY: z.string().min(1),
  ANTHROPIC_MODEL: z.string().default('claude-haiku-4-5'),

  SUPABASE_URL: z.string().url(),
  SUPABASE_SERVICE_ROLE_KEY: z.string().min(1),

  EVOLUTION_URL: z.string().url(),
  EVOLUTION_API_KEY: z.string().min(1),
  EVOLUTION_INSTANCE: z.string().min(1),

  MISTRAL_API_KEY: z.string().min(1),
});

export const config = schema.parse(process.env);
export type Config = z.infer<typeof schema>;
