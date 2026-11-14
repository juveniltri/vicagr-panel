import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/auth", () => ({ auth: vi.fn() }));
vi.mock("@/lib/health", () => ({ comprobarSalud: vi.fn() }));

import { auth } from "@/lib/auth";
import { comprobarSalud } from "@/lib/health";
import { GET } from "./route";

const sano = {
  status: "ok" as const,
  checks: {
    database: "ok" as const,
    docker: "ok" as const,
    proxy: "ok" as const,
    certificados: "ok" as const,
  },
  version: "3.1.0",
};

describe("GET /api/health", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(comprobarSalud).mockResolvedValue(sano);
    vi.mocked(auth).mockResolvedValue(null as never);
  });

  // Anyone can call it: the version and which piece is down help an attacker
  // and are of no use to a monitor.
  it("sin sesión solo dice si está bien o no", async () => {
    const res = await GET();

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "ok" });
  });

  it("sin sesión, degradado responde 503 sin decir qué falla", async () => {
    vi.mocked(comprobarSalud).mockResolvedValue({
      ...sano,
      status: "degraded",
      checks: { ...sano.checks, proxy: "error" },
    });

    const res = await GET();

    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ status: "degraded" });
  });

  it("con sesión devuelve cada comprobación y la versión", async () => {
    vi.mocked(auth).mockResolvedValue({ user: { id: "u1" } } as never);

    const cuerpo = await (await GET()).json();

    expect(cuerpo).toMatchObject({ ...sano, timestamp: expect.any(String) });
  });
});
