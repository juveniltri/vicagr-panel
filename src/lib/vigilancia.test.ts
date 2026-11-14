import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/prisma", () => ({
  prisma: { proyecto: { findMany: vi.fn(), updateMany: vi.fn() } },
}));
vi.mock("@/lib/docker/proyectos", () => ({ listarServicios: vi.fn() }));
vi.mock("@/lib/backups/restaurando", () => ({ estaRestaurando: vi.fn() }));
vi.mock("@/lib/notificaciones", () => ({ enviarNotificacion: vi.fn() }));

import { estaRestaurando } from "@/lib/backups/restaurando";
import { listarServicios } from "@/lib/docker/proyectos";
import { enviarNotificacion } from "@/lib/notificaciones";
import { prisma } from "@/lib/prisma";
import { olvidarFallos, reconciliarEstados } from "./vigilancia";

type Estado = "running" | "error";
const proyecto = (
  estado: Estado,
  ultimoDeploy: "exito" | "error" | null = "exito",
) => ({
  id: "p1",
  nombre: "web",
  estado,
  cliente: { slug: "acme" },
  deploys: ultimoDeploy ? [{ resultado: ultimoDeploy }] : [],
});
const servicio = (
  nombre: string,
  estado: "running" | "stopped" | "error" | "deploying",
  detalle = "Up 2 hours",
) => ({ servicio: nombre, estado, detalle });

const hay = (p: ReturnType<typeof proyecto>) =>
  vi.mocked(prisma.proyecto.findMany).mockResolvedValue([p] as never);
const docker = (...servicios: ReturnType<typeof servicio>[]) =>
  vi.mocked(listarServicios).mockResolvedValue(servicios);
const estadoGuardado = () =>
  vi.mocked(prisma.proyecto.updateMany).mock.calls.at(-1)?.[0];

describe("reconciliarEstados", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    olvidarFallos();
    vi.mocked(estaRestaurando).mockReturnValue(false);
    vi.mocked(prisma.proyecto.updateMany).mockResolvedValue({ count: 1 });
  });

  it("solo mira los Proyectos en running o error: deploying y stopped no se tocan", async () => {
    vi.mocked(prisma.proyecto.findMany).mockResolvedValue([]);

    await reconciliarEstados();

    expect(vi.mocked(prisma.proyecto.findMany).mock.calls[0][0]?.where).toEqual(
      { estado: { in: ["running", "error"] } },
    );
  });

  it("con todos los Servicios en marcha no cambia nada", async () => {
    hay(proyecto("running"));
    docker(servicio("web", "running"), servicio("migrar", "stopped"));

    await reconciliarEstados();

    expect(prisma.proyecto.updateMany).not.toHaveBeenCalled();
    expect(enviarNotificacion).not.toHaveBeenCalled();
  });

  // One bad reading can be a container between two restarts.
  it("un Servicio caído pasa el Proyecto a error a la segunda comprobación seguida y avisa una sola vez", async () => {
    hay(proyecto("running"));
    docker(
      servicio("web", "running"),
      servicio("worker", "error", "Exited (1) 2 minutes ago"),
    );

    await reconciliarEstados();
    expect(prisma.proyecto.updateMany).not.toHaveBeenCalled();

    await reconciliarEstados();
    expect(estadoGuardado()).toEqual({
      // Only if it is still running: a deploy may have started meanwhile.
      where: { id: "p1", estado: "running" },
      data: { estado: "error" },
    });
    expect(enviarNotificacion).toHaveBeenCalledExactlyOnceWith({
      evento: "servicio",
      proyectoNombre: "web",
      clienteSlug: "acme",
      rama: "—",
      sha: null,
      resultado: "error",
      output: "worker: Exited (1) 2 minutes ago",
    });
  });

  it("un Servicio en bucle de reinicios cuenta como caído", async () => {
    hay(proyecto("running"));
    docker(servicio("web", "deploying", "Restarting (1) 3 seconds ago"));

    await reconciliarEstados();
    await reconciliarEstados();

    expect(estadoGuardado()?.data).toEqual({ estado: "error" });
  });

  it("una lectura buena entre dos malas reinicia la cuenta", async () => {
    hay(proyecto("running"));
    docker(servicio("web", "error", "Exited (1)"));
    await reconciliarEstados();
    docker(servicio("web", "running"));
    await reconciliarEstados();
    docker(servicio("web", "error", "Exited (1)"));
    await reconciliarEstados();

    expect(prisma.proyecto.updateMany).not.toHaveBeenCalled();
  });

  it("no avisa si otro proceso cambió el estado antes (un deploy recién lanzado)", async () => {
    hay(proyecto("running"));
    docker(servicio("web", "error", "Exited (1)"));
    vi.mocked(prisma.proyecto.updateMany).mockResolvedValue({ count: 0 });

    await reconciliarEstados();
    await reconciliarEstados();

    expect(enviarNotificacion).not.toHaveBeenCalled();
  });

  it("un Proyecto running sin ningún Servicio en marcha, parados sin error, pasa a stopped sin avisar", async () => {
    hay(proyecto("running"));
    docker(servicio("web", "stopped", "Exited (143) 1 minute ago"));

    await reconciliarEstados();

    expect(estadoGuardado()?.data).toEqual({ estado: "stopped" });
    expect(enviarNotificacion).not.toHaveBeenCalled();
  });

  it("un Proyecto en error que vuelve a estar en marcha pasa a running y avisa de la recuperación", async () => {
    hay(proyecto("error"));
    docker(servicio("web", "running"));

    await reconciliarEstados();

    expect(estadoGuardado()).toEqual({
      where: { id: "p1", estado: "error" },
      data: { estado: "running" },
    });
    expect(enviarNotificacion).toHaveBeenCalledWith(
      expect.objectContaining({ evento: "servicio", resultado: "exito" }),
    );
  });

  // The old containers keep serving after a failed deploy; "error" there
  // means "look at the deploy", and must stay until someone does.
  it("no saca del error a un Proyecto cuyo último deploy falló", async () => {
    hay(proyecto("error", "error"));
    docker(servicio("web", "running"));

    await reconciliarEstados();

    expect(prisma.proyecto.updateMany).not.toHaveBeenCalled();
  });

  it("un Proyecto ya en error con Servicios caídos no vuelve a avisar", async () => {
    hay(proyecto("error"));
    docker(servicio("web", "error", "Exited (1)"));

    await reconciliarEstados();
    await reconciliarEstados();
    await reconciliarEstados();

    expect(enviarNotificacion).not.toHaveBeenCalled();
  });

  it("no toca un Proyecto que se está restaurando", async () => {
    hay(proyecto("running"));
    vi.mocked(estaRestaurando).mockReturnValue(true);

    await reconciliarEstados();

    expect(listarServicios).not.toHaveBeenCalled();
  });

  it("sin Docker disponible no cambia nada ni falla", async () => {
    hay(proyecto("running"));
    vi.mocked(listarServicios).mockRejectedValue(new Error("ENOENT docker"));

    await expect(reconciliarEstados()).resolves.toBeUndefined();

    expect(prisma.proyecto.updateMany).not.toHaveBeenCalled();
  });

  it("un fallo de la base de datos no tumba el vigilante", async () => {
    vi.mocked(prisma.proyecto.findMany).mockRejectedValue(new Error("db"));

    await expect(reconciliarEstados()).resolves.toBeUndefined();
  });
});
