import { buildReport, checkReport, type Report } from "./aggregate";
import {
  BENCHMARK_VERSION,
  DEFAULT_PER_FAMILY,
  DEFAULT_SEED,
  buildCases,
  duplicateMap,
  type BenchmarkCase,
} from "./cases";
import { runArenaCase, runSystemCase } from "./execute";
import type { RunRecord } from "./schema";

/**
 * Runs the benchmark: builds the cases from an explicit seed, executes every one (arena cases synchronously, system
 * scenarios through the real services), and returns the report. Deterministic: the same (seed, perFamily, cases)
 * always give the same `resultsHash`. Only `meta.generatedAt` varies, and it is not hashed.
 */
export async function runBenchmark(
  options: { seed?: number; perFamily?: number; cases?: readonly BenchmarkCase[] } = {},
): Promise<Report> {
  const seed = options.seed ?? DEFAULT_SEED;
  const perFamily = options.perFamily ?? DEFAULT_PER_FAMILY;
  const cases = options.cases ?? buildCases(seed, perFamily);
  const dup = duplicateMap(cases);

  const runs: RunRecord[] = [];
  for (const c of cases) {
    const duplicateOf = dup.get(c.caseId) ?? null;
    if (c.layer === "ARENA") runs.push(...runArenaCase(c, duplicateOf));
    else runs.push(...(await runSystemCase(c, duplicateOf)));
  }

  const report = buildReport({
    runs,
    benchmarkVersion: BENCHMARK_VERSION,
    seed,
    perFamily,
    generatedAt: new Date().toISOString(),
    node: process.version,
  });
  const problems = checkReport(report);
  if (problems.length > 0)
    throw new Error(`the benchmark produced an inconsistent report: ${problems.join("; ")}`);
  return report;
}
