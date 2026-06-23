import Anthropic from '@anthropic-ai/sdk';
import { config } from './config.js';
import type { Category, Employee } from './lib/supabase.js';
import {
  guardarFactura,
  guardarFacturaSchema,
  type GuardarCtx,
  type GuardarInput,
} from './tools/guardar.js';

const anthropic = new Anthropic({ apiKey: config.ANTHROPIC_API_KEY });

const MAX_HISTORY = 20;

export interface AgentContext {
  employee: Employee;
  phone: string;
  categories: Category[];
  history: Anthropic.MessageParam[];
  userText: string; // caption o mensaje de texto del empleado
  ocrText: string; // OCR de ESTE mensaje (para el prompt cuando hay foto)
  windowOcr: string; // OCR de la ventana (para guardar en datos_extra)
  archivoUrl: string | null; // path del archivo ya subido a Storage
  hasImage: boolean;
}

function buildSystem(ctx: AgentContext): string {
  const cats = ctx.categories.map((c, i) => `${i + 1}) ${c.nombre}`).join('   ');

  return `Sos el asistente de gastos de Domus Global por WhatsApp. Tono profesional y cordial, claro y breve. Evitá modismos e informalidades (NO uses "¿va?", "dale", "bárbaro" y similares).

El empleado es de la empresa "${ctx.employee.company_nombre ?? 'desconocida'}". Registrás gastos a partir de fotos de tickets/facturas.

Flujo (minimizá la cantidad de mensajes):
1. NO ves la foto: recibís el texto del OCR (Mistral), puede tener errores.
2. Si el OCR está vacío o ilegible: pedí una foto más nítida y nada más.
3. Si hay datos: extraé TODO del OCR — emisora (proveedor), monto, moneda (detectala del ticket: UYU/USD/CLP/$), fecha (YYYY-MM-DD), nº de comprobante, RUT del receptor si aparece. NO preguntes lo que ya está en el ticket.
4. Deducí la categoría más probable según el OCR (proveedor, rubro, ítems). En UN SOLO mensaje: resumen de 1-2 líneas + preguntá si la categoría deducida es correcta. Ej: "Leí: Starbucks, $4.900, 29/01/2025. ¿Lo pongo en *Representación*? Si no, elegí de la lista: ${cats}".
5. Si confirma o indica otra categoría:
   - Si la categoría es *Otros*: antes de guardar, pedí una descripción breve del tipo de gasto ("¿Podés indicar brevemente en qué consiste el gasto?"). Guardá recién cuando la tengas.
   - Cualquier otra categoría: guardá YA con guardar_factura (categoria = nombre EXACTO de la lista). No vuelvas a preguntar ni re-confirmes.
6. Tras guardar, confirmá EXPLÍCITAMENTE que quedó registrado, en UNA línea. Ej: "✅ Registrado: Starbucks, $4.900 CLP, Alimentación / Restaurantes."

Nunca pidas confirmación de lo mismo dos veces. Nunca digas "registrando..." sin llamar la tool. Si falta sólo el monto, pedí únicamente eso.`;
}

const tools: Anthropic.Tool[] = [
  {
    name: 'guardar_factura',
    description:
      'Guarda la factura/ticket confirmado en la base de datos. Llamar SOLO cuando el empleado confirmó los datos y eligió una categoría válida.',
    input_schema: guardarFacturaSchema as unknown as Anthropic.Tool.InputSchema,
  },
];

export interface AgentResult {
  reply: string;
  newHistory: Anthropic.MessageParam[];
  saved: boolean; // true si se llamó guardar_factura con éxito en este turno
}

export async function runAgent(ctx: AgentContext): Promise<AgentResult> {
  const parts: string[] = [];
  if (ctx.hasImage) {
    parts.push(
      `[Sistema] Llegó una foto de factura. Texto OCR (Mistral):\n${ctx.ocrText ? ctx.ocrText : '(vacío / no se pudo leer)'}`,
    );
  }
  if (ctx.userText) parts.push(ctx.userText);
  const userContent = parts.join('\n\n') || '(mensaje vacío)';

  const messages: Anthropic.MessageParam[] = [
    ...ctx.history,
    { role: 'user', content: userContent },
  ];

  const guardarCtx: GuardarCtx = {
    companyId: ctx.employee.company_id,
    phone: ctx.phone,
    categories: ctx.categories,
    ocrText: ctx.windowOcr,
    archivoUrl: ctx.archivoUrl,
  };

  const system = buildSystem(ctx);
  let reply = 'Disculpá, tuve un problema procesando esto. ¿Podés reintentar?';
  let saved = false;

  // Loop agéntico manual (máx 6 vueltas)
  for (let i = 0; i < 6; i++) {
    const res = await anthropic.messages.create({
      model: config.ANTHROPIC_MODEL,
      max_tokens: 1024,
      system,
      tools,
      messages,
    });

    if (res.stop_reason === 'tool_use') {
      messages.push({ role: 'assistant', content: res.content });
      const toolResults: Anthropic.ToolResultBlockParam[] = [];
      for (const block of res.content) {
        if (block.type === 'tool_use' && block.name === 'guardar_factura') {
          console.log('[tool] guardar_factura input:', JSON.stringify(block.input));
          const out = await guardarFactura(guardarCtx, block.input as GuardarInput);
          console.log('[tool] guardar_factura result:', out);
          if (out.startsWith('OK')) saved = true;
          toolResults.push({ type: 'tool_result', tool_use_id: block.id, content: out });
        }
      }
      messages.push({ role: 'user', content: toolResults });
      continue;
    }

    reply = res.content
      .filter((b): b is Anthropic.TextBlock => b.type === 'text')
      .map((b) => b.text)
      .join('\n')
      .trim();
    break;
  }

  const userTurn: Anthropic.MessageParam = { role: 'user', content: userContent };
  const assistantTurn: Anthropic.MessageParam = { role: 'assistant', content: reply };
  const newHistory = [...ctx.history, userTurn, assistantTurn].slice(-MAX_HISTORY);

  return { reply, newHistory, saved };
}
