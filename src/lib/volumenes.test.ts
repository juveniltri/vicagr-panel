import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("node:fs/promises", () => ({ lstat: vi.fn() }));
vi.mock("@/lib/backups/procesos", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/backups/procesos")>()),
  ejecutar: vi.fn(),
}));

import { lstat } from "node:fs/promises";
import { ejecutar, ErrorProceso } from "@/lib/backups/procesos";
import {
  borrarEnVolumen,
  crearCarpetaEnVolumen,
  moverAVolumen,
  YaExiste,
  resolverRutaSegura,
  resolverRutaSinEnlaces,
  rutaHostVolumen,
  volumenSinEnlaces,
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

  // The Volumen folder sits in the Proyecto's checkout: Docker would follow a
  // link there when mounting it, and the helpers act as root.
  describe("con reposDir", () => {
    const repos = "/var/vicagr/repos";
    const opciones = { reposDir: repos };

    it.each(["acme/web", "acme/web/volumes", "acme/web/volumes/uploads"])(
      "rechaza un Volumen bajo el enlace %s",
      async (enlace) => {
        enlaces.add(path.resolve(repos, enlace));
        expect(
          await resolverRutaSinEnlaces(base, "a.jpg", opciones),
        ).toBeNull();
      },
    );

    it("resuelve si no hay enlaces de reposDir al Volumen", async () => {
      expect(await resolverRutaSinEnlaces(base, "a.jpg", opciones)).toBe(
        en("a.jpg"),
      );
    });

    it("rechaza un Volumen fuera de reposDir", async () => {
      expect(
        await resolverRutaSinEnlaces(base, "a.jpg", { reposDir: "/otro" }),
      ).toBeNull();
    });
  });
});

describe("volumenSinEnlaces", () => {
  beforeEach(() => {
    vi.mocked(lstat).mockImplementation(async (ruta) => {
      if (String(ruta).endsWith("uploads"))
        throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
      return { isSymbolicLink: () => false } as never;
    });
  });

  it("acepta un Volumen que aún no existe (primer deploy)", async () => {
    expect(await volumenSinEnlaces("/var/vicagr/repos", base)).toBe(true);
  });

  it("rechaza la propia carpeta de repos como Volumen", async () => {
    expect(
      await volumenSinEnlaces("/var/vicagr/repos", "/var/vicagr/repos"),
    ).toBe(false);
  });
});

describe("escrituras en el Volumen", () => {
  const ultimaLlamada = () => {
    const [comando, args] = vi.mocked(ejecutar).mock.calls.at(-1)!;
    const i = args.indexOf("-c");
    return {
      comando,
      args,
      script: args[i + 1],
      posicionales: args.slice(i + 3),
    };
  };

  beforeEach(() => {
    vi.mocked(ejecutar).mockReset();
    vi.mocked(ejecutar).mockResolvedValue("");
  });

  // The Panel cannot write files owned by the container's users.
  it("se hacen como root en un contenedor sin red que solo monta el Volumen", async () => {
    await borrarEnVolumen(base, path.resolve(base, "fotos/a.jpg"));

    const { comando, args } = ultimaLlamada();
    expect(comando).toBe("docker");
    expect(args.slice(0, 6)).toEqual([
      "run",
      "--rm",
      "--network",
      "none",
      "-v",
      `${base}:/v`,
    ]);
    expect(args).toContain("busybox:1.37.0");
  });

  it("borrar pasa la ruta como argumento, nunca dentro del script", async () => {
    await borrarEnVolumen(base, path.resolve(base, 'raro"; rm -rf x'));

    const { script, posicionales } = ultimaLlamada();
    expect(script).toBe('set -e; rm -rf -- "$1"');
    expect(posicionales).toEqual(['/v/raro"; rm -rf x']);
  });

  it("crear carpeta la deja con el propietario de la carpeta donde se crea", async () => {
    await crearCarpetaEnVolumen(base, path.resolve(base, "fotos/2026"));

    const { script, posicionales } = ultimaLlamada();
    expect(script).toContain('stat -c %u:%g "$(dirname "$1")"');
    expect(script).toContain('mkdir "$1"; chown "$o" "$1"');
    expect(posicionales).toEqual(["/v/fotos/2026"]);
  });

  it("crear una carpeta que ya existe da YaExiste", async () => {
    vi.mocked(ejecutar).mockRejectedValue(
      new ErrorProceso(
        "docker terminó con código 1:\nmkdir: can't create directory '/v/fotos': File exists",
        1,
        "",
      ),
    );

    await expect(
      crearCarpetaEnVolumen(base, path.resolve(base, "fotos")),
    ).rejects.toBeInstanceOf(YaExiste);
  });

  it("otros fallos al crear la carpeta se propagan", async () => {
    vi.mocked(ejecutar).mockRejectedValue(new Error("docker caído"));

    await expect(
      crearCarpetaEnVolumen(base, path.resolve(base, "fotos")),
    ).rejects.toThrow("docker caído");
  });

  it("mover una subida copia el temporal del Panel, le da el propietario de la carpeta y lo renombra", async () => {
    await moverAVolumen(
      base,
      "/var/vicagr/repos/.subidas/abc-123",
      path.resolve(base, "fotos/a.jpg"),
    );

    const { args, script, posicionales } = ultimaLlamada();
    expect(args).toEqual(
      expect.arrayContaining(["-v", "/var/vicagr/repos/.subidas:/subidas:ro"]),
    );
    expect(script).toContain(
      'cp "/subidas/$2" "$t"; chown "$o" "$t"; mv -f "$t" "$1"',
    );
    expect(posicionales).toEqual(["/v/fotos/a.jpg", "abc-123"]);
  });
});
