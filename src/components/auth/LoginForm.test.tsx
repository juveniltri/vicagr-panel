// @vitest-environment jsdom
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/app/(auth)/login/actions", () => ({
  loginAction: vi.fn().mockResolvedValue(undefined),
  loginOidcAction: vi.fn(),
}));

import { loginAction, loginOidcAction } from "@/app/(auth)/login/actions";
import { LoginForm } from "./LoginForm";

describe("LoginForm — renderizado", () => {
  it("renders email input with label", () => {
    render(<LoginForm />);
    expect(screen.getByLabelText("Email")).toBeInTheDocument();
  });

  it("renders password input with label", () => {
    render(<LoginForm />);
    expect(screen.getByLabelText("Contraseña")).toBeInTheDocument();
  });

  it("renders submit button", () => {
    render(<LoginForm />);
    expect(screen.getByRole("button", { name: "Entrar" })).toBeInTheDocument();
  });

  it("no muestra error al inicio", () => {
    render(<LoginForm />);
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });
});

describe("LoginForm — submit", () => {
  beforeEach(() => {
    vi.mocked(loginAction).mockResolvedValue(undefined);
  });

  it("llama a loginAction con los valores del formulario", async () => {
    render(<LoginForm />);

    fireEvent.change(screen.getByLabelText("Email"), {
      target: { value: "admin@vicalba.com" },
    });
    fireEvent.change(screen.getByLabelText("Contraseña"), {
      target: { value: "secret123" },
    });

    fireEvent.submit(
      screen.getByRole("button", { name: "Entrar" }).closest("form")!,
    );

    await waitFor(() => {
      expect(loginAction).toHaveBeenCalledWith(
        "admin@vicalba.com",
        "secret123",
      );
    });
  });

  it("muestra el botón deshabilitado mientras carga", async () => {
    let resolve!: () => void;
    vi.mocked(loginAction).mockReturnValue(
      new Promise((r) => {
        resolve = () => r(undefined);
      }) as ReturnType<typeof loginAction>,
    );

    render(<LoginForm />);

    fireEvent.submit(
      screen.getByRole("button", { name: "Entrar" }).closest("form")!,
    );

    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Entrando…" })).toBeDisabled();
    });

    resolve();
  });
});

describe("LoginForm — error de credenciales", () => {
  beforeEach(() => {
    vi.mocked(loginAction).mockResolvedValue({
      error: "Credenciales incorrectas",
    });
  });

  it("muestra mensaje de error cuando loginAction devuelve error", async () => {
    render(<LoginForm />);

    fireEvent.submit(
      screen.getByRole("button", { name: "Entrar" }).closest("form")!,
    );

    await waitFor(() => {
      expect(screen.getByRole("alert")).toHaveTextContent(
        "Credenciales incorrectas",
      );
    });
  });

  it("vuelve a habilitar el botón tras el error", async () => {
    render(<LoginForm />);

    fireEvent.submit(
      screen.getByRole("button", { name: "Entrar" }).closest("form")!,
    );

    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Entrar" })).toBeEnabled();
    });
  });

  it("no muestra error antes de hacer submit", () => {
    render(<LoginForm />);
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });
});

describe("LoginForm — Pocket ID", () => {
  const assign = vi.fn();

  beforeEach(() => {
    assign.mockClear();
    vi.stubGlobal("location", { assign });
  });

  afterEach(() => vi.unstubAllGlobals());

  it("sin configurar no ofrece Pocket ID", () => {
    render(<LoginForm />);
    expect(
      screen.queryByRole("button", { name: "Entrar con Pocket ID" }),
    ).not.toBeInTheDocument();
  });

  it("mantiene el login con contraseña como respaldo", () => {
    render(<LoginForm oidcActivo />);
    expect(
      screen.getByRole("button", { name: "Entrar con Pocket ID" }),
    ).toBeInTheDocument();
    expect(screen.getByLabelText("Contraseña")).toBeInTheDocument();
  });

  it("navega a la URL del proveedor", async () => {
    vi.mocked(loginOidcAction).mockResolvedValue("https://id.example.com/auth");
    render(<LoginForm oidcActivo />);

    fireEvent.click(
      screen.getByRole("button", { name: "Entrar con Pocket ID" }),
    );

    await waitFor(() =>
      expect(assign).toHaveBeenCalledWith("https://id.example.com/auth"),
    );
  });

  it("si falla avisa y deja entrar con contraseña", async () => {
    vi.mocked(loginOidcAction).mockRejectedValue(new Error("caído"));
    render(<LoginForm oidcActivo />);

    fireEvent.click(
      screen.getByRole("button", { name: "Entrar con Pocket ID" }),
    );

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Entra con tu contraseña",
    );
    expect(
      screen.getByRole("button", { name: "Entrar con Pocket ID" }),
    ).toBeEnabled();
  });

  it("sin vínculo muestra el identificador para vincular la cuenta", () => {
    render(
      <LoginForm
        oidcActivo
        errorOidc="oidc_sin_vincular"
        subSinVincular="sub-123"
      />,
    );
    expect(screen.getByRole("alert")).toHaveTextContent("no está vinculada");
    expect(screen.getByRole("alert")).toHaveTextContent("sub-123");
  });

  it("con otro error del proveedor da un aviso genérico", () => {
    render(<LoginForm oidcActivo errorOidc="Configuration" />);
    expect(screen.getByRole("alert")).toHaveTextContent(
      "No se pudo entrar con Pocket ID",
    );
  });
});
