const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const GMAIL_API = 'https://gmail.googleapis.com/gmail/v1/users/me';

export interface GmailPart {
  partId: string;
  mimeType: string;
  filename: string;
  body: { size: number; data?: string; attachmentId?: string };
  parts?: GmailPart[];
  headers?: { name: string; value: string }[];
}

export interface GmailFullMessage {
  id: string;
  payload: {
    mimeType: string;
    headers: { name: string; value: string }[];
    parts?: GmailPart[];
    body?: { data?: string };
  };
}

function flatParts(part: GmailPart): GmailPart[] {
  const out: GmailPart[] = [];
  if (part.parts?.length) {
    for (const p of part.parts) out.push(...flatParts(p));
  } else {
    out.push(part);
  }
  return out;
}

export class GmailClient {
  private clientId: string;
  private clientSecret: string;
  private refreshToken: string;
  private accessToken: string | null = null;
  private tokenExpiry = 0;

  constructor(clientId: string, clientSecret: string, refreshToken: string) {
    this.clientId = clientId;
    this.clientSecret = clientSecret;
    this.refreshToken = refreshToken;
  }

  async getAccessToken(): Promise<string> {
    if (this.accessToken && Date.now() < this.tokenExpiry - 60_000) {
      return this.accessToken;
    }
    const res = await fetch(TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: this.clientId,
        client_secret: this.clientSecret,
        refresh_token: this.refreshToken,
        grant_type: 'refresh_token',
      }),
    });
    if (!res.ok) throw new Error(`Token refresh failed: ${await res.text()}`);
    const data = await res.json() as { access_token: string; expires_in: number };
    this.accessToken = data.access_token;
    this.tokenExpiry = Date.now() + data.expires_in * 1000;
    return this.accessToken;
  }

  private async get(path: string): Promise<unknown> {
    const token = await this.getAccessToken();
    const res = await fetch(`${GMAIL_API}${path}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) throw new Error(`Gmail GET ${path} failed: ${await res.text()}`);
    return res.json();
  }

  private async post(path: string, body: unknown): Promise<void> {
    const token = await this.getAccessToken();
    const res = await fetch(`${GMAIL_API}${path}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`Gmail POST ${path} failed: ${await res.text()}`);
  }

  async listUnreadWithAttachments(): Promise<string[]> {
    const data = await this.get('/messages?q=is:unread+has:attachment&maxResults=20') as {
      messages?: { id: string }[];
    };
    return (data.messages ?? []).map((m) => m.id);
  }

  async getMessage(id: string): Promise<GmailFullMessage> {
    return this.get(`/messages/${id}?format=full`) as Promise<GmailFullMessage>;
  }

  async downloadAttachment(messageId: string, attachmentId: string): Promise<string> {
    const data = await this.get(`/messages/${messageId}/attachments/${attachmentId}`) as {
      data: string;
    };
    // base64url → base64 standard
    return data.data.replace(/-/g, '+').replace(/_/g, '/');
  }

  async markAsRead(id: string): Promise<void> {
    await this.post(`/messages/${id}/modify`, { removeLabelIds: ['UNREAD'] });
  }

  /**
   * Devuelve los parts que son adjuntos reales (PDF, XML, imagenes).
   *
   * Descarta las imagenes incrustadas en el cuerpo del mail. Los logos de firma
   * ("nublit by DOMUS GLOBAL", la tarjeta de contacto de alguien) viajan como
   * parts de imagen igual que un ticket, y entraban como si fueran facturas:
   * quedaban cargadas con monto 0, sin fecha y sin proveedor, ensuciando la base
   * y el respaldo. Se reconocen porque el HTML del mail las referencia con
   * `cid:`, asi que traen Content-ID y Content-Disposition: inline.
   *
   * Los PDF y XML nunca se descartan por esto: un adjunto de esos siempre es
   * intencional, aunque el cliente de correo lo marque inline.
   */
  getAttachmentParts(msg: GmailFullMessage): GmailPart[] {
    const all = msg.payload.parts ? msg.payload.parts.flatMap(flatParts) : [];
    return all.filter((p) => {
      if (!p.body.attachmentId) return false;
      const mime = p.mimeType.toLowerCase();
      const fname = (p.filename ?? '').toLowerCase();

      if (mime.includes('image/')) {
        const h = (n: string) =>
          (p.headers ?? []).find((x) => x.name.toLowerCase() === n)?.value ?? '';
        if (h('content-id')) return false;
        if (h('content-disposition').toLowerCase().includes('inline')) return false;
        // Red de seguridad: ningun ticket legible pesa menos que esto, y los
        // logos de firma andan en los 5-40 KB.
        if ((p.body.size ?? 0) < 45_000) return false;
      }

      return (
        mime.includes('image/') ||
        mime.includes('pdf') ||
        mime.includes('xml') ||
        mime.includes('octet') ||
        fname.endsWith('.pdf') ||
        fname.endsWith('.xml') ||
        fname.endsWith('.jpg') ||
        fname.endsWith('.jpeg') ||
        fname.endsWith('.png') ||
        fname.endsWith('.webp')
      );
    });
  }


  /** Extrae el texto del cuerpo del email (text/plain, o html sin tags). */
  getBodyText(msg: GmailFullMessage): string {
    const all = msg.payload.parts ? msg.payload.parts.flatMap(flatParts) : [];
    let plain = '';
    let html = '';
    const decode = (d?: string) =>
      d ? Buffer.from(d.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf-8') : '';
    if (msg.payload.body?.data) plain += decode(msg.payload.body.data);
    for (const p of all) {
      const m = (p.mimeType || '').toLowerCase();
      if (m.includes('text/plain')) plain += ' ' + decode(p.body?.data);
      else if (m.includes('text/html')) html += ' ' + decode(p.body?.data);
    }
    const fromHtml = html.replace(/<[^>]+>/g, ' ');
    return (plain + ' ' + fromHtml).replace(/\s+/g, ' ').trim();
  }

  getHeader(msg: GmailFullMessage, name: string): string {
    return msg.payload.headers.find(
      (h) => h.name.toLowerCase() === name.toLowerCase(),
    )?.value ?? '';
  }
}
