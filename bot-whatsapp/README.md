# Domus — Bot de gastos

Servicio Node.js + TypeScript que corre en el VPS. Recibe comprobantes de gasto por **WhatsApp** (foto del ticket) y por **mail** (factura adjunta), los lee con **Mistral OCR**, conversa con la persona para completar lo que falte y los guarda en **Supabase**.

Un empleado saca la foto y contesta dos preguntas; del otro lado queda la factura cargada, categorizada y con el archivo asociado, lista para conciliar contra el banco.

---

## Los cuatro flujos

### 1. WhatsApp (`index.ts` → `agent.ts`)

```
WhatsApp ──(webhook messages.upsert)──▶ POST /webhook
   │
   ├─ whitelist por teléfono → empleado + empresa   (desconocido: se rechaza)
   ├─ lock por teléfono → los mensajes de una persona se procesan de a uno
   ├─ OCR (Mistral) en paralelo al agente
   └─ agente Claude Sonnet con tools:
         ocr_factura · guardar_factura · consultar_gastos
```

El agente **no ve la foto**: se le inyecta el texto del OCR. Pide la categoría y la descripción cuando son obligatorias, confirma antes de guardar y acepta correcciones.

### 2. Mail (`email-processor.ts`)

Poller de Gmail cada 60s. Extrae los datos de la factura adjunta con Haiku, identifica al remitente contra el mapa de remitentes conocidos y le escribe por WhatsApp para que confirme la categoría. Si no contesta, `completion.ts` recuerda a las 2h y categoriza solo a las 24h.

### 3. Cierre mensual (`lib/cierre.ts`)

Poller cada 30 min. Al cerrar el período arma el paquete de cada empresa (CSV + comprobantes en ZIP) y lo entrega. Reintenta hasta 5 veces antes de darse por vencido; si el ZIP pasa los 20 MB lo sube a Storage y manda un link firmado.

### 4. Vigilancia (`lib/alertas.ts` + `vigilante.ts`)

Dos cosas distintas, a propósito:

- **`alertas.ts`** — avisa cuando algo **se rompe**. Cualquier módulo llama a `alertar(...)` y sigue de largo; el módulo traduce el error crudo a algo accionable ("Anthropic sin créditos: el bot no procesa nada hasta recargar") y lo manda por WhatsApp a los devs. Es **solo de salida**: importa `sendText` y nada más, así que no puede leer ni responder mensajes. Nunca lanza y nunca se llama a sí mismo (si lo caído es WhatsApp, sería un bucle).
  Solo avisa de lo que **persiste**. Un corte de red de dos segundos se arregla solo en el siguiente ciclo del poller; avisar de eso es ruido, y una alerta que suena por nada deja de mirarse. Los errores marcados `transitorio` (red, rate limit, sobrecarga) necesitan 3 fallas seguidas antes de sonar, y se callan durante los primeros 90s de vida del proceso y mientras se está apagando. Los críticos (sin créditos, key vencida) avisan siempre y al toque: eso no se cura esperando.

- **`vigilante.ts`** — busca lo que quedó **mal sin romperse**: una fecha imposible, una factura sin categoría, un archivo que nunca se asoció a nada. Nada de eso lanza un error, así que sin este barrido nadie se entera. Corre cada 3 días, arregla lo que el OCR prueba y manda un resumen de lo que arregló y lo que hay que mirar a mano.

Reglas del vigilante, deliberadas: **nunca toca `monto` ni `moneda`** (un número mal en plata se propaga a la conciliación contra el banco; esa decisión la toma una persona, el bot solo reporta), nunca borra una factura, corrige solo si el OCR lo prueba, deja constancia en `datos_extra.correccion_automatica` y tiene tope de 20 correcciones por corrida. `VIGILANTE_DRY=1` lo corre en seco: recorre y arma el resumen sin escribir.

---

## Estructura

```
src/
  index.ts              Express + webhook + arranque de los pollers
  config.ts             carga y valida el env (zod)
  agent.ts              agente Sonnet: system prompt, tools, guard anti-alucinación
  email-processor.ts    poller de Gmail + extracción a JSON con Haiku
  completion.ts         completar por WhatsApp lo que falta de las facturas de mail
  whatsapp-drafts.ts    recordatorio a las 2h y auto-guardado a las 24h
  vigilante.ts          revisión de datos cada 3 días (arregla y reporta)
  admins.ts             quién puede asignar empresa y corregir
  lib/
    evolution.ts        cliente de WhatsApp (bajar media, mandar texto)
    supabase.ts         base + storage + catálogo cacheado
    mistral.ts          OCR
    gmail.ts            cliente de Gmail
    cierre.ts           armado y envío del paquete de cierre
    alertas.ts          avisos de error a los devs (solo salida)
    lock.ts             lock por teléfono, compartido entre webhook y barridos
    interactions.ts     log de interacciones a disco
  tools/
    ocr.ts · guardar.ts · consultar.ts
```

### Dos decisiones que no se ven en el código

**El teléfono no es parámetro de tool.** `consultar_gastos` toma el teléfono del contexto del webhook, no de lo que el modelo escribe. Si fuera un parámetro, alcanzaría con convencer al agente de pasar otro número para leer los gastos de un tercero.

**El hash de deduplicación puede ser `null`.** `md5(rut|nro|monto)` identifica una factura, pero un ticket sin RUT ni número no tiene clave real: si se hasheara igual, dos tickets distintos del mismo monto colisionarían y el segundo se rechazaría como duplicado. Devolver `null` lo deja fuera del índice UNIQUE (en Postgres, NULL nunca colisiona).

---

## Correr y desplegar

Producción, en el VPS:

```bash
cd /root/domus-bot
docker compose up -d --build
docker compose logs -f
```

El `.env` (no versionado, `chmod 600`) tiene las claves; `docker-compose.yml` define puerto, volumen y rotación de logs. `data/` se monta desde el host: ahí viven el log de interacciones y el estado de los pollers, así que **sobrevive a los redeploys**.

Local:

```bash
npm install
cp .env.example .env    # completar claves
npm run dev
```

Evolution apunta el webhook `messages.upsert` a la URL pública del servicio.

### Datos que no van al repo

El repo es público, así que los mails y celulares de la gente viven en `data/`, que está fuera de git:

| archivo | qué es | si falta |
|---|---|---|
| `data/remitentes.json` | mail → teléfono de quien reporta el gasto | las facturas que llegan por mail quedan en `sin_contacto` y nadie las completa (avisa por WhatsApp) |
| `data/admins.json` | quiénes pueden cargar de cualquier empresa | nadie es admin (avisa en los logs al arrancar) |

Hay un `.example.json` de cada uno con el formato. En un deploy nuevo hay que copiarlos a mano.

### Variables

Ver `.env.example`. Obligatorias: `ANTHROPIC_API_KEY`, `SUPABASE_URL` + `SUPABASE_SERVICE_ROLE_KEY`, `EVOLUTION_URL` + `EVOLUTION_API_KEY` + `EVOLUTION_INSTANCE`, `MISTRAL_API_KEY`, `GMAIL_CLIENT_ID` + `GMAIL_CLIENT_SECRET` + `GMAIL_REFRESH_TOKEN`.

Opcionales: `ANTHROPIC_MODEL` (agente, default Haiku; en producción corre Sonnet), `ANTHROPIC_MODEL_EXTRACCION` (OCR→JSON, Haiku alcanza), `WEBHOOK_TOKEN`, `ALERTAS_PHONES` (destinatarios de las alertas, separados por coma), `VIGILANTE_DRY`.
