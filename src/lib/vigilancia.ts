import { env } from "@/env";
import { estaRestaurando } from "@/lib/backups/restaurando";
import { listarServicios } from "@/lib/docker/proyectos";
import { comprobarSalud } from "@/lib/health";
import { logger } from "@/lib/logger";
import { enviarNotificacion } from "@/lib/notificaciones";
import { prisma } from "@/lib/prisma";
import { obtenerMetricas } from "@/lib/system/metrics";

const log = logger.child({ module: "vigilancia" });

// One bad reading can be a container between two restarts: a Proyecto is only
// marked after this many in a row.
const LECTURAS_PARA_ERROR = 2;

const global = globalThis as unknown as {
  vigilancia?: NodeJS.Timeout;
  fallosVigilancia?: Map<string, number>;
  discoAvisado?: boolean;
  caidosAvisados?: Set<string>;
};
const fallos = (global.fallosVigilancia ??= new Map<string, number>());
// Proyectos with a «caído» sent and no «recuperado» yet. Fixing one from the
// Panel (Reiniciar, a deploy) marks it running directly, so the Estado alone
// would never show the way back to whoever got the first message.
const avisados = (global.caidosAvisados ??= new Set<string>());

export function olvidarFallos(): void {
  fallos.clear();
  avisados.clear();
  global.discoAvisado = false;
}

// A full disk takes databases and deploys down with it. The gap between the
// two thresholds keeps a disk hovering around 85 % from messaging every minute.
const DISCO_AVISO = 85;
const DISCO_RECUPERADO = 80;

export function comprobarDisco(): void {
  let disco;
  try {
    ({ disco } = obtenerMetricas());
  } catch {
    return;
  }
  const porcentaje = (disco.usado / disco.total) * 100;
  const avisar = (resultado: "exito" | "error") =>
    void enviarNotificacion({
      evento: "disco",
      proyectoNombre: "VPS",
      clienteSlug: "panel",
      rama: "—",
      sha: null,
      resultado,
      output: `Disco al ${Math.round(porcentaje)} %: ${disco.usado} de ${disco.total} ${disco.unidad} ocupados.`,
    });
  if (!global.discoAvisado && porcentaje >= DISCO_AVISO) {
    global.discoAvisado = true;
    avisar("error");
  } else if (global.discoAvisado && porcentaje < DISCO_RECUPERADO) {
    global.discoAvisado = false;
    avisar("exito");
  }
}

// The Panel lives on the VPS it watches, so it cannot report its own death:
// an outside service (healthchecks.io…) expects this call every minute and
// alerts when it stops. Silent while unhealthy, so that also raises the alert.
export async function enviarLatido(): Promise<void> {
  if (!env.LATIDO_URL) return;
  try {
    if ((await comprobarSalud()).status !== "ok") return;
    await fetch(env.LATIDO_URL, { signal: AbortSignal.timeout(10_000) });
  } catch (err) {
    log.warn({ err }, "No se pudo enviar el latido");
  }
}

// The Estado in the database only changes with actions taken in the Panel.
// This compares it with Docker so a container that dies on its own shows up,
// and tells the notification channels when a Proyecto falls or recovers.
export async function reconciliarEstados(): Promise<void> {
  try {
    const proyectos = await prisma.proyecto.findMany({
      // deploying belongs to the deploy; stopped was asked for.
      where: { estado: { in: ["running", "error"] } },
      select: {
        id: true,
        nombre: true,
        estado: true,
        cliente: { select: { slug: true } },
        deploys: {
          orderBy: { iniciadoEn: "desc" },
          take: 1,
          select: { resultado: true },
        },
      },
    });

    for (const p of proyectos) {
      if (estaRestaurando(p.id)) continue;
      const servicios = await listarServicios(p.cliente.slug, p.nombre);
      const caidos = servicios.filter(
        // "deploying" is Docker's restarting: a crash loop.
        (s) => s.estado === "error" || s.estado === "deploying",
      );
      const enMarcha = servicios.some((s) => s.estado === "running");

      // Conditional on the Estado just read: a deploy may have started since.
      const cambiar = async (estado: "running" | "stopped" | "error") =>
        (
          await prisma.proyecto.updateMany({
            where: { id: p.id, estado: p.estado },
            data: { estado },
          })
        ).count === 1;
      const avisar = (resultado: "exito" | "error", output: string) =>
        void enviarNotificacion({
          evento: "servicio",
          proyectoNombre: p.nombre,
          clienteSlug: p.cliente.slug,
          rama: "—",
          sha: null,
          resultado,
          output,
        });

      if (caidos.length > 0) {
        const lecturas = (fallos.get(p.id) ?? 0) + 1;
        fallos.set(p.id, lecturas);
        if (
          p.estado === "running" &&
          lecturas >= LECTURAS_PARA_ERROR &&
          (await cambiar("error"))
        ) {
          avisados.add(p.id);
          avisar(
            "error",
            caidos.map((s) => `${s.servicio}: ${s.detalle}`).join("\n"),
          );
        }
        continue;
      }
      fallos.delete(p.id);

      const recuperado = () => {
        avisados.delete(p.id);
        avisar("exito", "Todos los Servicios vuelven a estar en marcha.");
      };
      if (p.estado === "running" && !enMarcha) {
        await cambiar("stopped");
      } else if (p.estado === "running" && avisados.has(p.id)) {
        recuperado();
      } else if (
        p.estado === "error" &&
        enMarcha &&
        // After a failed deploy the old containers keep serving; that "error"
        // means "look at the deploy" and stays until someone does.
        p.deploys[0]?.resultado === "exito" &&
        (await cambiar("running"))
      ) {
        recuperado();
      }
    }
  } catch (err) {
    // Docker or the database down: nothing to compare against this minute.
    log.warn({ err }, "No se pudo comprobar el estado de los Proyectos");
  }
}

export function iniciarVigilancia(): void {
  if (global.vigilancia) return;
  global.vigilancia = setInterval(() => {
    void reconciliarEstados();
    comprobarDisco();
    void enviarLatido();
  }, 60_000);
}
