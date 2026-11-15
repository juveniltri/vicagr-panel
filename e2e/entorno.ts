import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@prisma/client";
import {
  PROYECTO,
  RED_DEMO,
  TMP,
  docker,
  type EntornoGuia,
} from "../scripts/guia/entorno";

export const BASE = "https://localhost";
export const USUARIO = {
  email: "e2e@vicagr.local",
  password: "e2e-pruebas-2026",
  nombre: "Pruebas E2E",
};
// Every Cliente the suite creates starts with this, so the teardown can find
// what the tests deployed without touching anything else on the machine.
export const PREFIJO = "e2e";
// Receives the Panel's notifications; the tests read what arrived.
export const BUZON = "vicagr-e2e-buzon";
export const REPOS = "/var/vicagr/repos";

const FICHERO_ENTORNO = path.join(TMP, "e2e.json");

export function compose(args: string[]): void {
  execFileSync(
    "docker",
    [
      "compose",
      "-p",
      PROYECTO,
      "--env-file",
      path.join(TMP, ".env"),
      "-f",
      "docker-compose.yml",
      "-f",
      path.join("scripts", "guia", "compose.guia.yml"),
      "-f",
      path.join("e2e", "compose.e2e.yml"),
      ...args,
    ],
    { stdio: "inherit", env: { ...process.env, MSYS_NO_PATHCONV: "1" } },
  );
}

export function guardarEntorno(entorno: EntornoGuia): void {
  writeFileSync(FICHERO_ENTORNO, JSON.stringify(entorno));
}

export function leerEntorno(): EntornoGuia {
  return JSON.parse(readFileSync(FICHERO_ENTORNO, "utf-8")) as EntornoGuia;
}

export function conectarBd(entorno = leerEntorno()): PrismaClient {
  return new PrismaClient({
    adapter: new PrismaPg({
      connectionString: `postgresql://vicagr:${entorno.DB_PASSWORD}@localhost:5434/vicagr`,
    }),
  });
}

// Writes what arrives at :8080 to /tmp/buzon.jsonl, one JSON per line.
const SERVIDOR_BUZON = `
const fs = require("fs");
require("http").createServer((req, res) => {
  let cuerpo = "";
  req.on("data", (t) => (cuerpo += t));
  req.on("end", () => {
    fs.appendFileSync("/tmp/buzon.jsonl", cuerpo.replace(/\\n/g, " ") + "\\n");
    res.end("ok");
  });
}).listen(8080);
`;

export function arrancarBuzon(): void {
  docker([
    "run",
    "-d",
    "--name",
    BUZON,
    "--network",
    RED_DEMO,
    "--label",
    "vicagr.guia=1",
    "node:22-alpine",
    "node",
    "-e",
    SERVIDOR_BUZON,
  ]);
}

export function avisosRecibidos(): Array<Record<string, unknown>> {
  const contenido = docker(["exec", BUZON, "cat", "/tmp/buzon.jsonl"], {
    permitirFallo: true,
  });
  return contenido
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l) as Record<string, unknown>);
}

// Containers, volumes and networks of the Proyectos the tests deployed, and
// their folders: the guide's cleanup only knows about its own stack.
export function limpiarProyectosE2e(): void {
  const contenedores = docker(
    [
      "ps",
      "-a",
      "--filter",
      "label=com.docker.compose.project",
      "--format",
      '{{.ID}} {{.Label "com.docker.compose.project"}}',
    ],
    { permitirFallo: true },
  )
    .split("\n")
    .filter((l) => l.split(" ")[1]?.startsWith(`${PREFIJO}`))
    .map((l) => l.split(" ")[0]);
  if (contenedores.length)
    docker(["rm", "-f", ...contenedores], { permitirFallo: true });
  for (const tipo of ["volume", "network"] as const) {
    const nombres = docker([tipo, "ls", "--format", "{{.Name}}"], {
      permitirFallo: true,
    })
      .split("\n")
      .filter(
        (n) => n.startsWith(`${PREFIJO}`) || n.startsWith(`cliente-${PREFIJO}`),
      );
    if (nombres.length)
      docker([tipo, "rm", ...nombres], { permitirFallo: true });
  }
  docker(
    [
      "run",
      "--rm",
      "-v",
      `${REPOS}:/r`,
      "busybox:1.37.0",
      "sh",
      "-c",
      `rm -rf /r/${PREFIJO}* /r/.git-known_hosts`,
    ],
    { permitirFallo: true },
  );
}
