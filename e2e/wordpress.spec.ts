import { expect, test } from "@playwright/test";
import {
  abrir,
  contenedor,
  crearCliente,
  crearProyecto,
  desplegar,
  enContenedor,
  entrar,
  esperarA,
} from "./ayudas";
import { PREFIJO } from "./entorno";

const CLIENTE = { slug: `${PREFIJO}-blog`, nombre: "E2E Blog" };

test("la plantilla WordPress queda lista para instalar tras el primer deploy", async ({
  page,
}) => {
  await entrar(page);
  await crearCliente(page, CLIENTE.slug, CLIENTE.nombre);
  const id = await crearProyecto(page, CLIENTE.nombre, {
    nombre: "wp",
    plantilla: /WordPress/,
  });

  await abrir(page, `/proyectos/${id}?tab=variables`);
  await expect(page.getByText("DB_PASSWORD=")).toBeVisible();
  await expect(page.getByText("DB_ROOT_PASSWORD=")).toBeVisible();

  // WordPress waits for MariaDB to be healthy: allow for the image pulls.
  const { resultado, output } = await desplegar(page, id, {
    esperarMs: 7 * 60_000,
  });
  expect(resultado, output ?? "").toBe("exito");

  const wordpress = contenedor(CLIENTE.slug, "wp", "wordpress");
  let codigo = "";
  await esperarA(
    () => {
      codigo = enContenedor(wordpress, [
        "curl",
        "-s",
        "-o",
        "/dev/null",
        "-w",
        "%{http_code}",
        "http://localhost/wp-admin/install.php",
      ]);
      return codigo === "200";
    },
    { ms: 60_000, cada: 3000, motivo: "el instalador de WordPress" },
  );
  expect(
    enContenedor(wordpress, [
      "php",
      "-r",
      'echo ini_get("upload_max_filesize");',
    ]),
  ).toBe("64M");
});
