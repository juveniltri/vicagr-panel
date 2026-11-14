import { execFile, spawn } from "node:child_process";
import { mkdir, readdir, readFile, unlink, writeFile } from "node:fs/promises";
import { promisify } from "node:util";
import { env } from "@/env";
import { IMAGEN_AUXILIAR } from "@/lib/backups/comandos";
import { ejecutar, encadenar, ErrorProceso } from "@/lib/backups/procesos";
import { logger } from "@/lib/logger";
import {
  apuntarEnvFile,
  encontrarServicioPorPuerto,
  generarOverrideLogging,
  LIMITE_LOGS,
} from "@/lib/compose";
import { docker } from "./client";
import { asegurarRedCliente } from "./networks";
import { conectarTraefikARed } from "./traefik";

const log = logger.child({ module: "docker" });

const execFileAsync = promisify(execFile);

// docker compose does not substitute ${VAR} in YAML map keys (e.g. top-level
// network names). Pre-substituting here ensures network/volume declarations
// match the references inside service definitions.
function substituirVarsEnCompose(
  content: string,
  vars: Array<{ clave: string; valor: string }>,
): string {
  // Compose still interpolates the result, so a $ in the value becomes $$.
  // Replacer functions: a string replacement would expand $& and $$ itself.
  return vars.reduce(
    (acc, { clave, valor }) =>
      acc.replaceAll(`\${${clave}}`, () => valor.replaceAll("$", () => "$$")),
    content,
  );
}

export async function ensureRepo(
  repoUrl: string,
  repoDir: string,
  gitEnv: NodeJS.ProcessEnv,
  onLog?: (line: string) => void,
  signal?: AbortSignal,
): Promise<void> {
  const opts = { env: gitEnv, signal };
  try {
    await execFileAsync(
      "git",
      ["-C", repoDir, "rev-parse", "--is-inside-work-tree"],
      opts,
    );
    onLog?.("→ Repositorio ya clonado, actualizando...");
  } catch {
    onLog?.("→ Clonando repositorio...");
    await execFileAsync("git", ["clone", repoUrl, repoDir], opts);
  }
}

export async function prepararRepo(
  repoUrl: string,
  repoDir: string,
  rama: string,
  gitEnv: NodeJS.ProcessEnv,
): Promise<void> {
  const opts = { env: gitEnv };
  await ensureRepo(repoUrl, repoDir, gitEnv);
  await execFileAsync("git", ["-C", repoDir, "fetch", "origin"], opts);
  await execFileAsync(
    "git",
    ["-C", repoDir, "checkout", "-B", rama, `origin/${rama}`],
    opts,
  );
}

async function conectarContenedoresARedCliente(
  projectSlug: string,
  clienteSlug: string,
  puerto: number,
  servicio: string | undefined,
  serviciosConRuta: string[],
  onLog?: (line: string) => void,
): Promise<void> {
  try {
    const redNombre = `cliente-${clienteSlug}-network`;
    const containers = await docker.listContainers({
      all: false,
      filters: { label: [`com.docker.compose.project=${projectSlug}`] },
    });
    // Un proyecto compose puede tener varios contenedores (db, redis, workers...).
    // Traefik enruta por alias de red, así que solo el que sirve el puerto configurado
    // debe recibirlo — si todos comparten alias, Docker resuelve el DNS de forma no
    // determinista entre ellos.
    // 1) Si conocemos el nombre del servicio (por el compose YAML), es la señal fiable:
    //    varios servicios pueden compartir imagen (worker/beat con el mismo Dockerfile
    //    EXPOSE que web) y entonces todos aparentan exponer el mismo puerto.
    // 2) Si no, se cae al puerto expuesto por Docker.
    // 3) Si ninguno aplica (compose sin expose/ports explícito), se conectan todos como
    //    antes para no romper el deploy.
    const porServicio = servicio
      ? containers.filter(
          (c) => c.Labels?.["com.docker.compose.service"] === servicio,
        )
      : [];
    const conPuertoExpuesto = containers.filter((c) =>
      c.Ports?.some((p) => p.PrivatePort === puerto),
    );
    const destino =
      porServicio.length > 0
        ? porServicio
        : conPuertoExpuesto.length > 0
          ? conPuertoExpuesto
          : containers;

    // A container joins the network once, so every alias it needs (the
    // Proyecto's and its Servicio's own route alias) goes in the same connect.
    const aliases = new Map<string, string[]>(
      destino.map((c) => [c.Id, [projectSlug]]),
    );
    for (const nombre of serviciosConRuta) {
      const delServicio = containers.filter(
        (c) => c.Labels?.["com.docker.compose.service"] === nombre,
      );
      if (delServicio.length === 0)
        onLog?.(
          `⚠ Hay rutas al Servicio «${nombre}», que está sin contenedor: Traefik responderá 502`,
        );
      for (const c of delServicio)
        aliases.set(c.Id, [
          ...(aliases.get(c.Id) ?? []),
          `${nombre}.${projectSlug}`,
        ]);
    }

    await Promise.all(
      [...aliases].map(async ([id, nombres]) => {
        try {
          await docker.getNetwork(redNombre).connect({
            Container: id,
            EndpointConfig: { Aliases: nombres },
          });
        } catch (err) {
          const msg = (err as { message?: string }).message ?? "";
          // "already exists" → container already connected, safe to ignore.
          // "network sandbox" → container network namespace not ready yet (race condition
          // immediately after compose up); will be connected on the next deploy.
          if (msg.includes("already exists") || msg.includes("network sandbox"))
            return;
          throw err;
        }
      }),
    );
  } catch (err) {
    if (env.NODE_ENV === "production") throw err;
    log.warn({ err }, "conectarContenedoresARedCliente omitido en desarrollo");
  }
}

async function resolverComando(
  repoDir: string,
  campo: "build" | "start",
  override?: string | null,
): Promise<string> {
  if (override?.trim()) return override.trim();
  try {
    const raw = await readFile(`${repoDir}/package.json`, "utf-8");
    const pkg = JSON.parse(raw) as { scripts?: Record<string, string> };
    if (pkg.scripts?.[campo]) return `npm run ${campo}`;
    // Vite / SvelteKit usan "preview" en lugar de "start"
    if (campo === "start" && pkg.scripts?.preview) return "npm run preview";
  } catch {
    // no package.json o error de parseo
  }
  return campo === "build" ? "npm run build" : "npm start";
}

function generarDockerfileNodejs(
  buildCmd: string,
  startCmd: string,
  puerto: number,
  hasBuildVars?: boolean,
): string {
  if (hasBuildVars) {
    // Multi-stage: build vars go into builder via .env.local (auto-loaded by Next.js/dotenv).
    // Runner copies the final state of /app after the build + rm, so .env.local is not in
    // the deployed image. Builder intermediate layers still have it but are not deployed.
    return [
      "FROM node:22-alpine AS builder",
      "WORKDIR /app",
      // python3/make/g++: dependencias nativas (better-sqlite3, sharp, bcrypt...) sin
      // binario prebuilt para node:22-alpine caen a node-gyp, que necesita este toolchain.
      "RUN apk add --no-cache python3 make g++",
      "COPY . .",
      "RUN npm ci",
      `RUN ${buildCmd} && rm -f .env.local`,
      "",
      "FROM node:22-alpine AS runner",
      "WORKDIR /app",
      "ENV NODE_ENV=production",
      "COPY --from=builder /app .",
      `EXPOSE ${puerto}`,
      `CMD ["sh", "-c", "${startCmd}"]`,
    ].join("\n");
  }

  return [
    "FROM node:22-alpine",
    "WORKDIR /app",
    "RUN apk add --no-cache python3 make g++",
    "COPY . .",
    "RUN npm ci",
    `RUN ${buildCmd}`,
    `EXPOSE ${puerto}`,
    `CMD ["sh", "-c", "${startCmd}"]`,
  ].join("\n");
}

const SIN_COMILLAS = /^[A-Za-z0-9_./:@%+,=-]*$/;

// Unquoted, Compose expands $ and cuts the value at " #". Double quotes with
// \\ \" \$ is the only form that round-trips every value (checked against
// Compose v5: single quotes break on a trailing backslash).
function valorEnvCompose(valor: string): string {
  if (SIN_COMILLAS.test(valor)) return valor;
  return `"${valor.replace(/[\\"$]/g, "\\$&")}"`;
}

// .env.local is read by the app's own dotenv (Next, Vite), which cannot escape
// a quote and expands $: wrap in a quote the value does not use and escape $
// (checked against @next/env). A value with ', ` and " has no faithful form.
function valorEnvApp(valor: string): string {
  if (SIN_COMILLAS.test(valor)) return valor;
  const comilla = ["'", "`", '"'].find((c) => !valor.includes(c)) ?? "";
  return `${comilla}${valor.replaceAll("$", () => "\\$")}${comilla}`;
}

function serializarEnvFile(
  variables: Array<{ clave: string; valor: string }>,
  formato: (valor: string) => string = valorEnvCompose,
): string {
  return variables
    .map(({ clave, valor }) => `${clave}=${formato(valor)}`)
    .join("\n");
}

function serializarMapaYaml(
  cabecera: string,
  indent: string,
  variables: Array<{ clave: string; valor: string }>,
): string[] {
  if (!variables.length) return [];
  return [
    cabecera,
    ...variables.map(
      ({ clave, valor }) =>
        // $$ so Compose does not interpolate the value
        `${indent}${clave}: "${valor.replace(/[\\"]/g, "\\$&").replaceAll("$", () => "$$")}"`,
    ),
  ];
}

function serializarEnvironment(
  variables: Array<{ clave: string; valor: string }>,
): string[] {
  return serializarMapaYaml("    environment:", "      ", variables);
}

function serializarVolumes(
  volumenes: Array<{ rutaHost: string; rutaContenedor: string }>,
): string[] {
  if (!volumenes.length) return [];
  return [
    "    volumes:",
    ...volumenes.map(
      ({ rutaHost, rutaContenedor }) =>
        `      - "${rutaHost}:${rutaContenedor}"`,
    ),
  ];
}

const LOGGING_YAML = [
  "    logging:",
  `      driver: ${LIMITE_LOGS.driver}`,
  "      options:",
  ...Object.entries(LIMITE_LOGS.options).map(
    ([clave, valor]) => `        ${clave}: "${valor}"`,
  ),
];

function generarDockerComposeConBuild(params: {
  context: string;
  dockerfile: string;
  puerto: number;
  buildArgs?: Array<{ clave: string; valor: string }>;
  variables?: Array<{ clave: string; valor: string }>;
  volumenes?: Array<{ rutaHost: string; rutaContenedor: string }>;
}): string {
  return [
    "services:",
    "  app:",
    "    build:",
    `      context: "${params.context}"`,
    `      dockerfile: "${params.dockerfile}"`,
    ...serializarMapaYaml("      args:", "        ", params.buildArgs ?? []),
    // Not published on the host: reached only through Traefik.
    "    expose:",
    `      - "${params.puerto}"`,
    ...serializarEnvironment(params.variables ?? []),
    ...serializarVolumes(params.volumenes ?? []),
    ...LOGGING_YAML,
  ].join("\n");
}

function generarDockerComposeConImage(params: {
  imagenUrl: string;
  puerto: number;
  variables?: Array<{ clave: string; valor: string }>;
  volumenes?: Array<{ rutaHost: string; rutaContenedor: string }>;
}): string {
  return [
    "services:",
    "  app:",
    `    image: "${params.imagenUrl}"`,
    // Not published on the host: reached only through Traefik.
    "    expose:",
    `      - "${params.puerto}"`,
    ...serializarEnvironment(params.variables ?? []),
    ...serializarVolumes(params.volumenes ?? []),
    ...LOGGING_YAML,
  ].join("\n");
}

function spawnDockerCompose(
  args: string[],
  onLog?: (line: string) => void,
  signal?: AbortSignal,
): Promise<string> {
  return new Promise((resolve, reject) => {
    let collected = "";
    // NOTE: on abort only the docker CLI gets the signal. On Linux it forwards it
    // to the compose plugin and BuildKit drops the build; on Windows the
    // docker-compose.exe child survives and finishes the build (dev only).
    const proc = spawn("docker", args, {
      env: { ...process.env, DOCKER_BUILDKIT: "1" },
      signal,
    });

    const handleChunk = (chunk: Buffer) => {
      const text = chunk.toString();
      collected += text;
      if (onLog) {
        text
          .split("\n")
          .filter(Boolean)
          .forEach((line) => onLog(line));
      }
    };

    proc.stdout.on("data", handleChunk);
    proc.stderr.on("data", handleChunk);

    proc.on("close", (code) => {
      if (code !== 0) {
        const err = new Error(`docker compose exited with code ${code}`);
        Object.assign(err, { stdout: collected, stderr: "" });
        reject(err);
      } else {
        resolve(collected);
      }
    });

    proc.on("error", reject);
  });
}

// Every build leaves the previous image untagged and adds build cache; without
// pruning the VPS disk fills up. Rollback rebuilds from the commit, so the old
// images are not needed; cache used in the last week is kept for fast builds.
async function limpiarDisco(onLog?: (line: string) => void): Promise<void> {
  onLog?.("→ Liberando espacio (imágenes sin uso y caché de build antigua)...");
  try {
    await execFileAsync("docker", ["image", "prune", "-f"]);
    await execFileAsync("docker", [
      "builder",
      "prune",
      "-f",
      "--filter",
      "until=168h",
    ]);
  } catch (err) {
    log.warn({ err }, "No se pudo liberar espacio tras el deploy");
  }
}

// As root in a helper container: the files belong to the app's user, which the
// Panel (uid 1001) can neither create nor delete.
const enVolumen = (rutaHost: string, ...comando: string[]) => ({
  comando: "docker",
  args: [
    "run",
    "--rm",
    "-i",
    "--network",
    "none",
    "-v",
    `${rutaHost}:/destino`,
    IMAGEN_AUXILIAR,
    ...comando,
  ],
});

// A Volumen is an empty host folder mounted over the container path. Without
// this, what the image has there is hidden and what the container created at
// runtime (uploads) is lost when the deploy recreates it. Only empty Volúmenes
// are seeded, from the container about to be replaced or, on a first deploy,
// from the image.
async function sembrarVolumenesNuevos(params: {
  volumenes: Array<{ rutaHost: string; rutaContenedor: string }>;
  projectSlug: string;
  composeFile: string;
  imagen: string | null;
  onLog?: (line: string) => void;
  signal?: AbortSignal;
}): Promise<void> {
  const { projectSlug, composeFile, imagen, onLog, signal } = params;
  const vacios: typeof params.volumenes = [];
  for (const v of params.volumenes) {
    await mkdir(v.rutaHost, { recursive: true });
    if ((await readdir(v.rutaHost)).length === 0) vacios.push(v);
  }
  if (!vacios.length) return;

  const [previo] = await docker.listContainers({
    all: true,
    filters: {
      label: [
        `com.docker.compose.project=${projectSlug}`,
        "com.docker.compose.service=app",
      ],
    },
  });
  let origen = previo?.Id;
  let temporal: string | undefined;
  if (!origen) {
    onLog?.("→ Preparando la imagen para rellenar los volúmenes nuevos...");
    await spawnDockerCompose(
      [
        "compose",
        "-p",
        projectSlug,
        "-f",
        composeFile,
        imagen ? "pull" : "build",
      ],
      onLog,
      signal,
    );
    // Compose names the image it builds <proyecto>-<servicio>.
    const creado = await ejecutar(
      "docker",
      ["create", imagen ?? `${projectSlug}-app`],
      { signal },
    );
    origen = temporal = creado.trim();
  }

  try {
    for (const { rutaHost, rutaContenedor } of vacios) {
      onLog?.(`→ Copiando al volumen lo que había en ${rutaContenedor}...`);
      try {
        await encadenar(
          {
            comando: "docker",
            args: ["cp", `${origen}:${rutaContenedor}/.`, "-"],
          },
          enVolumen(rutaHost, "tar", "-x", "-C", "/destino"),
          { signal },
        );
      } catch (err) {
        // Nothing at that path in the container: an empty Volumen is right.
        if (
          err instanceof ErrorProceso &&
          /Could not find the file/i.test(err.message)
        )
          continue;
        // Half a copy would pass for a seeded Volumen on the next deploy, which
        // would then recreate the container and lose the rest.
        const vaciar = enVolumen(
          rutaHost,
          "find",
          "/destino",
          "-mindepth",
          "1",
          "-delete",
        );
        await ejecutar(vaciar.comando, vaciar.args, {}).catch(() => {});
        throw err;
      }
    }
  } finally {
    if (temporal)
      await ejecutar("docker", ["rm", "-f", temporal], {}).catch(() => {});
  }
}

export async function deployProyecto(params: {
  tipo: string;
  repoUrl?: string | null;
  rama: string;
  sha?: string;
  clienteSlug: string;
  proyectoNombre: string;
  composeContent?: string | null;
  variables?: Array<{ clave: string; valor: string }>;
  variablesBuildTime?: Array<{ clave: string; valor: string }>;
  credencial?: { clavePrivada: string };
  imagenUrl?: string | null;
  dockerfilePath?: string | null;
  buildCommand?: string | null;
  startCommand?: string | null;
  puerto?: number | null;
  volumenes?: Array<{ rutaHost: string; rutaContenedor: string }>;
  // Compose Servicios that routes point at; each gets "<servicio>.<proyecto>".
  serviciosConRuta?: string[];
  onLog?: (line: string) => void;
  signal?: AbortSignal;
}): Promise<{ output: string; sha: string }> {
  const {
    tipo,
    repoUrl,
    rama,
    sha,
    clienteSlug,
    proyectoNombre,
    composeContent,
    variables,
    variablesBuildTime,
    credencial,
    imagenUrl,
    dockerfilePath,
    buildCommand,
    startCommand,
    onLog,
    signal,
  } = params;
  const volumenes = params.volumenes ?? [];

  const puerto = params.puerto ?? 3000;
  const repoDir = `${env.REPOS_DIR}/${clienteSlug}/${proyectoNombre}`;
  const panelDir = `${env.REPOS_DIR}/${clienteSlug}/.panel`;
  const keyFilePath = `${panelDir}/${proyectoNombre}.deploy_key`;
  const projectSlug = `${clienteSlug}-${proyectoNombre}`;

  await mkdir(panelDir, { recursive: true });

  if (credencial) {
    // SSH requires Unix line endings and a trailing newline — normalize before writing
    const normalizedKey =
      credencial.clavePrivada.replace(/\r\n/g, "\n").trimEnd() + "\n";
    await writeFile(keyFilePath, normalizedKey, { mode: 0o600 });
  }

  const gitEnv: NodeJS.ProcessEnv = credencial
    ? {
        ...process.env,
        GIT_SSH_COMMAND: `ssh -i ${keyFilePath} -o StrictHostKeyChecking=accept-new -o UserKnownHostsFile=/dev/null`,
      }
    : { ...process.env };

  // SSH keys only work with SSH URLs — convert HTTPS GitHub URLs automatically
  const effectiveRepoUrl =
    credencial && repoUrl
      ? repoUrl.replace(
          /^https:\/\/github\.com\/(.+?)(?:\.git)?$/,
          "git@github.com:$1.git",
        )
      : repoUrl;

  const opts = { env: gitEnv, signal };
  let capturedSha = "";

  try {
    // Operaciones git — solo para tipos que usan repo
    if (tipo !== "image" && effectiveRepoUrl) {
      await ensureRepo(effectiveRepoUrl, repoDir, gitEnv, onLog, signal);

      if (sha) {
        onLog?.(`→ Haciendo checkout de ${sha}...`);
        await execFileAsync("git", ["-C", repoDir, "fetch", "origin"], opts);
        await execFileAsync("git", ["-C", repoDir, "checkout", sha], opts);
      } else {
        onLog?.(`→ Actualizando rama ${rama}...`);
        await execFileAsync("git", ["-C", repoDir, "fetch", "origin"], opts);
        await execFileAsync(
          "git",
          ["-C", repoDir, "checkout", "-B", rama, `origin/${rama}`],
          opts,
        );
      }

      capturedSha = (
        await execFileAsync("git", ["-C", repoDir, "rev-parse", "HEAD"], opts)
      ).stdout.trim();
      onLog?.(`→ SHA: ${capturedSha}`);
    }

    // Determinar fichero compose según tipo
    let composeFile: string;

    const runtimeVars = variables ?? [];
    // The panel's commit hash wins over any user-defined var with the same name.
    const buildVars = [
      ...(variablesBuildTime ?? []).filter((v) => v.clave !== "GIT_SHA_SHORT"),
      ...(capturedSha
        ? [{ clave: "GIT_SHA_SHORT", valor: capturedSha.slice(0, 7) }]
        : []),
    ];
    const esComposeDesdeRepo = tipo === "compose" && !composeContent;
    let escribioEnvLocal = false;

    if (tipo === "compose") {
      if (composeContent) {
        // User-authored compose: write to panelDir so it stays separate from any repo clone.
        // Pre-substitute ${VAR} so network/volume map keys are resolved — docker compose
        // does not interpolate variables in YAML map keys, only in values.
        const composePath = `${panelDir}/${proyectoNombre}.docker-compose.yml`;
        const processedContent = apuntarEnvFile(
          substituirVarsEnCompose(composeContent, runtimeVars),
          `${proyectoNombre}.env`,
        );
        await writeFile(composePath, processedContent, { encoding: "utf-8" });
        composeFile = composePath;
        // Always write .env — the compose may have `env_file: .env` directives that
        // require the file to exist even when no vars are configured yet.
        const envContent = serializarEnvFile(runtimeVars);
        await writeFile(`${panelDir}/${proyectoNombre}.env`, envContent, {
          encoding: "utf-8",
          mode: 0o600,
        });
        // Left by versions before 3.1.0, which shared it between the Cliente's
        // Proyectos. TODO: drop this cleanup once every VPS has redeployed.
        await unlink(`${panelDir}/.env`).catch(() => {});
      } else {
        composeFile = `${repoDir}/docker-compose.yml`;
        // Always write .env next to the compose file — docker compose auto-loads it for
        // ${VAR} substitution, and `env_file: .env` in service definitions requires it
        // to exist even when no vars are configured yet. Build-time vars are only
        // present during the build; the finally below restores runtime-only content.
        await writeFile(
          `${repoDir}/.env`,
          serializarEnvFile([...runtimeVars, ...buildVars]),
          { encoding: "utf-8", mode: 0o600 },
        );
      }
    } else if (tipo === "dockerfile") {
      const dfPath = dockerfilePath?.trim() || "Dockerfile";
      const dfAbsoluto = dfPath.startsWith("/")
        ? dfPath
        : `${repoDir}/${dfPath}`;
      const composePath = `${panelDir}/${proyectoNombre}.docker-compose.yml`;
      await writeFile(
        composePath,
        generarDockerComposeConBuild({
          context: repoDir,
          dockerfile: dfAbsoluto,
          puerto,
          buildArgs: buildVars,
          variables: runtimeVars,
          volumenes,
        }),
      );
      composeFile = composePath;
    } else if (tipo === "nodejs") {
      const buildCmd = await resolverComando(repoDir, "build", buildCommand);
      const startCmd = await resolverComando(repoDir, "start", startCommand);
      const dfGenerado = `${panelDir}/${proyectoNombre}.Dockerfile`;
      const composePath = `${panelDir}/${proyectoNombre}.docker-compose.yml`;

      const hasBuildVars = buildVars.length > 0;
      if (hasBuildVars) {
        // Write to .env.local in the repo so COPY . . picks it up during build.
        // The multi-stage Dockerfile deletes it before the runner stage copies,
        // so the deployed image stays clean.
        const envLocal = serializarEnvFile(buildVars, valorEnvApp);
        await writeFile(`${repoDir}/.env.local`, envLocal, {
          encoding: "utf-8",
          mode: 0o600,
        });
        escribioEnvLocal = true;
      }

      await writeFile(
        dfGenerado,
        generarDockerfileNodejs(buildCmd, startCmd, puerto, hasBuildVars),
      );
      // BuildKit uses <Dockerfile>.dockerignore instead of the context's own,
      // so the repo's rules are merged in. `COPY . .` would otherwise ship .git.
      const ignoreRepo = await readFile(
        `${repoDir}/.dockerignore`,
        "utf-8",
      ).catch(() => "");
      await writeFile(
        `${dfGenerado}.dockerignore`,
        `${ignoreRepo ? `${ignoreRepo.trimEnd()}\n\n` : ""}.git\n`,
      );
      await writeFile(
        composePath,
        generarDockerComposeConBuild({
          context: repoDir,
          dockerfile: dfGenerado,
          puerto,
          variables: runtimeVars,
          volumenes,
        }),
      );
      composeFile = composePath;
    } else {
      // image
      const composePath = `${panelDir}/${proyectoNombre}.docker-compose.yml`;
      await writeFile(
        composePath,
        generarDockerComposeConImage({
          imagenUrl: imagenUrl!,
          puerto,
          variables: runtimeVars,
          volumenes,
        }),
      );
      composeFile = composePath;
    }

    // dockerfile/nodejs/image generan siempre un único servicio "app"; en compose
    // (repo o composeContent) hay que averiguar cuál de los servicios del YAML es
    // el que sirve el puerto configurado.
    const composeUsuario =
      tipo === "compose" ? await readFile(composeFile, "utf-8") : null;
    const servicioObjetivo =
      composeUsuario !== null
        ? encontrarServicioPorPuerto(composeUsuario, puerto)
        : "app";

    // Generated composes already carry the log limit; a user compose gets it
    // through a second -f for the services that do not set their own logging.
    const overrideLogging =
      composeUsuario !== null ? generarOverrideLogging(composeUsuario) : null;
    const overrideArgs: string[] = [];
    if (overrideLogging) {
      const overridePath = `${panelDir}/${proyectoNombre}.logging.yml`;
      await writeFile(overridePath, overrideLogging, { encoding: "utf-8" });
      overrideArgs.push("-f", overridePath);
    }

    // Always, even when empty: without it Compose would interpolate with
    // whatever .env sits in the shared .panel/ directory.
    const envFileArgs =
      tipo === "compose" && composeContent
        ? ["--env-file", `${panelDir}/${proyectoNombre}.env`]
        : [];

    const composeArgs = [
      "compose",
      "-p",
      projectSlug,
      "-f",
      composeFile,
      ...overrideArgs,
      ...envFileArgs,
      "up",
      "--build",
      "-d",
      "--force-recreate",
    ];

    let output = "";
    try {
      // Generated composes only: the Panel does not mount Volúmenes in a
      // compose Proyecto.
      if (tipo !== "compose")
        await sembrarVolumenesNuevos({
          volumenes,
          projectSlug,
          composeFile,
          imagen: tipo === "image" ? imagenUrl! : null,
          onLog,
          signal,
        });
      onLog?.("→ Construyendo e iniciando contenedores...");
      output = await spawnDockerCompose(composeArgs, onLog, signal);
    } finally {
      if (escribioEnvLocal) {
        await unlink(`${repoDir}/.env.local`).catch(() => {});
      }
      if (esComposeDesdeRepo && buildVars.length > 0) {
        await writeFile(`${repoDir}/.env`, serializarEnvFile(runtimeVars), {
          encoding: "utf-8",
          mode: 0o600,
        });
      }
    }

    onLog?.("→ Conectando red y proxy...");
    await asegurarRedCliente(clienteSlug);
    await conectarTraefikARed(clienteSlug);
    await conectarContenedoresARedCliente(
      projectSlug,
      clienteSlug,
      puerto,
      servicioObjetivo,
      params.serviciosConRuta ?? [],
      onLog,
    );

    await limpiarDisco(onLog);

    onLog?.("✓ Deploy completado");
    return { output, sha: capturedSha };
  } finally {
    if (credencial) {
      await unlink(keyFilePath).catch(() => {});
    }
  }
}
