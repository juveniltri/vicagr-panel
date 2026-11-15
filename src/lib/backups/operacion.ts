import { prisma } from "@/lib/prisma";

export const LIMITE_MS = 60 * 60 * 1000;
export const MOTIVO_LIMITE = "Cancelado: superó 60 minutos";

export const motivoCancelacion = (quien: string) => `Cancelado por ${quien}`;

// The reason travels inside the error text, alone or after an element's key
// («bd:db: Cancelado por …»).
export function esCancelacionDelUsuario(error: string): boolean {
  return /(^|: )Cancelado por /m.test(error);
}

// An aborted child process rejects with a generic AbortError; say why instead
// (the time limit or «Cancelado por <usuario>»).
export function motivoDeFallo(err: unknown, signal: AbortSignal): string {
  if (
    err instanceof Error &&
    err.name === "AbortError" &&
    typeof signal.reason === "string"
  ) {
    return signal.reason;
  }
  return err instanceof Error ? err.message : String(err);
}

export class OperacionEnCurso extends Error {
  constructor() {
    super("Ya hay una copia o restauración en curso");
    this.name = "OperacionEnCurso";
  }
}

// NOTE: globalThis because tRPC, server actions and the scheduler live in
// different route bundles but must see the same lock.
const global = globalThis as unknown as { operacionBackup?: AbortController };

export function tomarOperacion(): AbortController {
  if (global.operacionBackup) throw new OperacionEnCurso();
  global.operacionBackup = new AbortController();
  return global.operacionBackup;
}

export function soltarOperacion(): void {
  global.operacionBackup = undefined;
}

// The lock stays taken: the operation releases it once its processes stop.
export function cancelarOperacion(motivo: string): boolean {
  if (!global.operacionBackup) return false;
  global.operacionBackup.abort(motivo);
  return true;
}

export function hayOperacionEnCurso(): boolean {
  return global.operacionBackup !== undefined;
}

// Called at startup: nothing can be running yet, so any en_curso row died
// with the previous process.
export async function limpiarBackupsHuerfanos(motivo: string): Promise<number> {
  const cerrar = (where: object, error: string) =>
    prisma.backup.updateMany({
      where: { resultado: "en_curso", ...where },
      data: { resultado: "error", error, finalizadoEn: new Date() },
    });
  // A restore cut halfway leaves things in a state a plain «interrupted» does
  // not explain: say what may be broken and how to fix it.
  const proyectos = await cerrar(
    { operacion: "restauracion", proyectoId: { not: null } },
    `${motivo}: los datos pueden haber quedado a medias y los Servicios parados. Vuelve a restaurar la misma copia o la copia previa a esta restauración.`,
  );
  const panel = await cerrar(
    { operacion: "restauracion", proyectoId: null },
    `${motivo}: la BD del Panel o la config de Traefik pueden haber quedado a medias. Vuelve a restaurar la misma copia; si el Panel no arranca, sigue docs/recuperacion.md.`,
  );
  const resto = await cerrar({}, motivo);
  const count = proyectos.count + panel.count + resto.count;
  await prisma.elementoCopia.updateMany({
    where: { resultado: "en_curso" },
    data: { resultado: "error", error: motivo },
  });
  return count;
}
