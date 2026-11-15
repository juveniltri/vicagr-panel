import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/prisma", () => ({
  prisma: { proyecto: { findMany: vi.fn(), updateMany: vi.fn() } },
}));
vi.mock("@/lib/docker/proyectos", () => ({ listarServicios: vi.fn() }));
vi.mock("@/lib/backups/restaurando", () => ({ estaRestaurando: vi.fn() }));
vi.mock("@/lib/notificaciones", () => ({ enviarNotificacion: vi.fn() }));
vi.mock("@/lib/system/metrics", () => ({ obtenerMetricas: vi.fn() }));
vi.mock("@/lib/health", () => ({ comprobarSalud: vi.fn() }));
const { env } = vi.hoisted(() => ({
  env: { LATIDO_URL: undefined as string | undefined },
}));
vi.mock("@/env", () => ({ env }));

import { estaRestaurando } from "@/lib/backups/restaurando";
import { listarServicios } from "@/lib/docker/proyectos";
import { enviarNotificacion } from "@/lib/notificaciones";
import { prisma } from "@/lib/prisma";
import { comprobarSalud } from "@/lib/health";
import { obtenerMetricas } from "@/lib/system/metrics";
import {
  comprobarDisco,
  enviarLatido,
  olvidarFallos,
  reconciliarEstados,
} from "./vigilancia";

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

  // Reiniciar or a deploy from the Panel set running themselves, so the
  // Estado never goes through error -> running here.
  it("avisa de la recuperación aunque se arreglara desde el Panel", async () => {
    hay(proyecto("running"));
    docker(servicio("web", "error", "Exited (1)"));
    await reconciliarEstados();
    await reconciliarEstados();
    vi.mocked(enviarNotificacion).mockClear();

    hay(proyecto("running"));
    docker(servicio("web", "running"));
    await reconciliarEstados();
    await reconciliarEstados();

    expect(enviarNotificacion).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ evento: "servicio", resultado: "exito" }),
    );
  });

  it("un Proyecto en marcha del que no se avisó caída no recibe «recuperado»", async () => {
    hay(proyecto("running"));
    docker(servicio("web", "running"));

    await reconciliarEstados();

    expect(enviarNotificacion).not.toHaveBeenCalled();
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

describe("comprobarDisco", () => {
  const disco = (usado: number) =>
    vi.mocked(obtenerMetricas).mockReturnValue({
      cpu: 1,
      ram: { usado: 1, total: 8, unidad: "GB" },
      disco: { usado, total: 100, unidad: "GB" },
    });

  beforeEach(() => {
    vi.clearAllMocks();
    olvidarFallos();
  });

  it("por debajo del 85 % no avisa", () => {
    disco(84.9);
    comprobarDisco();
    expect(enviarNotificacion).not.toHaveBeenCalled();
  });

  it("al llegar al 85 % avisa una sola vez mientras siga lleno", () => {
    disco(87);
    comprobarDisco();
    comprobarDisco();

    expect(enviarNotificacion).toHaveBeenCalledExactlyOnceWith({
      evento: "disco",
      proyectoNombre: "VPS",
      clienteSlug: "panel",
      rama: "—",
      sha: null,
      resultado: "error",
      output: "Disco al 87 %: 87 de 100 GB ocupados.",
    });
  });

  // Hovering around the threshold must not send a message every minute.
  it("avisa de la recuperación solo al bajar del 80 %", () => {
    disco(87);
    comprobarDisco();
    disco(82);
    comprobarDisco();
    expect(enviarNotificacion).toHaveBeenCalledTimes(1);

    disco(79);
    comprobarDisco();
    expect(enviarNotificacion).toHaveBeenLastCalledWith(
      expect.objectContaining({ evento: "disco", resultado: "exito" }),
    );
  });

  it("si no se pueden leer las métricas no avisa ni falla", () => {
    vi.mocked(obtenerMetricas).mockImplementation(() => {
      throw new Error("statfs");
    });
    expect(() => comprobarDisco()).not.toThrow();
    expect(enviarNotificacion).not.toHaveBeenCalled();
  });
});

// The Panel lives on the VPS it watches: only someone outside can tell that
// it stopped. The heartbeat is what that someone listens for.
describe("enviarLatido", () => {
  const mockFetch = vi.fn();
  const salud = (status: "ok" | "degraded") =>
    vi.mocked(comprobarSalud).mockResolvedValue({ status } as never);

  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal("fetch", mockFetch);
    mockFetch.mockResolvedValue({ ok: true });
    env.LATIDO_URL = "https://hc-ping.com/abc";
  });

  it("sin URL configurada no envía nada", async () => {
    env.LATIDO_URL = undefined;
    await enviarLatido();
    expect(mockFetch).not.toHaveBeenCalled();
    expect(comprobarSalud).not.toHaveBeenCalled();
  });

  it("con el Panel sano llama a la URL", async () => {
    salud("ok");
    await enviarLatido();
    expect(mockFetch).toHaveBeenCalledWith(
      "https://hc-ping.com/abc",
      expect.anything(),
    );
  });

  it("con la base de datos, Docker o Traefik caídos se calla, para que salte el aviso de fuera", async () => {
    salud("degraded");
    await enviarLatido();
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("un fallo de red al enviarlo no tumba el vigilante", async () => {
    salud("ok");
    mockFetch.mockRejectedValue(new Error("ENOTFOUND"));
    await expect(enviarLatido()).resolves.toBeUndefined();
  });
});
