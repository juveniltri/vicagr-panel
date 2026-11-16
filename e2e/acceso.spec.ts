import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";
import { abrir, alerta, entrar } from "./ayudas";
import { BASE, USUARIO } from "./entorno";

test("una contraseña incorrecta no entra y lo dice", async ({ page }) => {
  await abrir(page, "/login");
  await page.getByLabel("Email").fill(USUARIO.email);
  await page.getByLabel("Contraseña").fill("no-es-la-contraseña");
  await page.getByRole("button", { name: "Entrar" }).click();

  await expect(alerta(page)).toHaveText("Credenciales incorrectas");
  await expect(page).toHaveURL(/\/login/);
});

test("sin sesión, las páginas del Panel llevan al login", async ({ page }) => {
  await abrir(page, "/proyectos");

  await expect(page).toHaveURL(/\/login/);
});

test("el health check sin sesión solo dice si está bien", async ({
  request,
}) => {
  const res = await request.get("/api/health");

  expect(Object.keys(await res.json())).toEqual(["status"]);
});

test.describe("con sesión", () => {
  test.describe.configure({ mode: "serial" });
  // One login for the whole block: the login limits attempts per account.
  let page: Page;

  test.beforeAll(async ({ browser }) => {
    // axe needs a page from an explicit context.
    page = await (await browser.newContext()).newPage();
    await entrar(page);
  });

  test.afterAll(async () => {
    await page.close();
  });

  test("entra al Dashboard", async () => {
    await expect(page).toHaveURL(/\/$/);
    await expect(page.getByRole("main")).toBeVisible();
  });

  // Serious and critical only, every page checked even if one fails.
  test("accesibilidad de las páginas principales", async () => {
    for (const ruta of ["/", "/proyectos", "/configuracion", "/usuarios"]) {
      await abrir(page, ruta);
      await page.waitForLoadState("networkidle");
      const { violations } = await new AxeBuilder({ page }).analyze();
      const graves = violations
        .filter((v) => v.impact === "serious" || v.impact === "critical")
        .flatMap((v) =>
          v.nodes.map(
            (n) => `${v.id} ${n.target.join(" ")}: ${n.failureSummary}`,
          ),
        );
      expect.soft(graves, ruta).toEqual([]);
    }
  });

  test("la CSP solo deja scripts propios y con nonce, y nada la incumple", async () => {
    const violaciones: string[] = [];
    page.on("console", (m) => {
      if (m.text().includes("Content Security Policy"))
        violaciones.push(m.text());
    });
    for (const ruta of ["/", "/proyectos", "/configuracion", "/novedades"]) {
      const res = await page.goto(BASE + ruta);
      const csp = res?.headers()["content-security-policy"] ?? "";
      expect(csp, ruta).toMatch(/script-src 'self' 'nonce-[^']+'(;|$)/);
      await page.waitForLoadState("networkidle");
    }
    expect(violaciones).toEqual([]);
  });
});
