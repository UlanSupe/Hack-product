import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  buildReport,
  checkReport,
  dedupe,
  groupOf,
  renderText,
  resultsHashOf,
  summarize,
} from "./aggregate";
import { makeRng } from "./rng";
import { emptyMetrics, type Metrics, type RunRecord, type Verdict } from "./schema";

/** Hand-built records: the aggregation is tested on data whose correct totals are obvious by inspection. */

const hex = (s: string) => createHash("sha256").update(s).digest("hex");
let n = 0;

type Over = Omit<Partial<RunRecord>, "metrics"> & { metrics?: Partial<Metrics> };

function rec(over: Over = {}): RunRecord {
  n += 1;
  const { metrics, ...rest } = over;
  const caseId = rest.caseId ?? `case-${n}`;
  return {
    runId: `${caseId}|${rest.mode ?? "PROTECTED"}|${rest.brain ?? "-"}|${n}`,
    layer: "ARENA",
    caseId,
    evidenceUnit: `unit-${caseId}`,
    mechanism: "BUDGET_ESCALATION",
    mode: "PROTECTED",
    executionMode: "SIMULATED_LEDGER",
    brain: "SUSCEPTIBLE",
    seed: null,
    caseFingerprint: hex(`case:${caseId}`),
    inputFingerprint: hex(`input:${caseId}:${n}`),
    duplicateOfCase: null,
    status: "COMPLETED",
    reason: null,
    expected: { x: 1 },
    actual: { x: 1 },
    verdict: "AS_EXPECTED",
    metrics: { ...emptyMetrics(), ...metrics },
    ...rest,
  };
}

const blocked = (over: Over = {}) =>
  rec({ metrics: { attemptedViolations: 1, blockedViolations: 1 }, ...over });
const allowed = (over: Over = {}) =>
  rec({
    verdict: "UNEXPECTED_ALLOWED",
    metrics: {
      attemptedViolations: 1,
      allowedViolations: 1,
      moneyMovedMinor: 500,
      harms: ["CAP_EXCEEDED"],
    },
    ...over,
  });
const falseBlock = (over: Over = {}) =>
  rec({ verdict: "FALSE_BLOCK", metrics: { legitimateAttempts: 1, falseBlocks: 1 }, ...over });

describe("counting", () => {
  it("is all zeros for no runs, and never divides by zero", () => {
    const s = summarize([]);
    expect(s.totals).toEqual({
      recorded: 0,
      duplicateRunsExcluded: 0,
      executed: 0,
      completed: 0,
      modelErrors: 0,
      infrastructureErrors: 0,
      skipped: 0,
    });
    expect(s.protected.arena.rates).toEqual({
      blockRate: null,
      allowRate: null,
      falseBlockRate: null,
    });
    expect(s.unitSummary.ARENA.upperBound95NoUnexpectedAllowed).toBeNull();
    expect(
      renderText(
        buildReport({
          runs: [],
          benchmarkVersion: "t",
          seed: 1,
          perFamily: 1,
          generatedAt: "x",
          node: "n",
        }),
      ),
    ).not.toMatch(/NaN|undefined|Infinity/);
  });

  it("sums attempted, blocked, allowed and false-blocked exactly", () => {
    const runs = [blocked(), blocked(), blocked(), allowed(), falseBlock(), falseBlock()];
    const g = groupOf(runs);
    expect(g.metrics).toMatchObject({
      attemptedViolations: 4,
      blockedViolations: 3,
      allowedViolations: 1,
      legitimateAttempts: 2,
      falseBlocks: 2,
      moneyMovedMinor: 500,
    });
    expect(g.rates).toEqual({ blockRate: 0.75, allowRate: 0.25, falseBlockRate: 1 });
    expect(g.verdicts).toMatchObject({ AS_EXPECTED: 3, UNEXPECTED_ALLOWED: 1, FALSE_BLOCK: 2 });
    expect(g.harmedRuns.CAP_EXCEEDED).toBe(1);
    expect(g.metrics.harms).toEqual(["CAP_EXCEEDED"]);
  });

  it("every executed run falls in exactly one status bucket, and the totals reconcile", () => {
    const runs = [
      blocked(),
      allowed(),
      rec({ status: "MODEL_ERROR", verdict: "NOT_EVALUATED", actual: { failedClosed: true } }),
      rec({ status: "INFRASTRUCTURE_ERROR", verdict: "NOT_EVALUATED", reason: "boom" }),
      rec({ status: "SKIPPED", verdict: "NOT_EVALUATED", reason: "NO_BASELINE_ANALOGUE" }),
    ];
    const t = summarize(runs).totals;
    expect(t).toMatchObject({
      recorded: 5,
      executed: 4,
      completed: 2,
      modelErrors: 1,
      infrastructureErrors: 1,
      skipped: 1,
    });
    expect(
      t.completed + t.modelErrors + t.infrastructureErrors + t.skipped + t.duplicateRunsExcluded,
    ).toBe(t.recorded);
  });
});

describe("separation of result classes", () => {
  it("keeps model errors, infrastructure errors and skipped runs out of every policy metric", () => {
    const runs = [
      blocked(),
      rec({
        status: "MODEL_ERROR",
        verdict: "NOT_EVALUATED",
        metrics: { attemptedViolations: 9, allowedViolations: 9 },
      }),
      rec({
        status: "INFRASTRUCTURE_ERROR",
        verdict: "NOT_EVALUATED",
        metrics: { attemptedViolations: 9, allowedViolations: 9 },
      }),
      rec({
        status: "SKIPPED",
        verdict: "NOT_EVALUATED",
        metrics: { attemptedViolations: 9, allowedViolations: 9 },
      }),
    ];
    const s = summarize(runs);
    expect(s.protected.arena.metrics.attemptedViolations).toBe(1);
    expect(s.protected.arena.metrics.allowedViolations).toBe(0);
    expect(s.modelErrors.count).toBe(1);
    expect(s.infrastructureErrors).toMatchObject({ count: 1 });
    expect(s.skipped.count).toBe(1);
  });

  it("never blends baseline with protected, nor the arena with the system layer", () => {
    const runs = [
      allowed({ mode: "UNSAFE_BASELINE" }),
      allowed({ mode: "UNSAFE_BASELINE" }),
      blocked({ mode: "PROTECTED" }),
      blocked({
        mode: "PROTECTED",
        layer: "SYSTEM",
        executionMode: "IN_MEMORY_SERVICES_FAKE_PAYPAL",
        brain: null,
      }),
    ];
    const s = summarize(runs);
    expect(s.baseline.arena.metrics.allowedViolations).toBe(2);
    expect(s.protected.arena.metrics.allowedViolations).toBe(0);
    expect(s.protected.arena.runs).toBe(1);
    expect(s.protected.system.runs).toBe(1);
    expect(s.protected.system.metrics.blockedViolations).toBe(1);
  });

  it("splits results per simulated model and, for the system layer, per attack category", () => {
    const runs = [
      blocked({ brain: "SUSCEPTIBLE" }),
      allowed({ brain: "CAREFUL" }),
      blocked({ layer: "SYSTEM", brain: null, mechanism: "REPLAY" }),
      blocked({ layer: "SYSTEM", brain: null, mechanism: "REPLAY" }),
      blocked({ layer: "SYSTEM", brain: null, mechanism: "MANDATE_TAMPERING" }),
    ];
    const s = summarize(runs);
    expect(s.protected.arenaByBrain.SUSCEPTIBLE.runs).toBe(1);
    expect(s.protected.arenaByBrain.CAREFUL.metrics.allowedViolations).toBe(1);
    expect(Object.keys(s.protected.systemByMechanism)).toEqual(["MANDATE_TAMPERING", "REPLAY"]);
    expect(s.protected.systemByMechanism.REPLAY?.runs).toBe(2);
  });

  it("reports model errors by whether they failed closed, and lists the ones that did not", () => {
    const s = summarize([
      rec({ status: "MODEL_ERROR", verdict: "NOT_EVALUATED", actual: { failedClosed: true } }),
      rec({
        status: "MODEL_ERROR",
        verdict: "NOT_EVALUATED",
        actual: { failedClosed: false },
        reason: "oops",
      }),
      rec({ status: "MODEL_ERROR", verdict: "NOT_EVALUATED", actual: null }),
    ]);
    expect(s.modelErrors).toMatchObject({ count: 3, failedClosed: 1, notFailedClosed: 2 });
  });

  it("counts skipped runs by reason", () => {
    const s = summarize([
      rec({ status: "SKIPPED", verdict: "NOT_EVALUATED", reason: "A" }),
      rec({ status: "SKIPPED", verdict: "NOT_EVALUATED", reason: "A" }),
      rec({ status: "SKIPPED", verdict: "NOT_EVALUATED", reason: "B" }),
      rec({ status: "SKIPPED", verdict: "NOT_EVALUATED", reason: null }),
    ]);
    expect(s.skipped).toEqual({ count: 4, byReason: { A: 2, B: 1, UNSPECIFIED: 1 } });
  });
});

describe("repeated copies are not independent evidence", () => {
  it("excludes a run whose input fingerprint was already seen, and says so", () => {
    const a = blocked({ caseId: "c1" });
    const copies = Array.from({ length: 49 }, (_v, i) => ({ ...a, runId: `${a.runId}-copy${i}` }));
    const s = summarize([a, ...copies]);
    expect(s.totals).toMatchObject({ recorded: 50, duplicateRunsExcluded: 49, executed: 1 });
    expect(s.protected.arena.metrics.attemptedViolations).toBe(1);
    expect(dedupe([a, ...copies]).unique).toEqual([a]);
  });

  it("fifty copies are one case, one unit and one mechanism; fifty variants of a family are fifty cases but one unit", () => {
    const base = blocked({ caseId: "c1" });
    const copies = Array.from({ length: 50 }, (_v, i) => ({ ...base, runId: `copy${i}` }));
    const sCopies = summarize(copies).independence;
    expect(sCopies).toMatchObject({
      executedRuns: 1,
      distinctCases: 1,
      evidenceUnits: 1,
      mechanisms: 1,
    });

    const variants = Array.from({ length: 50 }, (_v, i) =>
      blocked({ caseId: `v${i}`, evidenceUnit: "GEN:FAMILY" }),
    );
    const sVariants = summarize(variants).independence;
    expect(sVariants).toMatchObject({
      executedRuns: 50,
      distinctCases: 50,
      evidenceUnits: 1,
      mechanisms: 1,
    });
  });

  it("two modes and two models of one case are four runs but one case", () => {
    const runs = (["UNSAFE_BASELINE", "PROTECTED"] as const).flatMap((mode) =>
      (["SUSCEPTIBLE", "CAREFUL"] as const).map((brain) =>
        blocked({ caseId: "same", mode, brain, evidenceUnit: "u" }),
      ),
    );
    expect(summarize(runs).independence).toMatchObject({
      executedRuns: 4,
      distinctCases: 1,
      evidenceUnits: 1,
    });
  });

  it("the rule-of-three bound uses exercised UNITS, not runs, and disappears when anything slipped through", () => {
    const manyRunsOneUnit = Array.from({ length: 40 }, (_v, i) =>
      blocked({ caseId: `v${i}`, evidenceUnit: "GEN:ONE" }),
    );
    const s = summarize(manyRunsOneUnit);
    expect(s.unitSummary.ARENA).toMatchObject({
      protectedUnitsEvaluated: 1,
      protectedUnitsExercised: 1,
    });
    expect(s.unitSummary.ARENA.upperBound95NoUnexpectedAllowed).toBe(3); // one unit proves almost nothing: bound 300%, i.e. none
    const withLeak = summarize([...manyRunsOneUnit, allowed({ evidenceUnit: "GEN:TWO" })]);
    expect(withLeak.unitSummary.ARENA.upperBound95NoUnexpectedAllowed).toBeNull();
    expect(withLeak.unitSummary.ARENA.protectedUnitsWithUnexpectedAllowed).toBe(1);
  });

  it("keeps the layers apart: 100 system scenarios do not tighten the bound for 2 arena units", () => {
    const system = Array.from({ length: 100 }, (_v, i) =>
      blocked({ layer: "SYSTEM", brain: null, caseId: `sys${i}`, evidenceUnit: `SYSTEM:${i}` }),
    );
    const arena = [blocked({ evidenceUnit: "ARENA:A" }), blocked({ evidenceUnit: "ARENA:B" })];
    const u = summarize([...system, ...arena]).unitSummary;
    expect(u.SYSTEM.protectedUnitsExercised).toBe(100);
    expect(u.SYSTEM.upperBound95NoUnexpectedAllowed).toBe(0.03);
    expect(u.ARENA.protectedUnitsExercised).toBe(2);
    expect(u.ARENA.upperBound95NoUnexpectedAllowed).toBe(1.5);
  });

  it("a unit where no violation was ever attempted is evaluated but not exercised", () => {
    const quiet = rec({ evidenceUnit: "GEN:MODEL-DECLINES", metrics: { modelRestraint: 1 } });
    const s = summarize([quiet, blocked({ evidenceUnit: "GEN:REAL" })]);
    expect(s.unitSummary.ARENA).toMatchObject({
      protectedUnitsEvaluated: 2,
      protectedUnitsExercised: 1,
    });
    expect(
      s.units.find((u) => u.evidenceUnit === "GEN:MODEL-DECLINES")?.protectedViolationAttempts,
    ).toBe(0);
  });
});

describe("baseline against protected", () => {
  it("pairs runs only when both modes ran the same case with the same model", () => {
    const fp = hex("shared-case");
    const runs = [
      allowed({ mode: "UNSAFE_BASELINE", caseId: "p", caseFingerprint: fp, brain: "SUSCEPTIBLE" }),
      blocked({ mode: "PROTECTED", caseId: "p", caseFingerprint: fp, brain: "SUSCEPTIBLE" }),
      allowed({ mode: "UNSAFE_BASELINE", caseId: "q", brain: "CAREFUL" }), // no protected partner
    ];
    expect(summarize(runs).paired).toEqual({
      pairs: 1,
      attemptedViolations: 1,
      baselineAllowed: 1,
      protectedAllowed: 0,
      protectedFalseBlocks: 0,
    });
  });
});

describe("per-unit verdicts", () => {
  it("marks a unit as deviated if any protected run deviated, and null if none completed", () => {
    const s = summarize([
      blocked({ evidenceUnit: "ok" }),
      blocked({ evidenceUnit: "bad" }),
      allowed({ evidenceUnit: "bad" }),
      rec({ evidenceUnit: "none", status: "INFRASTRUCTURE_ERROR", verdict: "NOT_EVALUATED" }),
      allowed({ evidenceUnit: "base-only", mode: "UNSAFE_BASELINE" }),
    ]);
    const row = (u: string) => s.units.find((x) => x.evidenceUnit === u);
    expect(row("ok")?.protectedAsExpected).toBe(true);
    expect(row("bad")).toMatchObject({ protectedAsExpected: false, protectedUnexpectedAllowed: 1 });
    expect(row("none")?.protectedAsExpected).toBeNull();
    expect(row("base-only")).toMatchObject({
      protectedAsExpected: null,
      baselineAllowedViolations: 1,
    });
  });
});

describe("the exported report", () => {
  const sample = () => {
    const runs = [
      blocked(),
      allowed({ mode: "UNSAFE_BASELINE" }),
      falseBlock(),
      rec({ status: "SKIPPED", verdict: "NOT_EVALUATED", reason: "R" }),
    ];
    return buildReport({
      runs,
      benchmarkVersion: "t/1",
      seed: 7,
      perFamily: 3,
      generatedAt: "2026-01-01T00:00:00.000Z",
      node: "v0",
    });
  };

  it("is consistent, survives a JSON round trip, and carries every field the benchmark promises per run", () => {
    const report = sample();
    expect(checkReport(report)).toEqual([]);
    expect(checkReport(JSON.parse(JSON.stringify(report)))).toEqual([]);
    for (const r of report.runs) {
      for (const field of [
        "caseId",
        "inputFingerprint",
        "expected",
        "actual",
        "executionMode",
        "status",
        "verdict",
      ] as const)
        expect(r, field).toHaveProperty(field);
    }
  });

  it("detects a tampered run, a tampered summary, a forged hash, a duplicate id and a malformed record", () => {
    const report = JSON.parse(JSON.stringify(sample())) as ReturnType<typeof sample>;
    const t = (mutate: (r: ReturnType<typeof sample>) => void) => {
      const copy = JSON.parse(JSON.stringify(report)) as ReturnType<typeof sample>;
      mutate(copy);
      return checkReport(copy);
    };
    expect(
      t((r) => {
        (r.runs[0] as RunRecord).verdict = "FALSE_BLOCK";
      }),
    ).toEqual(expect.arrayContaining(["resultsHash does not match the runs"]));
    expect(
      t((r) => {
        r.summary.totals.completed += 1;
      }),
    ).toEqual(["summary does not match the runs"]);
    expect(
      t((r) => {
        r.resultsHash = "0".repeat(64);
      }),
    ).toEqual(["resultsHash does not match the runs"]);
    expect(
      t((r) => {
        (r.runs[1] as RunRecord).runId = (r.runs[0] as RunRecord).runId;
      }),
    ).toContain("run ids are not unique");
    expect(
      t((r) => {
        delete (r.runs[0] as Partial<RunRecord>).caseFingerprint;
      })[0],
    ).toMatch(/run 0/);
    expect(
      t((r) => {
        r.schemaVersion = "x" as never;
      }),
    ).toContain("unknown schema version");
    expect(checkReport(null)).toEqual(["the report is not an object"]);
  });

  it("hashes the runs independently of their order and of the metadata", () => {
    const report = sample();
    const reversed = [...report.runs].reverse();
    expect(resultsHashOf(reversed)).toBe(report.resultsHash);
    const other = buildReport({
      runs: report.runs,
      benchmarkVersion: "t/1",
      seed: 7,
      perFamily: 3,
      generatedAt: "later",
      node: "v1",
    });
    expect(other.resultsHash).toBe(report.resultsHash);
    const changed = [...report.runs];
    changed[0] = { ...(changed[0] as RunRecord), reason: "different" };
    expect(resultsHashOf(changed)).not.toBe(report.resultsHash);
  });

  it("renders only figures that are in the summary, deterministically", () => {
    const report = sample();
    const text = renderText(report);
    expect(renderText(report)).toBe(text);
    const t = report.summary.totals;
    expect(text).toContain(
      `recorded ${t.recorded}; executed ${t.executed}; skipped ${t.skipped}; duplicate copies excluded ${t.duplicateRunsExcluded}`,
    );
    expect(text).toContain(`results hash ${report.resultsHash}`);
    expect(text).toContain("2. How much independent evidence that is");
    expect(text).not.toMatch(/NaN|undefined|Infinity/);
  });
});

describe("invariants over many random record sets (seeded)", () => {
  it("never double-counts and always reconciles", () => {
    const rng = makeRng(424242);
    const statuses = [
      "COMPLETED",
      "COMPLETED",
      "COMPLETED",
      "MODEL_ERROR",
      "INFRASTRUCTURE_ERROR",
      "SKIPPED",
    ] as const;
    for (let round = 0; round < 60; round++) {
      const runs: RunRecord[] = [];
      const size = rng.int(0, 40);
      for (let i = 0; i < size; i++) {
        const status = rng.pick(statuses);
        const verdict: Verdict =
          status === "COMPLETED"
            ? rng.pick([
                "AS_EXPECTED",
                "UNEXPECTED_ALLOWED",
                "FALSE_BLOCK",
                "UNEXPECTED_OTHER",
              ] as const)
            : "NOT_EVALUATED";
        const attempted = status === "COMPLETED" ? rng.int(0, 2) : 0;
        const r = rec({
          status,
          verdict,
          mode: rng.pick(["PROTECTED", "UNSAFE_BASELINE"] as const),
          layer: rng.pick(["ARENA", "SYSTEM"] as const),
          brain: rng.pick(["SUSCEPTIBLE", "CAREFUL", null] as const),
          caseId: `c${rng.int(0, 12)}`,
          evidenceUnit: `u${rng.int(0, 5)}`,
          metrics: { attemptedViolations: attempted, blockedViolations: attempted },
        });
        runs.push(
          rng.int(0, 4) === 0 && runs.length > 0
            ? { ...(runs[0] as RunRecord), runId: `dup${i}` }
            : r,
        );
      }
      const s = summarize(runs);
      const t = s.totals;
      expect(
        t.completed + t.modelErrors + t.infrastructureErrors + t.skipped + t.duplicateRunsExcluded,
        `round ${round}`,
      ).toBe(t.recorded);
      expect(t.executed).toBe(t.completed + t.modelErrors + t.infrastructureErrors);
      const grouped = s.baseline.arena.runs + s.protected.arena.runs + s.protected.system.runs;
      const baselineSystem = dedupe(runs).unique.filter(
        (r) => r.status === "COMPLETED" && r.mode === "UNSAFE_BASELINE" && r.layer === "SYSTEM",
      ).length;
      expect(grouped + baselineSystem).toBe(t.completed);
      expect(s.independence.evidenceUnits).toBeLessThanOrEqual(t.executed);
      expect(s.independence.distinctCases).toBeLessThanOrEqual(t.executed);
      expect(
        checkReport(
          buildReport({
            runs,
            benchmarkVersion: "t",
            seed: 1,
            perFamily: 1,
            generatedAt: "x",
            node: "n",
          }),
        ),
      ).toEqual([]);
    }
  });
});
