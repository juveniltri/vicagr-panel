import { defineConfig, devices } from "@playwright/test";

// End-to-end suite against the production stack running in Docker on this
// machine (`npm run test:e2e`). It deploys real containers, so the tests run
// one at a time and share the stack. Needs Docker and ports 80, 443 and 5434.
export default defineConfig({
  testDir: "e2e",
  globalSetup: "./e2e/preparar.ts",
  globalTeardown: "./e2e/limpiar.ts",
  fullyParallel: false,
  workers: 1,
  // Deploys pull images and the fall alert takes two checks one minute apart.
  timeout: 8 * 60_000,
  expect: { timeout: 15_000 },
  reporter: [["list"], ["html", { open: "never" }]],
  use: {
    baseURL: "https://localhost",
    ignoreHTTPSErrors: true,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    ...devices["Desktop Chrome"],
  },
});
