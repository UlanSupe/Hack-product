import { existsSync, readFileSync, statSync } from "node:fs";

import type { BenchmarkFileRead } from "../../ports/cockpit-source.ts";

/** Largest benchmark file the Cockpit will read (the default benchmark writes under 1 MB). */
export const MAX_BENCHMARK_BYTES = 20 * 1024 * 1024;

/** Reads the persisted benchmark file. Never writes, never creates it, and never returns a path in an error message. */
export function readBenchmarkFile(path: string): BenchmarkFileRead {
  try {
    if (!existsSync(path)) return { kind: "MISSING" };
    const size = statSync(path).size;
    if (size > MAX_BENCHMARK_BYTES)
      return { kind: "ERROR", message: "benchmark.json is larger than the Cockpit will read." };
    return { kind: "TEXT", text: readFileSync(path, "utf8") };
  } catch {
    return { kind: "ERROR", message: "benchmark.json could not be read." };
  }
}
