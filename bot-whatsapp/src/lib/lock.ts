/**
 * Serializa el trabajo por teléfono dentro del proceso.
 *
 * Lo usan DOS orígenes que pueden tocar la misma sesión a la vez:
 *  - el webhook de WhatsApp (varias fotos/mensajes casi simultáneos), y
 *  - los barridos por timer (recordatorio 2h / auto-guardado 24h).
 * Sin esto, el barrido puede auto-guardar una factura justo mientras el empleado
 * la está confirmando: se registra dos veces o la sesión recién cerrada revive.
 */
const locks = new Map<string, Promise<unknown>>();

export function withPhoneLock<T>(phone: string, fn: () => Promise<T>): Promise<T> {
  const prev = locks.get(phone) ?? Promise.resolve();
  const run = prev.then(fn, fn);
  const tracked = run.catch(() => {});
  locks.set(phone, tracked);
  tracked.then(() => {
    if (locks.get(phone) === tracked) locks.delete(phone);
  });
  return run;
}
