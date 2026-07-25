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

export async function getCompanyById(id: string): Promise<{ id: string; nombre: string } | null> {
  const { data } = await supabase.from('companies').select('id, nombre').eq('id', id).maybeSingle();
  return (data as { id: string; nombre: string } | null) ?? null;
}

/** Empresa comodín para facturas cuya empresa del holding no se pudo determinar. */
export const NO_IDENTIFICADO_ID = '9ecf5160-11f5-434e-945f-38078d0076bf';

export interface Company {
  id: string;
  nombre: string;
}

/**
 * Cache en memoria con TTL para catálogos que cambian rarísimo (categorías,
 * empresas). Antes se pegaba a Supabase en CADA mensaje entrante; ahora una vez
 * cada TTL. Un cambio en la DB tarda como mucho el TTL en reflejarse.
 */
const CATALOGO_TTL_MS = 5 * 60_000;
function memo<T>(cargar: () => Promise<T>): () => Promise<T> {
  let valor: T | undefined;
  let vence = 0;
  let enVuelo: Promise<T> | null = null;
  return async () => {
    if (valor !== undefined && Date.now() < vence) return valor;
    if (enVuelo) return enVuelo; // coalescing: llamadas simultáneas comparten el fetch
    enVuelo = cargar()
      .then((v) => {
        valor = v;
        vence = Date.now() + CATALOGO_TTL_MS;
        return v;
      })
      .finally(() => {
        enVuelo = null;
      });
    return enVuelo;
  };
}

export interface Category {
  id: string;
  nombre: string;
  descripcion: string | null;
}

/**
 * Empresas reales del holding, para ofrecerle la lista al admin cuando la factura
 * no se pudo imputar sola. Excluye los comodines ("No Identificado", "Empresa
 * Demo"): no son opciones válidas para elegir. Cacheado en memoria (ver memo).
 */
export const getCompaniesElegibles = memo(async (): Promise<Company[]> => {
  const { data, error } = await supabase
    .from('companies')
    .select('id, nombre')
    .eq('activo', true)
    .not('id', 'eq', NO_IDENTIFICADO_ID)
    .not('nombre', 'eq', 'Empresa Demo')
    .order('nombre');
  if (error) throw error;
  return data ?? [];
});

/** Categorías activas, en orden. Cacheado en memoria (ver memo). */
export const getCategories = memo(async (): Promise<Category[]> => {
  const { data, error } = await supabase
    .from('categories')
    .select('id, nombre, descripcion')
    .eq('activo', true)
    .order('orden');
  if (error) throw error;
  return data ?? [];
});

/** Foto/factura de WhatsApp encolada esperando que se termine la anterior. */
export interface WaMediaItem {
  archivo_url: string | null;
  ocr: string;
  company_id: string;
  company_nombre: string | null;
}

export interface WaPending {
  archivo_url: string | null;
  ocr: string;
  /** Cola de facturas (ids) esperando categoría por WhatsApp (flujo mail). */
  cola_facturas?: string[];
  /** Cola de fotos de WhatsApp esperando su turno (flujo foto). */
  cola_media?: WaMediaItem[];
  /** ISO timestamp: desde cuándo se espera confirmación de este borrador. */
  recibido_at?: string;
  /** Si ya se envió el recordatorio de las 2 horas para este borrador. */
  recordatorio_enviado?: boolean;
  /**
   * Posición (1-based) de la factura en curso dentro del lote que mandó el
   * empleado. El total del lote es lote_pos + cola_media.length. Sirve para que
   * el bot y el empleado hablen de "la factura 2 de 3" y no se confundan.
   */
  lote_pos?: number;
  /**
   * Flujo mail→WhatsApp: categoría ya elegida para la factura en curso, cuando
   * falta que el empleado mande la descripción obligatoria. El próximo texto que
   * llegue se toma como esa descripción.
   */
  categoria_pendiente?: string;
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
