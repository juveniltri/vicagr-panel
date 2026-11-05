import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/prisma", () => ({
  prisma: { user: { findUnique: vi.fn() } },
}));

import { prisma } from "@/lib/prisma";
import {
  DURACION_SESION_OIDC_MS,
  accesoOidc,
  sesionVigente,
  tokenOidc,
} from "./sesion";

const cambioPassword = new Date("2026-10-10T10:00:00Z");

describe("sesionVigente", () => {
  beforeEach(() => {
    vi.mocked(prisma.user.findUnique).mockResolvedValue({
      sesionesDesde: cambioPassword,
    } as never);
  });

  it("acepta una sesión iniciada después del último cambio de contraseña", async () => {
    const token = { sub: "u1", iniciadaEn: cambioPassword.getTime() + 1000 };
    expect(await sesionVigente(token)).toBe(true);
    expect(prisma.user.findUnique).toHaveBeenCalledWith({
      where: { id: "u1" },
      select: { sesionesDesde: true },
    });
  });

  it("rechaza la sesión de un usuario eliminado", async () => {
    vi.mocked(prisma.user.findUnique).mockResolvedValue(null);
    const token = { sub: "u1", iniciadaEn: cambioPassword.getTime() + 1000 };
    expect(await sesionVigente(token)).toBe(false);
  });

  it("rechaza una sesión iniciada antes de cambiar la contraseña", async () => {
    const token = { sub: "u1", iniciadaEn: cambioPassword.getTime() - 1000 };
    expect(await sesionVigente(token)).toBe(false);
  });

  it("rechaza los tokens anteriores a esta comprobación, sin usuario o sin fecha de inicio", async () => {
    expect(await sesionVigente({ sub: "u1" })).toBe(false);
    expect(await sesionVigente({ sub: "u1", iniciadaEn: "ayer" })).toBe(false);
    expect(await sesionVigente({ iniciadaEn: Date.now() })).toBe(false);
  });
});

describe("sesionVigente — sesión iniciada con Pocket ID", () => {
  beforeEach(() => {
    vi.mocked(prisma.user.findUnique).mockResolvedValue({
      sesionesDesde: new Date(0),
    } as never);
  });

  it("sigue vigente antes de que pase su duración", async () => {
    const iniciadaEn = Date.now() - DURACION_SESION_OIDC_MS + 60_000;
    expect(await sesionVigente({ sub: "u1", iniciadaEn, oidc: true })).toBe(
      true,
    );
  });

  it("caduca al pasar su duración, para que una baja en Pocket ID tenga efecto", async () => {
    const iniciadaEn = Date.now() - DURACION_SESION_OIDC_MS - 1;
    expect(await sesionVigente({ sub: "u1", iniciadaEn, oidc: true })).toBe(
      false,
    );
  });

  it("no acorta las sesiones con contraseña", async () => {
    const iniciadaEn = Date.now() - DURACION_SESION_OIDC_MS - 1;
    expect(await sesionVigente({ sub: "u1", iniciadaEn })).toBe(true);
  });
});

describe("accesoOidc", () => {
  it("deja entrar a quien está vinculado a un usuario del Panel", async () => {
    vi.mocked(prisma.user.findUnique).mockResolvedValue({ id: "u1" } as never);
    expect(await accesoOidc("sub-1")).toBe(true);
    expect(prisma.user.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({ where: { oidcSub: "sub-1" } }),
    );
  });

  it("sin vínculo no entra y vuelve al login con su identificador", async () => {
    vi.mocked(prisma.user.findUnique).mockResolvedValue(null);
    expect(await accesoOidc("sub con/raro")).toBe(
      "/login?error=oidc_sin_vincular&sub=sub%20con%2Fraro",
    );
  });

  it("sin identificador no consulta la BD ni deja entrar", async () => {
    vi.mocked(prisma.user.findUnique).mockClear();
    expect(await accesoOidc(undefined)).toBe("/login?error=oidc");
    expect(prisma.user.findUnique).not.toHaveBeenCalled();
  });
});

describe("tokenOidc", () => {
  it("sustituye la identidad de Pocket ID por la del usuario local", async () => {
    vi.mocked(prisma.user.findUnique).mockResolvedValue({
      id: "u1",
      email: "local@vicagr.local",
      nombre: "Local",
    } as never);

    const token = await tokenOidc(
      { sub: "sub-1", email: "otro@ejemplo.com", name: "Otro", extra: 1 },
      "sub-1",
    );

    expect(token).toMatchObject({
      sub: "u1",
      email: "local@vicagr.local",
      name: "Local",
      oidc: true,
      extra: 1,
    });
    expect(token?.iniciadaEn).toEqual(expect.any(Number));
  });

  it("sin vínculo no emite sesión", async () => {
    vi.mocked(prisma.user.findUnique).mockResolvedValue(null);
    expect(await tokenOidc({ sub: "sub-1" }, "sub-1")).toBeNull();
    expect(await tokenOidc({ sub: "sub-1" }, undefined)).toBeNull();
  });
});
