import { lstat } from "node:fs/promises";
import path from "node:path";

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
