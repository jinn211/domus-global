import fs from 'node:fs';
import path from 'node:path';

/**
 * Administradores: cargan facturas de CUALQUIER empresa. La empresa se
 * determina desde la factura (RUT/datos), no desde el remitente.
 *
 * La lista vive FUERA del código, en `data/admins.json`, que no se versiona:
 * son mails corporativos y celulares personales y el repo es público. Ver
 * `admins.example.json` para el formato.
 *
 * Si el archivo falta se cae a la lista vacía: nadie es admin y las facturas de
 * empresa ajena se rechazan. Es visible en los logs al arrancar.
 */
const ADMINS_FILE = path.join(process.env.CIERRE_DATA_DIR || '/app/data', 'admins.json');

interface AdminsFile {
  emails?: string[];
  telefonos?: string[];
}

function cargar(): AdminsFile {
  try {
    const a = JSON.parse(fs.readFileSync(ADMINS_FILE, 'utf8')) as AdminsFile;
    console.log(`[admins] ${a.emails?.length ?? 0} mails y ${a.telefonos?.length ?? 0} teléfonos de admin cargados`);
    return a;
  } catch (e) {
    console.error(`[admins] no pude leer ${ADMINS_FILE} — NADIE va a tener permisos de admin:`, (e as Error).message);
    return {};
  }
}

const archivo = cargar();

export const ADMIN_EMAILS = new Set<string>((archivo.emails ?? []).map((e) => e.toLowerCase()));
export const ADMIN_PHONES = new Set<string>(archivo.telefonos ?? []);

export function isAdminEmail(email?: string | null): boolean {
  return !!email && ADMIN_EMAILS.has(email.toLowerCase());
}

export function isAdminPhone(phone?: string | null): boolean {
  return !!phone && ADMIN_PHONES.has(phone);
}
