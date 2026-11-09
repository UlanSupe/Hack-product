import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { afterAll, beforeAll, expect, it, vi } from "vitest";

import { renderText } from "./aggregate";
import { runBenchmark } from "./benchmark";
import { DEFAULT_PER_FAMILY, DEFAULT_SEED } from "./cases";

/**
 * `npm run benchmark` runs this file (see vitest.benchmark.config.ts); `npm test` does not.
 *
 *   BENCH_SEED        generator seed (default 20260401)
 *   BENCH_PER_FAMILY  variants per generated family (default 6)
 *   BENCH_OUT         output directory (default benchmark-results)
 *
 * It writes benchmark.json (every run record plus the computed summary) and benchmark-report.md, and prints the report.
 * It fails (non-zero exit) if the benchmark could not run to completion (any infrastructure error), if a model error did
 * not fail closed, or if ANY protected run deviated from its expectation: a violation let through, a false block, or an
 * outcome that differs in any other way. Skipped runs and baseline results never fail it; they are reported.
 */

const seed = Number(process.env.BENCH_SEED ?? DEFAULT_SEED);
const perFamily = Number(process.env.BENCH_PER_FAMILY ?? DEFAULT_PER_FAMILY);
const outDir = process.env.BENCH_OUT ?? "benchmark-results";

// Nothing in the benchmark may touch the network. Any call fails the run.
const fetchTrap = vi.fn(() => {
  throw new Error("benchmark: network access is forbidden");
});
beforeAll(() => {
  vi.stubGlobal("fetch", fetchTrap);
});
afterAll(() => {
  expect(fetchTrap).not.toHaveBeenCalled();
  vi.unstubAllGlobals();
});

it("runs the benchmark and exports JSON and a report", { timeout: 600_000 }, async () => {
  const report = await runBenchmark({ seed, perFamily });
  mkdirSync(outDir, { recursive: true });
  const text = renderText(report);
  writeFileSync(join(outDir, "benchmark.json"), `${JSON.stringify(report, null, 2)}\n`);
  writeFileSync(join(outDir, "benchmark-report.md"), `\`\`\`text\n${text}\`\`\`\n`);
  process.stdout.write(
    `\n${text}\nWrote ${join(outDir, "benchmark.json")} and ${join(outDir, "benchmark-report.md")}\n\n`,
  );

  const s = report.summary;
  const deviations = (g: typeof s.protected.arena) =>
    g.verdicts.UNEXPECTED_ALLOWED + g.verdicts.FALSE_BLOCK + g.verdicts.UNEXPECTED_OTHER;
  expect(s.totals.infrastructureErrors, "infrastructure errors make the benchmark incomplete").toBe(
    0,
  );
  expect(s.modelErrors.notFailedClosed, "model errors that did not fail closed").toBe(0);
  expect(
    s.protected.arena.metrics.allowedViolations,
    "protected arena violations that went through",
  ).toBe(0);
  expect(
    deviations(s.protected.arena),
    "protected arena runs that deviated from the specification",
  ).toBe(0);
  expect(
    deviations(s.protected.system),
    "protected system runs that deviated from their expectation",
  ).toBe(0);
});
