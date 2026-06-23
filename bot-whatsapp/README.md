# Domus — Bot de WhatsApp de Gastos

Servicio standalone (Node.js + TypeScript) que corre en el VPS. Recibe fotos de tickets por WhatsApp (Evolution API), las procesa con **Mistral (OCR)** y un agente **Claude Haiku** que conversa con el empleado para confirmar los datos y guardarlos en **Supabase**.

## Arquitectura

```
WhatsApp ──(webhook messages.upsert)──▶ Express POST /webhook
                                              │
                    1. Parsear evento (teléfono, tipo, texto, media)
                    2. Whitelist: employees por teléfono → empresa  (si no: rechazar)
                    3. Cargar historial de conversación del teléfono
                    4. Agente Claude Haiku (tool use)  ◀── system prompt + categorías
                          tools:
                            • ocr_factura(image)      → Mistral OCR, devuelve texto
                            • guardar_factura(campos) → Supabase invoices + Storage
                       (loop hasta que produce un texto de respuesta)
                    5. Enviar respuesta por Evolution (sendText)
                    6. Persistir historial actualizado
```

## Reglas del agente (Haiku)

- **No ve la foto.** El OCR (Mistral) corre en paralelo y se le inyecta el **texto extraído**, no la imagen.
- Si el OCR viene **vacío o ilegible** → pide que saquen otra foto mejor.
- **Pide el tipo de gasto** (una de las categorías) y cualquier dato que falte.
- **Asocia los mensajes de texto con la foto** para enriquecer (ej: foto + "esto fue nafta de la camioneta" = la misma factura). La memoria por teléfono lo permite.
- **Confirma los datos antes de guardar** y acepta correcciones.

## Estructura

```
src/
  index.ts            # Express + webhook
  config.ts           # carga y valida env
  lib/
    evolution.ts      # cliente Evolution (descargar media, enviar texto)
    supabase.ts       # cliente Supabase (whitelist, invoices, storage, historial)
    mistral.ts        # OCR
    agent.ts          # armado del agente Haiku + loop de tools
  tools/
    ocr.ts            # tool ocr_factura
    guardar.ts        # tool guardar_factura
```

## Estado / memoria de la conversación

Cada empleado (teléfono) tiene una conversación con contexto. El historial se guarda en Supabase (tabla `wa_sessions`, pendiente de crear) para que sobreviva reinicios del proceso. El estado de la factura en curso vive como borrador en `invoices` (`estado_conciliacion='revision'`) hasta que el agente la confirma.

## Variables de entorno

Ver `.env.example`. Claves necesarias: `ANTHROPIC_API_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, `EVOLUTION_API_KEY` + `EVOLUTION_INSTANCE`, `MISTRAL_API_KEY`.

## Correr local

```bash
npm install
cp .env.example .env   # completar claves
npm run dev
```

El webhook queda en `POST /webhook`. En Evolution se configura apuntando a la URL pública del servicio con el evento `messages.upsert`.

## Deploy

Pensado para correr en Easypanel (VPS Hostinger) como app Node o contenedor Docker, exponiendo el puerto con un dominio para que Evolution alcance el webhook. (Dockerfile pendiente.)
