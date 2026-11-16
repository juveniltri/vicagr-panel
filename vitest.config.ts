import { configDefaults, defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    tsconfigPaths: true,
  },
  test: {
    globals: true,
    environment: "node",
    // e2e/ is Playwright's (`npm run test:e2e`), not Vitest's.
    exclude: [...configDefaults.exclude, "e2e/**"],
    setupFiles: ["./src/test/setup.ts"],
    coverage: {
      provider: "v8",
      reporter: ["text", "json", "html", "lcov"],
      reportsDirectory: "./coverage",
      exclude: [
        "node_modules/**",
        "dist/**",
        ".next/**",
        "coverage/**",
        "**/*.config.*",
        "**/*.d.ts",
        "**/test/**",
        // Infrastructure tier
        "src/app/**",
        "src/db/**",
        "src/env.ts",
        "src/styles/**",
        // Lib infrastructure (configuración, sin lógica de negocio)
        "src/lib/prisma.ts",
        "src/lib/auth.ts",
        "src/lib/sentry.ts",
        "src/lib/logger.ts",
        // Infrastructure tier (regla 100/80/0)
        "src/lib/docker/**",
        // Server infrastructure
        "src/server/trpc.ts",
        "src/server/caller.ts",
        "src/server/routers/_app.ts",
      ],
      thresholds: {
        // Core — 100%
        "src/server/routers/**": {
          branches: 100,
          functions: 100,
          lines: 100,
          statements: 100,
        },
        // Toda src/lib salvo src/lib/docker (Infrastructure, excluida arriba).
        "src/lib/**": {
          branches: 100,
          functions: 100,
          lines: 100,
          statements: 100,
        },
        // Important — 80%
        "src/components/**": {
          branches: 80,
          functions: 80,
          lines: 80,
          statements: 80,
        },
        "src/hooks/**": {
          branches: 80,
          functions: 80,
          lines: 80,
          statements: 80,
        },
      },
    },
  },
});
