import { createHmac } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import {
  LIMITE_CUERPO,
  leerCuerpo,
  mismoRepositorio,
  verificarFirmaGitHub,
} from "./webhook";

function firmarPayload(body: string, secret: string): string {
  return "sha256=" + createHmac("sha256", secret).update(body).digest("hex");
}

describe("verificarFirmaGitHub", () => {
  const secret = "super-secret-webhook-key";
  const body = JSON.stringify({ ref: "refs/heads/main" });

  it("retorna true con firma válida", () => {
    const signature = firmarPayload(body, secret);
    expect(verificarFirmaGitHub(body, signature, secret)).toBe(true);
  });

  it("retorna false con firma inválida", () => {
    expect(verificarFirmaGitHub(body, "sha256=invalida", secret)).toBe(false);
  });

  it("retorna false con secret vacío", () => {
    const signature = firmarPayload(body, secret);
    expect(verificarFirmaGitHub(body, signature, "")).toBe(false);
  });

  it("retorna false cuando la firma no tiene prefijo sha256=", () => {
    const hmac = createHmac("sha256", secret).update(body).digest("hex");
    expect(verificarFirmaGitHub(body, hmac, secret)).toBe(false);
  });
});

describe("mismoRepositorio", () => {
  it.each([
    ["https://github.com/org/repo", "https://github.com/org/repo.git"],
    ["https://github.com/org/repo/", "https://github.com/org/repo.git"],
    ["https://github.com/Org/Repo", "https://github.com/org/repo.git"],
    ["git@github.com:org/repo.git", "https://github.com/org/repo.git"],
    ["ssh://git@github.com/org/repo.git", "git@github.com:org/repo.git"],
  ])("%s equivale a %s", (guardada, recibida) => {
    expect(mismoRepositorio(guardada, recibida)).toBe(true);
  });

  it("distingue repositorios distintos", () => {
    expect(
      mismoRepositorio(
        "https://github.com/org/repo",
        "https://github.com/org/repo-2.git",
      ),
    ).toBe(false);
  });
});

describe("leerCuerpo", () => {
  afterEach(() => {
    LIMITE_CUERPO.bytes = 25 * 1024 * 1024;
  });

  const peticion = (cuerpo: string | null, cabeceras = {}) =>
    new Request("https://panel.test/api/webhooks/github", {
      method: "POST",
      body: cuerpo,
      headers: cabeceras,
    });

  it("devuelve el cuerpo entero cuando cabe", async () => {
    expect(await leerCuerpo(peticion('{"ref":"x"}'))).toBe('{"ref":"x"}');
  });

  it("sin cuerpo devuelve una cadena vacía", async () => {
    expect(await leerCuerpo(peticion(null))).toBe("");
  });

  it("rechaza por la cabecera sin leer nada si anuncia más del máximo", async () => {
    LIMITE_CUERPO.bytes = 10;
    const req = peticion("corto", { "content-length": "9999" });

    expect(await leerCuerpo(req)).toBeNull();
    expect(req.bodyUsed).toBe(false);
  });

  // The header can be missing or lie: what arrives is what counts.
  it("rechaza al pasarse del máximo aunque la cabecera no lo anuncie", async () => {
    LIMITE_CUERPO.bytes = 10;

    expect(await leerCuerpo(peticion("x".repeat(50)))).toBeNull();
  });
});
