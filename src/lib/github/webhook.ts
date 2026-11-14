import { createHmac, timingSafeEqual } from "node:crypto";

export function verificarFirmaGitHub(
  body: string,
  signature: string,
  secret: string,
): boolean {
  if (!secret || !signature.startsWith("sha256=")) return false;

  const expected = createHmac("sha256", secret).update(body).digest("hex");
  const received = signature.slice("sha256=".length);

  try {
    return timingSafeEqual(
      Buffer.from(expected, "hex"),
      Buffer.from(received, "hex"),
    );
  } catch {
    return false;
  }
}

function normalizarRepoUrl(url: string): string {
  return url
    .trim()
    .toLowerCase()
    .replace(/^(https?|ssh):\/\//, "")
    .replace(/^git@([^:/]+):/, "$1/")
    .replace(/^git@/, "")
    .replace(/\/+$/, "")
    .replace(/\.git$/, "");
}

export function mismoRepositorio(a: string, b: string): boolean {
  return normalizarRepoUrl(a) === normalizarRepoUrl(b);
}

// GitHub caps its payloads at 25 MB; nothing bigger is a real delivery.
export const LIMITE_CUERPO = { bytes: 25 * 1024 * 1024 };

// Read with a ceiling: the signature can only be checked on the whole body,
// so without one anybody could make the Panel buffer an endless request.
// null means it was too big.
export async function leerCuerpo(req: Request): Promise<string | null> {
  if (Number(req.headers.get("content-length")) > LIMITE_CUERPO.bytes)
    return null;
  if (!req.body) return "";
  const trozos: Uint8Array[] = [];
  let total = 0;
  for await (const trozo of req.body as unknown as AsyncIterable<Uint8Array>) {
    total += trozo.length;
    if (total > LIMITE_CUERPO.bytes) return null;
    trozos.push(trozo);
  }
  return Buffer.concat(trozos).toString("utf-8");
}
