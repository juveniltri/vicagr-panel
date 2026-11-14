"use client";

import { useEffect, useState } from "react";
import { loginAction, loginOidcAction } from "@/app/(auth)/login/actions";

// Only a path on this origin: the parameter comes from the URL.
function destinoTrasEntrar(search: string, origin: string): string {
  const pedido = new URLSearchParams(search).get("callbackUrl");
  if (!pedido) return "/";
  try {
    const url = new URL(pedido, origin);
    if (url.origin !== origin || url.pathname.startsWith("/login")) return "/";
    return url.pathname + url.search;
  } catch {
    return "/";
  }
}

export function LoginForm({
  oidcActivo = false,
  errorOidc,
  subSinVincular,
}: {
  oidcActivo?: boolean;
  errorOidc?: string;
  subSinVincular?: string;
}) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [redirigiendo, setRedirigiendo] = useState(false);

  // The session cookie is SameSite=Strict, so the browser withholds it on a
  // navigation that starts on another site (Pocket ID's redirect back, a link
  // in an email) and a logged-in user lands here. A same-origin fetch does
  // carry it.
  useEffect(() => {
    if (errorOidc) return;
    let vigente = true;
    fetch("/api/auth/session")
      .then((res) => res.json())
      .then((sesion: unknown) => {
        if (!vigente || !sesion || typeof sesion !== "object") return;
        if (!("user" in sesion)) return;
        window.location.replace(
          destinoTrasEntrar(window.location.search, window.location.origin),
        );
      })
      .catch(() => {});
    return () => {
      vigente = false;
    };
  }, [errorOidc]);

  async function entrarConPocketId() {
    setRedirigiendo(true);
    setError(null);
    try {
      window.location.assign(await loginOidcAction());
    } catch {
      setError("No se pudo contactar con Pocket ID. Entra con tu contraseña.");
      setRedirigiendo(false);
    }
  }

  async function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setLoading(true);
    setError(null);
    const data = new FormData(e.currentTarget);
    const email = data.get("email") as string;
    const password = data.get("password") as string;
    const result = await loginAction(email, password);
    if (result?.error) {
      setError(result.error);
      setLoading(false);
    }
  }

  return (
    <div className="w-full max-w-sm p-8 bg-surface border border-border rounded-[var(--radius-md)]">
      <h1 className="font-display text-xl font-bold text-text-primary mb-6">
        VICAGR
      </h1>
      {errorOidc && (
        <div
          role="alert"
          className="mb-4 flex flex-col gap-1 font-body text-sm text-state-error"
        >
          {errorOidc === "oidc_sin_vincular" ? (
            <>
              <p>Tu cuenta de Pocket ID no está vinculada a este Panel.</p>
              {subSinVincular && (
                <p className="text-xs text-text-muted">
                  Identificador para vincularla:{" "}
                  <code className="break-all">{subSinVincular}</code>
                </p>
              )}
            </>
          ) : (
            <p>
              No se pudo entrar con Pocket ID. Prueba otra vez o entra con tu
              contraseña.
            </p>
          )}
        </div>
      )}
      {oidcActivo && (
        <div className="mb-4 flex flex-col gap-4">
          <button
            type="button"
            onClick={entrarConPocketId}
            disabled={redirigiendo}
            className="px-4 py-2 bg-primary-500 text-white font-body text-sm font-medium rounded-[var(--radius-sm)] hover:bg-primary-600 disabled:opacity-50 transition-colors"
          >
            {redirigiendo ? "Redirigiendo…" : "Entrar con Pocket ID"}
          </button>
          <p className="font-body text-xs text-text-muted text-center">
            o con tu contraseña
          </p>
        </div>
      )}
      <form onSubmit={handleSubmit} className="flex flex-col gap-4">
        <div className="flex flex-col gap-1.5">
          <label htmlFor="email" className="font-body text-sm text-text-muted">
            Email
          </label>
          <input
            id="email"
            name="email"
            type="email"
            required
            autoComplete="email"
            className="px-3 py-2 bg-background border border-border rounded-[var(--radius-sm)] font-body text-sm text-text-primary focus:outline-none focus:border-primary-500"
          />
        </div>
        <div className="flex flex-col gap-1.5">
          <label
            htmlFor="password"
            className="font-body text-sm text-text-muted"
          >
            Contraseña
          </label>
          <input
            id="password"
            name="password"
            type="password"
            required
            autoComplete="current-password"
            className="px-3 py-2 bg-background border border-border rounded-[var(--radius-sm)] font-body text-sm text-text-primary focus:outline-none focus:border-primary-500"
          />
        </div>
        {error && (
          <p role="alert" className="font-body text-sm text-state-error">
            {error}
          </p>
        )}
        <button
          type="submit"
          disabled={loading}
          className="mt-2 px-4 py-2 bg-primary-500 text-white font-body text-sm font-medium rounded-[var(--radius-sm)] hover:bg-primary-600 disabled:opacity-50 transition-colors"
        >
          {loading ? "Entrando…" : "Entrar"}
        </button>
      </form>
    </div>
  );
}
