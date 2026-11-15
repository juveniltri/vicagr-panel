// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { generarSecretoWebhookAction, quitarSecretoWebhookAction } = vi.hoisted(
  () => ({
    generarSecretoWebhookAction: vi.fn(),
    quitarSecretoWebhookAction: vi.fn(),
  }),
);
vi.mock("@/app/(panel)/actions", () => ({
  generarSecretoWebhookAction,
  quitarSecretoWebhookAction,
}));

import { SecretoWebhook } from "./SecretoWebhook";

describe("SecretoWebhook", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    generarSecretoWebhookAction.mockResolvedValue({ secreto: "abc123" });
    quitarSecretoWebhookAction.mockResolvedValue(undefined);
  });

  it("sin secreto propio dice que usa el global", () => {
    render(<SecretoWebhook proyectoId="p1" propio={false} />);
    expect(screen.getByText(/GITHUB_WEBHOOK_SECRET/)).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Quitar" }),
    ).not.toBeInTheDocument();
  });

  it("al generar muestra el secreto una vez y lo copia", async () => {
    const user = userEvent.setup();
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText },
      configurable: true,
    });
    render(<SecretoWebhook proyectoId="p1" propio={false} />);

    await user.click(
      screen.getByRole("button", { name: "Generar secreto propio" }),
    );

    expect(generarSecretoWebhookAction).toHaveBeenCalledWith("p1");
    expect(await screen.findByText("abc123")).toBeInTheDocument();
    expect(screen.getByText(/No se volverá a mostrar/)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Copiar" }));
    expect(writeText).toHaveBeenCalledWith("abc123");
  });

  it("regenerar pide confirmación antes de cambiarlo", async () => {
    const user = userEvent.setup();
    render(<SecretoWebhook proyectoId="p1" propio />);

    await user.click(screen.getByRole("button", { name: "Regenerar" }));
    expect(generarSecretoWebhookAction).not.toHaveBeenCalled();
    await user.click(
      screen.getByRole("button", {
        name: "¿Regenerar? El actual deja de valer",
      }),
    );

    expect(generarSecretoWebhookAction).toHaveBeenCalledWith("p1");
    expect(await screen.findByText("abc123")).toBeInTheDocument();
  });

  it("quitar pide confirmación y vuelve al global", async () => {
    const user = userEvent.setup();
    render(<SecretoWebhook proyectoId="p1" propio />);

    await user.click(screen.getByRole("button", { name: "Quitar" }));
    await user.click(
      screen.getByRole("button", { name: "¿Quitar? Vuelve al global" }),
    );

    expect(quitarSecretoWebhookAction).toHaveBeenCalledWith("p1");
    expect(
      await screen.findByRole("button", { name: "Generar secreto propio" }),
    ).toBeInTheDocument();
  });

  it("muestra el error si la acción falla", async () => {
    generarSecretoWebhookAction.mockResolvedValue({ error: "No se pudo" });
    render(<SecretoWebhook proyectoId="p1" propio={false} />);

    await userEvent.click(
      screen.getByRole("button", { name: "Generar secreto propio" }),
    );

    expect(await screen.findByRole("alert")).toHaveTextContent("No se pudo");
  });

  it("muestra el error si quitar falla y sigue con el propio", async () => {
    quitarSecretoWebhookAction.mockResolvedValue({ error: "Falló" });
    const user = userEvent.setup();
    render(<SecretoWebhook proyectoId="p1" propio />);

    await user.click(screen.getByRole("button", { name: "Quitar" }));
    await user.click(
      screen.getByRole("button", { name: "¿Quitar? Vuelve al global" }),
    );

    expect(await screen.findByRole("alert")).toHaveTextContent("Falló");
    expect(screen.getByRole("button", { name: "Quitar" })).toBeInTheDocument();
  });
});
