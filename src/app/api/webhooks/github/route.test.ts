import { createHmac } from "node:crypto";
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/env", () => ({ env: { GITHUB_WEBHOOK_SECRET: "s3cret" } }));
vi.mock("@/lib/prisma", () => ({
  prisma: { proyecto: { findMany: vi.fn() } },
}));
vi.mock("@/server/routers/proyectos", () => ({
  lanzarDeploy: vi.fn(),
}));

vi.mock("@/lib/backups/restaurando", () => ({
  estaRestaurando: vi.fn().mockReturnValue(false),
}));
const avisos = vi.hoisted(() => vi.fn());
vi.mock("@/lib/logger", () => ({
  logger: { child: () => ({ warn: avisos }) },
}));

import { prisma } from "@/lib/prisma";
import { estaRestaurando } from "@/lib/backups/restaurando";
import { lanzarDeploy } from "@/server/routers/proyectos";
import { LIMITE_CUERPO } from "@/lib/github/webhook";
import { TRPCError } from "@trpc/server";
import { POST } from "./route";

const proyectoCrm = {
  id: "p1",
  nombre: "crm",
  rama: "main",
  estado: "running",
  repositorioUrl: "https://github.com/microcapilar/crm",
  autoDeployHabilitado: true,
  cliente: { slug: "microcapilar" },
};

const pushPayload = {
  ref: "refs/heads/main",
  after: "e881352abcdef0123456789abcdef0123456789a",
  repository: {
    clone_url: "https://github.com/microcapilar/crm.git",
    ssh_url: "git@github.com:microcapilar/crm.git",
  },
};

function peticion(
  body: string,
  {
    event = "push",
    contentType = "application/json",
    secret = "s3cret",
  }: { event?: string; contentType?: string; secret?: string } = {},
) {
  const firma =
    "sha256=" + createHmac("sha256", secret).update(body).digest("hex");
  return new NextRequest("https://panel.test/api/webhooks/github", {
    method: "POST",
    body,
    headers: {
      "content-type": contentType,
      "x-github-event": event,
      "x-hub-signature-256": firma,
    },
  });
}

describe("POST /api/webhooks/github", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(estaRestaurando).mockReturnValue(false);
    vi.mocked(prisma.proyecto.findMany).mockResolvedValue([
      proyectoCrm,
    ] as never);
    vi.mocked(lanzarDeploy).mockResolvedValue(proyectoCrm as never);
  });

  it("despliega aunque la URL guardada no lleve .git y responde 202", async () => {
    const res = await POST(peticion(JSON.stringify(pushPayload)));

    expect(res.status).toBe(202);
    expect(lanzarDeploy).toHaveBeenCalledWith(proyectoCrm, {
      rama: "main",
      sha: "e881352abcdef0123456789abcdef0123456789a",
      origen: "webhook",
    });
  });

  it("acepta webhooks configurados como application/x-www-form-urlencoded", async () => {
    const body = new URLSearchParams({
      payload: JSON.stringify(pushPayload),
    }).toString();

    const res = await POST(
      peticion(body, { contentType: "application/x-www-form-urlencoded" }),
    );

    expect(res.status).toBe(202);
    expect(lanzarDeploy).toHaveBeenCalled();
  });

  it("responde al ping de GitHub sin desplegar", async () => {
    const res = await POST(peticion("{}", { event: "ping" }));

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ pong: true });
    expect(lanzarDeploy).not.toHaveBeenCalled();
  });

  it("rechaza con 401 una firma inválida", async () => {
    const res = await POST(
      peticion(JSON.stringify(pushPayload), { secret: "otro" }),
    );

    expect(res.status).toBe(401);
    expect(lanzarDeploy).not.toHaveBeenCalled();
  });

  it("no despliega proyectos de otro repositorio", async () => {
    vi.mocked(prisma.proyecto.findMany).mockResolvedValue([
      { ...proyectoCrm, repositorioUrl: "https://github.com/microcapilar/dp" },
    ] as never);

    const res = await POST(peticion(JSON.stringify(pushPayload)));

    expect(await res.json()).toMatchObject({ reason: "sin_proyecto" });
    expect(lanzarDeploy).not.toHaveBeenCalled();
  });

  it("no lanza un segundo deploy si el proyecto ya está desplegando", async () => {
    vi.mocked(prisma.proyecto.findMany).mockResolvedValue([
      { ...proyectoCrm, estado: "deploying" },
    ] as never);

    const res = await POST(peticion(JSON.stringify(pushPayload)));

    expect(await res.json()).toMatchObject({ reason: "deploy_en_curso" });
    expect(lanzarDeploy).not.toHaveBeenCalled();
  });

  it("ignora el push que borra la rama", async () => {
    const res = await POST(
      peticion(
        JSON.stringify({
          ...pushPayload,
          deleted: true,
          after: "0000000000000000000000000000000000000000",
        }),
      ),
    );

    expect(res.status).toBe(200);
    expect(lanzarDeploy).not.toHaveBeenCalled();
  });

  it("responde 409 y registra un aviso si todos los candidatos se están restaurando", async () => {
    vi.mocked(estaRestaurando).mockReturnValue(true);

    const res = await POST(peticion(JSON.stringify(pushPayload)));

    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ ok: false, reason: "restaurando" });
    expect(lanzarDeploy).not.toHaveBeenCalled();
    expect(avisos).toHaveBeenCalledTimes(1);
  });

  it("despliega solo los Proyectos que no se están restaurando", async () => {
    const otro = { ...proyectoCrm, id: "p2" };
    vi.mocked(prisma.proyecto.findMany).mockResolvedValue([
      proyectoCrm,
      otro,
    ] as never);
    vi.mocked(estaRestaurando).mockImplementation((id) => id === "p1");

    const res = await POST(peticion(JSON.stringify(pushPayload)));

    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({ ok: true, deployed: ["p2"] });
    expect(lanzarDeploy).toHaveBeenCalledTimes(1);
    expect(lanzarDeploy).toHaveBeenCalledWith(otro, expect.anything());
    // The skipped one leaves a trace too.
    expect(avisos).toHaveBeenCalledWith(
      { proyectos: ["p1"] },
      "Push ignorado: los Proyectos se están restaurando",
    );
  });

  // A restore marked between the check and the deploy: same answer as above,
  // not a 500 that GitHub would show as a failed delivery.
  it("si la restauración empieza a la vez, 409 y no 500", async () => {
    vi.mocked(lanzarDeploy).mockRejectedValueOnce(
      new TRPCError({ code: "CONFLICT", message: "restaurando" }),
    );

    const res = await POST(peticion(JSON.stringify(pushPayload)));

    expect(res.status).toBe(409);
    expect(avisos).toHaveBeenCalledWith(
      { proyectos: ["p1"] },
      "Push ignorado: la restauración empezó a la vez",
    );
  });

  it("con varios Proyectos, despliega los demás aunque uno choque con una restauración", async () => {
    const otro = { ...proyectoCrm, id: "p2" };
    vi.mocked(prisma.proyecto.findMany).mockResolvedValue([
      proyectoCrm,
      otro,
    ] as never);
    vi.mocked(lanzarDeploy)
      .mockRejectedValueOnce(new TRPCError({ code: "CONFLICT", message: "x" }))
      .mockResolvedValueOnce({} as never);

    const res = await POST(peticion(JSON.stringify(pushPayload)));

    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({ ok: true, deployed: ["p2"] });
  });

  it("cualquier otro error al lanzar el deploy sigue siendo un error", async () => {
    vi.mocked(lanzarDeploy).mockRejectedValueOnce(new Error("BD caída"));

    await expect(POST(peticion(JSON.stringify(pushPayload)))).rejects.toThrow(
      "BD caída",
    );
  });

  // The commit ends up as an argument to `git checkout`.
  it.each([
    "--upload-pack=x",
    "main",
    "e881352",
    "E881352ABCDEF0123456789ABCDEF0123456789A",
  ])(
    "rechaza con 400 un commit que no es un sha completo: %s",
    async (after) => {
      const res = await POST(
        peticion(JSON.stringify({ ...pushPayload, after })),
      );

      expect(res.status).toBe(400);
      expect(lanzarDeploy).not.toHaveBeenCalled();
    },
  );

  it("rechaza con 413 un cuerpo mayor que el máximo sin procesarlo", async () => {
    const enorme = JSON.stringify({ ...pushPayload, relleno: "x".repeat(200) });
    LIMITE_CUERPO.bytes = 100;

    const res = await POST(peticion(enorme));

    expect(res.status).toBe(413);
    expect(prisma.proyecto.findMany).not.toHaveBeenCalled();
    LIMITE_CUERPO.bytes = 25 * 1024 * 1024;
  });
});
