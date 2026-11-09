import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { checkReport, renderText, type Report } from "./aggregate";
import { runBenchmark } from "./benchmark";
import { DEFAULT_PER_FAMILY, DEFAULT_SEED, systemCases, type SystemCase } from "./cases";
import { runSystemCase } from "./execute";
import { RunRecordSchema } from "./schema";

/**
 * The benchmark end to end: it really executes the cases, and the numbers it reports are the numbers in its records.
 * (`npm run benchmark` runs the same thing and writes the files; this checks the machinery under `npm test`.)
 */

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

let full: Report;
let again: Report;

describe("the default benchmark", () => {
  beforeAll(async () => {
    full = await runBenchmark({});
    again = await runBenchmark({});
  }, 120_000);

  it("executes at least 100 completed runs, and the report is internally consistent", () => {
    expect(full.summary.totals.completed).toBeGreaterThanOrEqual(100);
    expect(checkReport(full)).toEqual([]);
    expect(checkReport(JSON.parse(JSON.stringify(full)))).toEqual([]);
    expect(full.seed).toBe(DEFAULT_SEED);
    expect(full.perFamily).toBe(DEFAULT_PER_FAMILY);
  });

  it("is reproducible: a second execution has the identical results hash, summary and run records", () => {
    expect(again.resultsHash).toBe(full.resultsHash);
    expect(JSON.stringify(again.summary)).toBe(JSON.stringify(full.summary));
    expect(JSON.stringify(again.runs)).toBe(JSON.stringify(full.runs));
    expect(renderText(again)).toBe(renderText(full));
  });

  it("stores, for every run, its case id, input fingerprint, expected outcome, actual outcome and execution mode", () => {
    for (const r of full.runs) {
      expect(RunRecordSchema.safeParse(r).success, r.runId).toBe(true);
      expect(r.caseId.length).toBeGreaterThan(0);
      expect(r.inputFingerprint).toMatch(/^[0-9a-f]{64}$/);
      expect(r.executionMode).toMatch(
        /^(SIMULATED_LEDGER|IN_MEMORY_SERVICES_FAKE_PAYPAL|NOT_EXECUTED)$/,
      );
      if (r.status === "COMPLETED") {
        expect(r.expected, r.runId).not.toBeNull();
        expect(r.actual, r.runId).not.toBeNull();
      }
    }
  });

  it("uses the real execution modes only: arena runs a simulated ledger, system runs the fake PayPal, and skipped runs did not run", () => {
    for (const r of full.runs) {
      if (r.status === "SKIPPED") expect(r.executionMode).toBe("NOT_EXECUTED");
      else if (r.layer === "ARENA") expect(r.executionMode).toBe("SIMULATED_LEDGER");
      else expect(r.executionMode).toBe("IN_MEMORY_SERVICES_FAKE_PAYPAL");
    }
    expect(
      full.runs.every(
        (r) => r.layer === "ARENA" || r.mode === "PROTECTED" || r.status === "SKIPPED",
      ),
    ).toBe(true);
  });

  it("separates the result classes and reports each, with the skipped baseline legs explained", () => {
    const s = full.summary;
    expect(
      s.totals.completed +
        s.totals.modelErrors +
        s.totals.infrastructureErrors +
        s.totals.skipped +
        s.totals.duplicateRunsExcluded,
    ).toBe(s.totals.recorded);
    expect(s.skipped.count).toBeGreaterThan(0);
    expect(Object.keys(s.skipped.byReason).every((k) => k.startsWith("NO_BASELINE_ANALOGUE"))).toBe(
      true,
    );
    expect(s.modelErrors.count).toBeGreaterThan(0);
    expect(s.modelErrors.notFailedClosed).toBe(0);
    expect(s.infrastructureErrors.count).toBe(0);
  });

  it("can detect violations: the unsafe baseline lets them through, so a clean protected result is not an artefact of the measuring", () => {
    const b = full.summary.baseline.arena.metrics;
    const p = full.summary.protected.arena.metrics;
    expect(b.attemptedViolations).toBeGreaterThan(0);
    expect(b.allowedViolations).toBeGreaterThan(0);
    expect(b.allowedViolations).toBeGreaterThan(p.allowedViolations);
    expect(b.harms.length).toBeGreaterThan(0);
  });

  it("the protected buyer lets nothing through and refuses nothing legitimate in this benchmark", () => {
    const s = full.summary;
    expect(s.protected.arena.metrics.allowedViolations).toBe(0);
    expect(s.protected.arena.metrics.falseBlocks).toBe(0);
    expect(s.protected.system.verdicts.UNEXPECTED_ALLOWED).toBe(0);
    expect(s.protected.system.verdicts.FALSE_BLOCK).toBe(0);
  });

  it("reports evidence in units and mechanisms, which are far fewer than runs", () => {
    const i = full.summary.independence;
    expect(i.distinctCases).toBeLessThan(i.executedRuns);
    expect(i.mechanisms).toBeLessThanOrEqual(15);
    expect(i.evidenceUnits).toBeLessThan(i.distinctCases);
    // the 60 generated cases form only a handful of units
    const generated = full.summary.units.filter((u) => u.evidenceUnit.startsWith("GEN:"));
    expect(generated).toHaveLength(10);
  });

  it("finds the real duplicates among its own cases and excludes them from every figure", () => {
    const dups = full.runs.filter((r) => r.duplicateOfCase !== null);
    expect(dups.length).toBeGreaterThan(0);
    expect(full.summary.totals.duplicateRunsExcluded).toBe(dups.length);
  });
});

describe("other seeds and sizes", () => {
  it("a different seed changes the generated cases and the hash; the same seed does not", async () => {
    const a = await runBenchmark({ seed: 11, perFamily: 2 });
    const b = await runBenchmark({ seed: 11, perFamily: 2 });
    const c = await runBenchmark({ seed: 12, perFamily: 2 });
    expect(b.resultsHash).toBe(a.resultsHash);
    expect(c.resultsHash).not.toBe(a.resultsHash);
    expect(c.seed).toBe(12);
    // the hand-written and system cases do not depend on the seed
    const stable = (r: Report) =>
      r.runs
        .filter((x) => x.seed === null)
        .map((x) => x.inputFingerprint)
        .sort();
    expect(stable(c)).toEqual(stable(a));
  }, 120_000);
});

describe("failures of the harness are reported as such", () => {
  it("a scenario whose setup cannot be built is an INFRASTRUCTURE_ERROR, and is kept out of the policy figures", async () => {
    const real = systemCases().find((c) => c.caseId === "APR-01") as SystemCase;
    const broken: SystemCase = {
      ...real,
      caseId: "BROKEN",
      caseFingerprint: "b".repeat(64),
      scenario: {
        ...real.scenario,
        id: "BROKEN",
        // accepting an offer that does not exist: the world cannot reach the state the scenario starts from
        initial: { steps: [{ do: "open" }, { do: "accept", proposal: "nope" }] },
      },
    };
    const [protectedRun, baseline] = await runSystemCase(broken);
    expect(protectedRun?.status).toBe("INFRASTRUCTURE_ERROR");
    expect(protectedRun?.verdict).toBe("NOT_EVALUATED");
    expect(protectedRun?.metrics.attemptedViolations).toBe(0);
    expect(baseline?.status).toBe("SKIPPED");

    const report = await runBenchmark({ cases: [broken] });
    expect(report.summary.totals).toMatchObject({
      infrastructureErrors: 1,
      completed: 0,
      skipped: 1,
    });
    expect(report.summary.protected.system.runs).toBe(0);
    expect(checkReport(report)).toEqual([]);
  });

  it("a model-output scenario is a MODEL_ERROR that failed closed, not a policy result", async () => {
    const aio = systemCases().find((c) => c.caseId === "AIO-04") as SystemCase;
    const [run] = await runSystemCase(aio);
    expect(run?.status).toBe("MODEL_ERROR");
    expect((run?.actual as { failedClosed: boolean }).failedClosed).toBe(true);
    expect(run?.metrics.attemptedViolations).toBe(0);
  });

  it("a system scenario whose result differs from its expectation is classified by direction, never silently passed", async () => {
    const real = systemCases().find((c) => c.caseId === "BUD-01") as SystemCase;
    // claim that the offer should have been accepted: the actual outcome is then LESS far along than expected
    const wrong: SystemCase = {
      ...real,
      scenario: { ...real.scenario, expect: { ...real.scenario.expect, txStates: ["AGREED"] } },
    };
    const [run] = await runSystemCase(wrong);
    expect(run?.status).toBe("COMPLETED");
    expect(run?.verdict).toBe("FALSE_BLOCK");
    expect(run?.metrics).toMatchObject({ falseBlocks: 1, blockedViolations: 0 });
    // and the reverse: expecting nothing where an agreement exists is an unexpected ALLOW
    const open = systemCases().find((c) => c.caseId === "APR-01") as SystemCase;
    const lenient: SystemCase = {
      ...open,
      scenario: { ...open.scenario, expect: { ...open.scenario.expect, txStates: [] } },
    };
    const [run2] = await runSystemCase(lenient);
    expect(run2?.verdict).toBe("UNEXPECTED_ALLOWED");
    expect(run2?.metrics.allowedViolations).toBe(1);
  });
});

describe("isolation", () => {
  const dir = import.meta.dirname;
  const sources = readdirSync(dir).filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts"));

  it("imports no PayPal client, environment loader or credential module", () => {
    for (const f of sources) {
      const text = readFileSync(join(dir, f), "utf8");
      for (const m of text.matchAll(/from\s+["']([^"']+)["']/g)) {
        expect(m[1], `${f} imports ${m[1]}`).not.toMatch(
          /adapters\/paypal|server\/env|server\/payments|server\/webhooks|config\/env|dotenv/,
        );
      }
    }
  });

  it("makes no network call and reads the environment only in the entry point that sets the seed", () => {
    for (const f of sources) {
      const code = readFileSync(join(dir, f), "utf8")
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/^\s*\/\/.*$/gm, "");
      expect(code, f).not.toMatch(/\bfetch\s*\(|XMLHttpRequest|node:https?\b|node:net\b/);
      if (f !== "run.benchmark.ts") expect(code, f).not.toMatch(/process\.env/);
    }
  });

  it("contains nothing credential-shaped", () => {
    for (const f of sources) {
      expect(readFileSync(join(dir, f), "utf8"), f).not.toMatch(
        /client_secret|PAYPAL_CLIENT_SECRET|access_token|Bearer\s+[A-Za-z0-9]/i,
      );
    }
  });
});
