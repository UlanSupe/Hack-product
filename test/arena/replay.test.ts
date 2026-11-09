import { describe, expect, it } from "vitest";

import { SCENARIOS, runExperiment, summarizeAll } from "@/application/arena";
import { BRAIN_PROFILES, WORLD_MANDATE } from "@/domain/experiment";

const run = (id: string, brain: "SUSCEPTIBLE" | "CAREFUL" = "SUSCEPTIBLE") => {
  const r = runExperiment({ scenarioId: id, brain });
  if (!r) throw new Error(`no scenario ${id}`);
  return r;
};

describe("deterministic scenario replay", () => {
  const cases = SCENARIOS.flatMap((s) => BRAIN_PROFILES.map((b) => [s.id, b] as const));

  it.each(cases)("%s with the %s model replays exactly: same result, same hash", (id, brain) => {
    const first = run(id, brain);
    const second = run(id, brain);
    expect(second).toEqual(first);
    expect(second.runHash).toBe(first.runHash);
    expect(first.runHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("order does not matter: running other scenarios in between changes nothing", () => {
    const alone = run("S1").runHash;
    for (const s of [...SCENARIOS].reverse()) run(s.id);
    run("S1", "CAREFUL");
    expect(run("S1").runHash).toBe(alone);
  });

  it("a result survives a JSON round trip unchanged (what the replay endpoint returns is what was run)", () => {
    for (const s of SCENARIOS) {
      const r = run(s.id);
      expect(JSON.parse(JSON.stringify(r))).toEqual(r);
    }
  });

  it("the hash covers the outcome: different scenarios and different models give different hashes", () => {
    const hashes = cases.map(([id, b]) => run(id, b).runHash);
    // identical outcomes under both models (for example N0) are the only collisions allowed: they differ in `brain`
    expect(new Set(hashes).size).toBe(hashes.length);
  });

  it("the hash changes when the world changes: a lower per-purchase cap is a different run", () => {
    const base = run("N0").runHash;
    const lowered = runExperiment({
      scenarioId: "N0",
      mandate: { ...WORLD_MANDATE, perTxCapMinor: 5_000 },
    })!;
    expect(lowered.runHash).not.toBe(base);
    expect(lowered.protected.moneyMovedMinor).toBe(0); // 80.00 is now over the 50.00 cap
    expect(lowered.baseline.moneyMovedMinor).toBe(0); // the susceptible model also declines an over-limit price with no override text
  });

  it("there is no clock and no randomness: nothing in a result is a timestamp or an unstable id", () => {
    const r = run("S8");
    // the only date in a result is the mandate's fixed expiry, a constant of the world, not a reading of the clock
    const text = JSON.stringify(r).replace(r.mandate.expiresAt, "EXPIRY");
    expect(text).not.toMatch(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/);
    expect(text).not.toMatch(/uuid|random/i);
    // receipts are numbered per ledger, in order
    expect(run("S8").baseline.steps.map((s) => s.settlement?.receiptId)).toEqual([
      "SIM-B-001",
      "SIM-B-002",
      "SIM-B-003",
    ]);
  });

  it("an unknown scenario is simply not found", () => {
    expect(runExperiment({ scenarioId: "S99" })).toBeUndefined();
    expect(runExperiment({ scenarioId: "" })).toBeUndefined();
    expect(runExperiment({ scenarioId: "__proto__" })).toBeUndefined();
  });

  it("the all-scenarios summary is itself deterministic and agrees with the single runs", () => {
    const a = summarizeAll("SUSCEPTIBLE");
    expect(summarizeAll("SUSCEPTIBLE")).toEqual(a);
    for (const row of a) expect(row.runHash).toBe(run(row.scenarioId).runHash);
  });
});
