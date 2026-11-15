import { randomUUID } from "node:crypto";
import { createWriteStream } from "node:fs";
import { lstat, mkdir, readdir, rm } from "node:fs/promises";
import path from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ReadableStream as WebReadableStream } from "node:stream/web";
import { type NextRequest } from "next/server";
import { auth } from "@/lib/auth";
import { env } from "@/env";
import {
  borrarEnVolumen,
  MAX_SUBIDA_BYTES,
  moverAVolumen,
  resolverRutaSinEnlaces,
  rutaHostVolumen,
} from "@/lib/volumenes";
import { prisma } from "@/lib/prisma";

async function resolveVolumen(id: string) {
  return prisma.volumen.findUnique({
    where: { id },
    include: { proyecto: { include: { cliente: true } } },
  });
}

function hostDir(
  clienteSlug: string,
  proyectoNombre: string,
  volumenNombre: string,
): string {
  return rutaHostVolumen(
    env.REPOS_DIR,
    clienteSlug,
    proyectoNombre,
    volumenNombre,
  );
}

// GET — list files in volume directory
export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const session = await auth();
  if (!session) return new Response("Unauthorized", { status: 401 });

  const { id } = await params;
  const volumen = await resolveVolumen(id);
  if (!volumen) return new Response("Not Found", { status: 404 });

  const base = hostDir(
    volumen.proyecto.cliente.slug,
    volumen.proyecto.nombre,
    volumen.nombre,
  );

  const subpath = req.nextUrl.searchParams.get("path") ?? "";
  const target = await resolverRutaSinEnlaces(base, subpath);
  if (!target) return new Response("Invalid path", { status: 400 });

  try {
    const entries = await readdir(target, { withFileTypes: true });
    const files = await Promise.all(
      entries.map(async (e) => {
        // lstat: a link is listed as a link, never as what it points at.
        const info = await lstat(path.join(target, e.name)).catch(() => null);
        return {
          nombre: e.name,
          tipo: e.isSymbolicLink()
            ? "enlace"
            : e.isDirectory()
              ? "dir"
              : "file",
          tamaño: info && e.isFile() ? info.size : null,
          modificadoEn: info?.mtime ?? null,
        };
      }),
    );
    return Response.json(files);
  } catch {
    return new Response("Not Found", { status: 404 });
  }
}

class DemasiadoGrande extends Error {}

// POST — upload one file: the request body is the file itself (?nombre=).
// Streamed to disk, never held in memory: multipart parsing would buffer it.
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const session = await auth();
  if (!session) return new Response("Unauthorized", { status: 401 });

  const { id } = await params;
  const volumen = await resolveVolumen(id);
  if (!volumen) return new Response("Not Found", { status: 404 });

  const base = hostDir(
    volumen.proyecto.cliente.slug,
    volumen.proyecto.nombre,
    volumen.nombre,
  );

  const subpath = req.nextUrl.searchParams.get("path") ?? "";
  const target = await resolverRutaSinEnlaces(base, subpath);
  if (!target) return new Response("Invalid path", { status: 400 });

  const nombre = path.basename(req.nextUrl.searchParams.get("nombre") ?? "");
  const destPath =
    nombre && nombre !== "." && nombre !== ".."
      ? await resolverRutaSinEnlaces(target, nombre, { permitirRaiz: false })
      : null;
  if (!destPath || !req.body)
    return new Response("Nombre de fichero no válido", { status: 400 });

  const demasiadoGrande = () =>
    new Response(
      `El fichero supera el máximo de ${MAX_SUBIDA_BYTES / 1024 ** 3} GB`,
      { status: 413 },
    );
  if (Number(req.headers.get("content-length")) > MAX_SUBIDA_BYTES)
    return demasiadoGrande();

  // Content-Length can be missing or wrong: count what actually arrives.
  let bytes = 0;
  const limite = new Transform({
    transform(trozo: Buffer, _codificacion, hecho) {
      bytes += trozo.length;
      hecho(bytes > MAX_SUBIDA_BYTES ? new DemasiadoGrande() : null, trozo);
    },
  });
  // Written to the Panel's own folder first, where it can write and count
  // the size, and only then moved into the Volumen: a failed upload must not
  // truncate the file that was already there.
  const subidas = `${env.REPOS_DIR}/.subidas`;
  const temporal = `${subidas}/${randomUUID()}`;
  try {
    await mkdir(subidas, { recursive: true });
    await pipeline(
      Readable.fromWeb(req.body as WebReadableStream),
      limite,
      createWriteStream(temporal),
    );
    await moverAVolumen(base, temporal, destPath);
  } catch (err) {
    if (err instanceof DemasiadoGrande) return demasiadoGrande();
    return new Response(`No se pudo guardar ${nombre}`, { status: 500 });
  } finally {
    await rm(temporal, { force: true });
  }

  return Response.json({ nombre }, { status: 201 });
}

// DELETE — remove file or directory
export async function DELETE(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const session = await auth();
  if (!session) return new Response("Unauthorized", { status: 401 });

  const { id } = await params;
  const volumen = await resolveVolumen(id);
  if (!volumen) return new Response("Not Found", { status: 404 });

  const base = hostDir(
    volumen.proyecto.cliente.slug,
    volumen.proyecto.nombre,
    volumen.nombre,
  );

  const subpath = req.nextUrl.searchParams.get("path") ?? "";
  if (!subpath) return new Response("path is required", { status: 400 });

  const target = await resolverRutaSinEnlaces(base, subpath, {
    permitirRaiz: false,
    permitirEnlaceFinal: true,
  });
  if (!target) return new Response("Invalid path", { status: 400 });

  try {
    await borrarEnVolumen(base, target);
    return new Response(null, { status: 204 });
  } catch {
    return new Response("No se pudo borrar", { status: 500 });
  }
}
