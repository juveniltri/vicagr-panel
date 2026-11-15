import { expect, type Page } from "@playwright/test";
import { docker } from "../scripts/guia/entorno";
import { BASE, USUARIO, conectarBd } from "./entorno";

export { docker };

// Traefik may still be picking up the Panel right after it turns healthy.
export async function abrir(page: Page, ruta: string): Promise<void> {
  for (let intento = 0; ; intento++) {
    const res = await page.goto(BASE + ruta).catch(() => null);
    if (res && res.status() < 400) return;
    if (intento >= 10) throw new Error(`${ruta} respondió ${res?.status()}`);
    await page.waitForTimeout(2000);
  }
}

export async function entrar(page: Page): Promise<void> {
  await abrir(page, "/login");
  await page.getByLabel("Email").fill(USUARIO.email);
  await page.getByLabel("Contraseña").fill(USUARIO.password);
  await page.getByRole("button", { name: "Entrar" }).click();
  await page.waitForURL(BASE + "/");
}

export const seccionCliente = (page: Page, nombre: string) =>
  page.getByRole("region", { name: nombre, exact: true });

// Next.js keeps an empty role="alert" of its own for route announcements.
export const alerta = (page: Page) =>
  page.locator('[role="alert"]:not(#__next-route-announcer__)');

export async function crearCliente(
  page: Page,
  slug: string,
  nombre: string,
): Promise<void> {
  await abrir(page, "/proyectos");
  await page.getByRole("button", { name: "Nuevo cliente" }).click();
  await page.getByLabel("Slug").fill(slug);
  await page.getByLabel("Nombre").fill(nombre);
  await page.getByRole("button", { name: "Crear", exact: true }).click();
  await expect(seccionCliente(page, nombre)).toBeVisible();
}

export type DatosProyecto = {
  nombre: string;
  tipo?: "Docker Image" | "Node.js" | "Dockerfile" | "Docker Compose";
  imagen?: string;
  puerto?: number;
  plantilla?: RegExp;
};

// Opens the form of a new Proyecto of the Cliente and fills it in, without
// sending it: the caller decides whether to expect success or an error.
export async function rellenarProyecto(
  page: Page,
  cliente: string,
  datos: DatosProyecto,
): Promise<void> {
  await abrir(page, "/proyectos");
  await seccionCliente(page, cliente)
    .getByRole("button", { name: "+ Proyecto" })
    .click();
  if (datos.plantilla) {
    await page.locator("#plantilla").click();
    await page.getByRole("option", { name: datos.plantilla }).click();
  }
  await page.getByLabel("Nombre").fill(datos.nombre);
  if (datos.tipo) {
    await page.locator("#tipo").click();
    await page.getByRole("option", { name: datos.tipo }).click();
  }
  if (datos.imagen) await page.getByLabel("Imagen Docker").fill(datos.imagen);
  if (datos.puerto)
    await page.getByLabel(/Puerto del contenedor/).fill(String(datos.puerto));
}

export async function crearProyecto(
  page: Page,
  cliente: string,
  datos: DatosProyecto,
): Promise<string> {
  await rellenarProyecto(page, cliente, datos);
  await page.getByRole("button", { name: "Crear", exact: true }).click();
  const enlace = seccionCliente(page, cliente)
    // The link's name starts with the status badge ("stopped web").
    .getByRole("link", { name: new RegExp(`(^|\\s)${datos.nombre}$`) })
    .first();
  await expect(enlace).toBeVisible();
  const href = await enlace.getAttribute("href");
  return href!.split("/").pop()!;
}

type Deploy = { resultado: string; output: string | null };

// The deploy runs in the background: wait for its row to leave en_curso.
export async function desplegar(
  page: Page,
  proyectoId: string,
  { esperarMs = 6 * 60_000 } = {},
): Promise<Deploy> {
  const prisma = conectarBd();
  try {
    const antes = await prisma.deploy.count({ where: { proyectoId } });
    await abrir(page, `/proyectos/${proyectoId}`);
    await page.getByRole("button", { name: "Deploy", exact: true }).click();
    const limite = Date.now() + esperarMs;
    while (Date.now() < limite) {
      const [ultimo] = await prisma.deploy.findMany({
        where: { proyectoId },
        orderBy: { iniciadoEn: "desc" },
        take: 1,
      });
      const total = await prisma.deploy.count({ where: { proyectoId } });
      if (total > antes && ultimo && ultimo.resultado !== "en_curso")
        return { resultado: ultimo.resultado, output: ultimo.output };
      await page.waitForTimeout(3000);
    }
    throw new Error(`El deploy de ${proyectoId} no terminó a tiempo`);
  } finally {
    await prisma.$disconnect();
  }
}

export async function estadoProyecto(proyectoId: string): Promise<string> {
  const prisma = conectarBd();
  try {
    const p = await prisma.proyecto.findUniqueOrThrow({
      where: { id: proyectoId },
      select: { estado: true },
    });
    return p.estado;
  } finally {
    await prisma.$disconnect();
  }
}

// Monaco auto-closes quotes and brackets while typing, so the content is set
// through its own API, as pasting would.
export async function escribirEnEditor(page: Page, texto: string) {
  await page.locator(".monaco-editor").first().waitFor();
  await page.waitForFunction(() => {
    const w = window as unknown as {
      monaco?: { editor: { getEditors(): unknown[] } };
    };
    return (w.monaco?.editor.getEditors().length ?? 0) > 0;
  });
  await page.evaluate((valor) => {
    const w = window as unknown as {
      monaco: {
        editor: { getEditors(): Array<{ setValue(v: string): void }> };
      };
    };
    w.monaco.editor.getEditors()[0].setValue(valor);
  }, texto);
}

export const contenedor = (
  cliente: string,
  proyecto: string,
  servicio = "app",
) => `${cliente}-${proyecto}-${servicio}-1`;

export function enContenedor(nombre: string, comando: string[]): string {
  return docker(["exec", nombre, ...comando]);
}

export function existeContenedor(nombre: string): boolean {
  return (
    docker(
      ["ps", "-a", "--filter", `name=^${nombre}$`, "--format", "{{.Names}}"],
      {
        permitirFallo: true,
      },
    ) === nombre
  );
}

// Polls until the check passes or the time is up.
export async function esperarA(
  comprobar: () => boolean | Promise<boolean>,
  { ms, cada = 5000, motivo }: { ms: number; cada?: number; motivo: string },
): Promise<void> {
  const limite = Date.now() + ms;
  while (Date.now() < limite) {
    if (await comprobar()) return;
    await new Promise((r) => setTimeout(r, cada));
  }
  throw new Error(`Tiempo agotado esperando: ${motivo}`);
}
