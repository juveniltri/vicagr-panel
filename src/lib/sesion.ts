import { prisma } from "@/lib/prisma";

export const PROVEEDOR_OIDC = "pocket-id";

// Pocket ID can't reach a session that is already open, so a removal there only
// takes effect at the next login. Deleting the user in the Panel is immediate.
export const DURACION_SESION_OIDC_MS = 12 * 60 * 60 * 1000;

export type TokenSesion = {
  sub?: string;
  iniciadaEn?: unknown;
  oidc?: unknown;
};

// The JWT alone stays valid until it expires; checking the user on every
// request is what makes deleting a user or changing a password log them out.
export async function sesionVigente(token: TokenSesion): Promise<boolean> {
  const { sub, iniciadaEn, oidc } = token;
  if (!sub || typeof iniciadaEn !== "number") return false;
  if (oidc === true && Date.now() - iniciadaEn > DURACION_SESION_OIDC_MS)
    return false;
  const user = await prisma.user.findUnique({
    where: { id: sub },
    select: { sesionesDesde: true },
  });
  if (!user) return false;
  return user.sesionesDesde.getTime() <= iniciadaEn;
}

function usuarioVinculado(sub: string) {
  return prisma.user.findUnique({
    where: { oidcSub: sub },
    select: { id: true, email: true, nombre: true },
  });
}

// Being in Pocket ID isn't enough: only an explicit link to a Panel user gets in.
// Matched by sub and never by email, which can change on the other side.
export async function accesoOidc(
  sub: string | null | undefined,
): Promise<true | string> {
  if (!sub) return "/login?error=oidc";
  if (await usuarioVinculado(sub)) return true;
  return `/login?error=oidc_sin_vincular&sub=${encodeURIComponent(sub)}`;
}

export async function tokenOidc<T extends object>(
  token: T,
  sub: string | null | undefined,
) {
  const usuario = sub ? await usuarioVinculado(sub) : null;
  if (!usuario) return null;
  return {
    ...token,
    sub: usuario.id,
    email: usuario.email,
    name: usuario.nombre,
    iniciadaEn: Date.now(),
    oidc: true,
  };
}
