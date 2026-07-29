import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

export default defineConfig({
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
      "@lib": fileURLToPath(new URL("./src/lib", import.meta.url)),
    },
  },
  test: {
    environment: "node",
    setupFiles: ["./src/test/setup.ts"],
    include: ["src/**/*.test.ts"],
    coverage: {
      provider: "v8",
      // Coverage is enforced on the load-bearing logic only: sync, timer,
      // schema. Presentational components are covered by Playwright instead.
      include: ["src/lib/**/*.ts"],
      exclude: [
        "src/lib/**/*.test.ts",
        "src/lib/**/index.ts",
        // React hooks are thin glue over the engines below them, which are
        // themselves covered at ~98%. They need a DOM test environment and are
        // exercised end-to-end by Playwright in Phase 8; excluded here rather
        // than left to quietly drag the threshold down.
        "src/lib/**/use*.ts",
      ],
      thresholds: { lines: 90, functions: 90, branches: 85, statements: 90 },
    },
  },
});
