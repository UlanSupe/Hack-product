import { fileURLToPath } from "node:url";

import { defineConfig } from "vitest/config";

const r = (p: string) => fileURLToPath(new URL(p, import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      "@": r("./src"),
      // `server-only` throws outside a React Server build; tests run in plain Node.
      "server-only": r("./test/stubs/server-only.ts"),
    },
  },
  test: {
    environment: "node",
    include: ["src/**/*.test.{ts,tsx}", "test/**/*.test.{ts,tsx}"],
    // `npm run test:coverage`: the logic (domain, application, adapters, config, server) - not the React pages, which the
    // tests render but do not exercise interactively; those are covered by the Playwright suite instead.
    coverage: {
      provider: "v8",
      include: ["src/**"],
      exclude: ["src/**/*.test.ts", "src/app/**"],
      reporter: ["text-summary", "json-summary"],
    },
  },
});
