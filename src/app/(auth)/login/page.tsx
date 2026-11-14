import { headers } from "next/headers";
import { LoginForm } from "@/components/auth/LoginForm";
import { env } from "@/env";
import { passwordPermitida } from "@/lib/sesion";

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; sub?: string }>;
}) {
  const { error, sub } = await searchParams;
  return (
    <main className="min-h-screen flex items-center justify-center bg-background">
      <LoginForm
        oidcActivo={Boolean(env.OIDC_ISSUER)}
        passwordDisponible={passwordPermitida(
          await headers(),
          Boolean(env.OIDC_ISSUER),
        )}
        errorOidc={error}
        subSinVincular={sub}
      />
    </main>
  );
}
