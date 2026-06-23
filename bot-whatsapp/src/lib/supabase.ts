import { createClient } from '@supabase/supabase-js';
import { randomUUID } from 'node:crypto';
import type { MessageParam } from '@anthropic-ai/sdk/resources/messages';
import { config } from '../config.js';

export const supabase = createClient(
  config.SUPABASE_URL,
  config.SUPABASE_SERVICE_ROLE_KEY,
  { auth: { persistSession: false } },
);

export interface Employee {
  id: string;
  nombre: string | null;
  company_id: string;
  company_nombre: string | null;
}

/** Whitelist: devuelve el empleado autorizado para ese teléfono, o null. */
export async function getEmployeeByPhone(phone: string): Promise<Employee | null> {
  const { data, error } = await supabase
    .from('employees')
    .select('id, nombre, company_id, companies(nombre)')
    .eq('phone', phone)
    .eq('activo', true)
    .maybeSingle();
  if (error) throw error;
  if (!data) return null;
  const companies = (data as {
    companies?: { nombre: string | null } | { nombre: string | null }[];
  }).companies;
  const company_nombre = Array.isArray(companies)
    ? companies[0]?.nombre ?? null
    : companies?.nombre ?? null;
  return {
    id: data.id,
    nombre: data.nombre,
    company_id: data.company_id,
    company_nombre,
  };
}

export interface Category {
  id: string;
  nombre: string;
  descripcion: string | null;
}

export async function getCategories(): Promise<Category[]> {
  const { data, error } = await supabase
    .from('categories')
    .select('id, nombre, descripcion')
    .eq('activo', true)
    .order('orden');
  if (error) throw error;
  return data ?? [];
}

export interface WaPending {
  archivo_url: string | null;
  ocr: string;
}

export interface WaSession {
  phone: string;
  company_id: string | null;
  history: MessageParam[];
  draft_invoice_id: string | null;
  pending: WaPending | null;
}

export async function loadSession(phone: string): Promise<WaSession | null> {
  const { data, error } = await supabase
    .from('wa_sessions')
    .select('phone, company_id, history, draft_invoice_id, pending')
    .eq('phone', phone)
    .maybeSingle();
  if (error) throw error;
  return (data as WaSession | null) ?? null;
}

export async function saveSession(s: WaSession): Promise<void> {
  const { error } = await supabase
    .from('wa_sessions')
    .upsert(
      { ...s, updated_at: new Date().toISOString() },
      { onConflict: 'phone' },
    );
  if (error) throw error;
}

/** Cierra la "ventana": borra el contexto de conversación del teléfono. */
export async function clearSession(phone: string): Promise<void> {
  const { error } = await supabase.from('wa_sessions').delete().eq('phone', phone);
  if (error) throw error;
}

function extFromMime(mime?: string): string {
  switch ((mime ?? '').toLowerCase()) {
    case 'image/png': return 'png';
    case 'image/webp': return 'webp';
    case 'application/pdf': return 'pdf';
    default: return 'jpg';
  }
}

/** Sube el archivo original a Storage al llegar la foto. Devuelve el path (o null). */
export async function uploadFactura(
  base64: string,
  mime: string | undefined,
  companyId: string,
): Promise<string | null> {
  if (!base64) return null;
  const now = new Date();
  const yyyy = now.getFullYear();
  const mm = String(now.getMonth() + 1).padStart(2, '0');
  const path = `${companyId}/${yyyy}/${mm}/${randomUUID()}.${extFromMime(mime)}`;
  const buffer = Buffer.from(base64, 'base64');
  const { error } = await supabase.storage
    .from('facturas')
    .upload(path, buffer, { contentType: mime ?? 'image/jpeg', upsert: false });
  if (error) {
    console.error('upload error:', error.message);
    return null;
  }
  return path;
}
