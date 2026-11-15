import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const { raiz } = vi.hoisted(() => ({ raiz: { dir: "", repos: "" } }));

vi.mock("@/env", () => ({
  env: {
    get REPOS_DIR() {
      return raiz.repos;
    },
  },
}));
vi.mock("@/lib/auth", () => ({ auth: vi.fn() }));
vi.mock("@/lib/prisma", () => ({
  prisma: { volumen: { findUnique: vi.fn() } },
}));
// Real files in a temp folder: the point is what ends up on disk.
// The final move into the Volumen runs in a helper container; here it is a
// plain copy so the tests can look at the result on disk.
vi.mock("@/lib/volumenes", async (importOriginal) => {
  const { copyFile } = await import("node:fs/promises");
  return {
    ...(await importOriginal<typeof import("@/lib/volumenes")>()),
    MAX_SUBIDA_BYTES: 10,
    rutaHostVolumen: () => raiz.dir,
    moverAVolumen: vi.fn((_base: string, temporal: string, destino: string) =>
      copyFile(temporal, destino),
    ),
    borrarEnVolumen: vi.fn(),
  };
});

import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { borrarEnVolumen, moverAVolumen } from "@/lib/volumenes";
import { DELETE, POST } from "./route";

const params = { params: Promise.resolve({ id: "v1" }) };

function subir(query: Record<string, string>, cuerpo: string | null) {
  const url = new URL("http://localhost/api/volumes/v1/files");
  for (const [k, v] of Object.entries(query)) url.searchParams.set(k, v);
  return POST(new NextRequest(url, { method: "POST", body: cuerpo }), params);
}

describe("POST /api/volumes/[id]/files", () => {
  beforeEach(async () => {
    if (raiz.repos) await rm(raiz.repos, { recursive: true, force: true });
    raiz.repos = await mkdtemp(path.join(tmpdir(), "vicagr-repos-"));
    raiz.dir = await mkdtemp(path.join(raiz.repos, "volumen-"));
    vi.mocked(auth).mockResolvedValue({ user: { id: "u1" } } as never);
    vi.mocked(prisma.volumen.findUnique).mockResolvedValue({
      id: "v1",
      nombre: "galeria",
      proyecto: { nombre: "web", cliente: { slug: "acme" } },
    } as never);
  });

  afterAll(async () => {
    await rm(raiz.repos, { recursive: true, force: true });
  });

  // Docker follows a link in the source of a bind mount: the helper would
  // write as root wherever the Volumen folder points.
  it("rechaza un Volumen cuya carpeta es un enlace simbólico", async () => {
    const fuera = await mkdtemp(path.join(tmpdir(), "vicagr-fuera-"));
    const enlace = path.join(raiz.repos, "enlazado");
    await symlink(fuera, enlace, "junction");
    raiz.dir = enlace;
    try {
      expect((await subir({ nombre: "a.txt" }, "hola")).status).toBe(400);
      expect(moverAVolumen).not.toHaveBeenCalled();
      expect(await readdir(fuera)).toEqual([]);
    } finally {
      await rm(fuera, { recursive: true, force: true });
    }
  });

  it("devuelve 401 sin sesión", async () => {
    vi.mocked(auth).mockResolvedValue(null as never);
    expect((await subir({ nombre: "a.txt" }, "hola")).status).toBe(401);
  });

  // The file manager uploads into the folder it is showing, which exists.
  it("guarda el cuerpo de la petición como fichero en la carpeta pedida", async () => {
    await mkdir(path.join(raiz.dir, "fotos"));
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

  // The Panel cannot write in a folder owned by the container's user: the
  // upload is written to the Panel's own folder and moved in by the helper.
  it("escribe la subida en la carpeta del Panel y la mueve al Volumen", async () => {
    await subir({ nombre: "a.txt" }, "hola");

    const [base, temporal, destino] = vi.mocked(moverAVolumen).mock.calls[0];
    expect(base).toBe(raiz.dir);
    expect(path.dirname(temporal)).toBe(`${raiz.repos}/.subidas`);
    expect(destino).toBe(path.join(raiz.dir, "a.txt"));
  });

  it("no deja el temporal en la carpeta del Panel, haya ido bien o mal", async () => {
    await subir({ nombre: "a.txt" }, "hola");
    vi.mocked(moverAVolumen).mockRejectedValueOnce(new Error("docker"));
    const res = await subir({ nombre: "b.txt" }, "hola");

    expect(res.status).toBe(500);
    expect(await readdir(`${raiz.repos}/.subidas`)).toEqual([]);
  });

  it("borrar lo hace el contenedor auxiliar", async () => {
    const url = new URL("http://localhost/api/volumes/v1/files");
    url.searchParams.set("path", "a.txt");
    const res = await DELETE(
      new NextRequest(url, { method: "DELETE" }),
      params,
    );

    expect(res.status).toBe(204);
    expect(borrarEnVolumen).toHaveBeenCalledWith(
      raiz.dir,
      path.join(raiz.dir, "a.txt"),
    );
  });

  it("si el borrado falla responde 500", async () => {
    vi.mocked(borrarEnVolumen).mockRejectedValueOnce(new Error("docker"));
    const url = new URL("http://localhost/api/volumes/v1/files");
    url.searchParams.set("path", "a.txt");

    const res = await DELETE(
      new NextRequest(url, { method: "DELETE" }),
      params,
    );

    expect(res.status).toBe(500);
  });
});
