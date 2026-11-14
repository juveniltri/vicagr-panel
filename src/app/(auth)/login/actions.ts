"use server";

import { DemasiadosIntentos, SoloEmergencia, signIn } from "@/lib/auth";
import { PROVEEDOR_OIDC } from "@/lib/sesion";
import { AuthError } from "next-auth";

export async function loginAction(email: string, password: string) {
  try {
    await signIn("credentials", { email, password, redirectTo: "/" });
  } catch (error) {
    if (error instanceof DemasiadosIntentos) {
      return { error: "Demasiados intentos. Inténtalo más tarde." };
    }
    if (error instanceof SoloEmergencia) {
      return {
        error:
          "La contraseña solo vale por el acceso de emergencia. Entra con Pocket ID.",
      };
    }
    if (error instanceof AuthError) {
      return { error: "Credenciales incorrectas" };
    }
    throw error;
  }
}

// Returns the URL for the client to navigate to: the CSP's form-action 'self'
// would block a form that redirects to Pocket ID.
export async function loginOidcAction(): Promise<string> {
  return signIn(PROVEEDOR_OIDC, { redirect: false, redirectTo: "/" });
}
