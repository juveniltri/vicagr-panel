import { lstat } from "node:fs/promises";
import { IMAGEN_AUXILIAR } from "@/lib/backups/comandos";
import { ejecutar, ErrorProceso } from "@/lib/backups/procesos";
import path from "node:path";

// Per uploaded file. Bigger things (a database dump, a media library) go in
// over SFTP: the browser is not the tool for them.
export const MAX_SUBIDA_BYTES = 2 * 1024 ** 3;

export function rutaHostVolumen(
  reposDir: string,
  clienteSlug: string,
  proyectoNombre: string,
  volumenNombre: string,
): string {
  return `${reposDir}/${clienteSlug}/${proyectoNombre}/volumes/${volumenNombre}`;
}

// Blocks path traversal out of the volume. The base also goes through
// path.resolve: comparing the raw POSIX base against a resolved path rejected
// every request on Windows. Destructive actions pass permitirRaiz: false so
// "." or "x/.." cannot target the whole volume.
export function resolverRutaSegura(
  base: string,
  relativa: string,
  { permitirRaiz = true }: { permitirRaiz?: boolean } = {},
): string | null {
  const raiz = path.resolve(base);
  const ruta = path.resolve(raiz, relativa);
  if (ruta === raiz) return permitirRaiz ? ruta : null;
  return ruta.startsWith(raiz + path.sep) ? ruta : null;
}

// The text check above is not enough: a container writes into its own volume
// and can leave a symlink there pointing at another Cliente's files or at the
// VPS. Every existing component is checked with lstat, never followed.
export async function resolverRutaSinEnlaces(
  base: string,
  relativa: string,
  {
    permitirRaiz = true,
    // Deleting acts on the link itself, so the last component may be one.
    permitirEnlaceFinal = false,
  }: { permitirRaiz?: boolean; permitirEnlaceFinal?: boolean } = {},
): Promise<string | null> {
  const ruta = resolverRutaSegura(base, relativa, { permitirRaiz });
  if (!ruta) return null;
  const raiz = path.resolve(base);
  const partes = path.relative(raiz, ruta).split(path.sep).filter(Boolean);
  let actual = raiz;
  for (const [i, parte] of partes.entries()) {
    actual = path.join(actual, parte);
    let info;
    try {
      info = await lstat(actual);
    } catch (err) {
      // Not there yet (upload, new folder): nothing below it exists either.
      if ((err as NodeJS.ErrnoException).code === "ENOENT") break;
      return null;
    }
    if (
      info.isSymbolicLink() &&
      !(permitirEnlaceFinal && i === partes.length - 1)
    )
      return null;
  }
  return ruta;
}

// The files in a Volumen belong to the container's users (root for nginx,
// www-data for WordPress…), so the Panel (uid 1001) cannot write there.
// Writes go through a throwaway container as root, with no network and only
// the Volumen mounted: a link left by the container can lead nowhere outside
// it. New files and folders get the owner of the folder they land in, so the
// app can still use them. Paths are validated by the caller and passed as
// arguments, never as part of the script.
function enVolumen(
  base: string,
  script: string,
  args: string[],
  montajes: string[] = [],
) {
  return ejecutar(
    "docker",
    [
      "run",
      "--rm",
      "--network",
      "none",
      "-v",
      `${base}:/v`,
      ...montajes.flatMap((m) => ["-v", m]),
      IMAGEN_AUXILIAR,
      "sh",
      "-c",
      `set -e; ${script}`,
      "sh",
      ...args,
    ],
    {},
  );
}

const relativaA = (base: string, ruta: string) =>
  path.relative(path.resolve(base), ruta).split(path.sep).join("/");

const DUENO_DE_LA_CARPETA = 'o=$(stat -c %u:%g "$(dirname "$1")")';

// The upload is first written by the Panel to its own folder (so its size is
// checked as it arrives) and then moved in: a temporary name in the same
// folder makes the final rename replace the old file in one step.
export async function moverAVolumen(
  base: string,
  temporal: string,
  destino: string,
): Promise<void> {
  const dirTemporal = path.dirname(temporal);
  await enVolumen(
    base,
    `${DUENO_DE_LA_CARPETA}; t="$1.subiendo-$2"; trap 'rm -f "$t"' EXIT; cp "/subidas/$2" "$t"; chown "$o" "$t"; mv -f "$t" "$1"; trap - EXIT`,
    [`/v/${relativaA(base, destino)}`, path.basename(temporal)],
    [`${dirTemporal}:/subidas:ro`],
  );
}

export class YaExiste extends Error {}

export async function crearCarpetaEnVolumen(
  base: string,
  ruta: string,
): Promise<void> {
  try {
    await enVolumen(
      base,
      `${DUENO_DE_LA_CARPETA}; mkdir "$1"; chown "$o" "$1"`,
      [`/v/${relativaA(base, ruta)}`],
    );
  } catch (err) {
    if (err instanceof ErrorProceso && /File exists/i.test(err.message))
      throw new YaExiste();
    throw err;
  }
}

// rm does not follow links: deleting one removes only the link.
export async function borrarEnVolumen(
  base: string,
  ruta: string,
): Promise<void> {
  await enVolumen(base, 'rm -rf -- "$1"', [`/v/${relativaA(base, ruta)}`]);
}
