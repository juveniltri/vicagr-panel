import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockEjecutar } = vi.hoisted(() => ({ mockEjecutar: vi.fn() }));
vi.mock("./procesos", () => ({ ejecutar: mockEjecutar }));

import { entornoPg, pgDump, pgRestore } from "./postgres";

const URL_BD = "postgresql://vicagr:p%40ss@db:5432/vicagr?schema=public";

beforeEach(() => {
  vi.clearAllMocks();
  mockEjecutar.mockResolvedValue("");
});

describe("entornoPg", () => {
  it("convierte DATABASE_URL en variables PG* con la contraseña decodificada", () => {
    expect(entornoPg(URL_BD)).toEqual({
      PGHOST: "db",
      PGPORT: "5432",
      PGUSER: "vicagr",
      PGPASSWORD: "p@ss",
      PGDATABASE: "vicagr",
    });
  });

  it("usa el puerto 5432 si la URL no lo indica", () => {
    expect(entornoPg("postgresql://u:p@db/bd").PGPORT).toBe("5432");
  });
});

describe("pgDump y pgRestore", () => {
  it("pg_dump en formato personalizado sin la contraseña en los argumentos", async () => {
    await pgDump(URL_BD, "/tmp/c/panel-db.dump");
    const [comando, args, opciones] = mockEjecutar.mock.calls[0]!;
    expect(comando).toBe("pg_dump");
    expect(args).toEqual([
      "--format=custom",
      "--compress=0",
      "--file",
      "/tmp/c/panel-db.dump",
    ]);
    expect(JSON.stringify(args)).not.toContain("p@ss");
    expect(opciones.env.PGPASSWORD).toBe("p@ss");
  });

  it("pg_restore limpia, en una sola transacción y sin propietarios", async () => {
    await pgRestore(URL_BD, "/tmp/r/panel-db.dump");
    expect(mockEjecutar.mock.calls[0]![0]).toBe("pg_restore");
    expect(mockEjecutar.mock.calls[0]![1]).toEqual([
      "--clean",
      "--if-exists",
      "--single-transaction",
      "--no-owner",
      "--dbname",
      "vicagr",
      "/tmp/r/panel-db.dump",
    ]);
  });
});
