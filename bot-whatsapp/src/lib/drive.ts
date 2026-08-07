import { config } from '../config.js';

/**
 * Cliente mínimo de Google Drive. Solo lo que necesita el respaldo: buscar o
 * crear una carpeta, listar lo que ya hay adentro, y subir un archivo.
 *
 * El permiso es `drive.file`: la app solo ve y toca los archivos que ella misma
 * creó. No puede leer el resto del Drive de nadie, ni siquiera para listarlo.
 * Eso también explica por qué buscar la carpeta raíz funciona sin conocer su id:
 * la búsqueda devuelve únicamente lo nuestro.
 */

const API = 'https://www.googleapis.com/drive/v3';
const SUBIDA = 'https://www.googleapis.com/upload/drive/v3/files';
const CARPETA = 'application/vnd.google-apps.folder';

let accessToken: string | null = null;
let vence = 0;

async function token(): Promise<string> {
  if (accessToken && Date.now() < vence - 60_000) return accessToken;

  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: config.DRIVE_CLIENT_ID!,
      client_secret: config.DRIVE_CLIENT_SECRET!,
      refresh_token: config.DRIVE_REFRESH_TOKEN!,
      grant_type: 'refresh_token',
    }),
  });
  const data = (await res.json()) as { access_token?: string; expires_in?: number; error?: string; error_description?: string };
  if (!res.ok || !data.access_token) {
    // El caso típico: la app quedó en "Testing" en Google Cloud y el refresh
    // token caducó a los 7 días. Lo decimos con todas las letras para no perder
    // media hora adivinando.
    throw new Error(
      `Drive OAuth ${res.status}: ${data.error ?? ''} ${data.error_description ?? ''}`.trim() +
        (data.error === 'invalid_grant'
          ? ' — el refresh token dejó de valer. Suele pasar cuando la app quedó en "Testing" en Google Cloud (caduca a los 7 días) o si se revocó el acceso.'
          : ''),
    );
  }
  accessToken = data.access_token;
  vence = Date.now() + (data.expires_in ?? 3600) * 1000;
  return accessToken;
}

async function api(ruta: string): Promise<any> {
  const res = await fetch(`${API}${ruta}`, { headers: { Authorization: `Bearer ${await token()}` } });
  if (!res.ok) throw new Error(`Drive GET ${ruta.slice(0, 60)} → ${res.status} ${(await res.text()).slice(0, 200)}`);
  return res.json();
}

/** Las comillas simples rompen la sintaxis de `q` de Drive. */
const esc = (s: string) => s.replace(/\\/g, '\\\\').replace(/'/g, "\\'");

/** Devuelve el id de la carpeta, creándola si no existe. Idempotente. */
export async function carpeta(nombre: string, padre?: string): Promise<string> {
  const q = [
    `name = '${esc(nombre)}'`,
    `mimeType = '${CARPETA}'`,
    'trashed = false',
    padre ? `'${padre}' in parents` : "'root' in parents",
  ].join(' and ');

  const found = await api(`/files?q=${encodeURIComponent(q)}&fields=files(id)&pageSize=1`);
  if (found.files?.length) return found.files[0].id;

  const res = await fetch(`${API}/files?fields=id`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${await token()}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: nombre, mimeType: CARPETA, parents: [padre ?? 'root'] }),
  });
  if (!res.ok) throw new Error(`Drive crear carpeta "${nombre}" → ${res.status} ${(await res.text()).slice(0, 200)}`);
  return ((await res.json()) as { id: string }).id;
}

/**
 * Lo que ya está en una carpeta: id y nombre de cada archivo.
 *
 * Es la base del anti-duplicados: en vez de llevar un registro local de lo que
 * se copió (que se pierde si se recrea el contenedor y termina duplicando todo),
 * se le pregunta al destino. Sin estado propio, imposible desincronizarse.
 */
export async function archivosEn(carpetaId: string): Promise<{ id: string; name: string }[]> {
  const out: { id: string; name: string }[] = [];
  let pageToken: string | undefined;
  do {
    const q = `'${carpetaId}' in parents and trashed = false`;
    const r = await api(
      `/files?q=${encodeURIComponent(q)}&fields=nextPageToken,files(id,name)&pageSize=1000` +
        (pageToken ? `&pageToken=${pageToken}` : ''),
    );
    for (const f of r.files ?? []) out.push({ id: f.id, name: f.name });
    pageToken = r.nextPageToken;
  } while (pageToken);
  return out;
}

/**
 * Renombra un archivo ya subido.
 *
 * Hace falta porque el nombre lleva datos de la factura (fecha, monto, si está
 * confirmada) y esos datos cambian: el vigilante corrige una fecha, alguien
 * confirma una factura que estaba inferida. Sin esto, Drive se quedaría con la
 * foto del día que se copió y iría divergiendo de la base.
 */
export async function renombrar(fileId: string, nombre: string): Promise<void> {
  const res = await fetch(`${API}/files/${fileId}?fields=id`, {
    method: 'PATCH',
    headers: { Authorization: `Bearer ${await token()}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: nombre }),
  });
  if (!res.ok) throw new Error(`Drive renombrar → ${res.status} ${(await res.text()).slice(0, 200)}`);
}

export async function subir(
  nombre: string,
  carpetaId: string,
  cuerpo: Buffer,
  mime: string,
): Promise<void> {
  const linde = '===domus' + cuerpo.length.toString(36) + '===';
  const meta = JSON.stringify({ name: nombre, parents: [carpetaId] });
  const payload = Buffer.concat([
    Buffer.from(`--${linde}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${meta}\r\n--${linde}\r\nContent-Type: ${mime}\r\n\r\n`),
    cuerpo,
    Buffer.from(`\r\n--${linde}--`),
  ]);

  const res = await fetch(`${SUBIDA}?uploadType=multipart&fields=id`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${await token()}`,
      'Content-Type': `multipart/related; boundary=${linde}`,
    },
    body: new Uint8Array(payload),
  });
  if (!res.ok) throw new Error(`Drive subir "${nombre}" → ${res.status} ${(await res.text()).slice(0, 200)}`);
}

/**
 * Manda un archivo o carpeta a la papelera de Drive.
 *
 * A la papelera y no borrado definitivo a propósito: Drive la conserva 30 días,
 * así que un error se deshace desde la interfaz sin depender de nosotros.
 */
export async function aPapelera(fileId: string): Promise<void> {
  const res = await fetch(`${API}/files/${fileId}?fields=id`, {
    method: 'PATCH',
    headers: { Authorization: `Bearer ${await token()}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ trashed: true }),
  });
  if (!res.ok) throw new Error(`Drive papelera → ${res.status} ${(await res.text()).slice(0, 200)}`);
}
