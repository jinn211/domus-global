# Domus Global — Conciliación de Gastos · Estado de implementación

_Última actualización: 2026-06-08_

## Decisiones de arquitectura (actualizadas)

- **OCR = Mistral** (`api.mistral.ai/v1/ocr`, patrón del workflow `OCR_1`). NO Claude.
- **WhatsApp = agente de IA con Claude Haiku** como cerebro (nodo AI Agent + tools + memoria por teléfono).
- **Email = en pausa**: el cliente todavía no tiene el mailbox. Canal prioritario pasa a ser **WhatsApp**.
- **Supabase** = fuente de verdad + estado conversacional (borradores de factura).

## Infraestructura

| Recurso | Detalle |
|---|---|
| **Supabase** | Proyecto `kpsjrvfljhdwiplxllws` · `https://kpsjrvfljhdwiplxllws.supabase.co` · esquema + Storage listos |
| **n8n** | `https://prueba-n8n.n3nq2j.easypanel.host` |
| **Evolution API** | `https://prueba-evolution-api.n3nq2j.easypanel.host` · **v2.3.7 UP** · falta crear instancia · falta global API key |

## ✅ Hecho

- Esquema Supabase aplicado (migración `001`): `companies, employees, categories, invoices, bank_transactions` + índices + RLS (deny-by-default, n8n usa service_role).
- Bucket privado `facturas` (`facturas/{company_id}/{año}/{mes}/`).
- 5 categorías seed (borrador).
- Evolution API diagnosticado: vivo, falta instancia + global API key.

## ⏳ Bloqueado — falta del cliente

1. **Evolution global API key** (`AUTHENTICATION_API_KEY`, Easypanel env) → crear instancia + QR + webhook.
2. **Anthropic API key** → cerebro Haiku del agente WhatsApp.
3. **Supabase service_role key** → credencial Supabase en n8n (RLS bloquea la anon).
4. **Whitelist WhatsApp**: `teléfono, empresa, nombre`.
5. **13 empresas**: `nombre, rut, dominio_email` (para cuando se retome email).
6. **Mailbox Gmail** (email diferido hasta tenerlo).

> Mistral API key: reutilizable de `OCR_1` (hoy hardcodeada en texto plano — conviene moverla a credencial).

## 🔜 Roadmap

1. **WhatsApp (EN CURSO)** — webhook Evolution → whitelist → Mistral OCR → borrador en Supabase + Storage → agente Haiku (confirmar + categoría + correcciones) → guardar.
2. **Email (pausa)** — Gmail → dominio → e-CFE XML / Mistral OCR → invoices. Espera mailbox.
3. **Conciliación mensual** — extracto bancario → bank_transactions → matching → agente revisor → reporte por empresa.
4. **Dashboard** del reporte (estética Apple-inspired del design-system).

## Flujo WhatsApp — diseño

1. Webhook Evolution (`messages.upsert`).
2. Code: parsear evento → `phone` normalizado (solo dígitos), tipo, texto/caption, media.
3. Whitelist: `select company_id from employees where phone=...`. Si no está → responder "no autorizado" y cortar.
4. Buscar **borrador abierto** del teléfono (`invoices` con `reporter=phone` y `estado_conciliacion='revision'`).
5. Si llega imagen/PDF: descargar media (Evolution `getBase64FromMediaMessage`) → **Mistral OCR** → subir original a Storage → insertar fila borrador (`estado='revision'`). Ese pasa a ser el borrador abierto.
6. **AI Agent (Haiku)** recibe: empresa, borrador (id + campos), categorías disponibles, texto del usuario. Memoria simple por `phone`.
   - Tools: `actualizar_borrador(draft_id, campos)`, `confirmar_factura(draft_id, categoria)` → set categoría + `estado='pendiente'`.
7. Salida del agente → Evolution `sendText`.

> El estado de la factura vive en la fila borrador de Supabase (no en memoria volátil). El agente sólo manipula datos estructurados por `id` → interfaz de tools limpia (sin binarios).

## Referencias n8n

- `OCR_1` (`amy3V6tQ6D5CKZJK`) — patrón Mistral: `Extract from File` (binary→base64) → build body → `POST api.mistral.ai/v1/ocr` → `pages[].markdown`.
- `Bot Gastos: WhatsApp Listener` (`bILm1t26kMGkP8WF`) — esqueleto webhook + parseo Evolution + descarga media + sendText.
- Credencial Gmail n8n existente: `5e6jvL1nzgUsp6fH`.

## ⚠️ Seguridad

- Tabla ajena `public.agent_memory` con RLS deshabilitado (otro proyecto; no tocada).
- Mistral key hardcodeada en `OCR_1–4`.
