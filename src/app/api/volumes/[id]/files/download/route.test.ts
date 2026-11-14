import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@/env", () => ({ env: { REPOS_DIR: "/repos" } }));

vi.mock("@/lib/auth", () => ({ auth: vi.fn() }));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    volumen: { findUnique: vi.fn() },
  },
}));

const { contenidos, noFicheros, enlaces } = vi.hoisted(() => ({
  contenidos: new Map<string, string[]>(),
  noFicheros: new Set<string>(),
  enlaces: new Set<string>(),
}));
const nombreDe = (ruta: unknown) => String(ruta).split(/[\\/]/).pop()!;

vi.mock("node:fs/promises", () => ({
  lstat: vi.fn(async (ruta: unknown) => ({
    isSymbolicLink: () => enlaces.has(nombreDe(ruta)),
    isFile: () => !noFicheros.has(nombreDe(ruta)),
  })),
}));
// Each file arrives in several chunks, as a real read stream delivers it.
vi.mock("node:fs", async () => {
  const { Readable } = await import("node:stream");
  return {
    createReadStream: vi.fn((ruta: unknown) =>
      Readable.from(
        (contenidos.get(nombreDe(ruta)) ?? []).map((t) => Buffer.from(t)),
      ),
    ),
  };
});

vi.mock("@/lib/volumenes", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/volumenes")>()),
  rutaHostVolumen: vi
    .fn()
    .mockReturnValue("/repos/cliente/proyecto/volumes/galeria"),
}));

import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { createReadStream } from "node:fs";
import { strFromU8, unzipSync } from "fflate";
import { GET } from "./route";

const mockSession = {
  user: { id: "u1", email: "admin@vicagr.local" },
  expires: "2099-01-01",
};

const mockVolumen = {
  id: "v1",
  nombre: "galeria",
  proyecto: {
    nombre: "web-app",
    cliente: { slug: "cliente-uno" },
  },
};

function makeRequest(searchParams: Record<string, string>) {
  const url = new URL("http://localhost/api/volumes/v1/files/download");
  for (const [k, v] of Object.entries(searchParams)) url.searchParams.set(k, v);
  return new NextRequest(url);
}

describe("GET /api/volumes/[id]/files/download", () => {
  beforeEach(() => vi.clearAllMocks());

  it("devuelve 401 sin sesión", async () => {
    vi.mocked(auth).mockResolvedValue(null);
    const res = await GET(makeRequest({ files: "foto.jpg" }), {
      params: Promise.resolve({ id: "v1" }),
    });
    expect(res.status).toBe(401);
  });

  it("devuelve 404 si el volumen no existe", async () => {
    vi.mocked(auth).mockResolvedValue(mockSession as never);
    vi.mocked(prisma.volumen.findUnique).mockResolvedValue(null);
    const res = await GET(makeRequest({ files: "foto.jpg" }), {
      params: Promise.resolve({ id: "v1" }),
    });
    expect(res.status).toBe(404);
  });

  it("devuelve 400 si no se especifican ficheros", async () => {
    vi.mocked(auth).mockResolvedValue(mockSession as never);
    vi.mocked(prisma.volumen.findUnique).mockResolvedValue(
      mockVolumen as never,
    );
    const res = await GET(makeRequest({}), {
      params: Promise.resolve({ id: "v1" }),
    });
    expect(res.status).toBe(400);
  });

  it("devuelve 400 si el path contiene path traversal", async () => {
    vi.mocked(auth).mockResolvedValue(mockSession as never);
    vi.mocked(prisma.volumen.findUnique).mockResolvedValue(
      mockVolumen as never,
    );
    const res = await GET(makeRequest({ path: "../../etc", files: "passwd" }), {
      params: Promise.resolve({ id: "v1" }),
    });
    expect(res.status).toBe(400);
  });

  const descargar = async (files: string) => {
    vi.mocked(auth).mockResolvedValue(mockSession as never);
    vi.mocked(prisma.volumen.findUnique).mockResolvedValue(
      mockVolumen as never,
    );
    const res = await GET(makeRequest({ files }), {
      params: Promise.resolve({ id: "v1" }),
    });
    const zip = unzipSync(new Uint8Array(await res.arrayBuffer()));
    return {
      res,
      entradas: Object.fromEntries(
        Object.entries(zip).map(([nombre, datos]) => [
          nombre,
          strFromU8(datos),
        ]),
      ),
    };
  };

  it("devuelve application/zip con el nombre del volumen", async () => {
    contenidos.set("foto.jpg", ["contenido"]);
    const { res } = await descargar("foto.jpg");

    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("application/zip");
    const cd = res.headers.get("Content-Disposition") ?? "";
    expect(cd).toMatch(/attachment;\s*filename="galeria-\d+\.zip"/);
  });

  // Streamed chunk by chunk: a big file must never be held whole in memory.
  it("el ZIP contiene cada fichero pedido, leído por trozos", async () => {
    contenidos.set("a.jpg", ["primera parte, ", "segunda parte"]);
    contenidos.set("b.png", ["datos"]);

    const { entradas } = await descargar("a.jpg,b.png");

    expect(entradas).toEqual({
      "a.jpg": "primera parte, segunda parte",
      "b.png": "datos",
    });
  });

  it("omite lo que no es un fichero (carpetas, nombres que no existen)", async () => {
    contenidos.set("a.jpg", ["datos"]);
    noFicheros.add("carpeta");

    const { entradas } = await descargar("a.jpg,carpeta");

    expect(Object.keys(entradas)).toEqual(["a.jpg"]);
    noFicheros.clear();
  });

  it("no incluye un enlace simbólico: el contenedor podría apuntarlo fuera del volumen", async () => {
    contenidos.set("a.jpg", ["datos"]);
    enlaces.add("enlace");

    const { entradas } = await descargar("a.jpg,enlace");

    expect(Object.keys(entradas)).toEqual(["a.jpg"]);
    expect(createReadStream).toHaveBeenCalledTimes(1);
    enlaces.clear();
  });
});
