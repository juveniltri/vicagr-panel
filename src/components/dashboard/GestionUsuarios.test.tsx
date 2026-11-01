// @vitest-environment jsdom
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { GestionUsuarios } from "./GestionUsuarios";

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn() }) }));

const {
  crearUsuarioAction,
  actualizarUsuarioAction,
  cambiarPasswordAction,
  eliminarUsuarioAction,
  vincularOidcAction,
} = vi.hoisted(() => ({
  crearUsuarioAction: vi.fn().mockResolvedValue(undefined),
  actualizarUsuarioAction: vi.fn().mockResolvedValue(undefined),
  cambiarPasswordAction: vi.fn().mockResolvedValue(undefined),
  eliminarUsuarioAction: vi.fn().mockResolvedValue(undefined),
  vincularOidcAction: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/app/(panel)/actions", () => ({
  crearUsuarioAction,
  actualizarUsuarioAction,
  cambiarPasswordAction,
  eliminarUsuarioAction,
  vincularOidcAction,
}));

beforeAll(() => {
  window.HTMLElement.prototype.scrollIntoView = vi.fn();
});

const mockUsuarios = [
  {
    id: "u1",
    email: "admin@vicalba.local",
    nombre: "Admin",
    creadoEn: new Date(),
  },
  { id: "u2", email: "dev@vicalba.local", nombre: "Dev", creadoEn: new Date() },
];

describe("GestionUsuarios — lista", () => {
  beforeEach(() => vi.clearAllMocks());

  it("muestra los usuarios en tabla", () => {
    render(<GestionUsuarios usuariosIniciales={mockUsuarios} />);
    expect(screen.getByText("Admin")).toBeInTheDocument();
    expect(screen.getByText("admin@vicalba.local")).toBeInTheDocument();
    expect(screen.getByText("Dev")).toBeInTheDocument();
  });

  it("muestra mensaje vacío cuando no hay usuarios", () => {
    render(<GestionUsuarios usuariosIniciales={[]} />);
    expect(screen.getByText(/Sin usuarios/)).toBeInTheDocument();
  });

  it("muestra botón para crear nuevo usuario", () => {
    render(<GestionUsuarios usuariosIniciales={[]} />);
    expect(
      screen.getByRole("button", { name: /nuevo usuario/i }),
    ).toBeInTheDocument();
  });

  it("muestra botones Editar, Contraseña y Eliminar por usuario", () => {
    render(<GestionUsuarios usuariosIniciales={[mockUsuarios[0]]} />);
    expect(
      screen.getByRole("button", { name: /editar admin/i }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /cambiar contraseña de admin/i }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /eliminar admin/i }),
    ).toBeInTheDocument();
  });
});

describe("GestionUsuarios — nuevo usuario", () => {
  beforeEach(() => vi.clearAllMocks());

  it("muestra el formulario al pulsar 'Nuevo usuario'", () => {
    render(<GestionUsuarios usuariosIniciales={[]} />);
    fireEvent.click(screen.getByRole("button", { name: /nuevo usuario/i }));
    expect(screen.getByLabelText(/email/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/contraseña/i)).toBeInTheDocument();
  });

  it("llama a crearUsuarioAction con los datos del formulario", async () => {
    render(<GestionUsuarios usuariosIniciales={[]} />);
    fireEvent.click(screen.getByRole("button", { name: /nuevo usuario/i }));
    fireEvent.change(screen.getByLabelText(/nombre/i), {
      target: { value: "Nuevo" },
    });
    fireEvent.change(screen.getByLabelText(/email/i), {
      target: { value: "nuevo@vicalba.local" },
    });
    fireEvent.change(screen.getByLabelText(/contraseña/i), {
      target: { value: "secret123" },
    });
    fireEvent.click(screen.getByRole("button", { name: /crear usuario/i }));
    await waitFor(() =>
      expect(crearUsuarioAction).toHaveBeenCalledWith(
        "nuevo@vicalba.local",
        "Nuevo",
        "secret123",
      ),
    );
  });

  it("muestra error si crearUsuarioAction devuelve error", async () => {
    crearUsuarioAction.mockResolvedValueOnce({
      error: "El email ya está en uso",
    });
    render(<GestionUsuarios usuariosIniciales={[]} />);
    fireEvent.click(screen.getByRole("button", { name: /nuevo usuario/i }));
    fireEvent.change(screen.getByLabelText(/nombre/i), {
      target: { value: "X" },
    });
    fireEvent.change(screen.getByLabelText(/email/i), {
      target: { value: "dup@x.com" },
    });
    fireEvent.change(screen.getByLabelText(/contraseña/i), {
      target: { value: "secret123" },
    });
    fireEvent.click(screen.getByRole("button", { name: /crear usuario/i }));
    await waitFor(() =>
      expect(screen.getByRole("alert")).toHaveTextContent(
        "El email ya está en uso",
      ),
    );
  });

  it("cancela y vuelve a la lista", () => {
    render(<GestionUsuarios usuariosIniciales={[]} />);
    fireEvent.click(screen.getByRole("button", { name: /nuevo usuario/i }));
    fireEvent.click(screen.getByRole("button", { name: /cancelar/i }));
    expect(
      screen.getByRole("button", { name: /nuevo usuario/i }),
    ).toBeInTheDocument();
  });
});

describe("GestionUsuarios — editar usuario", () => {
  beforeEach(() => vi.clearAllMocks());

  it("muestra formulario de edición con datos pre-rellenados", () => {
    render(<GestionUsuarios usuariosIniciales={[mockUsuarios[0]]} />);
    fireEvent.click(screen.getByRole("button", { name: /editar admin/i }));
    expect(screen.getByDisplayValue("Admin")).toBeInTheDocument();
    expect(screen.getByDisplayValue("admin@vicalba.local")).toBeInTheDocument();
  });

  it("llama a actualizarUsuarioAction al guardar", async () => {
    render(<GestionUsuarios usuariosIniciales={[mockUsuarios[0]]} />);
    fireEvent.click(screen.getByRole("button", { name: /editar admin/i }));
    fireEvent.change(screen.getByDisplayValue("Admin"), {
      target: { value: "Admin Pro" },
    });
    fireEvent.click(screen.getByRole("button", { name: /guardar cambios/i }));
    await waitFor(() =>
      expect(actualizarUsuarioAction).toHaveBeenCalledWith(
        "u1",
        "Admin Pro",
        "admin@vicalba.local",
      ),
    );
  });
});

describe("GestionUsuarios — cambiar contraseña", () => {
  beforeEach(() => vi.clearAllMocks());

  it("muestra formulario de contraseña", () => {
    render(<GestionUsuarios usuariosIniciales={[mockUsuarios[0]]} />);
    fireEvent.click(
      screen.getByRole("button", { name: /cambiar contraseña de admin/i }),
    );
    expect(screen.getByLabelText(/nueva contraseña/i)).toBeInTheDocument();
  });

  it("llama a cambiarPasswordAction con el id y la nueva contraseña", async () => {
    render(<GestionUsuarios usuariosIniciales={[mockUsuarios[0]]} />);
    fireEvent.click(
      screen.getByRole("button", { name: /cambiar contraseña de admin/i }),
    );
    fireEvent.change(screen.getByLabelText(/nueva contraseña/i), {
      target: { value: "newpassword1" },
    });
    fireEvent.click(
      screen.getByRole("button", { name: /cambiar contraseña/i }),
    );
    await waitFor(() =>
      expect(cambiarPasswordAction).toHaveBeenCalledWith("u1", "newpassword1"),
    );
  });
});

describe("GestionUsuarios — eliminar usuario", () => {
  beforeEach(() => vi.clearAllMocks());

  it("pide confirmación antes de eliminar", () => {
    render(<GestionUsuarios usuariosIniciales={[mockUsuarios[0]]} />);
    fireEvent.click(screen.getByRole("button", { name: /eliminar admin/i }));
    expect(screen.getByText(/¿Eliminar\?/)).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /confirmar/i }),
    ).toBeInTheDocument();
  });

  it("llama a eliminarUsuarioAction al confirmar", async () => {
    render(<GestionUsuarios usuariosIniciales={[mockUsuarios[0]]} />);
    fireEvent.click(screen.getByRole("button", { name: /eliminar admin/i }));
    fireEvent.click(screen.getByRole("button", { name: /confirmar/i }));
    await waitFor(() =>
      expect(eliminarUsuarioAction).toHaveBeenCalledWith("u1"),
    );
  });

  it("cancela la confirmación y vuelve a los botones normales", () => {
    render(<GestionUsuarios usuariosIniciales={[mockUsuarios[0]]} />);
    fireEvent.click(screen.getByRole("button", { name: /eliminar admin/i }));
    fireEvent.click(screen.getByRole("button", { name: /cancelar/i }));
    expect(
      screen.getByRole("button", { name: /eliminar admin/i }),
    ).toBeInTheDocument();
  });
});

describe("GestionUsuarios — Pocket ID", () => {
  beforeEach(() => vi.clearAllMocks());

  const conVinculo = [{ ...mockUsuarios[0], oidcSub: "sub-1" }];

  it("sin Pocket ID configurado no aparece", () => {
    render(<GestionUsuarios usuariosIniciales={conVinculo} />);
    expect(
      screen.queryByRole("button", { name: "Pocket ID de Admin" }),
    ).not.toBeInTheDocument();
    expect(screen.queryByText("Pocket ID vinculado")).not.toBeInTheDocument();
  });

  it("vincula el identificador pegado", async () => {
    render(<GestionUsuarios usuariosIniciales={mockUsuarios} oidcActivo />);
    fireEvent.click(screen.getByRole("button", { name: "Pocket ID de Admin" }));
    fireEvent.change(screen.getByLabelText("Identificador en Pocket ID"), {
      target: { value: "sub-9" },
    });
    expect(
      screen.queryByRole("button", { name: "Quitar vínculo" }),
    ).not.toBeInTheDocument();
    fireEvent.submit(
      screen.getByRole("button", { name: "Guardar vínculo" }).closest("form")!,
    );

    await waitFor(() =>
      expect(vincularOidcAction).toHaveBeenCalledWith("u1", "sub-9"),
    );
    expect(
      await screen.findByRole("button", { name: "Pocket ID de Admin" }),
    ).toBeInTheDocument();
  });

  it("muestra el vínculo y permite quitarlo", async () => {
    render(<GestionUsuarios usuariosIniciales={conVinculo} oidcActivo />);
    expect(screen.getByText("Pocket ID vinculado")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Pocket ID de Admin" }));
    fireEvent.click(screen.getByRole("button", { name: "Quitar vínculo" }));

    await waitFor(() =>
      expect(vincularOidcAction).toHaveBeenCalledWith("u1", null),
    );
  });

  it("muestra el error y no cierra el formulario", async () => {
    vincularOidcAction.mockResolvedValueOnce({ error: "Ya está vinculado" });
    render(<GestionUsuarios usuariosIniciales={conVinculo} oidcActivo />);
    fireEvent.click(screen.getByRole("button", { name: "Pocket ID de Admin" }));
    fireEvent.submit(
      screen.getByRole("button", { name: "Guardar vínculo" }).closest("form")!,
    );

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Ya está vinculado",
    );
    expect(
      screen.getByLabelText("Identificador en Pocket ID"),
    ).toBeInTheDocument();
  });

  it("cancelar vuelve a la lista sin guardar", () => {
    render(<GestionUsuarios usuariosIniciales={conVinculo} oidcActivo />);
    fireEvent.click(screen.getByRole("button", { name: "Pocket ID de Admin" }));
    fireEvent.click(screen.getByRole("button", { name: "Cancelar" }));
    expect(vincularOidcAction).not.toHaveBeenCalled();
    expect(screen.getByText("Pocket ID vinculado")).toBeInTheDocument();
  });
});
