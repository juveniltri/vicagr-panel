"use client";

import { useState, useTransition } from "react";
import {
  generarSecretoWebhookAction,
  quitarSecretoWebhookAction,
} from "@/app/(panel)/actions";

const boton =
  "inline-flex items-center min-h-8 px-3 rounded-[var(--radius-md)] border border-border-strong font-body text-[12px] text-text-primary hover:bg-elevated disabled:opacity-50";

export function SecretoWebhook({
  proyectoId,
  propio: propioInicial,
}: {
  proyectoId: string;
  propio: boolean;
}) {
  const [propio, setPropio] = useState(propioInicial);
  const [secreto, setSecreto] = useState<string | null>(null);
  const [confirmando, setConfirmando] = useState<"regenerar" | "quitar" | null>(
    null,
  );
  const [copiado, setCopiado] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  const generar = () =>
    startTransition(async () => {
      setConfirmando(null);
      setError(null);
      const r = await generarSecretoWebhookAction(proyectoId);
      if ("error" in r) return setError(r.error);
      setSecreto(r.secreto);
      setCopiado(false);
      setPropio(true);
    });

  const quitar = () =>
    startTransition(async () => {
      setConfirmando(null);
      setError(null);
      const r = await quitarSecretoWebhookAction(proyectoId);
      if (r && "error" in r) return setError(r.error);
      setSecreto(null);
      setPropio(false);
    });

  const copiar = async () => {
    await navigator.clipboard.writeText(secreto!);
    setCopiado(true);
  };

  return (
    <div className="flex flex-col gap-2 mt-3 pt-3 border-t border-border font-body text-[12.5px]">
      <div className="flex flex-wrap items-center gap-2">
        <span className="flex flex-col gap-0.5 mr-auto">
          Secreto del webhook
          <span className="text-[11px] text-text-muted">
            {propio
              ? "Propio de este Proyecto"
              : "Global (GITHUB_WEBHOOK_SECRET)"}
          </span>
        </span>
        {!propio && (
          <button
            type="button"
            className={boton}
            disabled={isPending}
            onClick={generar}
          >
            Generar secreto propio
          </button>
        )}
        {propio && (
          <>
            <button
              type="button"
              className={boton}
              disabled={isPending}
              onClick={() =>
                confirmando === "regenerar"
                  ? generar()
                  : setConfirmando("regenerar")
              }
            >
              {confirmando === "regenerar"
                ? "¿Regenerar? El actual deja de valer"
                : "Regenerar"}
            </button>
            <button
              type="button"
              className={boton}
              disabled={isPending}
              onClick={() =>
                confirmando === "quitar" ? quitar() : setConfirmando("quitar")
              }
            >
              {confirmando === "quitar"
                ? "¿Quitar? Vuelve al global"
                : "Quitar"}
            </button>
          </>
        )}
      </div>
      {secreto && (
        <div className="flex flex-col gap-1.5">
          <div className="flex items-center gap-2 rounded-[var(--radius-md)] bg-elevated border border-border p-2">
            <code className="min-w-0 flex-1 break-all font-mono text-xs">
              {secreto}
            </code>
            <button
              type="button"
              className={boton}
              onClick={() => void copiar()}
            >
              {copiado ? "Copiado" : "Copiar"}
            </button>
          </div>
          <p className="text-[11px] text-text-secondary">
            Pégalo en GitHub → Settings → Webhooks → Secret. No se volverá a
            mostrar.
          </p>
        </div>
      )}
      {error && (
        <p role="alert" className="text-xs text-state-error">
          {error}
        </p>
      )}
    </div>
  );
}
