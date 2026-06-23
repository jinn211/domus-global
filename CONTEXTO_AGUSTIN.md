# Domus Global — Sistema de Conciliación de Gastos
## Contexto completo para Agustín

> Este documento te da el contexto completo del proyecto para que puedas colaborar desde cero con tu Claude. Está al día al 9 de junio 2026.

---

## 1. Qué es el proyecto

**Cliente: Domus Global** — holding de ~13 empresas en Uruguay.

El problema: cada empresa tiene empleados que hacen gastos (cenas de trabajo, nafta, materiales, etc.) y los pagan con tarjeta o efectivo. A fin de mes, el área contable necesita conciliar esos gastos contra el extracto bancario. Hoy lo hacen a mano, empresa por empresa.

**Lo que estamos construyendo:** un sistema que:

1. Recibe facturas/tickets por dos canales (WhatsApp y email)
2. Los clasifica por empresa y categoría automáticamente con IA
3. Al fin de mes, cruza esas facturas contra el extracto bancario → genera un reporte de conciliación por empresa

---

## 2. Stack completo

| Servicio | Qué hace | URL |
|---|---|---|
| **Supabase** | Base de datos Postgres + Storage de archivos | https://kpsjrvfljhdwiplxllws.supabase.co |
| **n8n** | Workflows de automatización (ingesta de emails) | https://prueba-n8n.n3nq2j.easypanel.host |
| **Evolution API** | Gateway WhatsApp (instancia "Paperclip") | https://prueba-evolution-api.n3nq2j.easypanel.host |
| **Bot WhatsApp** | App Node.js/Express que procesa mensajes de WhatsApp | corriendo en VPS puerto 3300 |
| **Claude Haiku 4.5** | Agente conversacional del bot + OCR de emails | modelo `claude-haiku-4-5-20251001` |
| **Mistral OCR** | Extracción de texto de imágenes y PDFs | `mistral-ocr-latest` |
| **VPS Hostinger** | Servidor donde corre todo | IP: `31.97.241.227` |

---

## 3. Accesos y credenciales

### VPS
```bash
ssh -i ~/.ssh/hostinger_vps root@31.97.241.227
```
*(necesitás la clave privada `hostinger_vps` — pedísela a Juani)*

### Supabase
- **URL:** `https://kpsjrvfljhdwiplxllws.supabase.co`
- **Service Role Key:** `sb_secret_fzIBcGxhuegjREHlVAKx8w_EyOe_Lof`
- **Proyecto ID:** `kpsjrvfljhdwiplxllws`
- Tiene RLS activo con deny-by-default. El bot usa service_role para bypassearlo.

### n8n
- **URL:** https://prueba-n8n.n3nq2j.easypanel.host
- Gmail credential ID: `5e6jvL1nzgUsp6fH`
- ⚠️ `n8n_update_partial_workflow` **NO funciona** en esta instancia. Siempre usar `n8n_update_full_workflow`.

### Evolution API (WhatsApp)
- **URL:** `https://prueba-evolution-api.n3nq2j.easypanel.host`
- **API Key:** `429683C4C977415CAAFCCE10F7D57E11`
- **Instancia:** `Paperclip`
- **Número de WhatsApp:** +598 9 598 4343

### APIs externas
- **Anthropic API Key:** `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`
  - ⚠️ Esta key fue expuesta en un chat — **pendiente rotarla en https://console.anthropic.com**
- **Mistral API Key:** `JJ9yBKO2CYHS7htklHuLn77thlAthHj1`

---

## 4. Infraestructura en el VPS

El VPS corre Easypanel, que es una UI que maneja Docker por abajo. Todo corre como contenedor Docker:

```
VPS 31.97.241.227
├── traefik          → reverse proxy HTTPS (puertos 80/443)
├── easypanel        → panel de control (puerto 3000 interno)
├── evolution-api    → WhatsApp gateway (puerto 8080 interno)
├── evolution-api-db → PostgreSQL de Evolution
├── evolution-redis  → Redis de Evolution
├── n8n              → workflows
└── domus-bot        → el bot de WhatsApp (puerto 3300 → 3000 interno)
```

También corren procesos Node fuera de Docker (son de otra cosa, no tocar):
- `/home/paperclip/pipeline_webhook.js`
- `/home/paperclip/...paperclipai run`

### Cómo redesplegar el bot

El código fuente del bot en el VPS está en `/root/domus-bot/`. Para redesplegar:

```bash
# 1. Subir archivos modificados
scp -i ~/.ssh/hostinger_vps src/index.ts root@31.97.241.227:/root/domus-bot/src/index.ts

# 2. Reconstruir imagen
ssh -i ~/.ssh/hostinger_vps root@31.97.241.227 "cd /root/domus-bot && docker build -t domus-bot:latest ."

# 3. Recrear contenedor (IMPORTANTE: no hacer stop+start, eso usa la imagen vieja)
ssh -i ~/.ssh/hostinger_vps root@31.97.241.227 "
docker stop domus-bot && docker rm domus-bot && \
docker run -d \
  --name domus-bot \
  --restart always \
  -p 3300:3000 \
  -e PORT=3000 \
  -e WEBHOOK_TOKEN=eb608308a1bb8242e30eafa66445bf31 \
  -e ANTHROPIC_API_KEY=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 \
  -e ANTHROPIC_MODEL=claude-haiku-4-5-20251001 \
  -e SUPABASE_URL=https://kpsjrvfljhdwiplxllws.supabase.co \
  -e SUPABASE_SERVICE_ROLE_KEY=sb_secret_fzIBcGxhuegjREHlVAKx8w_EyOe_Lof \
  -e EVOLUTION_URL=https://prueba-evolution-api.n3nq2j.easypanel.host \
  -e EVOLUTION_API_KEY=429683C4C977415CAAFCCE10F7D57E11 \
  -e EVOLUTION_INSTANCE=Paperclip \
  -e MISTRAL_API_KEY=JJ9yBKO2CYHS7htklHuLn77thlAthHj1 \
  domus-bot:latest"

# Ver logs en vivo
ssh -i ~/.ssh/hostinger_vps root@31.97.241.227 "docker logs domus-bot -f"
```

**Por qué `docker rm` y no solo `docker start`:** `docker stop` + `docker start` rearrancan el contenedor con la imagen original (la de cuando fue creado). Para usar una imagen reconstruida, hay que borrar el contenedor y recrearlo.

---

## 5. Base de datos — Supabase

### Tablas principales

#### `companies` — Las ~13 empresas del holding
```
id          uuid (PK)
nombre      text
rut         text (nullable — se autocompleta del e-CFE)
dominio_email text (nullable — para identificar emails entrantes)
activo      boolean
created_at  timestamptz
```

#### `employees` — Whitelist de WhatsApp
```
id          uuid (PK)
phone       text  — formato internacional SIN + ni espacios (ej: 59892751271)
nombre      text (nullable)
company_id  uuid (FK → companies)
activo      boolean
created_at  timestamptz
```
Solo los teléfonos en esta tabla pueden usar el bot. Si alguien manda un mensaje y no está acá, recibe "no autorizado".

#### `categories` — Categorías de gasto
```
id          uuid (PK)
nombre      text
descripcion text
orden       integer
activo      boolean
```
Las 9 categorías actuales (en orden):
1. Alimentación / Restaurantes
2. Combustible / Transporte
3. Alojamiento
4. Representación
5. Materiales / Insumos
6. Servicios Profesionales
7. Publicidad / Marketing
8. Tecnología
9. Otros

#### `invoices` — Todas las facturas/tickets recibidos
```
id                  uuid (PK)
company_id          uuid (FK → companies)
empresa_emisora     text  — nombre del proveedor (Shell, Devoto, etc.)
rut_emisor          text (nullable)
monto               numeric
moneda              text  — 'UYU' o 'USD' (default 'UYU')
fecha               date (nullable)
nro_factura         text (nullable)
tipo_comprobante    text (nullable)
categoria_id        uuid (FK → categories)
fuente              text  — 'whatsapp' o 'email'
reporter            text  — teléfono del empleado que subió (WhatsApp) o null (email)
archivo_url         text  — path en Storage bucket 'facturas'
archivo_xml_url     text  — path del XML original del e-CFE (solo emails)
estado_conciliacion text  — 'pendiente' | 'conciliada' | 'sin_match'
bank_transaction_id uuid (FK → bank_transactions, nullable)
datos_extra         jsonb — {ocr: "...", descripcion: "..."} info adicional
hash_dedupe         text  — MD5(rut_emisor|nro_factura|monto) para evitar duplicados
periodo             text  — 'YYYY-MM' generado por trigger automático
created_at          timestamptz
```

#### `bank_transactions` — Movimientos del extracto bancario (para conciliación)
```
id                uuid (PK)
company_id        uuid (FK → companies)
fecha             date
monto             numeric
moneda            text
descripcion       text
invoice_id        uuid (FK → invoices, nullable — cuando hay match)
estado            text  — 'sin_match' | 'matcheado'
extracto_periodo  text  — 'YYYY-MM'
raw               jsonb — fila original del CSV/Excel
created_at        timestamptz
```
*(Tabla creada, lógica de conciliación todavía no implementada)*

#### `wa_sessions` — Contexto de conversación del bot por teléfono
```
phone            text (PK)
company_id       uuid
history          jsonb  — array de {role, content} de la conversación
draft_invoice_id uuid (nullable)
pending          jsonb  — {archivo_url, ocr} del ticket en curso
updated_at       timestamptz
```
El bot mantiene una "ventana de conversación" por usuario. Una foto nueva abre ventana nueva (borra contexto anterior). Cuando se guarda la factura, la sesión se borra.

### Vistas útiles
- `v_facturas_mes_actual` — facturas del mes corriente con nombre de empresa y categoría
- `v_facturas_archivo` — facturas de meses anteriores (ídem)
- `v_resumen_empresa_mes` — totales por empresa+periodo+moneda con conteo de estados

### Storage
Bucket `facturas` — archivos organizados como `{company_id}/{YYYY}/{MM}/{uuid}.{ext}`

---

## 6. Bot WhatsApp — Arquitectura

### Qué es
Una app Node.js + Express + TypeScript que corre en el VPS. Evolution API le manda un webhook POST a `http://31.97.241.227:3300/webhook?token=eb608308a1bb8242e30eafa66445bf31` cada vez que llega un mensaje de WhatsApp a la instancia Paperclip.

### Código fuente
Local en `/Users/juani/Downloads/domus-conciliacion/bot-whatsapp/`
En VPS en `/root/domus-bot/`

```
src/
├── index.ts          → servidor Express, manejo de webhooks, orquestación
├── agent.ts          → loop agéntico con Claude Haiku + tool use
├── config.ts         → variables de entorno (zod)
└── lib/
    ├── evolution.ts  → cliente Evolution API (normalizeJid, downloadMedia, sendText)
    ├── mistral.ts    → OCR de imágenes y PDFs
    └── supabase.ts   → cliente Supabase, whitelist, sessions, storage
└── tools/
    └── guardar.ts    → herramienta guardar_factura (schema + ejecución)
```

### Flujo completo de un mensaje

```
Empleado manda foto/mensaje
        ↓
Evolution API → POST /webhook
        ↓
parseEvent()   → extrae phone, tipo, mime, caption
        ↓
normalizeJid() → "59892751271@s.whatsapp.net" → "59892751271"
        ↓
getEmployeeByPhone() → busca en employees WHERE phone = X AND activo = true
  → null: responde "no autorizado", fin
  → encontrado: continúa con employee.company_id
        ↓
Si es imagen/PDF:
  downloadMediaBase64() → descarga desde Evolution
  ocr(base64, mime)     → Mistral OCR → texto markdown
  uploadFactura()       → sube a Storage bucket 'facturas'
        ↓
runAgent() → loop agéntico (máx 6 iteraciones):
  [1] Claude Haiku recibe: OCR del ticket + mensaje del usuario + historial
  [2] Claude devuelve texto: "Leí: Shell, $1.200, 08/06/2025. ¿Lo pongo en *Combustible/Transporte*?"
  [3] Empleado confirma o corrige
  [4] Claude llama tool guardar_factura con los datos
  [5] guardar_factura inserta en invoices + auto-aprende RUT de empresa si aplica
  [6] Claude confirma: "✅ Registrado: Shell, $1.200 UYU, Combustible / Transporte."
        ↓
sendText() → responde por WhatsApp
saveSession() / clearSession() → persiste o limpia contexto
```

### Normalización de teléfonos
- `"59892751271@s.whatsapp.net"` → split('@')[0] → split(':')[0] → remove non-digits → `"59892751271"`
- Formato en DB: internacional sin + ni espacios (Uruguay: `598` + 8 dígitos)

### Tool use — cómo funciona
Claude Haiku no guarda directamente en la DB. Cuando decide guardar, devuelve `stop_reason: 'tool_use'` con el nombre `guardar_factura` y los datos extraídos. El bot ejecuta la inserción en Supabase y le pasa el resultado de vuelta a Claude, que entonces genera la confirmación en texto natural.

### Auto-aprendizaje de RUTs
Cuando el bot guarda una factura con `rut_receptor` (extraído del ticket), automáticamente actualiza `companies.rut` de esa empresa si todavía no lo tenía. Así el sistema aprende los RUTs sin necesidad de cargarlos manualmente.

### Categoría "Otros"
Si Claude clasifica en "Otros", antes de guardar pide una descripción breve del gasto. El sistema prompt le instruye explícitamente esto.

### Tono del bot
- Profesional y cordial. Sin informalidades ni uruguayismos ("¿va?", "dale", "bárbaro").
- El empleado es identificado como perteneciente a `employee.company_nombre`.
- Respuestas cortas, minimiza la cantidad de mensajes.

---

## 7. Workflow n8n — Ingesta Email e-CFE

### Qué hace
Procesa automáticamente las facturas electrónicas (e-CFE uruguayas) que llegan por email a una cuenta Gmail compartida del holding.

### ID del workflow
`MV43qJm3NQjbc1f0` — "Domus - Ingesta Email e-CFE" — **actualmente INACTIVO**

### Flujo de nodos

```
Gmail Trigger (poll 1 min)
  → Gmail Get (descarga adjuntos)
  → Code Parsear Adjuntos (extrae XML si hay, o deja para OCR)
  → IF Tiene XML
      TRUE → HTTP Buscar Empresa (Supabase: companies?rut=eq.{rut_receptor})
      FALSE → HTTP Mistral OCR (PDF → texto) 
              → HTTP Haiku Extraer (extrae campos del texto)
              → Code Fusionar OCR
              → HTTP Buscar Empresa
  → IF Empresa Encontrada
      TRUE → Code Preparar Datos
      FALSE → Code Extraer Nombre Receptor (primera palabra significativa de empresa_receptor)
              → HTTP Buscar Empresa por Nombre (companies?nombre=ilike.*{nombre}*)
              → IF Empresa por Nombre
                  TRUE → HTTP Actualizar RUT Empresa (PATCH, auto-aprende RUT)
                         → Code Preparar Datos
                  FALSE → Gmail Marcar Leido (Sin Empresa) [fin]
  → HTTP Verificar Duplicado (hash_dedupe)
  → IF No Duplicado
      TRUE → Code Preparar Archivo (base64)
             → HTTP Subir Storage (bucket facturas)
             → HTTP Insertar Factura (Supabase)
             → Gmail Marcar Leido
      FALSE → Gmail Marcar Leido (Duplicado) [fin]
```

### e-CFE — qué es
Comprobante Fiscal Electrónico uruguayo. El proveedor manda un XML (datos estructurados) + PDF (copia visual) adjuntos al email. El XML siempre tiene:
- `RUTEmisor` — RUT del proveedor
- `RUTRecep` — RUT de la empresa receptora del holding
- `RznSoc` — razón social del receptor
- `NroCFE` — número de comprobante
- `MntTotal` — monto total

El workflow identifica a qué empresa del holding pertenece el email por el `RUTRecep`. Si la empresa aún no tiene RUT en la DB, lo aprende del primer e-CFE que llegue (buscando primero por nombre).

### Para activar el workflow
1. Primero cargar las 13 empresas en Supabase con al menos el `nombre`
2. Verificar que la credential Gmail `5e6jvL1nzgUsp6fH` no requiera reautorización
3. Testear manualmente con un email real con XML adjunto
4. Activar el trigger

---

## 8. Estado actual y qué falta hacer

### Hecho ✅
| Qué | Detalle |
|---|---|
| Esquema Supabase completo | Tablas, Storage, vistas, triggers, RLS |
| Bot WhatsApp | Node.js/Express/TypeScript desplegado en VPS, agente Haiku, OCR Mistral, tool use, sesiones, whitelist |
| Workflow email e-CFE | Completo en n8n (inactivo, listo para activar) |
| Whitelist cargada | Juani y Agustín habilitados como prueba |
| Categorías seed | 9 categorías cargadas en DB |

### Pendiente ❌
| Qué | Prioridad | Detalle |
|---|---|---|
| Datos maestros del cliente | Alta | Las 13 empresas del holding con nombre, RUT, dominio_email. Sin esto, el email workflow no puede identificar empresas |
| Activar workflow email | Alta | Depende de datos maestros |
| Scope tarjetas de crédito | Media | El cliente también quiere manejar gastos con tarjeta corporativa y reintegros. Necesita nuevas tablas: `tarjetas`, `consumos_tarjeta`, `reintegros` |
| Workflow conciliación mensual | Media | Ingestar extracto bancario (CSV Itaú/BBVA) → cruzar contra invoices → reporte por empresa |
| Dashboard/reporte UI | Baja | Interfaz visual estilo Apple para ver el estado de conciliación |
| Rotar Anthropic API key | Urgente | Fue expuesta en un chat. Rotar en https://console.anthropic.com y actualizar en `.env` y en el contenedor Docker |
| Mover Mistral key a credential n8n | Baja | Actualmente hardcodeada en el nodo HTTP del workflow de email |

### Pendiente de pedir al cliente
1. **Lista de las 13 empresas** con nombre legal, RUT, y dominio de email corporativo
2. **Formato del extracto bancario** de Itaú/BBVA (CSV o Excel, columnas)
3. **Política de reintegros** — quién aprueba, monto máximo, tiempo límite
4. **Whitelist completa de empleados** con nombre, empresa y número de WhatsApp

---

## 9. Gotchas importantes

### `n8n_update_partial_workflow` no funciona
Esta instancia de n8n tiene una incompatibilidad con el MCP. Siempre usar `n8n_update_full_workflow` para actualizar workflows. Nunca usar el parcial aunque parezca más conveniente.

### Docker stop + start NO usa imagen nueva
`docker stop domus-bot && docker start domus-bot` rearrancar el contenedor con la imagen original con la que fue creado. Para aplicar una imagen reconstruida, hay que `docker rm` y recrear con `docker run`. Ver sección 4 para el comando completo.

### Formato de teléfono en la whitelist
Uruguay: `598` + número sin 0 inicial (ej: `09 2 751 271` → `59892751271`)
Argentina: `549` + número completo (los argentinos ya tienen el 9 en el celular)
Nunca con +, nunca con espacios, nunca con guiones.

### RLS en Supabase
RLS activo con deny-by-default. El bot y el workflow de n8n usan la `service_role_key` para bypasear RLS. Si alguna query devuelve vacío inexplicablemente, primero verificar que se está usando la service role key y no la anon key.

### Modelo Haiku — ID completo
El modelo correcto es `claude-haiku-4-5-20251001`. Sin el sufijo de fecha, la API puede rechazar o usar una versión diferente.

### Mistral OCR — tipos de documento
- Imágenes (jpeg, png, webp): usar `type: "image_url"` con `image_url: "data:image/jpeg;base64,..."`
- PDFs: usar `type: "document_url"` con `document_url: "data:application/pdf;base64,..."`
No confundir los tipos, Mistral los trata diferente.

---

## 10. Herramientas MCP disponibles

Para trabajar en este proyecto con Claude, los MCPs más importantes son:

- **`mcp__supabase__execute_sql`** — queries directas a la DB (ideal para verificar datos)
- **`mcp__supabase__apply_migration`** — cambios de schema
- **`mcp__n8n-mcp__n8n_get_workflow`** — ver un workflow completo
- **`mcp__n8n-mcp__n8n_update_full_workflow`** — actualizar workflow (SIEMPRE este, nunca el partial)
- **`mcp__n8n-mcp__n8n_list_workflows`** — listar todos
- **Bash tool + SSH** — para todo lo del VPS (logs, restart, deploy)

---

## 11. Código fuente relevante

Todo el código del bot está en `/Users/juani/Downloads/domus-conciliacion/bot-whatsapp/src/`.

Los archivos más importantes para entender el flujo:

- **`index.ts`** — orquestador principal. Recibe webhook → whitelist → OCR → runAgent → responde
- **`agent.ts`** — `buildSystem()` define el system prompt del bot. `runAgent()` es el loop agéntico.
- **`tools/guardar.ts`** — esquema JSON de la tool + lógica de inserción en Supabase + auto-aprendizaje de RUT
- **`lib/supabase.ts`** — `getEmployeeByPhone()`, `loadSession()`/`saveSession()`, `uploadFactura()`
- **`lib/mistral.ts`** — función `ocr(base64, mime)` que llama a Mistral OCR
- **`lib/evolution.ts`** — `normalizeJid()`, `downloadMediaBase64()`, `sendText()`

---

*Última actualización: 9 de junio 2026*
