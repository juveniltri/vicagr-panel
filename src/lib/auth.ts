// src/lib/auth.ts
import NextAuth, { CredentialsSignin } from "next-auth";
import Credentials from "next-auth/providers/credentials";
import bcrypt from "bcryptjs";
import { z } from "zod";
import { env } from "@/env";
import { prisma } from "@/lib/prisma";
import { authConfig } from "./auth.config";
import { crearLimitador } from "./rate-limit";
import { PROVEEDOR_OIDC, accesoOidc, sesionVigente, tokenOidc } from "./sesion";

const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(8),
});

export class DemasiadosIntentos extends CredentialsSignin {
  code = "demasiados_intentos";
}

// Both the login page (server action) and /api/auth/callback go through
// authorize(), so the brute-force limit lives here and not in the proxy.
const limitarLogin = crearLimitador({ max: 10, ventanaMs: 60_000 });

// Traefik sets X-Real-Ip and does not trust a client-sent X-Forwarded-For.
function ipCliente(request: Request): string {
  return (
    request.headers.get("x-real-ip") ??
    request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ??
    "desconocida"
  );
}

export const { handlers, signIn, signOut, auth } = NextAuth({
  ...authConfig,
  callbacks: {
    ...authConfig.callbacks,
    async signIn({ account, profile }) {
      if (account?.provider !== PROVEEDOR_OIDC) return true;
      return accesoOidc(profile?.sub);
    },
    // Returning null drops the session: auth() then answers as logged out.
    async jwt({ token, user, account, profile }) {
      if (account?.provider === PROVEEDOR_OIDC)
        return tokenOidc(token, profile?.sub);
      if (user) return { ...token, iniciadaEn: Date.now() };
      return (await sesionVigente(token)) ? token : null;
    },
  },
  providers: [
    Credentials({
      async authorize(credentials, request) {
        if (limitarLogin(ipCliente(request))) throw new DemasiadosIntentos();
        const parsed = loginSchema.safeParse(credentials);
        if (!parsed.success) return null;
        const user = await prisma.user.findUnique({
          where: { email: parsed.data.email },
        });
        if (!user) return null;
        const valid = await bcrypt.compare(
          parsed.data.password,
          user.passwordHash,
        );
        if (!valid) return null;
        return { id: user.id, email: user.email, name: user.nombre };
      },
    }),
    ...(env.OIDC_ISSUER
      ? [
          {
            id: PROVEEDOR_OIDC,
            name: "Pocket ID",
            type: "oidc" as const,
            issuer: env.OIDC_ISSUER,
            clientId: env.OIDC_CLIENT_ID,
            clientSecret: env.OIDC_CLIENT_SECRET,
            checks: ["pkce" as const, "state" as const, "nonce" as const],
          },
        ]
      : []),
  ],
});
