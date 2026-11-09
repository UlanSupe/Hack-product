import {
  AUDIT_STATES,
  SOURCES,
  SOURCE_LABEL,
  type AuditState,
  type BenchmarkRun,
  type BuyerModeName,
  type CockpitRow,
  type CockpitSource,
} from "./cockpit.ts";

/**
 * Benchmark analytics for the Cockpit. Pure: records in, figures out. Every figure is a count over stored records, and
 * every ratio is returned as a `Share` ({ n, d }) so the denominator is never hidden or recomputed by the screen.
 *
 * Rules that keep the figures honest (docs/COCKPIT.md section 8):
 *  1. A run whose input fingerprint appeared earlier in the file is a COPY: excluded from every figure and counted.
 *  2. Only COMPLETED runs contribute to policy figures. Model errors and infrastructure errors are counted beside them
 *     and say nothing about the policy; skipped runs are counted with their reasons and are not evidence at all.
 *  3. Baseline and protected results, and the two layers (arena simulation, system services), are never added together.
 *  4. Payment states and audit states are counted per source, so simulated benchmark rows never inflate real ones.
 *  5. A category in which no violation was attempted has no block rate (null), not 0% and not 100%.
 */

/** A ratio with its denominator. `d` is 0 when there was nothing to divide by; callers must show that, not a percentage. */
export type Share = { n: number; d: number };

export const share = (n: number, d: number): Share => ({ n, d });

/** "58 of 58 (100.0%)", or "n/a (0 attempted)" when the denominator is zero. */
export function shareText(s: Share, what = "attempted"): string {
  if (s.d === 0) return `n/a (0 ${what})`;
  const tenths = Math.round((s.n * 1000) / s.d);
  return `${s.n} of ${s.d} (${Math.floor(tenths / 10)}.${tenths % 10}%)`;
}

/* ------------------------------------------------------------------ the compact run record the analytics read */

export type AnalyticsRun = {
  runId: string;
  layer: "ARENA" | "SYSTEM";
  caseId: string;
  mechanism: string;
  mode: BuyerModeName;
  brain: string | null;
  status: "COMPLETED" | "MODEL_ERROR" | "INFRASTRUCTURE_ERROR" | "SKIPPED";
  verdict: string;
  reason: string | null;
  /** True when an earlier run in the whole file has the same input fingerprint. Decided on the full file, not the view. */
  copy: boolean;
  attempted: number;
  blocked: number;
  allowed: number;
  corrected: number;
  legitimate: number;
  falseBlocks: number;
  modelRestraint: number;
  /** Money that moved on a simulated ledger or a fake PayPal, in minor units of the scenario's own currency. */
  movedMinor: number;
};

/** Projects the persisted runs (file order) and marks copies. */
export function projectRuns(runs: readonly BenchmarkRun[]): AnalyticsRun[] {
  const seen = new Set<string>();
  return runs.map((r) => {
    const copy = seen.has(r.inputFingerprint);
    seen.add(r.inputFingerprint);
    return {
      runId: r.runId,
      layer: r.layer,
      caseId: r.caseId,
      mechanism: r.mechanism,
      mode: r.mode,
      brain: r.brain,
      status: r.status,
      verdict: r.verdict,
      reason: r.reason,
      copy,
      attempted: r.metrics.attemptedViolations,
      blocked: r.metrics.blockedViolations,
      allowed: r.metrics.allowedViolations,
      corrected: r.metrics.correctedViolations,
      legitimate: r.metrics.legitimateAttempts,
      falseBlocks: r.metrics.falseBlocks,
      modelRestraint: r.metrics.modelRestraint,
      movedMinor: r.metrics.moneyMovedMinor,
    };
  });
}

/* ------------------------------------------------------------------ outputs */

export type Scope = {
  /** Benchmark rows in the current view, before anything is excluded. */
  inView: number;
  copies: number;
  /** Requested but not executable: not evidence. */
  skipped: number;
  skipReasons: { reason: string; n: number }[];
  /** completed + modelErrors + infrastructureErrors. */
  executed: number;
  completed: number;
  modelErrors: number;
  infrastructureErrors: number;
};

export type Counts = {
  completedRuns: number;
  attempted: number;
  blocked: number;
  allowed: number;
  corrected: number;
  legitimate: number;
  falseBlocks: number;
  modelRestraint: number;
  movedMinor: number;
  asExpected: number;
  unexpectedAllowedRuns: number;
  falseBlockRuns: number;
  unexpectedOtherRuns: number;
};

const zeroCounts = (): Counts => ({
  completedRuns: 0,
  attempted: 0,
  blocked: 0,
  allowed: 0,
  corrected: 0,
  legitimate: 0,
  falseBlocks: 0,
  modelRestraint: 0,
  movedMinor: 0,
  asExpected: 0,
  unexpectedAllowedRuns: 0,
  falseBlockRuns: 0,
  unexpectedOtherRuns: 0,
});

function add(c: Counts, r: AnalyticsRun): void {
  c.completedRuns += 1;
  c.attempted += r.attempted;
  c.blocked += r.blocked;
  c.allowed += r.allowed;
  c.corrected += r.corrected;
  c.legitimate += r.legitimate;
  c.falseBlocks += r.falseBlocks;
  c.modelRestraint += r.modelRestraint;
  c.movedMinor += r.movedMinor;
  if (r.verdict === "AS_EXPECTED") c.asExpected += 1;
  else if (r.verdict === "UNEXPECTED_ALLOWED") c.unexpectedAllowedRuns += 1;
  else if (r.verdict === "FALSE_BLOCK") c.falseBlockRuns += 1;
  else if (r.verdict === "UNEXPECTED_OTHER") c.unexpectedOtherRuns += 1;
}

export type CategoryRow = Counts & {
  layer: AnalyticsRun["layer"];
  mechanism: string;
  mode: BuyerModeName;
  /** blocked / attempted, or { n: 0, d: 0 } when no violation was attempted in this category. */
  blockRate: Share;
};

export type LayerOutcome = Counts & {
  layer: AnalyticsRun["layer"];
  /** attempted === blocked + allowed + corrected. False means the records do not reconcile; the screen must say so. */
  reconciles: boolean;
  blockRate: Share;
  /** Protected runs whose verdict was UNEXPECTED_ALLOWED, so each can be opened and inspected. */
  unexpectedAllowed: { runId: string; caseId: string; mechanism: string }[];
};

export type PairStats = {
  pairs: number;
  attempted: number;
  baselineAllowed: number;
  protectedAllowed: number;
  protectedFalseBlocks: number;
  baselineMovedMinor: number;
  protectedMovedMinor: number;
};

export type Comparison = {
  /** Arena runs only: the system layer has no unprotected counterpart, so it cannot be compared. */
  paired: PairStats;
  byBrain: { brain: string; stats: PairStats }[];
  /** Completed arena runs in view with no completed partner in the other mode (and why not, in counts). */
  unpaired: { baselineOnly: number; protectedOnly: number };
  /** Protected system-layer runs in view that have no baseline analogue (always protected-only). */
  systemProtectedRuns: number;
};

export type Distribution = {
  source: CockpitSource;
  label: string;
  rows: number;
  /** Sorted by count (descending), then name. */
  counts: { value: string; n: number }[];
};

export type Analytics = {
  scope: Scope;
  byCategory: CategoryRow[];
  protectedOutcomes: LayerOutcome[];
  comparison: Comparison;
  /** Per source, never blended: real database rows and simulated benchmark rows are separate lines. */
  paymentStates: Distribution[];
  auditChain: (Distribution & { counts: { value: AuditState; n: number }[] })[];
};

const sortKey = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
const rateOf = (c: Counts): Share => share(c.blocked, c.attempted);

/** The run id behind a benchmark row (a database row has none). */
const benchmarkIds = (rows: readonly CockpitRow[]): Set<string> =>
  new Set(rows.filter((r) => r.source === "BENCHMARK").map((r) => r.refId));

function pairStats(pairs: { baseline: AnalyticsRun; protected: AnalyticsRun }[]): PairStats {
  const s: PairStats = {
    pairs: pairs.length,
    attempted: 0,
    baselineAllowed: 0,
    protectedAllowed: 0,
    protectedFalseBlocks: 0,
    baselineMovedMinor: 0,
    protectedMovedMinor: 0,
  };
  for (const p of pairs) {
    s.attempted += p.baseline.attempted;
    s.baselineAllowed += p.baseline.allowed;
    s.protectedAllowed += p.protected.allowed;
    s.protectedFalseBlocks += p.protected.falseBlocks;
    s.baselineMovedMinor += p.baseline.movedMinor;
    s.protectedMovedMinor += p.protected.movedMinor;
  }
  return s;
}

function distribution(
  rows: readonly CockpitRow[],
  source: CockpitSource,
  pick: (r: CockpitRow) => string,
) {
  const m = new Map<string, number>();
  let n = 0;
  for (const r of rows) {
    if (r.source !== source) continue;
    n += 1;
    m.set(pick(r), (m.get(pick(r)) ?? 0) + 1);
  }
  const counts = [...m.entries()]
    .map(([value, count]) => ({ value, n: count }))
    .sort((a, b) => b.n - a.n || sortKey(a.value, b.value));
  return { source, label: SOURCE_LABEL[source], rows: n, counts };
}

/**
 * The analytics for the rows in view. `rows` are the (already filtered) Cockpit rows, so the same date, scenario,
 * transaction and outcome filters that narrow the grid narrow every figure here. `runs` are all the persisted benchmark
 * runs; only those whose row is in view are counted.
 */
export function computeAnalytics(
  rows: readonly CockpitRow[],
  runs: readonly AnalyticsRun[],
): Analytics {
  const ids = benchmarkIds(rows);
  const inView = runs.filter((r) => ids.has(r.runId));
  const fresh = inView.filter((r) => !r.copy);
  const completed = fresh.filter((r) => r.status === "COMPLETED");
  const skipped = fresh.filter((r) => r.status === "SKIPPED");

  const reasons = new Map<string, number>();
  for (const r of skipped) {
    const key = (r.reason ?? "NO_REASON_RECORDED").split(":")[0] ?? "NO_REASON_RECORDED";
    reasons.set(key, (reasons.get(key) ?? 0) + 1);
  }
  const modelErrors = fresh.filter((r) => r.status === "MODEL_ERROR").length;
  const infra = fresh.filter((r) => r.status === "INFRASTRUCTURE_ERROR").length;
  const scope: Scope = {
    inView: inView.length,
    copies: inView.length - fresh.length,
    skipped: skipped.length,
    skipReasons: [...reasons.entries()]
      .map(([reason, n]) => ({ reason, n }))
      .sort((a, b) => b.n - a.n || sortKey(a.reason, b.reason)),
    executed: completed.length + modelErrors + infra,
    completed: completed.length,
    modelErrors,
    infrastructureErrors: infra,
  };

  // 1. outcomes by attack category, per layer and buyer mode
  const cat = new Map<string, CategoryRow>();
  for (const r of completed) {
    const key = `${r.layer}|${r.mechanism}|${r.mode}`;
    let row = cat.get(key);
    if (!row) {
      row = {
        ...zeroCounts(),
        layer: r.layer,
        mechanism: r.mechanism,
        mode: r.mode,
        blockRate: share(0, 0),
      };
      cat.set(key, row);
    }
    add(row, r);
  }
  const byCategory = [...cat.values()]
    .map((c) => ({ ...c, blockRate: rateOf(c) }))
    .sort(
      (a, b) =>
        sortKey(a.layer, b.layer) || sortKey(a.mechanism, b.mechanism) || sortKey(a.mode, b.mode),
    );

  // 2. protected: blocked versus unexpectedly allowed, per layer
  const protectedOutcomes: LayerOutcome[] = (["ARENA", "SYSTEM"] as const).map((layer) => {
    const mine = completed.filter((r) => r.layer === layer && r.mode === "PROTECTED");
    const c = zeroCounts();
    for (const r of mine) add(c, r);
    return {
      ...c,
      layer,
      reconciles: c.attempted === c.blocked + c.allowed + c.corrected,
      blockRate: rateOf(c),
      unexpectedAllowed: mine
        .filter((r) => r.verdict === "UNEXPECTED_ALLOWED")
        .map((r) => ({ runId: r.runId, caseId: r.caseId, mechanism: r.mechanism })),
    };
  });

  // 3. baseline versus protected, on the same (case, model) pairs, arena layer only
  const arena = completed.filter((r) => r.layer === "ARENA");
  const key = (r: AnalyticsRun) => `${r.caseId}|${r.brain ?? ""}`;
  const base = new Map(arena.filter((r) => r.mode === "UNSAFE_BASELINE").map((r) => [key(r), r]));
  const prot = new Map(arena.filter((r) => r.mode === "PROTECTED").map((r) => [key(r), r]));
  const pairs: { baseline: AnalyticsRun; protected: AnalyticsRun; brain: string }[] = [];
  for (const [k, b] of base) {
    const p = prot.get(k);
    if (p) pairs.push({ baseline: b, protected: p, brain: b.brain ?? "none" });
  }
  const brains = [...new Set(pairs.map((p) => p.brain))].sort(sortKey);
  const comparison: Comparison = {
    paired: pairStats(pairs),
    byBrain: brains.map((brain) => ({
      brain,
      stats: pairStats(pairs.filter((p) => p.brain === brain)),
    })),
    unpaired: {
      baselineOnly: [...base.keys()].filter((k) => !prot.has(k)).length,
      protectedOnly: [...prot.keys()].filter((k) => !base.has(k)).length,
    },
    systemProtectedRuns: completed.filter((r) => r.layer === "SYSTEM" && r.mode === "PROTECTED")
      .length,
  };

  // 4 and 5. payment states and audit-chain results, per source
  const present = SOURCES.filter((s) => rows.some((r) => r.source === s));
  return {
    scope,
    byCategory,
    protectedOutcomes,
    comparison,
    paymentStates: present.map((s) => distribution(rows, s, (r) => r.paymentStatus)),
    auditChain: present.map((s) => {
      const d = distribution(rows, s, (r) => r.auditChain);
      return {
        ...d,
        counts: d.counts.filter((c): c is { value: AuditState; n: number } =>
          (AUDIT_STATES as readonly string[]).includes(c.value),
        ),
      };
    }),
  };
}
