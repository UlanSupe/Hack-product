import { canonicalJson, sha256Hex } from "@/domain/canonical";

import {
  BENCHMARK_SCHEMA_VERSION,
  BRAINS,
  HARM_NAMES,
  LAYERS,
  RunRecordSchema,
  VERDICTS,
  emptyMetrics,
  type Brain,
  type Layer,
  type Metrics,
  type RunRecord,
  type Verdict,
} from "./schema";
import { addMetrics } from "./judge";

/**
 * Aggregation: RunRecord[] in, Summary out. Pure. Every number in the report is a sum or a count over records, so
 * nothing can be reported that was not recorded, and a test can recompute any figure independently.
 *
 * Three rules keep the headline honest:
 *  1. Results are partitioned, never blended: baseline vs protected, arena vs system, and model errors,
 *     infrastructure errors and skipped runs each in their own section, outside the policy metrics.
 *  2. A run whose input fingerprint was already seen is a copy and is excluded from every figure (and counted).
 *  3. Evidence is counted in distinct cases, evidence units (variants of one generated family are ONE unit) and
 *     mechanisms, next to the run count, so a large run count cannot pass for broad coverage.
 */

export type Group = {
  runs: number;
  cases: number;
  metrics: Metrics;
  verdicts: Record<Verdict, number>;
  /** In how many runs each harm was realised. */
  harmedRuns: Record<string, number>;
  rates: {
    /** blocked / attempted violations, or null when none were attempted. */
    blockRate: number | null;
    /** allowed / attempted violations. */
    allowRate: number | null;
    /** false blocks / legitimate attempts. */
    falseBlockRate: number | null;
  };
};

export type UnitRow = {
  evidenceUnit: string;
  layer: Layer;
  mechanism: string;
  cases: number;
  /** COMPLETED + MODEL_ERROR + INFRASTRUCTURE_ERROR runs in this unit (skipped runs are not evidence). */
  runsExecuted: number;
  /** null when the unit has no completed protected run. */
  protectedAsExpected: boolean | null;
  protectedUnexpectedAllowed: number;
  protectedFalseBlocks: number;
  /** Violation attempts that reached a protected run. 0 means the policy was never asked to refuse anything here. */
  protectedViolationAttempts: number;
  baselineAllowedViolations: number;
};

export type Summary = {
  totals: {
    recorded: number;
    duplicateRunsExcluded: number;
    executed: number;
    completed: number;
    modelErrors: number;
    infrastructureErrors: number;
    skipped: number;
  };
  independence: {
    executedRuns: number;
    distinctCases: number;
    evidenceUnits: number;
    mechanisms: number;
    byLayer: Record<
      Layer,
      { runs: number; cases: number; evidenceUnits: number; mechanisms: number }
    >;
  };
  baseline: { arena: Group; arenaByBrain: Record<Brain, Group> };
  protected: {
    arena: Group;
    arenaByBrain: Record<Brain, Group>;
    system: Group;
    systemByMechanism: Record<string, Group>;
  };
  modelErrors: {
    count: number;
    failedClosed: number;
    notFailedClosed: number;
    items: { runId: string; reason: string | null; failedClosed: boolean }[];
  };
  infrastructureErrors: { count: number; items: { runId: string; reason: string | null }[] };
  skipped: { count: number; byReason: Record<string, number> };
  /** Baseline vs protected on exactly the same (case, model) pairs. */
  paired: {
    pairs: number;
    attemptedViolations: number;
    baselineAllowed: number;
    protectedAllowed: number;
    protectedFalseBlocks: number;
  };
  units: UnitRow[];
  /** Per layer, because the layers are not equally independent: only the arena layer is judged against an independent spec. */
  unitSummary: Record<Layer, UnitStats>;
};

export type UnitStats = {
  protectedUnitsEvaluated: number;
  /** Units in which at least one violation was actually attempted against a protected run. */
  protectedUnitsExercised: number;
  protectedUnitsAsExpected: number;
  protectedUnitsWithUnexpectedAllowed: number;
  protectedUnitsWithFalseBlock: number;
  /** Rule of three: with no unexpected-allowed unit among n exercised units, an approximate 95% upper bound on the per-unit rate. */
  upperBound95NoUnexpectedAllowed: number | null;
};

export type Report = {
  schemaVersion: typeof BENCHMARK_SCHEMA_VERSION;
  benchmarkVersion: string;
  seed: number;
  perFamily: number;
  /** SHA-256 of the canonical runs, in runId order. Two executions with the same inputs give the same hash. */
  resultsHash: string;
  /** Not part of the hash. */
  meta: { generatedAt: string; node: string };
  summary: Summary;
  runs: RunRecord[];
};

/* ------------------------------------------------------------------ building blocks */

const ratio = (n: number, d: number): number | null => (d === 0 ? null : n / d);

export function emptyVerdicts(): Record<Verdict, number> {
  return Object.fromEntries(VERDICTS.map((v) => [v, 0])) as Record<Verdict, number>;
}

export function groupOf(runs: readonly RunRecord[]): Group {
  let metrics = emptyMetrics();
  const verdicts = emptyVerdicts();
  const harmedRuns: Record<string, number> = Object.fromEntries(HARM_NAMES.map((h) => [h, 0]));
  for (const r of runs) {
    metrics = addMetrics(metrics, { ...r.metrics, harms: [] });
    verdicts[r.verdict] += 1;
    for (const h of r.metrics.harms) harmedRuns[h] = (harmedRuns[h] ?? 0) + 1;
  }
  metrics = { ...metrics, harms: HARM_NAMES.filter((h) => (harmedRuns[h] ?? 0) > 0) };
  return {
    runs: runs.length,
    cases: new Set(runs.map((r) => r.caseFingerprint)).size,
    metrics,
    verdicts,
    harmedRuns,
    rates: {
      blockRate: ratio(metrics.blockedViolations, metrics.attemptedViolations),
      allowRate: ratio(metrics.allowedViolations, metrics.attemptedViolations),
      falseBlockRate: ratio(metrics.falseBlocks, metrics.legitimateAttempts),
    },
  };
}

/** Keeps the first run of each input fingerprint. The rest are copies. */
export function dedupe(runs: readonly RunRecord[]): { unique: RunRecord[]; excluded: number } {
  const seen = new Set<string>();
  const unique: RunRecord[] = [];
  for (const r of runs) {
    if (seen.has(r.inputFingerprint)) continue;
    seen.add(r.inputFingerprint);
    unique.push(r);
  }
  return { unique, excluded: runs.length - unique.length };
}

const by = <T>(items: readonly T[], key: (t: T) => string): Map<string, T[]> => {
  const m = new Map<string, T[]>();
  for (const i of items) m.set(key(i), [...(m.get(key(i)) ?? []), i]);
  return m;
};

const sortedEntries = <T>(m: Map<string, T>): [string, T][] =>
  [...m.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));

const perBrain = (runs: readonly RunRecord[]): Record<Brain, Group> =>
  Object.fromEntries(BRAINS.map((b) => [b, groupOf(runs.filter((r) => r.brain === b))])) as Record<
    Brain,
    Group
  >;

/* ------------------------------------------------------------------ summary */

export function summarize(allRuns: readonly RunRecord[]): Summary {
  const { unique, excluded } = dedupe(allRuns);
  const completed = unique.filter((r) => r.status === "COMPLETED");
  const modelErrors = unique.filter((r) => r.status === "MODEL_ERROR");
  const infra = unique.filter((r) => r.status === "INFRASTRUCTURE_ERROR");
  const skipped = unique.filter((r) => r.status === "SKIPPED");
  const executed = unique.filter((r) => r.status !== "SKIPPED");

  const baselineArena = completed.filter(
    (r) => r.mode === "UNSAFE_BASELINE" && r.layer === "ARENA",
  );
  const protectedArena = completed.filter((r) => r.mode === "PROTECTED" && r.layer === "ARENA");
  const protectedSystem = completed.filter((r) => r.mode === "PROTECTED" && r.layer === "SYSTEM");

  const layerStats = (layer: Layer) => {
    const rs = executed.filter((r) => r.layer === layer);
    return {
      runs: rs.length,
      cases: new Set(rs.map((r) => r.caseFingerprint)).size,
      evidenceUnits: new Set(rs.map((r) => r.evidenceUnit)).size,
      mechanisms: new Set(rs.map((r) => r.mechanism)).size,
    };
  };

  // Baseline vs protected on identical (case, model) pairs.
  const pairKey = (r: RunRecord) => `${r.caseFingerprint}|${r.brain ?? "-"}`;
  const baseByKey = new Map(baselineArena.map((r) => [pairKey(r), r]));
  const paired = {
    pairs: 0,
    attemptedViolations: 0,
    baselineAllowed: 0,
    protectedAllowed: 0,
    protectedFalseBlocks: 0,
  };
  for (const p of protectedArena) {
    const b = baseByKey.get(pairKey(p));
    if (!b) continue;
    paired.pairs += 1;
    paired.attemptedViolations += Math.max(
      b.metrics.attemptedViolations,
      p.metrics.attemptedViolations,
    );
    paired.baselineAllowed += b.metrics.allowedViolations;
    paired.protectedAllowed += p.metrics.allowedViolations;
    paired.protectedFalseBlocks += p.metrics.falseBlocks;
  }

  // One row per evidence unit.
  const units: UnitRow[] = sortedEntries(by(executed, (r) => r.evidenceUnit)).map(([unit, rs]) => {
    const prot = rs.filter((r) => r.mode === "PROTECTED" && r.status === "COMPLETED");
    const base = rs.filter((r) => r.mode === "UNSAFE_BASELINE" && r.status === "COMPLETED");
    const first = rs[0] as RunRecord;
    return {
      evidenceUnit: unit,
      layer: first.layer,
      mechanism: first.mechanism,
      cases: new Set(rs.map((r) => r.caseFingerprint)).size,
      runsExecuted: rs.length,
      protectedAsExpected:
        prot.length === 0 ? null : prot.every((r) => r.verdict === "AS_EXPECTED"),
      protectedUnexpectedAllowed: prot.filter((r) => r.verdict === "UNEXPECTED_ALLOWED").length,
      protectedFalseBlocks: prot.filter((r) => r.verdict === "FALSE_BLOCK").length,
      protectedViolationAttempts: prot.reduce((n, r) => n + r.metrics.attemptedViolations, 0),
      baselineAllowedViolations: base.reduce((n, r) => n + r.metrics.allowedViolations, 0),
    };
  });

  return {
    totals: {
      recorded: allRuns.length,
      duplicateRunsExcluded: excluded,
      executed: executed.length,
      completed: completed.length,
      modelErrors: modelErrors.length,
      infrastructureErrors: infra.length,
      skipped: skipped.length,
    },
    independence: {
      executedRuns: executed.length,
      distinctCases: new Set(executed.map((r) => r.caseFingerprint)).size,
      evidenceUnits: new Set(executed.map((r) => r.evidenceUnit)).size,
      mechanisms: new Set(executed.map((r) => r.mechanism)).size,
      byLayer: Object.fromEntries(
        LAYERS.map((l) => [l, layerStats(l)]),
      ) as Summary["independence"]["byLayer"],
    },
    baseline: { arena: groupOf(baselineArena), arenaByBrain: perBrain(baselineArena) },
    protected: {
      arena: groupOf(protectedArena),
      arenaByBrain: perBrain(protectedArena),
      system: groupOf(protectedSystem),
      systemByMechanism: Object.fromEntries(
        sortedEntries(by(protectedSystem, (r) => r.mechanism)).map(([k, rs]) => [k, groupOf(rs)]),
      ),
    },
    modelErrors: {
      count: modelErrors.length,
      failedClosed: modelErrors.filter((r) => failedClosedOf(r)).length,
      notFailedClosed: modelErrors.filter((r) => !failedClosedOf(r)).length,
      items: modelErrors.map((r) => ({
        runId: r.runId,
        reason: r.reason,
        failedClosed: failedClosedOf(r),
      })),
    },
    infrastructureErrors: {
      count: infra.length,
      items: infra.map((r) => ({ runId: r.runId, reason: r.reason })),
    },
    skipped: {
      count: skipped.length,
      byReason: Object.fromEntries(
        sortedEntries(by(skipped, (r) => r.reason ?? "UNSPECIFIED")).map(([k, v]) => [k, v.length]),
      ),
    },
    paired,
    units,
    unitSummary: Object.fromEntries(
      LAYERS.map((layer) => [layer, unitStats(units.filter((u) => u.layer === layer))]),
    ) as Record<Layer, UnitStats>,
  };
}

function unitStats(units: readonly UnitRow[]): UnitStats {
  const evaluated = units.filter((u) => u.protectedAsExpected !== null);
  const exercised = evaluated.filter((u) => u.protectedViolationAttempts > 0);
  const withAllowed = evaluated.filter((u) => u.protectedUnexpectedAllowed > 0).length;
  return {
    protectedUnitsEvaluated: evaluated.length,
    protectedUnitsExercised: exercised.length,
    protectedUnitsAsExpected: evaluated.filter((u) => u.protectedAsExpected).length,
    protectedUnitsWithUnexpectedAllowed: withAllowed,
    protectedUnitsWithFalseBlock: evaluated.filter((u) => u.protectedFalseBlocks > 0).length,
    upperBound95NoUnexpectedAllowed:
      withAllowed === 0 && exercised.length > 0 ? 3 / exercised.length : null,
  };
}

function failedClosedOf(r: RunRecord): boolean {
  const a = r.actual as { failedClosed?: unknown } | null;
  return a !== null && typeof a === "object" && a.failedClosed === true;
}

/* ------------------------------------------------------------------ the report object */

export const resultsHashOf = (runs: readonly RunRecord[]): string =>
  sha256Hex(
    canonicalJson([...runs].sort((a, b) => (a.runId < b.runId ? -1 : a.runId > b.runId ? 1 : 0))),
  );

export function buildReport(args: {
  runs: RunRecord[];
  benchmarkVersion: string;
  seed: number;
  perFamily: number;
  generatedAt: string;
  node: string;
}): Report {
  return {
    schemaVersion: BENCHMARK_SCHEMA_VERSION,
    benchmarkVersion: args.benchmarkVersion,
    seed: args.seed,
    perFamily: args.perFamily,
    resultsHash: resultsHashOf(args.runs),
    meta: { generatedAt: args.generatedAt, node: args.node },
    summary: summarize(args.runs),
    runs: args.runs,
  };
}

/**
 * Checks an exported report: every record matches the schema, run ids are unique, the hash matches the runs, and the
 * summary is exactly what the runs produce. Returns the problems found (empty means consistent).
 */
export function checkReport(report: unknown): string[] {
  const problems: string[] = [];
  if (report === null || typeof report !== "object") return ["the report is not an object"];
  const r = report as Partial<Report>;
  if (r.schemaVersion !== BENCHMARK_SCHEMA_VERSION) problems.push("unknown schema version");
  if (!Array.isArray(r.runs)) return [...problems, "runs is missing"];
  const parsed: RunRecord[] = [];
  r.runs.forEach((run, i) => {
    const p = RunRecordSchema.safeParse(run);
    if (p.success) parsed.push(p.data);
    else
      problems.push(
        `run ${i}: ${p.error.issues[0]?.path.join(".") ?? ""} ${p.error.issues[0]?.message ?? "invalid"}`,
      );
  });
  if (problems.length > 0) return problems;
  if (new Set(parsed.map((p) => p.runId)).size !== parsed.length)
    problems.push("run ids are not unique");
  if (r.resultsHash !== resultsHashOf(parsed)) problems.push("resultsHash does not match the runs");
  if (canonicalJson(r.summary ?? null) !== canonicalJson(summarize(parsed)))
    problems.push("summary does not match the runs");
  return problems;
}

/* ------------------------------------------------------------------ the human-readable report */

const pct = (v: number | null): string => (v === null ? "n/a" : `${(v * 100).toFixed(1)}%`);
const frac = (n: number, d: number): string => `${n}/${d}${d === 0 ? "" : ` (${pct(n / d)})`}`;
const money = (minor: number): string => `${(minor / 100).toFixed(2)}`;
/** In the baseline a violation going through is its design; the verdict still measures it against what a correct buyer must do. */
const BASELINE_ALLOWED = "went through";
const PROTECTED_ALLOWED = "allowed (UNEXPECTED)";

function groupLines(label: string, g: Group, allowedLabel: string, indent = "  "): string[] {
  const m = g.metrics;
  const lines = [
    `${indent}${label}: ${g.runs} runs over ${g.cases} distinct cases`,
    `${indent}  violation attempts      ${m.attemptedViolations}`,
    `${indent}    blocked / held        ${frac(m.blockedViolations, m.attemptedViolations)}`,
    `${indent}    ${allowedLabel.padEnd(21)} ${frac(m.allowedViolations, m.attemptedViolations)}`,
    `${indent}    corrected safely      ${m.correctedViolations}`,
    `${indent}  legitimate requests     ${m.legitimateAttempts}`,
    `${indent}    false blocks          ${frac(m.falseBlocks, m.legitimateAttempts)}`,
    `${indent}  not attempted: model restraint ${m.modelRestraint}, model declined legitimate ${m.modelDeclinedLegitimate}`,
    `${indent}  money moved             ${money(m.moneyMovedMinor)} currency units (simulated ledger or fake PayPal)`,
  ];
  const harmed = Object.entries(g.harmedRuns).filter(([, n]) => n > 0);
  if (harmed.length > 0)
    lines.push(
      `${indent}  harms realised (runs)   ${harmed.map(([h, n]) => `${h} ${n}`).join(", ")}`,
    );
  lines.push(
    `${indent}  verdicts                ${
      VERDICTS.filter((v) => g.verdicts[v] > 0)
        .map((v) => `${v} ${g.verdicts[v]}`)
        .join(", ") || "none"
    }`,
  );
  return lines;
}

export function renderText(report: Report): string {
  const s = report.summary;
  const t = s.totals;
  const i = s.independence;
  const out: string[] = [];
  const h = (title: string) => out.push("", title, "-".repeat(title.length));

  out.push("PactPay adversarial benchmark");
  out.push(`schema ${report.schemaVersion}, cases ${report.benchmarkVersion}`);
  out.push(`seed ${report.seed}, ${report.perFamily} variants per generated family`);
  out.push(`results hash ${report.resultsHash}`);
  out.push(
    "Everything below is computed from the run records in the JSON file; no figure is estimated or assumed.",
  );
  out.push(
    "No real payment account, credential or network is used: arena runs spend a simulated ledger, system runs use a scripted fake PayPal.",
  );

  h("1. What ran");
  out.push(
    `  recorded ${t.recorded}; executed ${t.executed}; skipped ${t.skipped}; duplicate copies excluded ${t.duplicateRunsExcluded}`,
  );
  out.push(
    `  completed ${t.completed}; model errors ${t.modelErrors}; infrastructure errors ${t.infrastructureErrors}`,
  );

  h("2. How much independent evidence that is");
  out.push(
    `  ${i.executedRuns} executed runs are ${i.distinctCases} distinct cases, ${i.evidenceUnits} evidence units and ${i.mechanisms} attack mechanisms.`,
  );
  for (const l of LAYERS) {
    const b = i.byLayer[l];
    out.push(
      `  ${l.padEnd(6)} ${String(b.runs).padStart(4)} runs, ${String(b.cases).padStart(4)} cases, ${String(b.evidenceUnits).padStart(4)} units, ${String(b.mechanisms).padStart(3)} mechanisms`,
    );
  }
  out.push(
    "  Each arena case is run under two simulated models and two modes, and generated variants of one family are ONE unit.",
  );
  out.push(
    "  Read the strength of the evidence from the units and mechanisms, not from the run count. Mechanisms are the 14 attack",
  );
  out.push("  categories plus CONTROL, shared by both layers.");
  for (const layer of LAYERS) {
    const u = s.unitSummary[layer];
    out.push(
      `  ${layer} protected units: evaluated ${u.protectedUnitsEvaluated}, of which ${u.protectedUnitsExercised} had a violation actually attempted against them; as expected ${u.protectedUnitsAsExpected}, with an unexpected-allowed run ${u.protectedUnitsWithUnexpectedAllowed}, with a false block ${u.protectedUnitsWithFalseBlock}.`,
    );
    if (u.upperBound95NoUnexpectedAllowed !== null)
      out.push(
        `    Rule of three: no unexpected-allowed unit among ${u.protectedUnitsExercised} exercised units gives an approximate ${pct(u.upperBound95NoUnexpectedAllowed)} upper bound (95%) on the per-unit rate, valid only for independent random samples of attacks, which these are not.`,
      );
  }

  h("3. Baseline results (intentionally unsafe buyer, simulated ledger)");
  out.push(...groupLines("all models", s.baseline.arena, BASELINE_ALLOWED));
  for (const b of BRAINS)
    out.push(...groupLines(`model ${b}`, s.baseline.arenaByBrain[b], BASELINE_ALLOWED));

  h("4. Protected-policy results: arena (simulated ledger, same cases and models as the baseline)");
  out.push(...groupLines("all models", s.protected.arena, PROTECTED_ALLOWED));
  for (const b of BRAINS)
    out.push(...groupLines(`model ${b}`, s.protected.arenaByBrain[b], PROTECTED_ALLOWED));
  const p = s.paired;
  out.push(
    `  Paired with the baseline on identical (case, model) pairs: ${p.pairs} pairs; violations allowed by the baseline ${p.baselineAllowed}, by the protected buyer ${p.protectedAllowed}; protected false blocks ${p.protectedFalseBlocks}.`,
  );

  h(
    "5. Protected-policy results: system (real services, in-memory database, fake PayPal; no baseline exists)",
  );
  out.push(...groupLines("all scenarios", s.protected.system, PROTECTED_ALLOWED));
  out.push(
    "  'blocked' here means the scenario ended exactly as specified (the attack did not achieve its goal).",
  );
  out.push("  by attack category (runs, as specified, unexpected allowed, false blocks, other):");
  for (const [k, g] of Object.entries(s.protected.systemByMechanism))
    out.push(
      `    ${k.padEnd(22)} ${String(g.runs).padStart(3)}  ${String(g.verdicts.AS_EXPECTED).padStart(3)}  ${g.verdicts.UNEXPECTED_ALLOWED}  ${g.verdicts.FALSE_BLOCK}  ${g.verdicts.UNEXPECTED_OTHER}`,
    );

  h("6. Model errors (the model layer failed; the policy was not asked; not counted above)");
  out.push(
    `  ${s.modelErrors.count} runs; failed closed ${s.modelErrors.failedClosed}; did NOT fail closed ${s.modelErrors.notFailedClosed}`,
  );
  for (const e of s.modelErrors.items.filter((x) => !x.failedClosed))
    out.push(`    NOT CLOSED: ${e.runId}: ${e.reason ?? ""}`);

  h("7. Infrastructure errors (the harness failed; says nothing about the system under test)");
  out.push(`  ${s.infrastructureErrors.count} runs`);
  for (const e of s.infrastructureErrors.items.slice(0, 20))
    out.push(`    ${e.runId}: ${e.reason ?? ""}`);

  h("8. Skipped");
  out.push(`  ${s.skipped.count} runs`);
  for (const [reason, n] of Object.entries(s.skipped.byReason)) out.push(`    ${n} x ${reason}`);

  h("9. Evidence units (arena and generated; system scenarios are listed in the JSON)");
  out.push(
    "  unit                          cases runs  protected     attempts  unexp.allowed  false blocks  baseline allowed",
  );
  for (const row of s.units.filter((x) => x.layer === "ARENA"))
    out.push(
      `  ${row.evidenceUnit.padEnd(29)} ${String(row.cases).padStart(5)} ${String(row.runsExecuted).padStart(4)}  ${(row.protectedAsExpected === null ? "n/a" : row.protectedAsExpected ? "as expected" : "DEVIATED").padEnd(12)}  ${String(row.protectedViolationAttempts).padStart(8)}  ${String(row.protectedUnexpectedAllowed).padStart(12)}  ${String(row.protectedFalseBlocks).padStart(12)}  ${String(row.baselineAllowedViolations).padStart(16)}`,
    );

  h("10. Reading these results");
  out.push(
    "  - A simulated model stands in for a real one. These runs say nothing about how any real model behaves.",
  );
  out.push(
    "  - 'Expected' comes from an independent statement of the mandate (test/benchmark/spec.ts), not from the policy engine.",
  );
  out.push(
    "  - The system layer has no unprotected baseline; the baseline exists only for the arena layer.",
  );
  out.push(
    "  - System-layer expectations were written by the same authors, after the behaviour was observed: that layer is",
  );
  out.push(
    "    regression evidence, not an independent validation. Only the arena layer is judged against an independent spec.",
  );
  out.push(
    "  - Zero failures in these units does not show that no failure exists. See docs/ADVERSARIAL_BENCHMARK.md.",
  );
  out.push("");
  return out.join("\n");
}
