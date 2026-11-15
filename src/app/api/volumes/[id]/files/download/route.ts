import { createReadStream } from "node:fs";
import { lstat } from "node:fs/promises";
import path from "node:path";
import { type NextRequest } from "next/server";
import { Zip, ZipPassThrough } from "fflate";
import { auth } from "@/lib/auth";
import { env } from "@/env";
import { resolverRutaSinEnlaces, rutaHostVolumen } from "@/lib/volumenes";
import { prisma } from "@/lib/prisma";

async function resolveVolumen(id: string) {
  return prisma.volumen.findUnique({
    where: { id },
    include: { proyecto: { include: { cliente: true } } },
  });
}

// Built as it is read: a volume can hold files far bigger than the Panel's
// memory. Stored without compression, which is what media mostly is anyway.
function zipEnStreaming(
  ficheros: Array<{ nombre: string; ruta: string }>,
): ReadableStream<Uint8Array> {
  async function* trozos() {
    let salida: Uint8Array[] = [];
    const vaciar = () => {
      const pendientes = salida;
      salida = [];
      return pendientes;
    };
    const zip = new Zip((err, trozo) => {
      if (err) throw err;
      salida.push(trozo);
    });
    for (const { nombre, ruta } of ficheros) {
      const entrada = new ZipPassThrough(nombre);
      zip.add(entrada);
      for await (const trozo of createReadStream(ruta)) {
        entrada.push(trozo as Buffer);
        yield* vaciar();
      }
      entrada.push(new Uint8Array(0), true);
    }
    zip.end();
    yield* vaciar();
  }
  const iterador = trozos();
  return new ReadableStream<Uint8Array>({
    async pull(controlador) {
      const { done, value } = await iterador.next();
      if (done) controlador.close();
      else controlador.enqueue(value);
    },
    cancel() {
      void iterador.return(undefined);
    },
  });
}

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const session = await auth();
  if (!session) return new Response("Unauthorized", { status: 401 });

  const { id } = await params;
  const volumen = await resolveVolumen(id);
  if (!volumen) return new Response("Not Found", { status: 404 });

  const filesParam = req.nextUrl.searchParams.get("files");
  if (!filesParam) return new Response("files param required", { status: 400 });

  const base = rutaHostVolumen(
    env.REPOS_DIR,
    volumen.proyecto.cliente.slug,
    volumen.proyecto.nombre,
    volumen.nombre,
  );

  const subpath = req.nextUrl.searchParams.get("path") ?? "";
  const dir = await resolverRutaSinEnlaces(base, subpath, {
    reposDir: env.REPOS_DIR,
  });
  if (!dir) return new Response("Invalid path", { status: 400 });

  const nombres = filesParam
    .split(",")
    .map((f) => f.trim())
    .filter(Boolean);

  const ficheros: Array<{ nombre: string; ruta: string }> = [];
  for (const nombre of nombres) {
    const safeName = path.basename(nombre);
    const ruta = await resolverRutaSinEnlaces(dir, safeName, {
      permitirRaiz: false,
    });
    if (!ruta) continue;
    // Folders and names that are not there are left out.
    const info = await lstat(ruta).catch(() => null);
    if (info?.isFile()) ficheros.push({ nombre: safeName, ruta });
  }

  const timestamp = Date.now();
  const filename = `${volumen.nombre}-${timestamp}.zip`;

  return new Response(zipEnStreaming(ficheros), {
    status: 200,
    headers: {
      "Content-Type": "application/zip",
      "Content-Disposition": `attachment; filename="${filename}"`,
    },
  });
}
