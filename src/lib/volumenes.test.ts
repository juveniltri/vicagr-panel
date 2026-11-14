import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("node:fs/promises", () => ({ lstat: vi.fn() }));

import { lstat } from "node:fs/promises";
import {
  resolverRutaSegura,
  resolverRutaSinEnlaces,
  rutaHostVolumen,
} from "./volumenes";

const base = "/var/vicagr/repos/acme/web/volumes/uploads";

describe("rutaHostVolumen", () => {
  it("construye la ruta del volumen dentro del directorio de repos", () => {
    expect(rutaHostVolumen("/var/vicagr/repos", "acme", "web", "uploads")).toBe(
      base,
    );
  });
});

describe("resolverRutaSegura", () => {
  it("resuelve rutas dentro del volumen", () => {
    expect(resolverRutaSegura(base, "fotos/a.jpg")).toBe(
      path.resolve(base, "fotos/a.jpg"),
    );
  });

  it("devuelve la raíz del volumen para una ruta vacía", () => {
    expect(resolverRutaSegura(base, "")).toBe(path.resolve(base));
  });

  it.each(["..", "../otro-volumen", "fotos/../../..", "/etc/passwd"])(
    "rechaza %s porque sale del volumen",
    (relativa) => {
      expect(resolverRutaSegura(base, relativa)).toBeNull();
    },
  );

  it("no confunde un volumen con otro cuyo nombre empieza igual", () => {
    expect(resolverRutaSegura(base, "../uploads-privado/x")).toBeNull();
  });

  it.each(["", ".", "fotos/.."])(
    "con permitirRaiz false rechaza «%s» porque apunta a la raíz",
    (relativa) => {
      expect(
        resolverRutaSegura(base, relativa, { permitirRaiz: false }),
      ).toBeNull();
      expect(resolverRutaSegura(base, "fotos", { permitirRaiz: false })).toBe(
        path.resolve(base, "fotos"),
      );
    },
  );
});

describe("resolverRutaSinEnlaces", () => {
  const enlaces = new Set<string>();
  const inexistentes = new Set<string>();
  const en = (relativa: string) => path.resolve(base, relativa);

  beforeEach(() => {
    enlaces.clear();
    inexistentes.clear();
    vi.mocked(lstat).mockImplementation(async (ruta) => {
      if (inexistentes.has(String(ruta)))
        throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
      return { isSymbolicLink: () => enlaces.has(String(ruta)) } as never;
    });
  });

  it("resuelve una ruta sin enlaces", async () => {
    expect(await resolverRutaSinEnlaces(base, "fotos/a.jpg")).toBe(
      en("fotos/a.jpg"),
    );
  });

  it("rechaza lo que sale del volumen sin tocar el disco", async () => {
    expect(await resolverRutaSinEnlaces(base, "../otro")).toBeNull();
    expect(lstat).not.toHaveBeenCalled();
  });

  it("rechaza un enlace simbólico a un fichero de fuera", async () => {
    enlaces.add(en("secretos.env"));
    expect(await resolverRutaSinEnlaces(base, "secretos.env")).toBeNull();
  });

  it("rechaza una ruta que atraviesa una carpeta enlazada", async () => {
    enlaces.add(en("fotos"));
    expect(await resolverRutaSinEnlaces(base, "fotos/2026/a.jpg")).toBeNull();
  });

  it("acepta una ruta que todavía no existe (subida, carpeta nueva)", async () => {
    inexistentes.add(en("nueva"));
    expect(await resolverRutaSinEnlaces(base, "nueva/a.jpg")).toBe(
      en("nueva/a.jpg"),
    );
  });

  it("rechaza si no se puede comprobar un componente", async () => {
    vi.mocked(lstat).mockRejectedValue(
      Object.assign(new Error("EACCES"), { code: "EACCES" }),
    );
    expect(await resolverRutaSinEnlaces(base, "fotos/a.jpg")).toBeNull();
  });

  it("con permitirEnlaceFinal deja borrar el propio enlace, no lo que hay detrás", async () => {
    enlaces.add(en("fotos/enlace"));
    const opciones = { permitirEnlaceFinal: true };
    expect(await resolverRutaSinEnlaces(base, "fotos/enlace", opciones)).toBe(
      en("fotos/enlace"),
    );
    expect(
      await resolverRutaSinEnlaces(base, "fotos/enlace/x", opciones),
    ).toBeNull();
  });
});
