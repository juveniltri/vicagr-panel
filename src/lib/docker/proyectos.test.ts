import { PassThrough } from "stream";
import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  mockStop,
  mockStart,
  mockRestart,
  mockGetContainer,
  mockLogs,
  mockDemuxStream,
  mockListContainers,
  mockRemove,
  mockListNetworks,
  mockListVolumes,
} = vi.hoisted(() => ({
  mockRemove: vi.fn(),
  mockListNetworks: vi.fn(),
  mockListVolumes: vi.fn(),
  mockStop: vi.fn(),
  mockStart: vi.fn(),
  mockRestart: vi.fn(),
  mockGetContainer: vi.fn(),
  mockLogs: vi.fn(),
  mockDemuxStream: vi.fn(),
  mockListContainers: vi.fn(),
}));

vi.mock("dockerode", () => ({
  default: vi.fn().mockImplementation(function () {
    return {
      getContainer: mockGetContainer,
      listContainers: mockListContainers,
      listNetworks: mockListNetworks,
      listVolumes: mockListVolumes,
      getNetwork: (id: string) => ({ remove: () => mockRemove("red", id) }),
      getVolume: (id: string) => ({ remove: () => mockRemove("volumen", id) }),
      modem: { demuxStream: mockDemuxStream },
    };
  }),
}));

vi.mock("@/env", () => ({
  env: { DOCKER_SOCKET_PATH: "/var/run/docker.sock" },
}));

import {
  DockerError,
  detenerProyecto,
  eliminarContenedoresProyecto,
  estadoContenedores,
  iniciarProyecto,
  listarServicios,
  restartProyecto,
  streamProyectoLogs,
} from "./proyectos";

const makeContainer = (
  id: string,
  serviceName: string,
  extraLabels: Record<string, string> = {},
) => ({
  Id: id,
  Names: [`/${id}`],
  Labels: {
    "com.docker.compose.project": "cliente-uno-web-app",
    "com.docker.compose.service": serviceName,
    ...extraLabels,
  },
});

describe("detenerProyecto", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetContainer.mockReturnValue({
      stop: mockStop,
      start: mockStart,
      logs: mockLogs,
    });
    mockStop.mockResolvedValue(undefined);
    mockStart.mockResolvedValue(undefined);
  });

  it("queries containers by compose project label", async () => {
    mockListContainers.mockResolvedValue([makeContainer("c1", "nginx")]);
    await detenerProyecto("cliente-uno", "web-app");

    expect(mockListContainers).toHaveBeenCalledWith(
      expect.objectContaining({
        filters: {
          label: ["com.docker.compose.project=cliente-uno-web-app"],
        },
      }),
    );
  });

  it("stops each container found by label", async () => {
    mockListContainers.mockResolvedValue([
      makeContainer("c1", "nginx"),
      makeContainer("c2", "node"),
    ]);
    await detenerProyecto("cliente-uno", "web-app");

    expect(mockGetContainer).toHaveBeenCalledWith("c1");
    expect(mockGetContainer).toHaveBeenCalledWith("c2");
    expect(mockStop).toHaveBeenCalledTimes(2);
  });

  it("ignores 304 (container already stopped)", async () => {
    mockListContainers.mockResolvedValue([makeContainer("c1", "nginx")]);
    mockStop.mockRejectedValueOnce({ statusCode: 304 });

    await expect(
      detenerProyecto("cliente-uno", "web-app"),
    ).resolves.toBeUndefined();
  });

  it("throws DockerError NOT_FOUND on 404", async () => {
    mockListContainers.mockResolvedValue([makeContainer("c1", "nginx")]);
    mockStop.mockRejectedValueOnce({ statusCode: 404 });

    const err = await detenerProyecto("cliente-uno", "web-app").catch((e) => e);

    expect(err).toBeInstanceOf(DockerError);
    expect(err.code).toBe("NOT_FOUND");
  });

  it("throws DockerError UNKNOWN on unexpected errors", async () => {
    mockListContainers.mockResolvedValue([makeContainer("c1", "nginx")]);
    mockStop.mockRejectedValueOnce(new Error("daemon error"));

    const err = await detenerProyecto("cliente-uno", "web-app").catch((e) => e);

    expect(err).toBeInstanceOf(DockerError);
    expect(err.code).toBe("UNKNOWN");
  });

  it("does nothing when no containers found", async () => {
    mockListContainers.mockResolvedValue([]);
    await expect(
      detenerProyecto("cliente-uno", "web-app"),
    ).resolves.toBeUndefined();
    expect(mockStop).not.toHaveBeenCalled();
  });
});

describe("iniciarProyecto", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetContainer.mockReturnValue({
      stop: mockStop,
      start: mockStart,
      logs: mockLogs,
    });
    mockStop.mockResolvedValue(undefined);
    mockStart.mockResolvedValue(undefined);
  });

  it("queries all containers (including stopped) by compose project label", async () => {
    mockListContainers.mockResolvedValue([makeContainer("c1", "nginx")]);
    await iniciarProyecto("cliente-uno", "web-app");

    expect(mockListContainers).toHaveBeenCalledWith(
      expect.objectContaining({ all: true }),
    );
  });

  it("starts each container found by label", async () => {
    mockListContainers.mockResolvedValue([
      makeContainer("c1", "nginx"),
      makeContainer("c2", "node"),
    ]);
    await iniciarProyecto("cliente-uno", "web-app");

    expect(mockGetContainer).toHaveBeenCalledWith("c1");
    expect(mockGetContainer).toHaveBeenCalledWith("c2");
    expect(mockStart).toHaveBeenCalledTimes(2);
  });

  it("ignores 304 (container already running)", async () => {
    mockListContainers.mockResolvedValue([makeContainer("c1", "nginx")]);
    mockStart.mockRejectedValueOnce({ statusCode: 304 });

    await expect(
      iniciarProyecto("cliente-uno", "web-app"),
    ).resolves.toBeUndefined();
  });

  it("throws DockerError NOT_FOUND on 404", async () => {
    mockListContainers.mockResolvedValue([makeContainer("c1", "nginx")]);
    mockStart.mockRejectedValueOnce({ statusCode: 404 });

    const err = await iniciarProyecto("cliente-uno", "web-app").catch((e) => e);

    expect(err).toBeInstanceOf(DockerError);
    expect(err.code).toBe("NOT_FOUND");
  });

  it("throws DockerError UNKNOWN on unexpected errors", async () => {
    mockListContainers.mockResolvedValue([makeContainer("c1", "nginx")]);
    mockStart.mockRejectedValueOnce(new Error("daemon error"));

    const err = await iniciarProyecto("cliente-uno", "web-app").catch((e) => e);

    expect(err).toBeInstanceOf(DockerError);
    expect(err.code).toBe("UNKNOWN");
  });
});

describe("restartProyecto", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetContainer.mockReturnValue({
      stop: mockStop,
      start: mockStart,
      restart: mockRestart,
      logs: mockLogs,
    });
    mockRestart.mockResolvedValue(undefined);
  });

  it("llama a restart en cada contenedor en marcha", async () => {
    mockListContainers.mockResolvedValue([
      makeContainer("c1", "nginx"),
      makeContainer("c2", "node"),
    ]);
    await restartProyecto("cliente-uno", "web-app");

    expect(mockGetContainer).toHaveBeenCalledWith("c1");
    expect(mockGetContainer).toHaveBeenCalledWith("c2");
    expect(mockRestart).toHaveBeenCalledTimes(2);
    expect(mockStop).not.toHaveBeenCalled();
    expect(mockStart).not.toHaveBeenCalled();
  });

  // A crashed container is exactly what Reiniciar is pressed for; a one-shot
  // job that finished (migrations) must not run again.
  it("levanta también los contenedores caídos, pero no repite los que terminaron bien", async () => {
    mockListContainers.mockResolvedValue([
      { ...makeContainer("c1", "web"), State: "running", Status: "Up 2 hours" },
      {
        ...makeContainer("c2", "worker"),
        State: "exited",
        Status: "Exited (1) 5 minutes ago",
      },
      {
        ...makeContainer("c3", "migrar"),
        State: "exited",
        Status: "Exited (0) 2 hours ago",
      },
    ]);
    await restartProyecto("cliente-uno", "web-app");

    expect(mockListContainers).toHaveBeenCalledWith(
      expect.objectContaining({ all: true }),
    );
    expect(mockGetContainer.mock.calls.map(([id]) => id)).toEqual(["c1", "c2"]);
  });

  it("al reiniciar un Servicio concreto lo arranca aunque estuviera parado", async () => {
    mockListContainers.mockResolvedValue([
      {
        ...makeContainer("c3", "web"),
        State: "exited",
        Status: "Exited (143) 2 hours ago",
      },
    ]);
    await restartProyecto("cliente-uno", "web-app", "web");

    expect(mockGetContainer).toHaveBeenCalledWith("c3");
  });

  it("ignora 304 en restart", async () => {
    mockListContainers.mockResolvedValue([makeContainer("c1", "nginx")]);
    mockRestart.mockRejectedValueOnce({ statusCode: 304 });

    await expect(
      restartProyecto("cliente-uno", "web-app"),
    ).resolves.toBeUndefined();
  });

  it("lanza DockerError NOT_FOUND en 404", async () => {
    mockListContainers.mockResolvedValue([makeContainer("c1", "nginx")]);
    mockRestart.mockRejectedValueOnce({ statusCode: 404 });

    const err = await restartProyecto("cliente-uno", "web-app").catch((e) => e);

    expect(err).toBeInstanceOf(DockerError);
    expect(err.code).toBe("NOT_FOUND");
  });

  it("lanza DockerError UNKNOWN en error inesperado", async () => {
    mockListContainers.mockResolvedValue([makeContainer("c1", "nginx")]);
    mockRestart.mockRejectedValueOnce(new Error("daemon error"));

    const err = await restartProyecto("cliente-uno", "web-app").catch((e) => e);

    expect(err).toBeInstanceOf(DockerError);
    expect(err.code).toBe("UNKNOWN");
  });
});

describe("acciones sobre un servicio", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetContainer.mockReturnValue({
      stop: mockStop,
      start: mockStart,
      restart: mockRestart,
    });
    mockListContainers.mockResolvedValue([makeContainer("c1", "worker")]);
  });

  const filtroServicio = {
    label: [
      "com.docker.compose.project=cliente-uno-web-app",
      "com.docker.compose.service=worker",
    ],
  };

  it("iniciarProyecto filtra también por la etiqueta del servicio", async () => {
    await iniciarProyecto("cliente-uno", "web-app", "worker");

    expect(mockListContainers).toHaveBeenCalledWith({
      all: true,
      filters: filtroServicio,
    });
    expect(mockStart).toHaveBeenCalledTimes(1);
  });

  it("detenerProyecto filtra también por la etiqueta del servicio", async () => {
    await detenerProyecto("cliente-uno", "web-app", "worker");

    expect(mockListContainers).toHaveBeenCalledWith({
      all: false,
      filters: filtroServicio,
    });
    expect(mockStop).toHaveBeenCalledTimes(1);
  });

  it("restartProyecto filtra también por la etiqueta del servicio", async () => {
    await restartProyecto("cliente-uno", "web-app", "worker");

    expect(mockListContainers).toHaveBeenCalledWith({
      all: true,
      filters: filtroServicio,
    });
    expect(mockRestart).toHaveBeenCalledTimes(1);
  });
});

describe("listarServicios", () => {
  beforeEach(() => vi.clearAllMocks());

  const contenedor = (
    id: string,
    servicio: string | undefined,
    State: string,
    Status: string,
  ) => ({
    Id: id,
    Names: [`/${id}`],
    State,
    Status,
    Labels: servicio ? { "com.docker.compose.service": servicio } : {},
  });

  it("consulta todos los contenedores del proyecto, también los parados", async () => {
    mockListContainers.mockResolvedValue([]);

    await expect(listarServicios("cliente-uno", "web-app")).resolves.toEqual(
      [],
    );
    expect(mockListContainers).toHaveBeenCalledWith({
      all: true,
      filters: { label: ["com.docker.compose.project=cliente-uno-web-app"] },
    });
  });

  // Docker has no "stopped on purpose" flag. 0 is a clean exit (one-shot jobs,
  // migrations); 143 and 137 are what `docker stop` leaves behind.
  it.each([
    ["Exited (1) 5 minutes ago", "error"],
    ["Exited (139) 2 hours ago", "error"],
    ["Exited (0) 5 minutes ago", "stopped"],
    ["Exited (143) 5 minutes ago", "stopped"],
    ["Exited (137) 5 minutes ago", "stopped"],
  ])("un contenedor con «%s» cuenta como %s", async (Status, estado) => {
    mockListContainers.mockResolvedValue([
      contenedor("c1", "web", "exited", Status),
    ]);

    const [servicio] = await listarServicios("cliente-uno", "web-app");

    expect(servicio.estado).toBe(estado);
  });

  it("devuelve un servicio por etiqueta, ordenado, con su estado y el detalle de Docker", async () => {
    mockListContainers.mockResolvedValue([
      contenedor("c1", "web", "running", "Up 2 hours"),
      contenedor("c2", "db", "running", "Up 2 hours (healthy)"),
      contenedor("c3", "worker", "exited", "Exited (0) 5 minutes ago"),
    ]);

    await expect(listarServicios("cliente-uno", "web-app")).resolves.toEqual([
      { servicio: "db", estado: "running", detalle: "Up 2 hours (healthy)" },
      { servicio: "web", estado: "running", detalle: "Up 2 hours" },
      {
        servicio: "worker",
        estado: "stopped",
        detalle: "Exited (0) 5 minutes ago",
      },
    ]);
  });

  it("marca como error un contenedor unhealthy o muerto, y como deploying uno reiniciándose", async () => {
    mockListContainers.mockResolvedValue([
      contenedor("c1", "api", "running", "Up 1 minute (unhealthy)"),
      contenedor("c2", "cola", "dead", "Dead"),
      contenedor("c3", "web", "restarting", "Restarting (1) 3 seconds ago"),
    ]);

    const servicios = await listarServicios("cliente-uno", "web-app");

    expect(servicios.map((s) => [s.servicio, s.estado])).toEqual([
      ["api", "error"],
      ["cola", "error"],
      ["web", "deploying"],
    ]);
  });

  it("con varias réplicas de un servicio prima el peor estado", async () => {
    mockListContainers.mockResolvedValue([
      contenedor("c1", "web", "running", "Up 2 hours"),
      contenedor("c2", "web", "exited", "Exited (137) 1 minute ago"),
    ]);

    await expect(listarServicios("cliente-uno", "web-app")).resolves.toEqual([
      {
        servicio: "web",
        estado: "stopped",
        detalle: "Exited (137) 1 minute ago",
      },
    ]);
  });

  it("usa el nombre del contenedor si no tiene etiqueta de servicio", async () => {
    mockListContainers.mockResolvedValue([
      contenedor("c1", undefined, "running", "Up 1 second"),
    ]);

    const [servicio] = await listarServicios("cliente-uno", "web-app");

    expect(servicio?.servicio).toBe("c1");
  });
});

describe("streamProyectoLogs", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetContainer.mockReturnValue({
      stop: mockStop,
      start: mockStart,
      logs: mockLogs,
    });
    mockDemuxStream.mockImplementation(
      (stream: NodeJS.ReadableStream, stdout: NodeJS.WritableStream) => {
        (stream as PassThrough).pipe(stdout as PassThrough);
      },
    );
  });

  it("calls onLine with service name from compose label", async () => {
    mockListContainers.mockResolvedValue([makeContainer("c1", "nginx")]);
    const mockStream = new PassThrough();
    mockLogs.mockResolvedValue(mockStream);
    const onLine = vi.fn();
    const controller = new AbortController();

    const promise = streamProyectoLogs(
      "cliente-uno",
      "web-app",
      onLine,
      controller.signal,
    );

    mockStream.write("server started\n");
    mockStream.write("listening on port 80\n");
    mockStream.end();

    await promise;

    expect(onLine).toHaveBeenCalledWith("nginx", "server started");
    expect(onLine).toHaveBeenCalledWith("nginx", "listening on port 80");
    expect(onLine).toHaveBeenCalledTimes(2);
  });

  it("falls back to container name when compose service label is missing", async () => {
    const containerWithoutServiceLabel = {
      Id: "c1",
      Names: ["/mycontainer"],
      Labels: { "com.docker.compose.project": "cliente-uno-web-app" },
    };
    mockListContainers.mockResolvedValue([containerWithoutServiceLabel]);
    const mockStream = new PassThrough();
    mockLogs.mockResolvedValue(mockStream);
    const onLine = vi.fn();
    const controller = new AbortController();

    const promise = streamProyectoLogs(
      "cliente-uno",
      "web-app",
      onLine,
      controller.signal,
    );

    mockStream.write("log line\n");
    mockStream.end();

    await promise;

    expect(onLine).toHaveBeenCalledWith("/mycontainer", "log line");
  });

  it("streams logs from multiple containers with correct service labels", async () => {
    mockListContainers.mockResolvedValue([
      makeContainer("c1", "nginx"),
      makeContainer("c2", "node"),
    ]);
    const streamA = new PassThrough();
    const streamB = new PassThrough();
    mockLogs.mockResolvedValueOnce(streamA).mockResolvedValueOnce(streamB);
    const onLine = vi.fn();
    const controller = new AbortController();

    const promise = streamProyectoLogs(
      "cliente-uno",
      "web-app",
      onLine,
      controller.signal,
    );

    streamA.write("nginx log\n");
    streamA.end();
    streamB.write("node log\n");
    streamB.end();

    await promise;

    expect(onLine).toHaveBeenCalledWith("nginx", "nginx log");
    expect(onLine).toHaveBeenCalledWith("node", "node log");
  });

  it("skips container silently when it is not found (404)", async () => {
    mockListContainers.mockResolvedValue([makeContainer("c1", "nginx")]);
    mockLogs.mockRejectedValue({ statusCode: 404 });
    const onLine = vi.fn();
    const controller = new AbortController();

    await expect(
      streamProyectoLogs("cliente-uno", "web-app", onLine, controller.signal),
    ).resolves.toStrictEqual({ sinContenedores: false });

    expect(onLine).not.toHaveBeenCalled();
  });

  it("rethrows non-404 error from container.logs()", async () => {
    mockListContainers.mockResolvedValue([makeContainer("c1", "nginx")]);
    mockLogs.mockRejectedValue(new Error("daemon unavailable"));
    const controller = new AbortController();

    await expect(
      streamProyectoLogs("cliente-uno", "web-app", vi.fn(), controller.signal),
    ).rejects.toThrow("daemon unavailable");
  });

  it("rejects when the log stream emits an error event", async () => {
    mockListContainers.mockResolvedValue([makeContainer("c1", "nginx")]);
    const mockStream = new PassThrough();
    mockLogs.mockResolvedValue(mockStream);
    const controller = new AbortController();

    const promise = streamProyectoLogs(
      "cliente-uno",
      "web-app",
      vi.fn(),
      controller.signal,
    );

    mockStream.destroy(new Error("stream broken"));

    await expect(promise).rejects.toThrow("stream broken");
  });

  it("stops streaming when AbortSignal is triggered", async () => {
    mockListContainers.mockResolvedValue([makeContainer("c1", "nginx")]);
    const mockStream = new PassThrough();
    mockLogs.mockResolvedValue(mockStream);
    const destroySpy = vi.spyOn(mockStream, "destroy");
    const onLine = vi.fn();
    const controller = new AbortController();

    const promise = streamProyectoLogs(
      "cliente-uno",
      "web-app",
      onLine,
      controller.signal,
    );

    // Wait for listProjectContainers + container.logs() to both resolve
    await new Promise((r) => setTimeout(r, 0));
    controller.abort();

    await promise;

    expect(destroySpy).toHaveBeenCalled();
  });

  it("resuelve con sinContenedores:true cuando no hay contenedores activos", async () => {
    mockListContainers.mockResolvedValue([]);
    const controller = new AbortController();

    await expect(
      streamProyectoLogs("cliente-uno", "web-app", vi.fn(), controller.signal),
    ).resolves.toStrictEqual({ sinContenedores: true });
  });
});

describe("estadoContenedores", () => {
  beforeEach(() => vi.clearAllMocks());

  it("devuelve running si algún contenedor del proyecto está corriendo", async () => {
    mockListContainers.mockResolvedValue([makeContainer("c1", "web")]);

    expect(await estadoContenedores("cliente-uno", "web-app")).toBe("running");
    expect(mockListContainers).toHaveBeenCalledWith({
      all: false,
      filters: { label: ["com.docker.compose.project=cliente-uno-web-app"] },
    });
  });

  it("devuelve stopped si no hay contenedores corriendo", async () => {
    mockListContainers.mockResolvedValue([]);
    expect(await estadoContenedores("cliente-uno", "web-app")).toBe("stopped");
  });
});

describe("eliminarContenedoresProyecto", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.unstubAllEnvs();
    mockGetContainer.mockImplementation((id: string) => ({
      remove: (opts: unknown) => mockRemove("contenedor", id, opts),
    }));
    mockListContainers.mockResolvedValue([
      makeContainer("c1", "web"),
      makeContainer("c2", "db"),
    ]);
    mockListNetworks.mockResolvedValue([{ Id: "n1" }]);
    mockListVolumes.mockResolvedValue({ Volumes: [{ Name: "acme_pgdata" }] });
  });

  const filtro = {
    filters: { label: ["com.docker.compose.project=cliente-uno-web-app"] },
  };

  it("borra todos los contenedores del Proyecto, parados incluidos, y su red de compose", async () => {
    await eliminarContenedoresProyecto("cliente-uno", "web-app");

    expect(mockListContainers).toHaveBeenCalledWith({ all: true, ...filtro });
    expect(mockRemove).toHaveBeenCalledWith("contenedor", "c1", {
      force: true,
    });
    expect(mockRemove).toHaveBeenCalledWith("contenedor", "c2", {
      force: true,
    });
    expect(mockRemove).toHaveBeenCalledWith("red", "n1");
  });

  it("no toca los volúmenes con nombre si no se pide: son los datos del Proyecto", async () => {
    await eliminarContenedoresProyecto("cliente-uno", "web-app");

    expect(mockListVolumes).not.toHaveBeenCalled();
  });

  it("con volumenes: true borra también los volúmenes con nombre del Proyecto", async () => {
    await eliminarContenedoresProyecto("cliente-uno", "web-app", {
      volumenes: true,
    });

    expect(mockListVolumes).toHaveBeenCalledWith(filtro);
    expect(mockRemove).toHaveBeenCalledWith("volumen", "acme_pgdata");
  });

  it("con volumenes: true y ninguno que borrar no falla", async () => {
    mockListVolumes.mockResolvedValue({ Volumes: null });

    await expect(
      eliminarContenedoresProyecto("cliente-uno", "web-app", {
        volumenes: true,
      }),
    ).resolves.toBeUndefined();
  });

  it("sin Docker en desarrollo no falla; en producción sí, para no borrar el Proyecto dejando contenedores", async () => {
    mockListContainers.mockRejectedValue(new Error("ENOENT docker.sock"));

    await expect(
      eliminarContenedoresProyecto("cliente-uno", "web-app"),
    ).resolves.toBeUndefined();

    vi.stubEnv("NODE_ENV", "production");
    await expect(
      eliminarContenedoresProyecto("cliente-uno", "web-app"),
    ).rejects.toThrow();
    vi.unstubAllEnvs();
  });
});
