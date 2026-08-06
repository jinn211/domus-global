import { supabase } from './supabase.js';
import { alertar, avisarDevs } from './alertas.js';

/**
 * Latido: cada pocos minutos confirma que el bot todavía puede hablar con la base.
 *
 * Por qué existe. El resto del sistema solo se entera de una falla cuando algo
 * se ejecuta: llega un mensaje, entra un mail, corre un barrido. Si la base se
 * cae y nadie escribe, no corre nada, no falla nada y no avisa nadie.
 *
 * El 4/8/2026 revocaron la key de Supabase. El bot quedó 25 horas sin poder
 * leer ni escribir: recibió tres fotos, no contestó ninguna, no guardó ninguna,
 * y no mandó una sola alerta. Esto es para que eso no vuelva a pasar.
 *
 * Es deliberadamente lo más tonto posible: una lectura chica y nada más. Un
 * vigilante complicado es un vigilante que se rompe solo y que además hay que
 * vigilar.
 */

const CADA_MS = 5 * 60_000;

let ultimoOk = Date.now();
let caido = false;

async function latir(): Promise<void> {
  // Lectura mínima. A propósito no escribe: el chequeo de salud no puede ser
  // algo que, si sale mal, ensucie los datos.
  const { error } = await supabase.from('categories').select('id').limit(1);

  if (error) {
    const horas = (Date.now() - ultimoOk) / 3_600_000;
    caido = true;
    // alertar() ya trae el anti-spam y el filtro de fallas pasajeras: un corte
    // de red no avisa, una key revocada sí y al toque.
    await alertar('chequeo de conexión a la base', new Error(error.message), {
      'sin conexión desde': new Date(ultimoOk).toLocaleString('es-UY', { timeZone: 'America/Montevideo' }),
      'horas caído': horas.toFixed(1),
    });
    return;
  }

  if (caido) {
    const horas = ((Date.now() - ultimoOk) / 3_600_000).toFixed(1);
    console.log(`[latido] la base volvió tras ${horas}h`);
    await avisarDevs(
      `✅ *La base volvió* — el bot ya puede leer y escribir de nuevo.\n\n` +
        `Estuvo ${horas}h sin conexión. Revisá si quedaron facturas sin registrar en ese rato.`,
    );
  }

  ultimoOk = Date.now();
  caido = false;
}

export function initLatido(): void {
  console.log(`[latido] activo (chequea la base cada ${CADA_MS / 60_000} min)`);
  // Arranca al minuto: si un deploy rompió la configuración, se entera enseguida
  // en vez de esperar el primer ciclo completo.
  setTimeout(() => void latir().catch(() => {}), 60_000);
  setInterval(() => void latir().catch(() => {}), CADA_MS);
}
