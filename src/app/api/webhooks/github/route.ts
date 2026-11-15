import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import {
  leerCuerpo,
  mismoRepositorio,
  verificarFirmaGitHub,
} from "@/lib/github/webhook";
import { prisma } from "@/lib/prisma";
import { env } from "@/env";
import { estaRestaurando } from "@/lib/backups/restaurando";
import { logger } from "@/lib/logger";
import { TRPCError } from "@trpc/server";
import { lanzarDeploy } from "@/server/routers/proyectos";

const pushPayloadSchema = z.object({
  ref: z.string(),
  // It ends up as an argument to `git checkout`.
  after: z
    .string()
    .regex(/^[0-9a-f]{40}$/)
    .optional(),
  deleted: z.boolean().optional(),
  repository: z.object({
    clone_url: z.string().optional(),
    ssh_url: z.string().optional(),
    html_url: z.string().optional(),
  }),
});

function extraerJson(body: string, contentType: string): unknown {
  // GitHub lets the webhook be configured as form-urlencoded: payload=<json>
  const json = contentType.includes("application/x-www-form-urlencoded")
    ? (new URLSearchParams(body).get("payload") ?? "")
    : body;
  return JSON.parse(json);
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  const body = await leerCuerpo(req);
  if (body === null)
    return NextResponse.json(
      { error: "Cuerpo demasiado grande" },
      { status: 413 },
    );
  const signature = req.headers.get("x-hub-signature-256") ?? "";
  const event = req.headers.get("x-github-event") ?? "";

  if (!verificarFirmaGitHub(body, signature, env.GITHUB_WEBHOOK_SECRET)) {
    return NextResponse.json({ error: "Firma inválida" }, { status: 401 });
  }

  if (event === "ping") {
    return NextResponse.json({ ok: true, pong: true });
  }

  if (event !== "push") {
    return NextResponse.json({ ok: true, skipped: true });
  }

  let payload: z.infer<typeof pushPayloadSchema>;
  try {
    payload = pushPayloadSchema.parse(
      extraerJson(body, req.headers.get("content-type") ?? ""),
    );
  } catch {
    return NextResponse.json({ error: "Payload inválido" }, { status: 400 });
  }

  if (!payload.ref.startsWith("refs/heads/") || payload.deleted) {
    return NextResponse.json({ ok: true, skipped: true });
  }
  const rama = payload.ref.slice("refs/heads/".length);
  const urlsRecibidas = [
    payload.repository.clone_url,
    payload.repository.ssh_url,
    payload.repository.html_url,
  ].filter((u): u is string => !!u);

  const candidatos = await prisma.proyecto.findMany({
    where: { rama, autoDeployHabilitado: true, repositorioUrl: { not: null } },
    include: {
      cliente: true,
      credencial: true,
      rutas: { orderBy: { creadoEn: "asc" } },
    },
  });
  const proyectos = candidatos.filter((p) =>
    urlsRecibidas.some((u) => mismoRepositorio(p.repositorioUrl!, u)),
  );
  const log = logger.child({ module: "webhook" });
  const libres = proyectos.filter((p) => !estaRestaurando(p.id));
  const restaurando = proyectos.filter((p) => !libres.includes(p));
  if (restaurando.length > 0) {
    log.warn(
      { proyectos: restaurando.map((p) => p.id) },
      "Push ignorado: los Proyectos se están restaurando",
    );
  }
  if (proyectos.length > 0 && libres.length === 0) {
    return NextResponse.json(
      { ok: false, reason: "restaurando" },
      { status: 409 },
    );
  }
  const desplegables = libres.filter((p) => p.estado !== "deploying");

  if (desplegables.length === 0) {
    return NextResponse.json({
      ok: true,
      skipped: true,
      reason: libres.length ? "deploy_en_curso" : "sin_proyecto",
    });
  }

  // GitHub gives up after 10s, so the deploy runs in the background.
  const resultados = await Promise.allSettled(
    desplegables.map((p) =>
      lanzarDeploy(p, { rama, sha: payload.after, origen: "webhook" }),
    ),
  );
  const desplegados: string[] = [];
  const enConflicto: string[] = [];
  for (const [i, r] of resultados.entries()) {
    const { id } = desplegables[i];
    if (r.status === "fulfilled") desplegados.push(id);
    // A restore started after the check above: the same answer as before it.
    else if (r.reason instanceof TRPCError && r.reason.code === "CONFLICT")
      enConflicto.push(id);
    else throw r.reason;
  }
  if (enConflicto.length > 0) {
    log.warn(
      { proyectos: enConflicto },
      "Push ignorado: la restauración empezó a la vez",
    );
  }
  if (desplegados.length === 0) {
    return NextResponse.json(
      { ok: false, reason: "restaurando" },
      { status: 409 },
    );
  }

  return NextResponse.json(
    { ok: true, deployed: desplegados },
    { status: 202 },
  );
}
