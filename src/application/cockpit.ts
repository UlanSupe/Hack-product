import { projectRuns, type AnalyticsRun } from "../domain/analytics.ts";
import {
  defaultSort,
  detailOfAttackRun,
  detailOfBenchmarkRun,
  detailOfRefused,
  detailOfTransaction,
  mapAttackRun,
  mapBenchmark,
  mapBenchmarkRun,
  mapRefusedOffer,
  mapTransaction,
  parseBenchmarkFile,
  type CockpitDetail,
  type CockpitRow,
  type SourceStatus,
} from "../domain/cockpit.ts";
import type { BenchmarkFileRead, BenchmarkResult, LiveResult } from "../ports/cockpit-source.ts";

/**
 * The Cockpit use cases: turn what the sources returned into grid rows, source statuses and row details. Pure; the
 * composition root (src/server/cockpit.ts) does the reading. A source that cannot be read becomes a status the page
 * shows, never a silently empty grid and never made-up rows.
 */

export type CockpitInput = { live: LiveResult; benchmark: BenchmarkResult };

export type CockpitData = {
  rows: CockpitRow[];
  /** Every persisted benchmark run, compact, for the analytics (empty when there is no readable benchmark). */
  runs: AnalyticsRun[];
  sources: { database: SourceStatus; benchmark: SourceStatus };
};

/** Parses and integrity-checks a benchmark file read from disk. */
export function benchmarkResultFromRead(read: BenchmarkFileRead): BenchmarkResult {
  if (read.kind === "MISSING")
    return {
      state: "MISSING",
      message:
        "No benchmark has been run yet. Run `npm run benchmark` to create benchmark-results/benchmark.json.",
    };
  if (read.kind === "ERROR") return { state: "ERROR", message: read.message };
  const parsed = parseBenchmarkFile(read.text);
  return parsed.ok
    ? { state: "OK", file: parsed.file }
    : { state: "ERROR", message: parsed.message };
}

export function buildCockpit(input: CockpitInput): CockpitData {
  const rows: CockpitRow[] = [];
  let database: SourceStatus;
  if (input.live.state === "OK") {
    const f = input.live.facts;
    rows.push(
      ...f.transactions.map((t) => mapTransaction(t, f.chain)),
      ...f.refusedOffers.map((r) => mapRefusedOffer(r, f.chain)),
      ...f.attackRuns.map((a) => mapAttackRun(a, f.chain)),
    );
    database = {
      source: "DATABASE",
      state: "OK",
      rows: f.transactions.length + f.refusedOffers.length + f.attackRuns.length,
      note:
        f.chain.status === "VERIFIED"
          ? `Audit chain verifies (${f.chain.count} events).`
          : f.chain.status === "FAILED"
            ? `Audit chain FAILS at event #${f.chain.firstBadSeq} (${f.chain.code}).`
            : `Audit chain could not be read: ${f.chain.message}`,
    };
  } else database = { source: "DATABASE", state: input.live.state, message: input.live.message };

  let benchmark: SourceStatus;
  let runs: AnalyticsRun[] = [];
  if (input.benchmark.state === "OK") {
    const file = input.benchmark.file;
    rows.push(...mapBenchmark(file));
    runs = projectRuns(file.runs);
    benchmark = {
      source: "BENCHMARK",
      state: "OK",
      rows: file.runs.length,
      generatedAt: file.generatedAt,
      resultsHash: file.resultsHash,
      seed: file.seed,
    };
  } else
    benchmark = {
      source: "BENCHMARK",
      state: input.benchmark.state,
      message: input.benchmark.message,
    };

  return { rows: defaultSort(rows), runs, sources: { database, benchmark } };
}

/** The detail of one row, or undefined if its source is not readable or has no such row. */
export function findDetail(input: CockpitInput, id: string): CockpitDetail | undefined {
  if (id.startsWith("bench:") && input.benchmark.state === "OK") {
    const file = input.benchmark.file;
    const run = file.runs.find((r) => `bench:${r.runId}` === id);
    return run ? detailOfBenchmarkRun(run, mapBenchmarkRun(run, file), file) : undefined;
  }
  if (input.live.state !== "OK") return undefined;
  const f = input.live.facts;
  if (id.startsWith("tx:")) {
    const t = f.transactions.find((x) => `tx:${x.txId}` === id);
    return t ? detailOfTransaction(t, mapTransaction(t, f.chain), f.chain) : undefined;
  }
  if (id.startsWith("refused:")) {
    const r = f.refusedOffers.find((x) => `refused:${x.checkId}` === id);
    return r ? detailOfRefused(r, mapRefusedOffer(r, f.chain), f.chain) : undefined;
  }
  if (id.startsWith("run:")) {
    const a = f.attackRuns.find((x) => `run:${x.id}` === id);
    return a ? detailOfAttackRun(a, mapAttackRun(a, f.chain)) : undefined;
  }
  return undefined;
}
