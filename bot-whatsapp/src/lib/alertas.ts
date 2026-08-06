import { sendText } from './evolution.js';

/**
 * Avisos de error por WhatsApp a los desarrolladores.
 *
 * Módulo aparte a propósito: no sabe nada del agente ni del flujo de facturas.
 * Cualquier parte del bot puede llamar a `alertar(...)` y seguir de largo.
 *
 * Reglas de la casa:
 *  - NUNCA lanza. Si el aviso falla, se loguea y listo: una alerta rota no puede
 *    tumbar el flujo que la disparó.
 *  - NUNCA se llama a sí misma. Si falla el envío por WhatsApp no se alerta de
 *    eso (sería un bucle infinito).
 *  - Anti-spam: un poller que falla cada 60s no manda 60 mensajes por hora.
 *  - Solo avisa de lo que PERSISTE. Un corte de red de dos segundos se arregla
 *    solo en el siguiente ciclo del poller; avisar de eso es ruido, y una alerta
 *    que suena por nada deja de mirarse. Ver `transitorio` mas abajo.
 */

// Destinatarios de las alertas técnicas (Juani y Agustín, no el cliente).
const DEVS: { nombre: string; phone: string }[] = (process.env.ALERTAS_PHONES ?? '')
  .split(',')
  .map((p) => p.trim())
  .filter(Boolean)
  .map((phone, i) => ({ nombre: 'dev' + (i + 1), phone }));
if (!DEVS.length) {
  console.error('[alertas] ALERTAS_PHONES vacío: los errores se van a loguear pero NADIE va a recibir el aviso.');
}

/** Ventana de silencio por tipo de error, para no repetir el mismo aviso. */
const VENTANA_MS = 30 * 60_000;
const ultimaAlerta = new Map<string, { enviadaAt: number; repeticiones: number }>();

/**
 * Errores transitorios: cuantas veces seguidas tienen que fallar antes de avisar.
 * Con el poller de mail cada 60s, 3 = la red estuvo caida ~3 minutos de verdad.
 */
const UMBRAL_TRANSITORIO = 3;
/** Si entre dos fallas pasa mas que esto, no fueron "seguidas": arranca de cero. */
const RACHA_MS = 5 * 60_000;
const rachas = new Map<string, { fallos: number; desde: number; ultimo: number }>();

/**
 * Al arrancar hay medio minuto de ruido normal (DNS del contenedor, pollers que
 * salen todos juntos). Nada transitorio avisa en esa ventana.
 */
const ARRANQUE = Date.now();
const GRACIA_ARRANQUE_MS = 90_000;

/**
 * Apagado a proposito (un `docker compose up` manda SIGTERM). Lo que falle
 * mientras nos estamos yendo no es una falla: es el redeploy. Sin esto, cada
 * cambio que le hacemos al sistema disparaba una alerta de red.
 */
let apagando = false;
export function marcarApagado(): void {
  apagando = true;
}

interface Diagnostico {
  titulo: string;
  significa: string;
  queHacer: string;
  /** true = el bot no puede operar (avisa aunque sea repetido, cada ventana). */
  critico: boolean;
  /**
   * true = se arregla solo si el problema no persiste (un blip de red, un rate
   * limit). No avisa hasta que falle UMBRAL_TRANSITORIO veces seguidas.
   */
  transitorio?: boolean;
}

/**
 * Traduce el error crudo a algo accionable. Los patrones salen de provocar los
 * errores reales contra cada servicio, no de suponer.
 */
export function diagnosticar(err: unknown): Diagnostico {
  const e = err as { message?: string; status?: number; code?: string };
  const msg = String(e?.message ?? err ?? '');
  const status = e?.status;

  // ── Anthropic (el cerebro del bot) ──────────────────────────────────────────
  if (/credit balance is too low|insufficient.*credit/i.test(msg)) {
    return {
      titulo: 'Anthropic sin créditos',
      significa: 'El bot NO puede leer ni responder mensajes. Todo lo que llegue por WhatsApp queda sin procesar hasta que se recargue.',
      queHacer: 'Cargar créditos en console.anthropic.com → Plans & Billing.',
      critico: true,
    };
  }
  if (status === 401 && /anthropic|authentication_error/i.test(msg)) {
    return {
      titulo: 'API key de Anthropic inválida',
      significa: 'El bot no puede procesar ningún mensaje: la key fue rotada, revocada o está mal escrita.',
      queHacer: 'Revisar ANTHROPIC_API_KEY en el contenedor y regenerarla si hace falta.',
      critico: true,
    };
  }
  if (status === 404 && /model:/i.test(msg)) {
    return {
      titulo: 'Modelo de IA mal configurado',
      significa: 'El nombre del modelo no existe. El bot no puede responder.',
      queHacer: 'Revisar ANTHROPIC_MODEL / ANTHROPIC_MODEL_EXTRACCION en el contenedor.',
      critico: true,
    };
  }
  if (status === 429) {
    return {
      titulo: 'Límite de uso de Anthropic (rate limit)',
      significa: 'Demasiadas consultas juntas. Suele ser pasajero y se reintenta solo.',
      queHacer: 'Si se repite seguido, subir el tier de la cuenta o espaciar la carga.',
      critico: false,
      transitorio: true,
    };
  }
  if (status === 529 || /overloaded/i.test(msg)) {
    return {
      titulo: 'Anthropic sobrecargado',
      significa: 'Problema temporal del lado de Anthropic, no del bot.',
      queHacer: 'Esperar unos minutos. Si dura, ver status.anthropic.com.',
      critico: false,
      transitorio: true,
    };
  }

  // ── Evolution / WhatsApp ────────────────────────────────────────────────────
  if (/Evolution .*40[13]|Unauthorized/i.test(msg) && /Evolution/i.test(msg)) {
    return {
      titulo: 'WhatsApp rechaza las credenciales',
      significa: 'El bot no puede enviar mensajes. Recibe, pero nadie obtiene respuesta.',
      queHacer: 'Revisar EVOLUTION_API_KEY en el contenedor y en Easypanel.',
      critico: true,
    };
  }
  if (/instance does not exist/i.test(msg)) {
    return {
      titulo: 'La instancia de WhatsApp no existe',
      significa: 'La instancia "Paperclip" fue borrada o renombrada. El bot no puede mandar nada.',
      queHacer: 'Revisar la instancia en Evolution API y reconectar el número.',
      critico: true,
    };
  }
  if (/Text is required/i.test(msg)) {
    return {
      titulo: 'Se intentó mandar un mensaje vacío',
      significa: 'Bug interno: el modelo devolvió texto vacío. El empleado no recibió respuesta.',
      queHacer: 'Avisar para revisar el turno en los logs (ya hay un fallback, no debería pasar).',
      critico: false,
    };
  }
  if (/Evolution/i.test(msg)) {
    return {
      titulo: 'Falla enviando WhatsApp',
      significa: 'Evolution API respondió con error. El mensaje no llegó al empleado.',
      queHacer: 'Verificar que la instancia esté conectada (QR vigente) en Easypanel.',
      critico: true,
    };
  }

  // ── Mistral (OCR de los tickets) ────────────────────────────────────────────
  if (/Mistral/i.test(msg)) {
    const auth = /401|Unauthorized/i.test(msg);
    return {
      titulo: auth ? 'API key de Mistral inválida' : 'Falla en el OCR (Mistral)',
      significa: auth
        ? 'El bot no puede leer NINGUNA foto de ticket. Va a pedir que reenvíen la foto una y otra vez.'
        : 'No se pudo leer una foto puntual. El empleado recibe el pedido de reenviarla.',
      queHacer: auth ? 'Revisar MISTRAL_API_KEY en el contenedor.' : 'Si se repite en varias fotos, revisar la cuenta de Mistral.',
      critico: auth,
    };
  }

  // ── Gmail (canal de facturas por mail) ──────────────────────────────────────
  if (/invalid_grant|gmail token/i.test(msg)) {
    return {
      titulo: 'Gmail desautorizado',
      significa: 'Dejaron de entrar las facturas por mail. El refresh token venció o fue revocado (cambio de contraseña, permisos retirados).',
      queHacer: 'Volver a generar GMAIL_REFRESH_TOKEN autorizando la cuenta de nuevo.',
      critico: true,
    };
  }
  if (/Gmail (GET|POST)/i.test(msg)) {
    return {
      titulo: 'Falla consultando Gmail',
      significa: 'No se pudieron leer los mails nuevos en este ciclo.',
      queHacer: 'Suele ser pasajero; si persiste revisar los permisos de la cuenta.',
      critico: false,
      transitorio: true,
    };
  }

  // ── Supabase / base de datos ────────────────────────────────────────────────
  if (/Unregistered API key|Invalid API key|No API key found|JWT expired/i.test(msg)) {
    return {
      titulo: 'La key de Supabase no sirve',
      significa:
        'El bot no puede leer NI escribir NADA: ni facturas, ni sesiones, ni archivos. ' +
        'Recibe los mensajes de la gente y no les puede contestar. Está caído por completo.',
      queHacer:
        'Generar una secret key nueva en Supabase → Project Settings → API Keys, ' +
        'ponerla en SUPABASE_SERVICE_ROLE_KEY del .env y reiniciar con docker compose up -d.',
      critico: true,
    };
  }
  if (/^23505|duplicate key/i.test(msg)) {
    return {
      titulo: 'Choque de clave única en la base',
      significa: 'Se intentó guardar algo que ya existía (normalmente el anti-duplicados).',
      queHacer: 'Si aparece al guardar una factura legítima, avisar: puede ser el hash de dedupe.',
      critico: false,
    };
  }
  if (/^42703|column .* does not exist/i.test(msg)) {
    return {
      titulo: 'Consulta contra una columna inexistente',
      significa: 'Bug de código o la base cambió de estructura. La operación falló.',
      queHacer: 'Revisar el último cambio de código o de esquema.',
      critico: true,
    };
  }
  if (/^42501|row-level security|permission denied/i.test(msg)) {
    return {
      titulo: 'Base de datos deniega permisos',
      significa: 'El bot no puede leer/escribir. Probablemente esté usando una key sin privilegios.',
      queHacer: 'Verificar SUPABASE_SERVICE_ROLE_KEY (no la anon) en el contenedor.',
      critico: true,
    };
  }
  if (/Object not found/i.test(msg)) {
    return {
      titulo: 'Falta un archivo en Storage',
      significa: 'Una factura quedó sin su imagen/PDF. Si es durante un cierre, ese comprobante no va en el ZIP.',
      queHacer: 'Revisar si el archivo se borró del bucket "facturas".',
      critico: false,
    };
  }

  // ── Red / infraestructura ───────────────────────────────────────────────────
  if (/ECONNREFUSED|ENOTFOUND|ETIMEDOUT|fetch failed|socket hang up/i.test(msg)) {
    return {
      titulo: 'Problema de red del servidor',
      significa: 'El bot no pudo conectarse a un servicio externo. Suele ser pasajero.',
      queHacer: 'Si se repite, revisar el VPS y la conectividad.',
      critico: false,
      transitorio: true,
    };
  }
  if (/ENOSPC|no space left/i.test(msg)) {
    return {
      titulo: 'Disco lleno en el servidor',
      significa: 'No se pueden guardar archivos ni logs. El bot va a fallar en cadena.',
      queHacer: 'Liberar espacio en el VPS urgente.',
      critico: true,
    };
  }

  return {
    titulo: 'Error no catalogado',
    significa: 'Falló una operación y no reconozco el patrón del error.',
    queHacer: 'Mirar el detalle técnico de abajo y los logs del contenedor.',
    critico: false,
  };
}

/**
 * Manda una novedad a los devs que NO es un error (ej: "se recuperó la base").
 * Comparte destinatarios con alertar() para no tener dos listas que se
 * desincronizan. Nunca lanza.
 */
export async function avisarDevs(texto: string): Promise<void> {
  if (apagando) return;
  for (const dev of DEVS) {
    await sendText(dev.phone, texto).catch((e) =>
      console.error('[alertas] no pude avisar a ' + dev.nombre + ':', (e as Error).message),
    );
  }
}

function ahoraUY(): string {
  return new Date().toLocaleString('es-UY', {
    timeZone: 'America/Montevideo', day: '2-digit', month: '2-digit',
    hour: '2-digit', minute: '2-digit',
  });
}

/**
 * Avisa por WhatsApp a los devs. Nunca lanza; podés llamarla con `void`.
 *
 * @param contexto dónde ocurrió, en criollo ("agente WhatsApp", "poller de email")
 * @param err el error tal cual
 * @param extra datos útiles (teléfono del empleado, id de factura, etc.)
 */
export async function alertar(
  contexto: string,
  err: unknown,
  extra?: Record<string, unknown>,
): Promise<void> {
  try {
    const d = diagnosticar(err);
    const detalle = String((err as Error)?.message ?? err ?? '').slice(0, 300);

    // Anti-spam: mismo contexto + mismo tipo de error = misma clave.
    const clave = `${contexto}::${d.titulo}`;
    const ahoraMs = Date.now();

    // ── Filtro de lo que se cura solo ────────────────────────────────────────
    // Un error critico (key vencida, sin creditos) avisa siempre y al toque:
    // eso no se arregla esperando, y si lo rompi con un deploy quiero saberlo ya.
    let racha = 0;
    if (d.transitorio) {
      if (apagando) {
        console.log(`[alertas] apagandose, ignoro: ${d.titulo} (${contexto})`);
        return;
      }
      if (ahoraMs - ARRANQUE < GRACIA_ARRANQUE_MS) {
        console.log(`[alertas] recien arrancado, ignoro: ${d.titulo} (${contexto})`);
        return;
      }
      const r = rachas.get(clave);
      const seguidas = r && ahoraMs - r.ultimo < RACHA_MS;
      racha = seguidas ? r!.fallos + 1 : 1;
      rachas.set(clave, { fallos: racha, desde: seguidas ? r!.desde : ahoraMs, ultimo: ahoraMs });
      if (racha < UMBRAL_TRANSITORIO) {
        console.warn(`[alertas] ${d.titulo} (${contexto}) — ${racha}/${UMBRAL_TRANSITORIO}, espero a ver si se recupera`);
        return;
      }
    }
    const prev = ultimaAlerta.get(clave);
    const ahora = ahoraMs;
    if (prev && ahora - prev.enviadaAt < VENTANA_MS) {
      prev.repeticiones++;
      return; // silenciado: se informa al reabrirse la ventana
    }
    const repetidas = prev?.repeticiones ?? 0;
    ultimaAlerta.set(clave, { enviadaAt: ahora, repeticiones: 0 });

    const lineas = [
      `${d.critico ? '🚨' : '⚠️'} *${d.critico ? 'ERROR CRÍTICO' : 'Error'} en el bot de gastos*`,
      ``,
      `*Qué pasó:* ${d.titulo}`,
      `*Dónde:* ${contexto}`,
      `*Significa:* ${d.significa}`,
      `*Qué hacer:* ${d.queHacer}`,
    ];
    if (racha >= UMBRAL_TRANSITORIO) {
      const min = Math.max(1, Math.round((ahoraMs - (rachas.get(clave)?.desde ?? ahoraMs)) / 60_000));
      lineas.push(`*Ojo:* viene fallando ${racha} veces seguidas hace ${min} min, no es un corte pasajero.`);
    }
    if (extra && Object.keys(extra).length) {
      lineas.push(``, `*Datos:* ${Object.entries(extra).map(([k, v]) => `${k}=${v}`).join(' · ')}`);
    }
    lineas.push(``, `_Técnico:_ ${detalle}`);
    lineas.push(
      repetidas > 0
        ? `_${ahoraUY()} · se repitió ${repetidas} ${repetidas === 1 ? 'vez' : 'veces'} en los últimos 30 min_`
        : `_${ahoraUY()}_`,
    );
    const texto = lineas.join('\n');

    for (const dev of DEVS) {
      // sendText puede fallar; lo tragamos acá. NO llamamos a alertar() de nuevo
      // (sería un bucle infinito si justo lo que está caído es WhatsApp).
      await sendText(dev.phone, texto).catch((e) =>
        console.error('[alertas] no pude avisar a ' + dev.nombre + ':', (e as Error).message),
      );
    }
    rachas.delete(clave);
    console.log(`[alertas] avisado: ${d.titulo} (${contexto})`);
  } catch (e) {
    console.error('[alertas] fallo interno del alertador:', (e as Error).message);
  }
}
