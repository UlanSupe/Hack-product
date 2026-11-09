import { beforeAll, describe, expect, it } from "vitest";

import { buildCockpit } from "@/application/cockpit";
import {
  computeAnalytics,
  projectRuns,
  share,
  shareText,
  type AnalyticsRun,
} from "@/domain/analytics";
import {
  NO_FILTERS,
  applyFilters,
  parseBenchmarkFile,
  type BenchmarkFile,
  type CockpitRow,
} from "@/domain/cockpit";

import { runBenchmark } from "../benchmark/benchmark";
import type { Report } from "../benchmark/aggregate";

/**
 * Analytics, checked two ways: against hand-built records with obvious answers (every exclusion rule, every
 * denominator), and against the benchmark's own independent aggregation of a freshly executed run.
 */

let n = 0;
const run = (over: Partial<AnalyticsRun> = {}): AnalyticsRun => ({
  runId: `r${++n}`,
  layer: "ARENA",
  caseId: `c${n}`,
  mechanism: "BUDGET_ESCALATION",
  mode: "PROTECTED",
  brain: "SUSCEPTIBLE",
  status: "COMPLETED",
  verdict: "AS_EXPECTED",
  reason: null,
  copy: false,
  attempted: 0,
  blocked: 0,
  allowed: 0,
  corrected: 0,
  legitimate: 0,
  falseBlocks: 0,
  modelRestraint: 0,
  movedMinor: 0,
  ...over,
});

const benchRow = (r: AnalyticsRun, over: Partial<CockpitRow> = {}): CockpitRow => ({
  id: `bench:${r.runId}`,
  source: "BENCHMARK",
  timestamp: "2026-11-04T10:00:00.000Z",
  refId: r.runId,
  scenario: r.caseId,
  category: r.mechanism,
  buyerMode: r.mode,
  currency: "USD",
  proposedMinor: null,
  approvedMinor: null,
  movedMinor: r.movedMinor,
  decision: "DENIED",
  reasonCodes: [],
  reasonSource: "SPEC",
  paymentStatus: "NO_PAYMENT",
  verification: r.verdict,
  verificationBasis: "BENCHMARK",
  auditChain: "NOT_RECORDED",
  ...over,
});

const dbRow = (id: string, payment: string, audit: CockpitRow["auditChain"]): CockpitRow => ({
  ...benchRow(run()),
  id: `tx:${id}`,
  source: "TRANSACTION",
  refId: id,
  paymentStatus: payment,
  auditChain: audit,
  verificationBasis: "PAYPAL",
});

const rowsOf = (runs: AnalyticsRun[]) => runs.map((r) => benchRow(r));

describe("denominators and exclusions", () => {
  const runs = [
    run({ attempted: 2, blocked: 2 }),
    run({ attempted: 1, blocked: 1, copy: true }), // a copy: excluded from every figure
    run({ status: "MODEL_ERROR", verdict: "NOT_EVALUATED" }),
    run({ status: "INFRASTRUCTURE_ERROR", verdict: "NOT_EVALUATED" }),
    run({ status: "SKIPPED", verdict: "NOT_EVALUATED", reason: "NO_BASELINE_ANALOGUE: no twin" }),
    run({ status: "SKIPPED", verdict: "NOT_EVALUATED", reason: "NO_BASELINE_ANALOGUE: another" }),
    run({ status: "SKIPPED", verdict: "NOT_EVALUATED", reason: "TOO_SLOW: x" }),
  ];
  const a = computeAnalytics(rowsOf(runs), runs);

  it("counts every run in view, then says what was set aside and why", () => {
    expect(a.scope).toEqual({
      inView: 7,
      copies: 1,
      skipped: 3,
      skipReasons: [
        { reason: "NO_BASELINE_ANALOGUE", n: 2 },
        { reason: "TOO_SLOW", n: 1 },
      ],
      executed: 3, // completed + model error + infrastructure error; skipped are not evidence
      completed: 1,
      modelErrors: 1,
      infrastructureErrors: 1,
    });
  });

  it("policy figures use completed, non-copy runs only (errors and skips never count as blocks or passes)", () => {
    expect(a.byCategory).toHaveLength(1);
    expect(a.byCategory[0]).toMatchObject({ completedRuns: 1, attempted: 2, blocked: 2 });
    expect(a.protectedOutcomes[0]).toMatchObject({ completedRuns: 1, attempted: 2, blocked: 2 });
  });

  it("a copy stays a copy when its original is filtered out of the view", () => {
    const all = [run({ attempted: 1, blocked: 1 }), run({ attempted: 1, blocked: 1 })];
    const fp = new Map<string, number>();
    const projected = projectRuns(
      all.map((r, i) => ({
        ...r,
        // same fingerprint for both: the second is a copy of the first
        inputFingerprint: "x".repeat(64),
        caseFingerprint: "y".repeat(64),
        evidenceUnit: "u",
        executionMode: "SIMULATED_LEDGER",
        seed: null,
        duplicateOfCase: null,
        expected: null,
        actual: null,
        metrics: {
          attemptedViolations: 1,
          blockedViolations: 1,
          allowedViolations: 0,
          correctedViolations: 0,
          legitimateAttempts: 0,
          falseBlocks: 0,
          modelRestraint: 0,
          moneyMovedMinor: i,
        },
      })),
    );
    expect(projected.map((p) => p.copy)).toEqual([false, true]);
    // view contains only the second run (its original is filtered out): it is still excluded
    const second = projected[1] as AnalyticsRun;
    const v = computeAnalytics([benchRow(second)], projected);
    expect(v.scope).toMatchObject({ inView: 1, copies: 1, completed: 0, executed: 0 });
    expect(fp.size).toBe(0);
  });
});

describe("outcomes by attack category", () => {
  it("separates layers and buyer modes and never adds them together", () => {
    const runs = [
      run({ mechanism: "PAYEE_SUBSTITUTION", mode: "PROTECTED", attempted: 3, blocked: 3 }),
      run({ mechanism: "PAYEE_SUBSTITUTION", mode: "UNSAFE_BASELINE", attempted: 3, allowed: 3 }),
      run({ mechanism: "PAYEE_SUBSTITUTION", layer: "SYSTEM", attempted: 4, blocked: 4 }),
    ];
    const rows = computeAnalytics(rowsOf(runs), runs).byCategory;
    expect(rows.map((r) => [r.layer, r.mode, r.attempted, r.blocked, r.allowed])).toEqual([
      ["ARENA", "PROTECTED", 3, 3, 0],
      ["ARENA", "UNSAFE_BASELINE", 3, 0, 3],
      ["SYSTEM", "PROTECTED", 4, 4, 0],
    ]);
  });

  it("a category with no attempted violation has no block rate (not 0%, not 100%)", () => {
    const runs = [run({ mechanism: "CONTROL", legitimate: 2 })];
    const [row] = computeAnalytics(rowsOf(runs), runs).byCategory;
    expect(row?.blockRate).toEqual({ n: 0, d: 0 });
    expect(shareText(row!.blockRate)).toBe("n/a (0 attempted)");
  });

  it("counts verdicts per category", () => {
    const runs = [
      run({ verdict: "AS_EXPECTED" }),
      run({ verdict: "UNEXPECTED_ALLOWED", attempted: 1, allowed: 1 }),
      run({ verdict: "FALSE_BLOCK", legitimate: 1, falseBlocks: 1 }),
      run({ verdict: "UNEXPECTED_OTHER" }),
    ];
    expect(computeAnalytics(rowsOf(runs), runs).byCategory[0]).toMatchObject({
      completedRuns: 4,
      asExpected: 1,
      unexpectedAllowedRuns: 1,
      falseBlockRuns: 1,
      unexpectedOtherRuns: 1,
      legitimate: 1,
      falseBlocks: 1,
    });
  });
});

describe("blocked versus unexpectedly allowed (protected mode)", () => {
  it("reports blocked, allowed and corrected out of attempted, and lists each unexpected pass", () => {
    const bad = run({ attempted: 2, blocked: 1, allowed: 1, verdict: "UNEXPECTED_ALLOWED" });
    const runs = [run({ attempted: 3, blocked: 2, corrected: 1 }), bad];
    const a = computeAnalytics(rowsOf(runs), runs).protectedOutcomes[0]!;
    expect(a).toMatchObject({
      attempted: 5,
      blocked: 3,
      allowed: 1,
      corrected: 1,
      reconciles: true,
    });
    expect(a.blockRate).toEqual({ n: 3, d: 5 });
    expect(a.unexpectedAllowed).toEqual([
      { runId: bad.runId, caseId: bad.caseId, mechanism: "BUDGET_ESCALATION" },
    ]);
  });

  it("says so when the records do not reconcile instead of hiding the gap", () => {
    const runs = [run({ attempted: 5, blocked: 2 })];
    expect(computeAnalytics(rowsOf(runs), runs).protectedOutcomes[0]?.reconciles).toBe(false);
  });

  it("baseline runs never enter the protected figures", () => {
    const runs = [run({ mode: "UNSAFE_BASELINE", attempted: 9, allowed: 9 })];
    expect(computeAnalytics(rowsOf(runs), runs).protectedOutcomes[0]).toMatchObject({
      completedRuns: 0,
      attempted: 0,
      allowed: 0,
    });
  });
});

describe("baseline versus protected", () => {
  it("pairs the same case and model, and counts what could not be paired", () => {
    const pair = (caseId: string, brain: string, baseAllowed: number, money: [number, number]) => [
      run({
        caseId,
        brain,
        mode: "UNSAFE_BASELINE",
        attempted: 2,
        allowed: baseAllowed,
        movedMinor: money[0],
      }),
      run({ caseId, brain, mode: "PROTECTED", attempted: 2, blocked: 2, movedMinor: money[1] }),
    ];
    const runs = [
      ...pair("A", "SUSCEPTIBLE", 2, [900, 0]),
      ...pair("A", "CAREFUL", 0, [0, 0]),
      run({ caseId: "B", brain: "SUSCEPTIBLE", mode: "UNSAFE_BASELINE", attempted: 1, allowed: 1 }), // no protected twin
      run({ caseId: "C", brain: "SUSCEPTIBLE", mode: "PROTECTED" }), // no baseline twin
      run({ caseId: "D", brain: "SUSCEPTIBLE", mode: "UNSAFE_BASELINE", status: "MODEL_ERROR" }), // not completed
      run({ caseId: "D", brain: "SUSCEPTIBLE", mode: "PROTECTED" }),
      run({
        layer: "SYSTEM",
        caseId: "S1",
        brain: null,
        mode: "PROTECTED",
        attempted: 1,
        blocked: 1,
      }),
    ];
    const c = computeAnalytics(rowsOf(runs), runs).comparison;
    expect(c.paired).toEqual({
      pairs: 2,
      attempted: 4, // two pairs of two attempted violations each
      baselineAllowed: 2,
      protectedAllowed: 0,
      protectedFalseBlocks: 0,
      baselineMovedMinor: 900,
      protectedMovedMinor: 0,
    });
    expect(c.byBrain.map((b) => [b.brain, b.stats.pairs, b.stats.baselineAllowed])).toEqual([
      ["CAREFUL", 1, 0],
      ["SUSCEPTIBLE", 1, 2],
    ]);
    expect(c.unpaired).toEqual({ baselineOnly: 1, protectedOnly: 2 }); // B; C and D(protected)
    expect(c.systemProtectedRuns).toBe(1); // protected-only by construction, never compared
  });
});

describe("payment states and audit-chain results", () => {
  const bench = [run({ attempted: 1, blocked: 1 }), run()];
  const rows = [
    ...rowsOf(bench),
    dbRow("t1", "CAPTURED", "VERIFIED"),
    dbRow("t2", "CAPTURED", "VERIFIED"),
    dbRow("t3", "AGREED", "BROKEN"),
    dbRow("t4", "NEEDS_RECONCILIATION", "NO_EVENTS"),
  ];
  const a = computeAnalytics(rows, bench);

  it("counts payment states per source, with the number of rows as the denominator", () => {
    const tx = a.paymentStates.find((d) => d.source === "TRANSACTION")!;
    expect(tx.rows).toBe(4);
    expect(tx.counts).toEqual([
      { value: "CAPTURED", n: 2 },
      { value: "AGREED", n: 1 },
      { value: "NEEDS_RECONCILIATION", n: 1 },
    ]);
    const b = a.paymentStates.find((d) => d.source === "BENCHMARK")!;
    expect(b.rows).toBe(2); // simulated rows are a separate line, never merged into the database's
  });

  it("counts audit-chain results per source; benchmark rows are 'not recorded', never 'verified'", () => {
    const tx = a.auditChain.find((d) => d.source === "TRANSACTION")!;
    expect(Object.fromEntries(tx.counts.map((c) => [c.value, c.n]))).toEqual({
      VERIFIED: 2,
      BROKEN: 1,
      NO_EVENTS: 1,
    });
    const b = a.auditChain.find((d) => d.source === "BENCHMARK")!;
    expect(b.counts).toEqual([{ value: "NOT_RECORDED", n: 2 }]);
  });

  it("omits a source with no rows in view instead of drawing an empty line", () => {
    const only = computeAnalytics(rowsOf(bench), bench);
    expect(only.paymentStates.map((d) => d.source)).toEqual(["BENCHMARK"]);
  });
});

describe("filters narrow every figure", () => {
  const runs = [
    run({ mode: "PROTECTED", attempted: 1, blocked: 1, mechanism: "REPLAY", caseId: "RPL-1" }),
    run({
      mode: "UNSAFE_BASELINE",
      attempted: 1,
      allowed: 1,
      mechanism: "REPLAY",
      caseId: "RPL-1",
    }),
    run({
      mode: "PROTECTED",
      attempted: 1,
      blocked: 1,
      mechanism: "PAYEE_SUBSTITUTION",
      caseId: "PAY-1",
    }),
  ];
  const rows = rowsOf(runs);
  const view = (patch: Partial<typeof NO_FILTERS>) =>
    computeAnalytics(applyFilters(rows, { ...NO_FILTERS, ...patch }), runs);

  it("by buyer mode", () => {
    const a = view({ mode: "PROTECTED" });
    expect(a.scope.inView).toBe(2);
    expect(a.byCategory.every((c) => c.mode === "PROTECTED")).toBe(true);
  });

  it("by scenario or transaction (the search box)", () => {
    expect(view({ q: "PAY-1" }).scope.inView).toBe(1);
    expect(view({ q: "RPL-1" }).byCategory.map((c) => c.mechanism)).toEqual(["REPLAY", "REPLAY"]);
  });

  it("by category and by outcome", () => {
    expect(view({ category: "PAYEE_SUBSTITUTION" }).scope.inView).toBe(1);
    const rowsWithDecisions = [
      benchRow(runs[0]!, { decision: "DENIED" }),
      benchRow(runs[1]!, { decision: "EXECUTED_UNCHECKED" }),
      benchRow(runs[2]!, { decision: "DENIED" }),
    ];
    const a = computeAnalytics(
      applyFilters(rowsWithDecisions, { ...NO_FILTERS, decision: "EXECUTED_UNCHECKED" }),
      runs,
    );
    expect(a.scope.inView).toBe(1);
    expect(a.byCategory[0]).toMatchObject({ mode: "UNSAFE_BASELINE", allowed: 1 });
  });

  it("by date (benchmark rows all carry the file's generation time)", () => {
    expect(view({ from: "2026-11-05" }).scope.inView).toBe(0);
    expect(view({ from: "2026-11-04", to: "2026-11-04" }).scope.inView).toBe(3);
  });

  it("an empty view yields zeros and no categories, never invented rows", () => {
    const a = view({ q: "no-such-scenario" });
    expect(a.scope.inView).toBe(0);
    expect(a.byCategory).toEqual([]);
    expect(a.protectedOutcomes.every((o) => o.completedRuns === 0)).toBe(true);
    expect(a.paymentStates).toEqual([]);
  });
});

describe("ratios carry their denominator", () => {
  it("formats n of d with one decimal, and says n/a for an empty denominator", () => {
    expect(shareText(share(58, 58))).toBe("58 of 58 (100.0%)");
    expect(shareText(share(1, 3))).toBe("1 of 3 (33.3%)");
    expect(shareText(share(0, 0), "legitimate attempts")).toBe("n/a (0 legitimate attempts)");
    expect(shareText(share(2, 3))).toBe("2 of 3 (66.7%)");
  });
});

describe("agrees with the benchmark's own aggregation of a real run", () => {
  let report: Report;
  let file: BenchmarkFile;
  let a: ReturnType<typeof computeAnalytics>;

  beforeAll(async () => {
    report = await runBenchmark({ seed: 11, perFamily: 1 });
    const parsed = parseBenchmarkFile(JSON.stringify(report));
    if (!parsed.ok) throw new Error(parsed.message);
    file = parsed.file;
    const data = buildCockpit({
      live: { state: "LOCKED", message: "" },
      benchmark: { state: "OK", file },
    });
    a = computeAnalytics(data.rows, data.runs);
  }, 120_000);

  it("scope: recorded, copies, skipped, executed, completed and errors", () => {
    const t = report.summary.totals;
    expect(a.scope.inView).toBe(t.recorded);
    expect(a.scope.copies).toBe(t.duplicateRunsExcluded);
    expect(a.scope.skipped).toBe(t.skipped);
    expect(a.scope.executed).toBe(t.executed);
    expect(a.scope.completed).toBe(t.completed);
    expect(a.scope.modelErrors).toBe(t.modelErrors);
    expect(a.scope.infrastructureErrors).toBe(t.infrastructureErrors);
    expect(a.scope.skipReasons.reduce((s, r) => s + r.n, 0)).toBe(report.summary.skipped.count);
  });

  it("protected arena figures", () => {
    const m = report.summary.protected.arena.metrics;
    const o = a.protectedOutcomes.find((x) => x.layer === "ARENA")!;
    expect([o.attempted, o.blocked, o.allowed, o.corrected]).toEqual([
      m.attemptedViolations,
      m.blockedViolations,
      m.allowedViolations,
      m.correctedViolations,
    ]);
    expect([o.legitimate, o.falseBlocks]).toEqual([m.legitimateAttempts, m.falseBlocks]);
    expect(o.reconciles).toBe(true);
  });

  it("protected system figures", () => {
    const m = report.summary.protected.system.metrics;
    const o = a.protectedOutcomes.find((x) => x.layer === "SYSTEM")!;
    expect([o.attempted, o.blocked, o.allowed]).toEqual([
      m.attemptedViolations,
      m.blockedViolations,
      m.allowedViolations,
    ]);
  });

  it("baseline arena figures, from the category table", () => {
    const m = report.summary.baseline.arena.metrics;
    const rows = a.byCategory.filter((r) => r.layer === "ARENA" && r.mode === "UNSAFE_BASELINE");
    expect(rows.reduce((s, r) => s + r.attempted, 0)).toBe(m.attemptedViolations);
    expect(rows.reduce((s, r) => s + r.allowed, 0)).toBe(m.allowedViolations);
    expect(rows.reduce((s, r) => s + r.movedMinor, 0)).toBe(m.moneyMovedMinor);
  });

  it("the pairs", () => {
    const p = report.summary.paired;
    expect(a.comparison.paired).toMatchObject({
      pairs: p.pairs,
      attempted: p.attemptedViolations,
      baselineAllowed: p.baselineAllowed,
      protectedAllowed: p.protectedAllowed,
      protectedFalseBlocks: p.protectedFalseBlocks,
    });
  });

  it("every completed protected run is in exactly one category row", () => {
    const protectedRuns = file.runs.filter(
      (r) => r.mode === "PROTECTED" && r.status === "COMPLETED",
    );
    const fresh = projectRuns(file.runs).filter(
      (r) => !r.copy && r.mode === "PROTECTED" && r.status === "COMPLETED",
    );
    expect(fresh.length).toBeLessThanOrEqual(protectedRuns.length);
    expect(
      a.byCategory.filter((r) => r.mode === "PROTECTED").reduce((s, r) => s + r.completedRuns, 0),
    ).toBe(fresh.length);
  });
});
