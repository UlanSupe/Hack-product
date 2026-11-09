import { fileURLToPath } from "node:url";

import { defineConfig } from "vitest/config";

const r = (p: string) => fileURLToPath(new URL(p, import.meta.url));

// Same aliases as vitest.config.ts, but it runs only the benchmark entry point, which `npm test` never includes.
export default defineConfig({
  resolve: {
    alias: {
      "@": r("./src"),
      "server-only": r("./test/stubs/server-only.ts"),
    },
  },
  test: {
    environment: "node",
    include: ["test/benchmark/run.benchmark.ts"],
    reporters: ["dot"],
  },
});
