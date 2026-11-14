import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  mockExecFile,
  mockExecFileOpts,
  mockSpawn,
  mockWriteFile,
  mockMkdir,
  mockUnlink,
  mockListContainers,
  mockConnect,
  mockGetNetwork,
  mockReadFile,
} = vi.hoisted(() => {
  const execFileMock = vi.fn();
  const execFileOptsMock = vi.fn();
  // Attach the custom promisify symbol so promisify(execFileMock) returns { stdout, stderr }
  const customSymbol = Symbol.for("nodejs.util.promisify.custom");
  (execFileMock as unknown as Record<symbol, (...args: unknown[]) => unknown>)[
    customSymbol
  ] = (
    cmd: unknown,
    args: unknown,
    opts?: unknown,
  ): Promise<{ stdout: string; stderr: string }> =>
    new Promise((resolve, reject) => {
      execFileOptsMock(cmd, args, opts);
      execFileMock(
        cmd,
        args,
        (err: Error | null, stdout: string, stderr: string) => {
          if (err) reject(err);
          else resolve({ stdout, stderr });
        },
      );
    });

  const makeSpawnResult = (exitCode = 0) => ({
    stdout: { on: vi.fn() },
    stderr: { on: vi.fn() },
    on: vi
      .fn()
      .mockImplementation(
        (event: string, cb: (arg: unknown) => void) =>
          event === "close" && setImmediate(() => cb(exitCode)),
      ),
  });
  const spawnMock = vi.fn().mockImplementation(() => makeSpawnResult(0));
  (spawnMock as unknown as { _make: typeof makeSpawnResult })._make =
    makeSpawnResult;

  return {
    mockExecFile: execFileMock,
    mockExecFileOpts: execFileOptsMock,
    mockSpawn: spawnMock,
    mockWriteFile: vi.fn().mockResolvedValue(undefined),
    mockMkdir: vi.fn().mockResolvedValue(undefined),
    mockUnlink: vi.fn().mockResolvedValue(undefined),
    mockReadFile: vi.fn().mockResolvedValue(""),
    mockListContainers: vi.fn().mockResolvedValue([]),
    mockConnect: vi.fn().mockResolvedValue(undefined),
    mockGetNetwork: vi.fn(),
  };
});

const { mockReaddir, mockEjecutar, mockEncadenar } = vi.hoisted(() => ({
  // Not empty by default: only an empty volume is seeded.
  mockReaddir: vi.fn().mockResolvedValue(["ya-hay-datos"]),
  mockEjecutar: vi.fn().mockResolvedValue(""),
  mockEncadenar: vi.fn().mockResolvedValue(""),
}));

vi.mock("@/lib/backups/procesos", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/backups/procesos")>()),
  ejecutar: mockEjecutar,
  encadenar: mockEncadenar,
}));

vi.mock("node:child_process", () => ({
  execFile: mockExecFile,
  spawn: mockSpawn,
}));
vi.mock("node:fs/promises", () => ({
  writeFile: mockWriteFile,
  mkdir: mockMkdir,
  unlink: mockUnlink,
  readFile: mockReadFile,
  readdir: mockReaddir,
}));
vi.mock("@/env", () => ({
  env: {
    REPOS_DIR: "/var/vicagr/repos",
    DOCKER_SOCKET_PATH: "/var/run/docker.sock",
    NODE_ENV: "test",
  },
}));
vi.mock("dockerode", () => ({
  default: vi.fn().mockImplementation(function () {
    return {
      listContainers: mockListContainers,
      getNetwork: mockGetNetwork,
    };
  }),
}));

import { ErrorProceso } from "@/lib/backups/procesos";
import { deployProyecto, TIEMPOS_SALUD } from "./deploy";

// No waiting in tests; the ones about the wait set their own times.
const sinEspera = { observacionMs: 0, intervaloMs: 0, maximoMs: 1000 };
Object.assign(TIEMPOS_SALUD, sinEspera);

const makeSpawnResult = (
  mockSpawn as unknown as { _make: (exitCode?: number) => object }
)._make;

const baseParams = {
  tipo: "compose",
  repoUrl: "https://github.com/org/repo",
  rama: "main",
  clienteSlug: "acme",
  proyectoNombre: "web-app",
};

describe("deployProyecto", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockWriteFile.mockResolvedValue(undefined);
    mockMkdir.mockResolvedValue(undefined);
    mockListContainers.mockResolvedValue([]);
    mockGetNetwork.mockReturnValue({ connect: mockConnect });
    mockSpawn.mockImplementation(() => makeSpawnResult(0));
    mockExecFile.mockImplementation(
      (
        _cmd: string,
        _args: string[],
        cb: (err: null, stdout: string, stderr: string) => void,
      ) => cb(null, "", ""),
    );
  });

  it("ejecuta docker compose con -p projectSlug y sin override de red", async () => {
    await deployProyecto(baseParams);

    expect(mockSpawn).toHaveBeenCalledWith(
      "docker",
      expect.arrayContaining(["-p", "acme-web-app"]),
      expect.anything(),
    );
    const spawnArgs = mockSpawn.mock.calls[0][1] as string[];
    expect(
      spawnArgs.some((a) => a.includes("docker-compose.network.yml")),
    ).toBe(false);
  });

  it("no escribe ningún archivo override de red", async () => {
    await deployProyecto(baseParams);

    const writeFileCalls = vi.mocked(mockWriteFile).mock.calls;
    const overrideCall = writeFileCalls.find((c) =>
      String(c[0]).includes("network.yml"),
    );
    expect(overrideCall).toBeUndefined();
  });

  it("conecta los contenedores del proyecto a la red del cliente tras el deploy", async () => {
    mockListContainers.mockResolvedValue([{ Id: "c1", Names: ["/web"] }]);

    await deployProyecto(baseParams);

    expect(mockListContainers).toHaveBeenCalledWith(
      expect.objectContaining({
        filters: {
          label: ["com.docker.compose.project=acme-web-app"],
        },
      }),
    );
    expect(mockConnect).toHaveBeenCalledWith({
      Container: "c1",
      EndpointConfig: { Aliases: ["acme-web-app"] },
    });
  });

  it("un Proyecto de tipo image también se conecta a la red del Cliente", async () => {
    mockListContainers.mockResolvedValue([{ Id: "c1", Names: ["/app"] }]);

    await deployProyecto({
      ...baseParams,
      tipo: "image",
      repoUrl: null,
      imagenUrl: "ghost:5-alpine",
      puerto: 2368,
    });

    expect(mockConnect).toHaveBeenCalledWith({
      Container: "c1",
      EndpointConfig: { Aliases: ["acme-web-app"] },
    });
  });

  it("anuncia en el log la fase de red y proxy antes de terminar", async () => {
    const onLog = vi.fn();
    await deployProyecto({ ...baseParams, onLog });

    const lineas = onLog.mock.calls.map(([l]) => l as string);
    const red = lineas.indexOf("→ Conectando red y proxy...");
    expect(red).toBeGreaterThan(-1);
    expect(red).toBeLessThan(lineas.indexOf("✓ Deploy completado"));
  });

  it("ignora silenciosamente el error 'already exists' al conectar a la red", async () => {
    mockListContainers.mockResolvedValue([{ Id: "c1", Names: ["/web"] }]);
    mockConnect.mockRejectedValueOnce(new Error("already exists in network"));

    await expect(deployProyecto(baseParams)).resolves.toBeDefined();
  });

  it("solo alía al contenedor que expone el puerto configurado, no a todo el stack", async () => {
    mockListContainers.mockResolvedValue([
      { Id: "c-db", Names: ["/db"], Ports: [{ PrivatePort: 5432 }] },
      { Id: "c-web", Names: ["/web"], Ports: [{ PrivatePort: 8000 }] },
      { Id: "c-worker", Names: ["/worker"], Ports: [] },
    ]);

    await deployProyecto({ ...baseParams, puerto: 8000 });

    expect(mockConnect).toHaveBeenCalledTimes(1);
    expect(mockConnect).toHaveBeenCalledWith({
      Container: "c-web",
      EndpointConfig: { Aliases: ["acme-web-app"] },
    });
  });

  it("distingue por nombre de servicio cuando varios contenedores comparten imagen y puerto expuesto", async () => {
    // web/worker/beat construidos del mismo Dockerfile (EXPOSE 8000) reportan el mismo
    // puerto en Docker aunque solo "web" sirva HTTP — el YAML es la señal fiable.
    mockReadFile.mockResolvedValueOnce(
      [
        "services:",
        "  db:",
        "    image: postgres:16",
        "  web:",
        "    build: ../crm",
        "    expose:",
        '      - "8000"',
        "  worker:",
        "    build: ../crm",
        "    command: celery worker",
        "  beat:",
        "    build: ../crm",
        "    command: celery beat",
      ].join("\n"),
    );
    mockListContainers.mockResolvedValue([
      { Id: "c-db", Labels: { "com.docker.compose.service": "db" } },
      {
        Id: "c-web",
        Labels: { "com.docker.compose.service": "web" },
        Ports: [{ PrivatePort: 8000 }],
      },
      {
        Id: "c-worker",
        Labels: { "com.docker.compose.service": "worker" },
        Ports: [{ PrivatePort: 8000 }],
      },
      {
        Id: "c-beat",
        Labels: { "com.docker.compose.service": "beat" },
        Ports: [{ PrivatePort: 8000 }],
      },
    ]);

    await deployProyecto({ ...baseParams, puerto: 8000 });

    expect(mockConnect).toHaveBeenCalledTimes(1);
    expect(mockConnect).toHaveBeenCalledWith({
      Container: "c-web",
      EndpointConfig: { Aliases: ["acme-web-app"] },
    });
  });

  it("si ningún contenedor declara el puerto, cae al comportamiento anterior (todos)", async () => {
    mockListContainers.mockResolvedValue([
      { Id: "c-db", Names: ["/db"], Ports: [{ PrivatePort: 5432 }] },
      { Id: "c-worker", Names: ["/worker"], Ports: [] },
    ]);

    await deployProyecto({ ...baseParams, puerto: 8000 });

    expect(mockConnect).toHaveBeenCalledTimes(2);
  });

  it("cada Servicio con ruta recibe su alias; el principal lleva los dos en una sola conexión", async () => {
    mockListContainers.mockResolvedValue([
      {
        Id: "c-web",
        Labels: { "com.docker.compose.service": "web" },
        Ports: [{ PrivatePort: 8000 }],
      },
      {
        Id: "c-api",
        Labels: { "com.docker.compose.service": "api" },
        Ports: [{ PrivatePort: 3000 }],
      },
      { Id: "c-db", Labels: { "com.docker.compose.service": "db" } },
    ]);

    await deployProyecto({
      ...baseParams,
      puerto: 8000,
      serviciosConRuta: ["web", "api"],
    });

    expect(mockConnect).toHaveBeenCalledTimes(2);
    expect(mockConnect).toHaveBeenCalledWith({
      Container: "c-web",
      EndpointConfig: { Aliases: ["acme-web-app", "web.acme-web-app"] },
    });
    expect(mockConnect).toHaveBeenCalledWith({
      Container: "c-api",
      EndpointConfig: { Aliases: ["api.acme-web-app"] },
    });
  });

  it("avisa en el log si un Servicio con ruta no tiene contenedor, sin fallar el deploy", async () => {
    const onLog = vi.fn();
    mockListContainers.mockResolvedValue([
      { Id: "c-web", Labels: { "com.docker.compose.service": "web" } },
    ]);

    await deployProyecto({
      ...baseParams,
      serviciosConRuta: ["backend"],
      onLog,
    });

    expect(onLog).toHaveBeenCalledWith(
      expect.stringMatching(/⚠.*«backend».*sin contenedor/),
    );
    expect(onLog).toHaveBeenCalledWith("✓ Deploy completado");
  });
});

describe("deployProyecto con variables de entorno", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockWriteFile.mockResolvedValue(undefined);
    mockMkdir.mockResolvedValue(undefined);
    mockUnlink.mockResolvedValue(undefined);
    mockListContainers.mockResolvedValue([]);
    mockGetNetwork.mockReturnValue({ connect: mockConnect });
    mockSpawn.mockImplementation(() => makeSpawnResult(0));
    mockExecFile.mockImplementation(
      (
        _cmd: string,
        _args: string[],
        cb: (err: null, stdout: string, stderr: string) => void,
      ) => cb(null, "", ""),
    );
  });

  it("escribe .env en el repoDir y no usa --env-file cuando hay variables (tipo compose)", async () => {
    await deployProyecto({
      ...baseParams,
      variables: [
        { clave: "DATABASE_URL", valor: "postgres://localhost/db" },
        { clave: "JWT_SECRET", valor: "supersecret" },
      ],
    });

    expect(mockWriteFile).toHaveBeenCalledWith(
      "/var/vicagr/repos/acme/web-app/.env",
      "DATABASE_URL=postgres://localhost/db\nJWT_SECRET=supersecret",
      { encoding: "utf-8", mode: 0o600 },
    );

    const spawnArgs = mockSpawn.mock.calls[0]?.[1] as string[] | undefined;
    expect(spawnArgs).not.toContain("--env-file");
  });

  it("no elimina el .env del repoDir tras deploy exitoso (se mantiene para reinicios)", async () => {
    await deployProyecto({
      ...baseParams,
      variables: [{ clave: "X", valor: "y" }],
    });
    expect(mockUnlink).not.toHaveBeenCalledWith(
      "/var/vicagr/repos/acme/web-app/.env",
    );
  });

  it("no elimina el .env aunque el deploy falle", async () => {
    mockSpawn.mockImplementationOnce(() => makeSpawnResult(1));

    await expect(
      deployProyecto({
        ...baseParams,
        variables: [{ clave: "X", valor: "y" }],
      }),
    ).rejects.toThrow();
    expect(mockUnlink).not.toHaveBeenCalledWith(
      "/var/vicagr/repos/acme/web-app/.env",
    );
  });

  // Compose expands $ and cuts at " #" in an unquoted .env value; double quotes
  // with \\ \" \$ is the form that round-trips (checked against Compose v5).
  it("entrecomilla y escapa en el .env los valores que Compose alteraría", async () => {
    await deployProyecto({
      ...baseParams,
      variables: [
        { clave: "SALT", valor: "|Rk}+w$1 #x 'a' \"b\" ${HOME}" },
        { clave: "PATH_VAR", valor: "C:\\Users\\name" },
        { clave: "URL", valor: "postgres://u:p@db:5432/app?x=1" },
      ],
    });

    expect(mockWriteFile).toHaveBeenCalledWith(
      "/var/vicagr/repos/acme/web-app/.env",
      [
        'SALT="|Rk}+w\\$1 #x \'a\' \\"b\\" \\${HOME}"',
        'PATH_VAR="C:\\\\Users\\\\name"',
        'URL="postgres://u:p@db:5432/app?x=1"',
      ].join("\n"),
      { encoding: "utf-8", mode: 0o600 },
    );
  });

  it("no escribe .env.panel cuando no hay variables", async () => {
    await deployProyecto(baseParams);
    const writeFileCalls = vi.mocked(mockWriteFile).mock.calls;
    const envFileCall = writeFileCalls.find(
      (c) => String(c[0]).includes("/.panel/") && String(c[0]).endsWith(".env"),
    );
    expect(envFileCall).toBeUndefined();
    expect(mockUnlink).not.toHaveBeenCalled();
  });
});

describe("deployProyecto — captura de SHA y path con sha", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockWriteFile.mockResolvedValue(undefined);
    mockUnlink.mockResolvedValue(undefined);
    mockListContainers.mockResolvedValue([]);
    mockGetNetwork.mockReturnValue({ connect: mockConnect });
    mockSpawn.mockImplementation(() => makeSpawnResult(0));
  });

  it("sin sha: hace checkout de la rama y retorna el sha capturado", async () => {
    mockExecFile.mockImplementation(
      (
        _cmd: string,
        args: string[],
        cb: (err: null, stdout: string, stderr: string) => void,
      ) => {
        if (args[2] === "rev-parse" && args[3] === "HEAD")
          return cb(null, "abc123def456\n", "");
        cb(null, "", "");
      },
    );

    const result = await deployProyecto(baseParams);

    const gitCalls = vi
      .mocked(mockExecFile)
      .mock.calls.filter(([cmd]) => cmd === "git");
    const checkoutCall = gitCalls.find(([, a]) => a[2] === "checkout");
    expect(checkoutCall?.[1]).toContain("main");
    expect(result.sha).toBe("abc123def456");
  });

  it("con sha: hace fetch y checkout del sha exacto, retorna ese sha", async () => {
    mockExecFile.mockImplementation(
      (
        _cmd: string,
        args: string[],
        cb: (err: null, stdout: string, stderr: string) => void,
      ) => {
        if (args[2] === "rev-parse" && args[3] === "HEAD")
          return cb(null, "deadbeef1234\n", "");
        cb(null, "", "");
      },
    );

    const result = await deployProyecto({ ...baseParams, sha: "deadbeef1234" });

    const gitCalls = vi
      .mocked(mockExecFile)
      .mock.calls.filter(([cmd]) => cmd === "git");
    const fetchCall = gitCalls.find(([, a]) => a[2] === "fetch");
    expect(fetchCall).toBeDefined();
    const checkoutCall = gitCalls.find(([, a]) => a[2] === "checkout");
    expect(checkoutCall?.[1]).toContain("deadbeef1234");
    expect(result.sha).toBe("deadbeef1234");
  });

  it("con sha: no hace git pull explícito después del checkout", async () => {
    mockExecFile.mockImplementation(
      (
        _cmd: string,
        args: string[],
        cb: (err: null, stdout: string, stderr: string) => void,
      ) => {
        if (args[2] === "rev-parse" && args[3] === "HEAD")
          return cb(null, "deadbeef\n", "");
        cb(null, "", "");
      },
    );

    await deployProyecto({ ...baseParams, sha: "deadbeef" });

    const gitCalls = vi
      .mocked(mockExecFile)
      .mock.calls.filter(([cmd]) => cmd === "git");
    const fetchCalls = gitCalls.filter(([, a]) => a[2] === "fetch");
    expect(fetchCalls.length).toBeGreaterThan(0);
    const checkoutIdx = gitCalls.findIndex(([, a]) => a[2] === "checkout");
    const pullAfterCheckout = gitCalls
      .slice(checkoutIdx + 1)
      .filter(([, a]) => a[2] === "pull");
    expect(pullAfterCheckout).toHaveLength(0);
  });

  it("usa stdout.trim() directamente para capturar el sha", async () => {
    mockExecFile.mockImplementation(
      (
        _cmd: string,
        args: string[],
        cb: (err: null, stdout: string, stderr: string) => void,
      ) => {
        if (args[2] === "rev-parse" && args[3] === "HEAD")
          return cb(null, "  cafebabe  \n", "");
        cb(null, "", "");
      },
    );

    const result = await deployProyecto(baseParams);
    expect(result.sha).toBe("cafebabe");
  });
});

describe("deployProyecto con credencial SSH", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockWriteFile.mockResolvedValue(undefined);
    mockUnlink.mockResolvedValue(undefined);
    mockListContainers.mockResolvedValue([]);
    mockGetNetwork.mockReturnValue({ connect: mockConnect });
    mockSpawn.mockImplementation(() => makeSpawnResult(0));
    mockExecFile.mockImplementation(
      (
        _cmd: string,
        _args: string[],
        cb: (err: null, stdout: string, stderr: string) => void,
      ) => cb(null, "", ""),
    );
  });

  const keyFilePath = "/var/vicagr/repos/acme/.panel/web-app.deploy_key";

  it("escribe la clave privada en .deploy_key con permisos 0o600", async () => {
    await deployProyecto({
      ...baseParams,
      credencial: { clavePrivada: "-----BEGIN RSA PRIVATE KEY-----" },
    });

    expect(mockWriteFile).toHaveBeenCalledWith(
      keyFilePath,
      "-----BEGIN RSA PRIVATE KEY-----\n",
      { mode: 0o600 },
    );
  });

  it("elimina .deploy_key en el bloque finally tras deploy exitoso", async () => {
    await deployProyecto({
      ...baseParams,
      credencial: { clavePrivada: "key" },
    });

    expect(mockUnlink).toHaveBeenCalledWith(keyFilePath);
  });

  it("elimina .deploy_key aunque el deploy falle", async () => {
    mockSpawn.mockImplementationOnce(() => makeSpawnResult(1));

    await expect(
      deployProyecto({ ...baseParams, credencial: { clavePrivada: "key" } }),
    ).rejects.toThrow();

    expect(mockUnlink).toHaveBeenCalledWith(keyFilePath);
  });

  it("no escribe .deploy_key cuando no hay credencial", async () => {
    await deployProyecto(baseParams);

    const writeFileCalls = vi.mocked(mockWriteFile).mock.calls;
    const keyCall = writeFileCalls.find((c) =>
      String(c[0]).endsWith(".deploy_key"),
    );
    expect(keyCall).toBeUndefined();
  });
});

describe("deployProyecto — composeContent (compose editor)", () => {
  const composeYaml = `services:\n  web:\n    image: nginx:alpine\n  api:\n    build: .\n`;

  beforeEach(() => {
    vi.clearAllMocks();
    mockWriteFile.mockResolvedValue(undefined);
    mockMkdir.mockResolvedValue(undefined);
    mockUnlink.mockResolvedValue(undefined);
    mockListContainers.mockResolvedValue([]);
    mockGetNetwork.mockReturnValue({ connect: mockConnect });
    mockSpawn.mockImplementation(() => makeSpawnResult(0));
    mockExecFile.mockImplementation(
      (
        _cmd: string,
        _args: string[],
        cb: (err: null, stdout: string, stderr: string) => void,
      ) => cb(null, "", ""),
    );
  });

  it("escribe composeContent en panelDir como fichero compose", async () => {
    await deployProyecto({ ...baseParams, composeContent: composeYaml });

    expect(mockWriteFile).toHaveBeenCalledWith(
      "/var/vicagr/repos/acme/.panel/web-app.docker-compose.yml",
      composeYaml,
      { encoding: "utf-8" },
    );
  });

  it("usa el fichero de panelDir (no repoDir) como -f en docker compose", async () => {
    await deployProyecto({ ...baseParams, composeContent: composeYaml });

    const spawnArgs = mockSpawn.mock.calls[0][1] as string[];
    const fIdx = spawnArgs.indexOf("-f");
    expect(spawnArgs[fIdx + 1]).toBe(
      "/var/vicagr/repos/acme/.panel/web-app.docker-compose.yml",
    );
  });

  it("limita los logs de los servicios con un segundo -f de override", async () => {
    mockReadFile.mockResolvedValueOnce(composeYaml);
    await deployProyecto({ ...baseParams, composeContent: composeYaml });

    const override = "/var/vicagr/repos/acme/.panel/web-app.logging.yml";
    const escrito = mockWriteFile.mock.calls.find((c) => c[0] === override);
    expect(escrito?.[1]).not.toContain("&");
    expect(escrito?.[1]).toMatch(/web:\n {4}logging:[\s\S]*api:\n {4}logging:/);
    expect(escrito?.[1]).toContain("max-size: 10m");
    const spawnArgs = mockSpawn.mock.calls[0][1] as string[];
    expect(spawnArgs.join(" ")).toContain(
      `-f /var/vicagr/repos/acme/.panel/web-app.docker-compose.yml -f ${override}`,
    );
  });

  it("no añade override de logs si todos los servicios ya configuran el suyo", async () => {
    const conLogging = `services:\n  web:\n    image: nginx\n    logging:\n      driver: local\n`;
    mockReadFile.mockResolvedValueOnce(conLogging);
    await deployProyecto({ ...baseParams, composeContent: conLogging });

    const spawnArgs = mockSpawn.mock.calls[0][1] as string[];
    expect(spawnArgs.filter((a) => a === "-f")).toHaveLength(1);
  });

  it("escribe env vars en panelDir como .env con --env-file cuando hay composeContent", async () => {
    await deployProyecto({
      ...baseParams,
      composeContent: composeYaml,
      variables: [
        { clave: "DB_URL", valor: "postgres://localhost/db" },
        { clave: "SECRET", valor: "abc123" },
      ],
    });

    expect(mockWriteFile).toHaveBeenCalledWith(
      "/var/vicagr/repos/acme/.panel/web-app.env",
      "DB_URL=postgres://localhost/db\nSECRET=abc123",
      { encoding: "utf-8", mode: 0o600 },
    );

    const spawnArgs = mockSpawn.mock.calls[0][1] as string[];
    const envFileIdx = spawnArgs.indexOf("--env-file");
    expect(envFileIdx).toBeGreaterThan(-1);
    expect(spawnArgs[envFileIdx + 1]).toBe(
      "/var/vicagr/repos/acme/.panel/web-app.env",
    );
  });

  // .panel/ is shared by every Proyecto of the Cliente: a common .env there
  // handed one Proyecto's secrets to the next one deployed.
  it("compose pegado: no escribe un .env común del Cliente y borra el antiguo", async () => {
    await deployProyecto({
      ...baseParams,
      composeContent: composeYaml,
      variables: [{ clave: "SECRET", valor: "abc123" }],
    });

    const comun = "/var/vicagr/repos/acme/.panel/.env";
    expect(
      vi.mocked(mockWriteFile).mock.calls.filter(([p]) => p === comun),
    ).toHaveLength(0);
    expect(mockUnlink).toHaveBeenCalledWith(comun);
  });

  it("compose pegado: env_file: .env apunta al fichero del propio Proyecto", async () => {
    await deployProyecto({
      ...baseParams,
      composeContent:
        "services:\n  web:\n    image: nginx\n    env_file: .env\n  api:\n    image: node\n    env_file:\n      - ./.env\n      - otro.env\n",
    });

    const [, contenido] = vi
      .mocked(mockWriteFile)
      .mock.calls.find(
        ([p]) =>
          p === "/var/vicagr/repos/acme/.panel/web-app.docker-compose.yml",
      )!;
    expect(contenido).toContain("env_file: web-app.env");
    expect(contenido).toContain("- web-app.env\n      - otro.env");
  });

  it("compose pegado: pasa siempre su --env-file para no interpolar con el .env de otro Proyecto", async () => {
    await deployProyecto({ ...baseParams, composeContent: composeYaml });

    const spawnArgs = mockSpawn.mock.calls[0][1] as string[];
    expect(spawnArgs[spawnArgs.indexOf("--env-file") + 1]).toBe(
      "/var/vicagr/repos/acme/.panel/web-app.env",
    );
  });

  it("no necesita repoUrl para desplegar cuando hay composeContent", async () => {
    await expect(
      deployProyecto({
        tipo: "compose",
        rama: "main",
        clienteSlug: "acme",
        proyectoNombre: "web-app",
        composeContent: composeYaml,
      }),
    ).resolves.toBeDefined();

    // Sin repoUrl no se llama a git
    const gitCalls = vi
      .mocked(mockExecFile)
      .mock.calls.filter(([cmd]) => cmd === "git");
    expect(gitCalls).toHaveLength(0);
  });

  it("sigue usando repoDir/docker-compose.yml cuando no hay composeContent", async () => {
    await deployProyecto(baseParams);

    const spawnArgs = mockSpawn.mock.calls[0][1] as string[];
    const fIdx = spawnArgs.indexOf("-f");
    expect(spawnArgs[fIdx + 1]).toBe(
      "/var/vicagr/repos/acme/web-app/docker-compose.yml",
    );
  });
});

describe("deployProyecto — variables build-time y GIT_SHA_SHORT", () => {
  const envRepo = "/var/vicagr/repos/acme/web-app/.env";

  beforeEach(() => {
    vi.clearAllMocks();
    mockWriteFile.mockResolvedValue(undefined);
    mockMkdir.mockResolvedValue(undefined);
    mockReadFile.mockResolvedValue("");
    mockUnlink.mockResolvedValue(undefined);
    mockListContainers.mockResolvedValue([]);
    mockGetNetwork.mockReturnValue({ connect: mockConnect });
    mockSpawn.mockImplementation(() => makeSpawnResult(0));
    mockExecFile.mockImplementation(
      (
        _cmd: string,
        args: string[],
        cb: (err: null, stdout: string, stderr: string) => void,
      ) => {
        if (args[2] === "rev-parse" && args[3] === "HEAD")
          return cb(null, "e881352abcdef0123456789\n", "");
        cb(null, "", "");
      },
    );
  });

  const writesTo = (path: string) =>
    vi.mocked(mockWriteFile).mock.calls.filter(([p]) => p === path);

  it("compose desde repo: el .env del build incluye runtime, build-time y GIT_SHA_SHORT antes del up", async () => {
    await deployProyecto({
      ...baseParams,
      variables: [{ clave: "DATABASE_URL", valor: "postgres://db" }],
      variablesBuildTime: [{ clave: "VITE_SENTRY_DSN", valor: "https://dsn" }],
    });

    const [primera] = writesTo(envRepo);
    expect(primera?.[1]).toBe(
      "DATABASE_URL=postgres://db\nVITE_SENTRY_DSN=https://dsn\nGIT_SHA_SHORT=e881352",
    );
    const writeOrder =
      vi.mocked(mockWriteFile).mock.invocationCallOrder[
        vi.mocked(mockWriteFile).mock.calls.indexOf(primera!)
      ];
    expect(writeOrder).toBeLessThan(mockSpawn.mock.invocationCallOrder[0]);
  });

  it("compose desde repo: tras el up el .env queda solo con las runtime (los secretos de build no persisten)", async () => {
    await deployProyecto({
      ...baseParams,
      variables: [{ clave: "DATABASE_URL", valor: "postgres://db" }],
      variablesBuildTime: [{ clave: "VITE_SENTRY_DSN", valor: "https://dsn" }],
    });

    const escrituras = writesTo(envRepo);
    expect(escrituras.at(-1)?.[1]).toBe("DATABASE_URL=postgres://db");
    const ultimaOrden =
      vi.mocked(mockWriteFile).mock.invocationCallOrder[
        vi.mocked(mockWriteFile).mock.calls.indexOf(escrituras.at(-1)!)
      ];
    expect(ultimaOrden).toBeGreaterThan(mockSpawn.mock.invocationCallOrder[0]);
  });

  it("compose desde repo: restaura el .env runtime aunque el build falle", async () => {
    mockSpawn.mockImplementationOnce(() => makeSpawnResult(1));

    await expect(
      deployProyecto({
        ...baseParams,
        variables: [{ clave: "DATABASE_URL", valor: "postgres://db" }],
        variablesBuildTime: [
          { clave: "VITE_SENTRY_DSN", valor: "https://dsn" },
        ],
      }),
    ).rejects.toThrow();

    expect(writesTo(envRepo).at(-1)?.[1]).toBe("DATABASE_URL=postgres://db");
  });

  it("compose desde repo: sin runtime vars deja el .env vacío tras el up (env_file: .env debe existir)", async () => {
    await deployProyecto({
      ...baseParams,
      variablesBuildTime: [{ clave: "VITE_SENTRY_DSN", valor: "https://dsn" }],
    });

    expect(writesTo(envRepo).at(-1)?.[1]).toBe("");
    expect(mockUnlink).not.toHaveBeenCalledWith(envRepo);
  });

  it("dockerfile: el compose generado pasa build-time y GIT_SHA_SHORT como build.args", async () => {
    await deployProyecto({
      ...baseParams,
      tipo: "dockerfile",
      variables: [{ clave: "DATABASE_URL", valor: "postgres://db" }],
      variablesBuildTime: [
        { clave: "VITE_SENTRY_DSN", valor: 'https://"dsn"' },
      ],
    });

    const [compose] = writesTo(
      "/var/vicagr/repos/acme/.panel/web-app.docker-compose.yml",
    );
    expect(compose?.[1]).toContain(
      [
        "    build:",
        '      context: "/var/vicagr/repos/acme/web-app"',
        '      dockerfile: "/var/vicagr/repos/acme/web-app/Dockerfile"',
        "      args:",
        '        VITE_SENTRY_DSN: "https://\\"dsn\\""',
        '        GIT_SHA_SHORT: "e881352"',
      ].join("\n"),
    );
    expect(compose?.[1]).not.toMatch(/args:[\s\S]*DATABASE_URL[\s\S]*ports:/);
  });

  it.each(["dockerfile", "nodejs", "image"])(
    "%s: el compose generado limita los logs a 3 ficheros de 10 MB",
    async (tipo) => {
      await deployProyecto({
        ...baseParams,
        tipo,
        imagenUrl: "nginx:alpine",
      });

      const [compose] = writesTo(
        "/var/vicagr/repos/acme/.panel/web-app.docker-compose.yml",
      );
      expect(compose?.[1]).toContain(
        [
          "    logging:",
          "      driver: json-file",
          "      options:",
          '        max-size: "10m"',
          '        max-file: "3"',
        ].join("\n"),
      );
    },
  );

  it.each(["dockerfile", "nodejs", "image"])(
    "%s: el puerto solo se expone en la red; no se publica en el host, se llega por Traefik",
    async (tipo) => {
      await deployProyecto({
        ...baseParams,
        tipo,
        imagenUrl: "nginx:alpine",
        puerto: 3000,
      });

      const [compose] = writesTo(
        "/var/vicagr/repos/acme/.panel/web-app.docker-compose.yml",
      );
      expect(compose?.[1]).toContain('    expose:\n      - "3000"');
      expect(compose?.[1]).not.toContain("ports:");
    },
  );

  const envLocal = "/var/vicagr/repos/acme/web-app/.env.local";
  const nodejs = {
    ...baseParams,
    tipo: "nodejs",
    puerto: 3000,
    buildCommand: "npm run build",
    startCommand: "npm start",
  };

  it("nodejs: .env.local del build incluye las build-time y GIT_SHA_SHORT", async () => {
    await deployProyecto({
      ...nodejs,
      variablesBuildTime: [{ clave: "VITE_SENTRY_DSN", valor: "https://dsn" }],
    });

    expect(writesTo(envLocal)[0]?.[1]).toBe(
      "VITE_SENTRY_DSN=https://dsn\nGIT_SHA_SHORT=e881352",
    );
  });

  it("nodejs: sin build-time del usuario también recibe GIT_SHA_SHORT y la imagen final no lleva .env.local", async () => {
    await deployProyecto(nodejs);

    expect(writesTo(envLocal)[0]?.[1]).toBe("GIT_SHA_SHORT=e881352");
    const [dockerfile] = writesTo(
      "/var/vicagr/repos/acme/.panel/web-app.Dockerfile",
    );
    expect(dockerfile?.[1]).toContain("rm -f .env.local");
    expect(dockerfile?.[1]).toContain("FROM node:22-alpine AS builder");
    expect(dockerfile?.[1]).toContain("FROM node:22-alpine AS runner");
    // Node 20 is out of support (no security patches) since April 2026.
    expect(dockerfile?.[1]).not.toContain("node:20");
    expect(mockUnlink).toHaveBeenCalledWith(envLocal);
  });

  // The app's dotenv (Next, Vite) can't escape a quote and expands $: wrap in
  // a quote the value doesn't use and escape $ (checked against @next/env).
  it("nodejs: los valores con $, # o comillas llegan intactos al .env.local", async () => {
    await deployProyecto({
      ...nodejs,
      variablesBuildTime: [
        { clave: "A", valor: 'pa$$ #x "dq"' },
        { clave: "B", valor: 'it\'s "q" $5' },
      ],
    });

    expect(writesTo(envLocal)[0]?.[1]).toBe(
      [
        "A='pa\\$\\$ #x \"dq\"'",
        'B=`it\'s "q" \\$5`',
        "GIT_SHA_SHORT=e881352",
      ].join("\n"),
    );
  });

  it("los composes generados escapan $ para que Compose no lo interpole", async () => {
    await deployProyecto({
      ...baseParams,
      tipo: "dockerfile",
      variables: [{ clave: "SALT", valor: 'a$b${C} "q" \\d' }],
      variablesBuildTime: [{ clave: "KEY", valor: "x$y" }],
    });

    const [compose] = writesTo(
      "/var/vicagr/repos/acme/.panel/web-app.docker-compose.yml",
    );
    expect(compose?.[1]).toContain('        KEY: "x$$y"');
    expect(compose?.[1]).toContain('      SALT: "a$$b$${C} \\"q\\" \\\\d"');
  });

  it("compose pegado: un valor con $ sustituido en el YAML no se vuelve a interpolar", async () => {
    await deployProyecto({
      ...baseParams,
      composeContent:
        "services:\n  web:\n    image: nginx\n    command: ${CMD}\n",
      variables: [{ clave: "CMD", valor: "echo $HOME $& $$" }],
    });

    const [compose] = writesTo(
      "/var/vicagr/repos/acme/.panel/web-app.docker-compose.yml",
    );
    expect(compose?.[1]).toContain("command: echo $$HOME $$& $$$$\n");
  });

  const ignoreGenerado =
    "/var/vicagr/repos/acme/.panel/web-app.Dockerfile.dockerignore";

  it("nodejs: la imagen no incluye el .git del repositorio", async () => {
    await deployProyecto(nodejs);

    expect(writesTo(ignoreGenerado)[0]?.[1]).toBe(".git\nvolumes\n");
  });

  it("nodejs: respeta el .dockerignore del repositorio y le añade .git", async () => {
    mockReadFile.mockImplementation(async (ruta: string) => {
      if (ruta === "/var/vicagr/repos/acme/web-app/.dockerignore")
        return "dist\n*.log\n";
      throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
    });

    await deployProyecto(nodejs);

    expect(writesTo(ignoreGenerado)[0]?.[1]).toBe(
      "dist\n*.log\n\n.git\nvolumes\n",
    );
  });

  it("compose desde repo no borra un .env.local que no ha creado", async () => {
    await deployProyecto({
      ...baseParams,
      variablesBuildTime: [{ clave: "VITE_SENTRY_DSN", valor: "https://dsn" }],
    });

    expect(mockUnlink).not.toHaveBeenCalledWith(envLocal);
  });

  it("GIT_SHA_SHORT definida por el usuario se sustituye por el commit realmente desplegado", async () => {
    await deployProyecto({
      ...baseParams,
      variablesBuildTime: [{ clave: "GIT_SHA_SHORT", valor: "v0.9.00" }],
    });

    expect(writesTo(envRepo)[0]?.[1]).toBe("GIT_SHA_SHORT=e881352");
  });
});

describe("deployProyecto — cancelación", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockWriteFile.mockResolvedValue(undefined);
    mockMkdir.mockResolvedValue(undefined);
    mockListContainers.mockResolvedValue([]);
    mockGetNetwork.mockReturnValue({ connect: mockConnect });
    mockSpawn.mockImplementation(() => makeSpawnResult(0));
    mockExecFile.mockImplementation(
      (
        _cmd: string,
        _args: string[],
        cb: (err: null, stdout: string, stderr: string) => void,
      ) => cb(null, "", ""),
    );
  });

  it("pasa la señal de cancelación a git y a docker compose", async () => {
    const { signal } = new AbortController();
    await deployProyecto({ ...baseParams, signal });

    const llamadasGit = mockExecFileOpts.mock.calls.filter(
      ([cmd]) => cmd === "git",
    );
    expect(llamadasGit.length).toBeGreaterThan(0);
    for (const [, , opts] of llamadasGit) {
      expect(opts).toMatchObject({ signal });
    }
    expect(mockSpawn).toHaveBeenCalledWith(
      "docker",
      expect.any(Array),
      expect.objectContaining({ signal }),
    );
  });
});

describe("deployProyecto — limpieza de disco", () => {
  const llamadasDocker = () =>
    mockExecFile.mock.calls
      .filter(([cmd]) => cmd === "docker")
      .map(([, args]) => (args as string[]).join(" "));

  beforeEach(() => {
    vi.clearAllMocks();
    mockWriteFile.mockResolvedValue(undefined);
    mockMkdir.mockResolvedValue(undefined);
    mockListContainers.mockResolvedValue([]);
    mockGetNetwork.mockReturnValue({ connect: mockConnect });
    mockSpawn.mockImplementation(() => makeSpawnResult(0));
    mockExecFile.mockImplementation(
      (
        _cmd: string,
        _args: string[],
        cb: (err: null, stdout: string, stderr: string) => void,
      ) => cb(null, "", ""),
    );
  });

  it("tras un deploy correcto borra las imágenes sin uso y la caché de build de más de 7 días", async () => {
    await deployProyecto(baseParams);

    expect(llamadasDocker()).toEqual([
      "image prune -f",
      "builder prune -f --filter until=168h",
    ]);
  });

  it("un fallo al limpiar no hace fallar el deploy", async () => {
    mockExecFile.mockImplementation(
      (
        cmd: string,
        _args: string[],
        cb: (err: Error | null, stdout: string, stderr: string) => void,
      ) =>
        cmd === "docker"
          ? cb(new Error("daemon ocupado"), "", "")
          : cb(null, "", ""),
    );

    await expect(deployProyecto(baseParams)).resolves.toMatchObject({
      sha: expect.any(String),
    });
  });

  it("no limpia si el deploy falla", async () => {
    mockSpawn.mockImplementation(() => makeSpawnResult(1));

    await expect(deployProyecto(baseParams)).rejects.toThrow();
    expect(llamadasDocker()).toEqual([]);
  });
});

// A Volumen is an empty host folder mounted over the container path: without
// seeding it, what the container had there is hidden, and what it had created
// at runtime (uploads) is lost when the deploy recreates it.
describe("deployProyecto — Volúmenes nuevos", () => {
  const rutaHost = "/var/vicagr/repos/acme/web-app/volumes/uploads";
  const conVolumen = {
    ...baseParams,
    tipo: "image",
    imagenUrl: "wordpress:6",
    volumenes: [{ rutaHost, rutaContenedor: "/var/www/html/wp-content" }],
  };
  const ordenDe = (mock: { mock: { invocationCallOrder: number[] } }) =>
    mock.mock.invocationCallOrder[0];
  const composeArgs = () =>
    mockSpawn.mock.calls.map(([, args]) => (args as string[]).join(" "));

  beforeEach(() => {
    vi.clearAllMocks();
    mockWriteFile.mockResolvedValue(undefined);
    mockMkdir.mockResolvedValue(undefined);
    mockReadFile.mockResolvedValue("");
    mockUnlink.mockResolvedValue(undefined);
    mockReaddir.mockResolvedValue([]);
    mockEjecutar.mockResolvedValue("");
    mockEncadenar.mockResolvedValue("");
    mockListContainers.mockResolvedValue([]);
    mockGetNetwork.mockReturnValue({ connect: mockConnect });
    mockSpawn.mockImplementation(() => makeSpawnResult(0));
    mockExecFile.mockImplementation(
      (
        _cmd: string,
        _args: string[],
        cb: (err: null, stdout: string, stderr: string) => void,
      ) => cb(null, "", ""),
    );
  });

  it("copia al Volumen vacío lo que el contenedor en marcha tiene en esa ruta, antes de recrearlo", async () => {
    mockListContainers.mockResolvedValue([{ Id: "previo123", Labels: {} }]);

    await deployProyecto(conVolumen);

    expect(mockEncadenar).toHaveBeenCalledWith(
      {
        comando: "docker",
        args: ["cp", "previo123:/var/www/html/wp-content/.", "-"],
      },
      {
        comando: "docker",
        args: [
          "run",
          "--rm",
          "-i",
          "--network",
          "none",
          "-v",
          `${rutaHost}:/destino`,
          "busybox:1.37.0",
          "tar",
          "-x",
          "-C",
          "/destino",
        ],
      },
      expect.anything(),
    );
    expect(ordenDe(mockEncadenar)).toBeLessThan(ordenDe(mockSpawn));
  });

  it("no toca un Volumen que ya tiene ficheros", async () => {
    mockReaddir.mockResolvedValue(["2026"]);
    mockListContainers.mockResolvedValue([{ Id: "previo123", Labels: {} }]);

    await deployProyecto(conVolumen);

    expect(mockEncadenar).not.toHaveBeenCalled();
  });

  it("en el primer deploy copia desde la imagen y borra el contenedor temporal", async () => {
    mockEjecutar.mockImplementation(async (_cmd: string, args: string[]) =>
      args[0] === "create" ? "temporal456\n" : "",
    );

    await deployProyecto(conVolumen);

    expect(composeArgs()[0]).toMatch(/ pull$/);
    expect(mockEjecutar).toHaveBeenCalledWith(
      "docker",
      ["create", "wordpress:6"],
      expect.anything(),
    );
    expect(mockEncadenar.mock.calls[0][0].args).toEqual([
      "cp",
      "temporal456:/var/www/html/wp-content/.",
      "-",
    ]);
    expect(mockEjecutar).toHaveBeenCalledWith(
      "docker",
      ["rm", "-f", "temporal456"],
      expect.anything(),
    );
  });

  it("un Proyecto con build construye la imagen antes de copiar desde ella", async () => {
    mockEjecutar.mockImplementation(async (_cmd: string, args: string[]) =>
      args[0] === "create" ? "temporal456\n" : "",
    );

    await deployProyecto({ ...conVolumen, tipo: "dockerfile" });

    expect(composeArgs()[0]).toMatch(/ build$/);
    expect(mockEjecutar).toHaveBeenCalledWith(
      "docker",
      ["create", "acme-web-app-app"],
      expect.anything(),
    );
  });

  it("si la ruta no existe en el contenedor deja el Volumen vacío y sigue", async () => {
    mockListContainers.mockResolvedValue([{ Id: "previo123", Labels: {} }]);
    mockEncadenar.mockRejectedValue(
      new ErrorProceso(
        "docker terminó con código 1:\nError response from daemon: Could not find the file /var/www/html/wp-content/. in container previo123",
        1,
        "",
      ),
    );

    await expect(deployProyecto(conVolumen)).resolves.toBeDefined();
  });

  it("si la copia falla, el deploy se detiene sin recrear el contenedor y el Volumen queda vacío", async () => {
    mockListContainers.mockResolvedValue([{ Id: "previo123", Labels: {} }]);
    mockEncadenar.mockRejectedValue(
      new ErrorProceso("docker terminó con código 1:\nno space left", 1, ""),
    );

    await expect(deployProyecto(conVolumen)).rejects.toThrow("no space left");

    expect(mockSpawn).not.toHaveBeenCalled();
    // Half a copy must not pass for a seeded Volumen on the next deploy.
    expect(mockEjecutar).toHaveBeenCalledWith(
      "docker",
      expect.arrayContaining(["-v", `${rutaHost}:/destino`, "find"]),
      expect.anything(),
    );
  });

  it("los Proyectos de tipo compose no siembran: el Panel no monta sus Volúmenes", async () => {
    await deployProyecto({ ...baseParams, volumenes: conVolumen.volumenes });

    expect(mockEncadenar).not.toHaveBeenCalled();
  });
});

// `docker compose up -d` returns as soon as the containers are created: one
// that dies two seconds later used to count as a successful deploy.
describe("deployProyecto — espera a que los contenedores estén sanos", () => {
  const contenedor = (servicio: string, State: string, Status: string) => ({
    Id: `id-${servicio}`,
    State,
    Status,
    Labels: { "com.docker.compose.service": servicio },
  });
  // The health check is the only listing of every container of the Proyecto:
  // the network step asks for the running ones and Traefik's has no filter.
  type Listado = { all?: boolean; filters?: { label?: string[] } };
  const esSalud = (opts: Listado) =>
    !!opts.all &&
    !!opts.filters?.label?.[0]?.startsWith("com.docker.compose.project=");
  const lecturas = (...sucesivas: ReturnType<typeof contenedor>[][]) => {
    let i = 0;
    mockListContainers.mockImplementation(async (opts: Listado) =>
      esSalud(opts) ? sucesivas[Math.min(i++, sucesivas.length - 1)] : [],
    );
  };

  beforeEach(() => {
    vi.clearAllMocks();
    Object.assign(TIEMPOS_SALUD, sinEspera);
    mockWriteFile.mockResolvedValue(undefined);
    mockMkdir.mockResolvedValue(undefined);
    mockReadFile.mockResolvedValue("");
    mockUnlink.mockResolvedValue(undefined);
    mockGetNetwork.mockReturnValue({ connect: mockConnect });
    mockSpawn.mockImplementation(() => makeSpawnResult(0));
    mockExecFile.mockImplementation(
      (
        _cmd: string,
        args: string[],
        cb: (err: null, stdout: string, stderr: string) => void,
      ) =>
        args[0] === "logs"
          ? cb(null, "", "Error: Cannot find module 'next'")
          : cb(null, "", ""),
    );
  });

  it("falla si un Servicio sale con error tras arrancar, con sus últimas líneas de log", async () => {
    lecturas([
      contenedor("db", "running", "Up 3 seconds"),
      contenedor("web", "exited", "Exited (1) 1 second ago"),
    ]);

    await expect(deployProyecto(baseParams)).rejects.toThrow(
      /El Servicio «web» no arrancó: Exited \(1\) 1 second ago[\s\S]*Cannot find module 'next'/,
    );
  });

  it("falla si un Servicio queda en bucle de reinicios o unhealthy", async () => {
    lecturas([contenedor("web", "restarting", "Restarting (1) 1 second ago")]);
    await expect(deployProyecto(baseParams)).rejects.toThrow("«web»");

    lecturas([contenedor("web", "running", "Up 40 seconds (unhealthy)")]);
    await expect(deployProyecto(baseParams)).rejects.toThrow("«web»");
  });

  it("espera mientras el healthcheck está arrancando y termina bien cuando pasa a healthy", async () => {
    lecturas(
      [contenedor("web", "running", "Up 1 second (health: starting)")],
      [contenedor("web", "running", "Up 2 seconds (health: starting)")],
      [contenedor("web", "running", "Up 3 seconds (healthy)")],
    );

    await expect(deployProyecto(baseParams)).resolves.toBeDefined();

    const comprobaciones = mockListContainers.mock.calls.filter(([opts]) =>
      esSalud(opts as Listado),
    );
    expect(comprobaciones).toHaveLength(3);
  });

  it("un Servicio que termina bien (migraciones) no cuenta como fallo", async () => {
    lecturas([
      contenedor("web", "running", "Up 3 seconds"),
      contenedor("migrar", "exited", "Exited (0) 1 second ago"),
    ]);

    await expect(deployProyecto(baseParams)).resolves.toBeDefined();
  });

  it("falla si el healthcheck sigue arrancando pasado el máximo", async () => {
    Object.assign(TIEMPOS_SALUD, { maximoMs: 0 });
    lecturas([contenedor("web", "running", "Up 1 second (health: starting)")]);

    await expect(deployProyecto(baseParams)).rejects.toThrow(
      "«web» sigue sin estar sano",
    );
  });

  it("cancelar el deploy corta la espera", async () => {
    Object.assign(TIEMPOS_SALUD, { intervaloMs: 60_000, maximoMs: 600_000 });
    lecturas([contenedor("web", "running", "Up 1 second (health: starting)")]);
    const cancelar = new AbortController();
    setTimeout(() => cancelar.abort("Cancelado"), 20);

    await expect(
      deployProyecto({ ...baseParams, signal: cancelar.signal }),
    ).rejects.toThrow();
  });

  it.each(["dockerfile", "nodejs", "image"])(
    "%s: el contenedor vuelve a arrancar solo tras un reinicio de la VPS",
    async (tipo) => {
      mockListContainers.mockResolvedValue([]);
      await deployProyecto({ ...baseParams, tipo, imagenUrl: "nginx:1.27" });

      const compose = mockWriteFile.mock.calls.find(
        ([ruta]) =>
          ruta === "/var/vicagr/repos/acme/.panel/web-app.docker-compose.yml",
      );
      expect(compose?.[1]).toContain("    restart: unless-stopped");
    },
  );
});

// One runaway container must not starve every other Cliente on the VPS.
describe("deployProyecto — límites de recursos", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockWriteFile.mockResolvedValue(undefined);
    mockMkdir.mockResolvedValue(undefined);
    mockReadFile.mockResolvedValue("");
    mockListContainers.mockResolvedValue([]);
    mockGetNetwork.mockReturnValue({ connect: mockConnect });
    mockSpawn.mockImplementation(() => makeSpawnResult(0));
    mockExecFile.mockImplementation(
      (
        _cmd: string,
        _args: string[],
        cb: (err: null, stdout: string, stderr: string) => void,
      ) => cb(null, "", ""),
    );
  });

  const composeGenerado = () =>
    mockWriteFile.mock.calls.find(
      ([ruta]) =>
        ruta === "/var/vicagr/repos/acme/.panel/web-app.docker-compose.yml",
    )?.[1] as string | undefined;

  it.each(["dockerfile", "nodejs", "image"])(
    "%s: el compose generado limita memoria y CPU y no deja ganar privilegios",
    async (tipo) => {
      await deployProyecto({
        ...baseParams,
        tipo,
        imagenUrl: "nginx:1.27",
        limites: { memoriaMb: 512, cpus: 0.5 },
      });

      expect(composeGenerado()).toContain(
        [
          '    mem_limit: "512m"',
          '    cpus: "0.5"',
          "    security_opt:",
          '      - "no-new-privileges:true"',
        ].join("\n"),
      );
    },
  );

  it("sin límites no los escribe", async () => {
    await deployProyecto({ ...baseParams, tipo: "image", imagenUrl: "nginx" });

    expect(composeGenerado()).not.toContain("mem_limit");
  });
});

// The Proyecto's Volúmenes live inside the folder the repository is cloned to.
describe("deployProyecto — Volúmenes dentro del clon", () => {
  const gitArgs = () =>
    mockExecFile.mock.calls
      .filter(([cmd]) => cmd === "git")
      .map(([, args]) => (args as string[]).join(" "));
  const escritos = (ruta: string) =>
    mockWriteFile.mock.calls.find(([r]) => r === ruta)?.[1] as
      string | undefined;

  beforeEach(() => {
    vi.clearAllMocks();
    mockWriteFile.mockResolvedValue(undefined);
    mockMkdir.mockResolvedValue(undefined);
    mockReadFile.mockResolvedValue("");
    mockReaddir.mockResolvedValue(["ya-hay-datos"]);
    mockListContainers.mockResolvedValue([]);
    mockGetNetwork.mockReturnValue({ connect: mockConnect });
    mockSpawn.mockImplementation(() => makeSpawnResult(0));
  });

  const git = (yaClonado: boolean) =>
    mockExecFile.mockImplementation(
      (
        _cmd: string,
        args: string[],
        cb: (err: Error | null, stdout: string, stderr: string) => void,
      ) =>
        args.includes("--is-inside-work-tree") && !yaClonado
          ? cb(new Error("not a git repository"), "", "")
          : cb(null, "abc1234\n", ""),
    );

  // `git clone` refuses a folder that already has files, and a Volumen
  // created before the first deploy puts one there.
  it("el primer deploy no usa git clone: inicia el repositorio en la carpeta, tenga o no ficheros", async () => {
    git(false);

    await deployProyecto(baseParams);

    const repo = "/var/vicagr/repos/acme/web-app";
    expect(gitArgs()).not.toContainEqual(expect.stringMatching(/^clone /));
    expect(gitArgs()).toEqual(
      expect.arrayContaining([
        `init ${repo}`,
        `-C ${repo} remote add origin https://github.com/org/repo`,
        `-C ${repo} fetch origin`,
      ]),
    );
  });

  it("en los siguientes apunta el remoto a la URL actual, por si se cambió el repositorio del Proyecto", async () => {
    git(true);

    await deployProyecto(baseParams);

    expect(gitArgs()).toContain(
      "-C /var/vicagr/repos/acme/web-app remote set-url origin https://github.com/org/repo",
    );
    expect(gitArgs()).not.toContainEqual(expect.stringMatching(/^init /));
  });

  it("nodejs: los Volúmenes no entran en la imagen", async () => {
    git(true);

    await deployProyecto({ ...baseParams, tipo: "nodejs" });

    expect(
      escritos("/var/vicagr/repos/acme/.panel/web-app.Dockerfile.dockerignore"),
    ).toBe(".git\nvolumes\n");
  });

  const ignorePropio = "/var/vicagr/repos/acme/web-app/Dockerfile.dockerignore";
  const conVolumen = {
    ...baseParams,
    tipo: "dockerfile",
    volumenes: [
      {
        rutaHost: "/var/vicagr/repos/acme/web-app/volumes/uploads",
        rutaContenedor: "/app/uploads",
      },
    ],
  };

  it("dockerfile con Volúmenes: escribe un dockerignore junto al Dockerfile con las reglas del repositorio y los Volúmenes", async () => {
    git(true);
    mockReadFile.mockImplementation(async (ruta: string) => {
      if (ruta === "/var/vicagr/repos/acme/web-app/.dockerignore")
        return "node_modules\n";
      throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
    });

    await deployProyecto(conVolumen);

    expect(escritos(ignorePropio)).toBe(
      "# generado por vicagr-panel\nnode_modules\n\nvolumes\n",
    );
  });

  it("dockerfile con Volúmenes: no pisa un dockerignore que el repositorio ya trae para ese Dockerfile, y lo avisa", async () => {
    git(true);
    mockReadFile.mockImplementation(async (ruta: string) =>
      ruta === ignorePropio ? "dist\n" : "",
    );
    const lineas: string[] = [];

    await deployProyecto({ ...conVolumen, onLog: (l) => lineas.push(l) });

    expect(escritos(ignorePropio)).toBeUndefined();
    expect(lineas.join("\n")).toContain("añade «volumes» a");
  });

  it("dockerfile sin Volúmenes no escribe nada en el repositorio", async () => {
    git(true);

    await deployProyecto({ ...baseParams, tipo: "dockerfile" });

    expect(escritos(ignorePropio)).toBeUndefined();
  });
});
