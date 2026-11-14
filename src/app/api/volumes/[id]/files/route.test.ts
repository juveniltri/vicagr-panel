import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const { raiz } = vi.hoisted(() => ({ raiz: { dir: "" } }));

vi.mock("@/env", () => ({ env: { REPOS_DIR: "/repos" } }));
vi.mock("@/lib/auth", () => ({ auth: vi.fn() }));
vi.mock("@/lib/prisma", () => ({
  prisma: { volumen: { findUnique: vi.fn() } },
}));
// Real files in a temp folder: the point is what ends up on disk.
vi.mock("@/lib/volumenes", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/volumenes")>()),
  MAX_SUBIDA_BYTES: 10,
  rutaHostVolumen: () => raiz.dir,
}));

import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { POST } from "./route";

const params = { params: Promise.resolve({ id: "v1" }) };

function subir(query: Record<string, string>, cuerpo: string | null) {
  const url = new URL("http://localhost/api/volumes/v1/files");
  for (const [k, v] of Object.entries(query)) url.searchParams.set(k, v);
  return POST(new NextRequest(url, { method: "POST", body: cuerpo }), params);
}

describe("POST /api/volumes/[id]/files", () => {
  beforeEach(async () => {
    if (raiz.dir) await rm(raiz.dir, { recursive: true, force: true });
    raiz.dir = await mkdtemp(path.join(tmpdir(), "vicagr-subida-"));
    vi.mocked(auth).mockResolvedValue({ user: { id: "u1" } } as never);
    vi.mocked(prisma.volumen.findUnique).mockResolvedValue({
      id: "v1",
      nombre: "galeria",
      proyecto: { nombre: "web", cliente: { slug: "acme" } },
    } as never);
  });

  afterAll(() => rm(raiz.dir, { recursive: true, force: true }));

  it("devuelve 401 sin sesión", async () => {
    vi.mocked(auth).mockResolvedValue(null as never);
    expect((await subir({ nombre: "a.txt" }, "hola")).status).toBe(401);
  });

  it("guarda el cuerpo de la petición como fichero en la carpeta pedida", async () => {
    const res = await subir({ path: "fotos", nombre: "a.txt" }, "hola");

    expect(res.status).toBe(201);
    expect(await readFile(path.join(raiz.dir, "fotos", "a.txt"), "utf-8")).toBe(
      "hola",
    );
  });

  it("rechaza con 413 un fichero mayor que el máximo y no deja restos", async () => {
    const res = await subir({ nombre: "grande.bin" }, "x".repeat(11));

    expect(res.status).toBe(413);
    expect(await readdir(raiz.dir)).toEqual([]);
  });

  it("una subida rechazada no destruye el fichero que ya existía", async () => {
    await writeFile(path.join(raiz.dir, "a.txt"), "original");

    await subir({ nombre: "a.txt" }, "x".repeat(11));

    expect(await readFile(path.join(raiz.dir, "a.txt"), "utf-8")).toBe(
      "original",
    );
    expect(await readdir(raiz.dir)).toEqual(["a.txt"]);
  });

  it.each(["", "..", "."])("rechaza el nombre «%s»", async (nombre) => {
    expect((await subir({ nombre }, "hola")).status).toBe(400);
  });

  it("usa solo el nombre: no escribe fuera de la carpeta pedida", async () => {
    const res = await subir({ nombre: "../../fuera.txt" }, "hola");

    expect(res.status).toBe(201);
    expect(await readdir(raiz.dir)).toEqual(["fuera.txt"]);
  });
});
