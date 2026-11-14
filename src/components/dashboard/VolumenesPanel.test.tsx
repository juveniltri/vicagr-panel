// @vitest-environment jsdom
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { VolumenesPanel } from "./VolumenesPanel";

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn() }) }));

const { crearVolumenAction, eliminarVolumenAction } = vi.hoisted(() => ({
  crearVolumenAction: vi.fn().mockResolvedValue(undefined),
  eliminarVolumenAction: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/app/(panel)/actions", () => ({
  crearVolumenAction,
  eliminarVolumenAction,
}));

beforeAll(() => {
  window.HTMLElement.prototype.scrollIntoView = vi.fn();
  global.fetch = vi.fn();
});

const mockVolumenes = [
  {
    id: "v1",
    nombre: "galeria",
    rutaContenedor: "/app/public/galeria",
    creadoEn: new Date(),
  },
];

describe("VolumenesPanel — lista", () => {
  beforeEach(() => vi.clearAllMocks());

  it("muestra los volúmenes en tabla", () => {
    render(
      <VolumenesPanel proyectoId="p1" volumenesIniciales={mockVolumenes} />,
    );
    expect(screen.getByText("galeria")).toBeInTheDocument();
    expect(screen.getByText("/app/public/galeria")).toBeInTheDocument();
  });

  it("muestra mensaje vacío cuando no hay volúmenes", () => {
    render(<VolumenesPanel proyectoId="p1" volumenesIniciales={[]} />);
    expect(screen.getByText(/Sin volúmenes/)).toBeInTheDocument();
  });

  it("muestra botón para añadir nuevo volumen", () => {
    render(<VolumenesPanel proyectoId="p1" volumenesIniciales={[]} />);
    expect(
      screen.getByRole("button", { name: /nuevo volumen/i }),
    ).toBeInTheDocument();
  });

  it("muestra botones Ficheros y Eliminar por volumen", () => {
    render(
      <VolumenesPanel proyectoId="p1" volumenesIniciales={mockVolumenes} />,
    );
    expect(
      screen.getByRole("button", { name: /explorar ficheros de galeria/i }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /eliminar volumen galeria/i }),
    ).toBeInTheDocument();
  });
});

describe("VolumenesPanel — crear volumen", () => {
  beforeEach(() => vi.clearAllMocks());

  it("muestra formulario al pulsar 'Nuevo volumen'", () => {
    render(<VolumenesPanel proyectoId="p1" volumenesIniciales={[]} />);
    fireEvent.click(screen.getByRole("button", { name: /nuevo volumen/i }));
    expect(screen.getByLabelText(/nombre del volumen/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/ruta en el contenedor/i)).toBeInTheDocument();
  });

  it("llama a crearVolumenAction con los datos del formulario", async () => {
    render(<VolumenesPanel proyectoId="p1" volumenesIniciales={[]} />);
    fireEvent.click(screen.getByRole("button", { name: /nuevo volumen/i }));
    fireEvent.change(screen.getByLabelText(/nombre del volumen/i), {
      target: { value: "uploads" },
    });
    fireEvent.change(screen.getByLabelText(/ruta en el contenedor/i), {
      target: { value: "/app/uploads" },
    });
    fireEvent.click(screen.getByRole("button", { name: /guardar volumen/i }));
    await waitFor(() =>
      expect(crearVolumenAction).toHaveBeenCalledWith(
        "p1",
        "uploads",
        "/app/uploads",
      ),
    );
  });

  it("muestra error si crearVolumenAction devuelve error", async () => {
    crearVolumenAction.mockResolvedValueOnce({
      error: "Ya existe un volumen con ese nombre",
    });
    render(<VolumenesPanel proyectoId="p1" volumenesIniciales={[]} />);
    fireEvent.click(screen.getByRole("button", { name: /nuevo volumen/i }));
    fireEvent.change(screen.getByLabelText(/nombre del volumen/i), {
      target: { value: "dup" },
    });
    fireEvent.change(screen.getByLabelText(/ruta en el contenedor/i), {
      target: { value: "/app/dup" },
    });
    fireEvent.click(screen.getByRole("button", { name: /guardar volumen/i }));
    await waitFor(() =>
      expect(screen.getByRole("alert")).toHaveTextContent(
        "Ya existe un volumen con ese nombre",
      ),
    );
  });

  it("cancela y vuelve a la lista", () => {
    render(<VolumenesPanel proyectoId="p1" volumenesIniciales={[]} />);
    fireEvent.click(screen.getByRole("button", { name: /nuevo volumen/i }));
    fireEvent.click(screen.getByRole("button", { name: /cancelar/i }));
    expect(
      screen.getByRole("button", { name: /nuevo volumen/i }),
    ).toBeInTheDocument();
  });
});

describe("VolumenesPanel — eliminar volumen", () => {
  beforeEach(() => vi.clearAllMocks());

  it("pide confirmación antes de eliminar", () => {
    render(
      <VolumenesPanel proyectoId="p1" volumenesIniciales={mockVolumenes} />,
    );
    fireEvent.click(
      screen.getByRole("button", { name: /eliminar volumen galeria/i }),
    );
    expect(screen.getByText(/¿Eliminar\?/)).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /confirmar/i }),
    ).toBeInTheDocument();
  });

  it("llama a eliminarVolumenAction al confirmar", async () => {
    render(
      <VolumenesPanel proyectoId="p1" volumenesIniciales={mockVolumenes} />,
    );
    fireEvent.click(
      screen.getByRole("button", { name: /eliminar volumen galeria/i }),
    );
    fireEvent.click(screen.getByRole("button", { name: /confirmar/i }));
    await waitFor(() =>
      expect(eliminarVolumenAction).toHaveBeenCalledWith("v1"),
    );
  });

  it("cancela la confirmación", () => {
    render(
      <VolumenesPanel proyectoId="p1" volumenesIniciales={mockVolumenes} />,
    );
    fireEvent.click(
      screen.getByRole("button", { name: /eliminar volumen galeria/i }),
    );
    fireEvent.click(screen.getByRole("button", { name: /cancelar/i }));
    expect(
      screen.getByRole("button", { name: /eliminar volumen galeria/i }),
    ).toBeInTheDocument();
  });
});

describe("VolumenesPanel — file manager modal", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(global.fetch).mockResolvedValue({
      ok: true,
      json: async () => [],
    } as Response);
  });

  it("muestra el botón 'Explorar' por volumen", () => {
    render(
      <VolumenesPanel proyectoId="p1" volumenesIniciales={mockVolumenes} />,
    );
    expect(
      screen.getByRole("button", { name: /explorar ficheros de galeria/i }),
    ).toBeInTheDocument();
  });

  it("abre el modal explorador al pulsar 'Explorar'", async () => {
    render(
      <VolumenesPanel proyectoId="p1" volumenesIniciales={mockVolumenes} />,
    );
    fireEvent.click(
      screen.getByRole("button", { name: /explorar ficheros de galeria/i }),
    );
    await waitFor(() =>
      expect(screen.getByText(/Explorador — galeria/i)).toBeInTheDocument(),
    );
  });

  it("cierra el modal al pulsar el botón de cerrar", async () => {
    render(
      <VolumenesPanel proyectoId="p1" volumenesIniciales={mockVolumenes} />,
    );
    fireEvent.click(
      screen.getByRole("button", { name: /explorar ficheros de galeria/i }),
    );
    await waitFor(() => screen.getByText(/Explorador — galeria/i));
    fireEvent.click(screen.getByRole("button", { name: /cerrar/i }));
    expect(screen.queryByText(/Explorador — galeria/i)).not.toBeInTheDocument();
  });
});

describe("VolumenesPanel — cuándo se aplica un volumen", () => {
  const antiguo = {
    ...mockVolumenes[0],
    creadoEn: new Date("2026-11-01T10:00:00Z"),
  };
  const nuevo = {
    id: "v2",
    nombre: "subidas",
    rutaContenedor: "/app/uploads",
    creadoEn: new Date("2026-11-10T10:00:00Z"),
  };

  it("al crear avisa de que hace falta un deploy y de que Reiniciar no basta", () => {
    render(<VolumenesPanel proyectoId="p1" volumenesIniciales={[]} />);
    fireEvent.click(screen.getByRole("button", { name: /nuevo volumen/i }));

    const aviso = screen.getByRole("note");
    expect(aviso).toHaveTextContent("próximo deploy");
    expect(aviso).toHaveTextContent("Reiniciar no basta");
    expect(aviso).toHaveTextContent("se copian al volumen");
  });

  it("marca como pendiente de deploy solo el volumen creado después del último deploy", () => {
    render(
      <VolumenesPanel
        proyectoId="p1"
        volumenesIniciales={[antiguo, nuevo]}
        ultimoDeployEn={new Date("2026-11-05T10:00:00Z")}
      />,
    );

    const filas = screen.getAllByRole("row");
    expect(filas[1]).not.toHaveTextContent("Pendiente de deploy");
    expect(filas[2]).toHaveTextContent("Pendiente de deploy");
  });

  it("sin ningún deploy correcto todos están pendientes", () => {
    render(<VolumenesPanel proyectoId="p1" volumenesIniciales={[antiguo]} />);

    expect(screen.getByText("Pendiente de deploy")).toBeInTheDocument();
  });

  it("en un Proyecto de tipo compose no deja crear volúmenes y explica por qué", () => {
    render(
      <VolumenesPanel proyectoId="p1" volumenesIniciales={[]} esCompose />,
    );

    expect(
      screen.queryByRole("button", { name: /nuevo volumen/i }),
    ).not.toBeInTheDocument();
    expect(screen.getByRole("note")).toHaveTextContent("docker-compose.yml");
  });
});
