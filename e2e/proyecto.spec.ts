import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, test, type Page } from "@playwright/test";
import {
  abrir,
  alerta,
  contenedor,
  crearCliente,
  crearProyecto,
  desplegar,
  docker,
  enContenedor,
  entrar,
  escribirEnEditor,
  esperarA,
  estadoProyecto,
  existeContenedor,
  rellenarProyecto,
} from "./ayudas";
import { PREFIJO, REPOS, avisosRecibidos } from "./entorno";

// One Proyecto followed through its whole life: the steps depend on each other.
test.describe.configure({ mode: "serial" });

const CLIENTE = { slug: `${PREFIJO}-tienda`, nombre: "E2E Tienda" };
const PROYECTO = "web";
const app = contenedor(CLIENTE.slug, PROYECTO);
// Values Compose used to cut or expand: $, ${…}, " #", quotes, backslashes.
const VARIABLES = {
  SALT: `|Rk}+w$1 #x 'a' "b" \${HOME} \\d`,
  CON_ESPACIOS: "  hola mundo  ",
};

let page: Page;
let proyectoId: string;

test.beforeAll(async ({ browser }) => {
  page = await browser.newPage();
  await entrar(page);
});

test.afterAll(async () => {
  await page.close();
});

test("crear un Cliente y un Proyecto de tipo imagen", async () => {
  await crearCliente(page, CLIENTE.slug, CLIENTE.nombre);
  proyectoId = await crearProyecto(page, CLIENTE.nombre, {
    nombre: PROYECTO,
    tipo: "Docker Image",
    imagen: "nginx:1.27-alpine",
    puerto: 80,
  });
});

test("un nombre que Docker vería como el de otro Proyecto se rechaza", async () => {
  // "e2e" + "tienda-web" is "e2e-tienda-web" in Docker, like the one above.
  await crearCliente(page, PREFIJO, "E2E");
  await rellenarProyecto(page, "E2E", { nombre: "tienda-web" });
  await page.getByRole("button", { name: "Crear", exact: true }).click();

  await expect(alerta(page)).toContainText("coincide en Docker");
});

test("variables con $, #, comillas y espacios", async () => {
  await abrir(page, `/proyectos/${proyectoId}?tab=variables`);
  await page.getByRole("button", { name: "Editar variables" }).click();
  await escribirEnEditor(
    page,
    Object.entries(VARIABLES)
      // Spaces at either end survive only in quotes, as in any .env file.
      .map(([clave, valor]) =>
        clave === "CON_ESPACIOS" ? `${clave}="${valor}"` : `${clave}=${valor}`,
      )
      .join("\n"),
  );
  await page.getByRole("button", { name: "Guardar variables" }).click();

  await expect(page.getByText("SALT=")).toBeVisible();
});

test("un Volumen nuevo avisa de que hace falta un deploy", async () => {
  await abrir(page, `/proyectos/${proyectoId}?tab=volumenes`);
  await page.getByRole("button", { name: "+ Nuevo volumen" }).click();

  await expect(page.getByRole("note")).toContainText("próximo deploy");
  await page.getByLabel("Nombre del volumen").fill("html");
  await page.getByLabel("Ruta en el contenedor").fill("/usr/share/nginx/html");
  await page.getByRole("button", { name: "Guardar volumen" }).click();

  await expect(page.getByText("Pendiente de deploy")).toBeVisible();
});

test("el deploy termina bien y deja el Proyecto en marcha", async () => {
  const { resultado, output } = await desplegar(page, proyectoId);

  expect(resultado, output ?? "").toBe("exito");
  expect(await estadoProyecto(proyectoId)).toBe("running");
  expect(docker(["inspect", "-f", "{{.State.Running}}", app])).toBe("true");
});

test("las variables llegan intactas al contenedor", async () => {
  for (const [clave, valor] of Object.entries(VARIABLES))
    expect(enContenedor(app, ["printenv", clave]).trim()).toBe(valor.trim());
  // docker exec's output is trimmed: check the ends from inside.
  expect(enContenedor(app, ["sh", "-c", 'printf "[%s]" "$CON_ESPACIOS"'])).toBe(
    `[${VARIABLES.CON_ESPACIOS}]`,
  );
});

test("los límites de recursos y el reinicio automático se aplican", async () => {
  const config = docker([
    "inspect",
    "-f",
    "{{.HostConfig.Memory}} {{.HostConfig.NanoCpus}} {{.HostConfig.RestartPolicy.Name}} {{.HostConfig.SecurityOpt}}",
    app,
  ]);

  expect(config).toBe(
    `${1024 * 1024 * 1024} 1000000000 unless-stopped [no-new-privileges:true]`,
  );
});

test("el Volumen conserva lo que la imagen tenía en esa ruta", async () => {
  expect(enContenedor(app, ["ls", "/usr/share/nginx/html"])).toContain(
    "index.html",
  );
  await abrir(page, `/proyectos/${proyectoId}?tab=volumenes`);
  await expect(page.getByText("Pendiente de deploy")).toHaveCount(0);
});

test("el gestor de ficheros sube y descarga", async () => {
  await abrir(page, `/proyectos/${proyectoId}?tab=volumenes`);
  await page.getByRole("button", { name: "Explorar ficheros de html" }).click();
  await expect(page.getByText("index.html")).toBeVisible();

  await page.getByLabel("Subir ficheros").setInputFiles({
    name: "prueba-e2e.txt",
    mimeType: "text/plain",
    buffer: Buffer.from("subido desde el Panel"),
  });
  await expect(page.getByText("prueba-e2e.txt")).toBeVisible();
  // The container sees what the Panel wrote: same folder on both sides.
  expect(
    enContenedor(app, ["cat", "/usr/share/nginx/html/prueba-e2e.txt"]),
  ).toBe("subido desde el Panel");

  await page.getByRole("checkbox", { name: "prueba-e2e.txt" }).check();
  const descarga = page.waitForEvent("download");
  await page.getByRole("link", { name: "Descargar ZIP" }).click();
  expect((await descarga).suggestedFilename()).toMatch(/^html-\d+\.zip$/);
});

test("el gestor de ficheros no sigue un enlace que deja el contenedor", async () => {
  enContenedor(app, [
    "ln",
    "-s",
    "/etc/passwd",
    "/usr/share/nginx/html/enlace",
  ]);
  await abrir(page, `/proyectos/${proyectoId}?tab=volumenes`);
  await page.getByRole("button", { name: "Explorar ficheros de html" }).click();

  await expect(
    page.getByText("(enlace: no se abre ni se descarga)"),
  ).toBeVisible();
  const res = await page.request.get(
    `/api/volumes/${await idVolumen()}/files/download?files=enlace`,
  );
  // An empty ZIP: 22 bytes, just the end-of-archive record.
  expect((await res.body()).length).toBe(22);
});

// `docker kill` would count as a stop on purpose (exit 137): break the config
// so nginx fails to start, as a real crash would.
const confNginx = "/etc/nginx/conf.d/default.conf";
let confOriginal = "";

test("un Servicio caído pasa el Proyecto a error y llega el aviso", async () => {
  const antes = avisosRecibidos().length;
  confOriginal = enContenedor(app, ["cat", confNginx]);
  docker(["update", "--restart=no", app]);
  enContenedor(app, ["sh", "-c", `echo roto > ${confNginx}`]);
  docker(["restart", app]);

  // Two readings one minute apart.
  await esperarA(async () => (await estadoProyecto(proyectoId)) === "error", {
    ms: 4 * 60_000,
    motivo: "que el Proyecto pase a error",
  });
  await esperarA(
    () =>
      avisosRecibidos()
        .slice(antes)
        .some((a) => a.evento === "servicio" && a.resultado === "error"),
    { ms: 30_000, cada: 2000, motivo: "el aviso «Proyecto caído»" },
  );
});

test("Reiniciar levanta el Servicio caído y llega la recuperación", async () => {
  const antes = avisosRecibidos().length;
  // Fixed while stopped: docker cp works on a container that is not running.
  const fichero = path.join(tmpdir(), "vicagr-e2e-default.conf");
  writeFileSync(fichero, confOriginal);
  docker(["cp", fichero, `${app}:${confNginx}`]);
  await abrir(page, `/proyectos/${proyectoId}`);
  await page.getByRole("button", { name: "Reiniciar" }).first().click();

  await esperarA(
    () => docker(["inspect", "-f", "{{.State.Running}}", app]) === "true",
    { ms: 60_000, cada: 2000, motivo: "que el contenedor vuelva" },
  );
  await esperarA(
    () =>
      avisosRecibidos()
        .slice(antes)
        .some((a) => a.evento === "servicio" && a.resultado === "exito"),
    { ms: 4 * 60_000, motivo: "el aviso «Proyecto recuperado»" },
  );
});

test("eliminar el Proyecto con sus datos no deja nada en la VPS", async () => {
  await abrir(page, `/proyectos/${proyectoId}`);
  await page.getByRole("button", { name: "Detener" }).first().click();
  await esperarA(async () => (await estadoProyecto(proyectoId)) === "stopped", {
    ms: 60_000,
    cada: 2000,
    motivo: "que el Proyecto se detenga",
  });

  await abrir(page, `/proyectos/${proyectoId}?tab=ajustes`);
  await page.getByRole("button", { name: "Eliminar proyecto" }).click();
  await page.getByLabel(/sus datos de la VPS/).check();
  await page.getByRole("button", { name: "Confirmar" }).click();
  await page.waitForURL(/\/proyectos$/);

  expect(existeContenedor(app)).toBe(false);
  const carpeta = docker([
    "run",
    "--rm",
    "-v",
    `${REPOS}:/r`,
    "busybox:1.37.0",
    "sh",
    "-c",
    `test -e /r/${CLIENTE.slug}/${PROYECTO} && echo existe || echo borrada`,
  ]);
  expect(carpeta).toBe("borrada");
});

async function idVolumen(): Promise<string> {
  const { conectarBd } = await import("./entorno");
  const prisma = conectarBd();
  try {
    const v = await prisma.volumen.findFirstOrThrow({ where: { proyectoId } });
    return v.id;
  } finally {
    await prisma.$disconnect();
  }
}
