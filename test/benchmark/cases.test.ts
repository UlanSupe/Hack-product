import { describe, expect, it } from "vitest";

import { serverTotalOf } from "@/domain/experiment";
import { scanInjection } from "@/domain/untrusted-text";

import {
  FAMILY_NAMES,
  arenaFingerprint,
  buildCases,
  duplicateMap,
  generatedArenaCases,
  handWrittenArenaCases,
  systemCases,
} from "./cases";
import { deriveSeed, makeRng } from "./rng";
import { offerClass } from "./spec";

describe("the seeded generator", () => {
  it("gives the same cases for the same seed, byte for byte", () => {
    const a = generatedArenaCases(123, 4);
    const b = generatedArenaCases(123, 4);
    expect(b.map((c) => c.caseFingerprint)).toEqual(a.map((c) => c.caseFingerprint));
    expect(JSON.stringify(b.map((c) => c.scenario))).toBe(JSON.stringify(a.map((c) => c.scenario)));
  });

  it("gives different cases for a different seed", () => {
    const a = generatedArenaCases(1, 4).map((c) => c.caseFingerprint);
    const b = generatedArenaCases(2, 4).map((c) => c.caseFingerprint);
    expect(b).not.toEqual(a);
  });

  it("rebuilds any single case from (seed, family, index) alone, so a failure can be reproduced in isolation", () => {
    const all = generatedArenaCases(77, 5);
    const pick = all.find((c) => c.caseId === "GEN-BUDGET-SEQUENCE-03");
    expect(pick?.seed).toBe(deriveSeed(77, "BUDGET-SEQUENCE", 3));
    // the same case from a run that asked for more variants per family
    const bigger = generatedArenaCases(77, 9).find((c) => c.caseId === "GEN-BUDGET-SEQUENCE-03");
    expect(bigger?.caseFingerprint).toBe(pick?.caseFingerprint);
  });

  it("records an explicit seed on every generated case and none on a hand-written one", () => {
    for (const c of generatedArenaCases(5, 3)) expect(Number.isInteger(c.seed)).toBe(true);
    for (const c of handWrittenArenaCases()) expect(c.seed).toBeNull();
    for (const c of systemCases()) expect(c.seed).toBeNull();
  });

  it("builds every family, with unique ids, and groups a family's variants in one evidence unit", () => {
    const cases = generatedArenaCases(9, 4);
    expect(cases).toHaveLength(FAMILY_NAMES.length * 4);
    expect(new Set(cases.map((c) => c.caseId)).size).toBe(cases.length);
    expect(new Set(cases.map((c) => c.evidenceUnit)).size).toBe(FAMILY_NAMES.length);
  });

  it("refuses a nonsense seed or size", () => {
    expect(() => generatedArenaCases(-1, 3)).toThrow(/seed/);
    expect(() => generatedArenaCases(1.5, 3)).toThrow(/seed/);
    expect(() => generatedArenaCases(1, 0)).toThrow(/perFamily/);
    expect(() => generatedArenaCases(1, 51)).toThrow(/perFamily/);
  });

  it("the random generator is mulberry32 and its output is pinned (seed 1 gives 62, 0, 52 from 0.627, 0.0027, 0.527)", () => {
    const r = makeRng(1);
    expect([r.int(0, 99), r.int(0, 99), r.int(0, 99)]).toEqual([62, 0, 52]);
    expect(deriveSeed(1, "A", 1)).toBe(deriveSeed(1, "A", 1));
    expect(deriveSeed(1, "A", 1)).not.toBe(deriveSeed(1, "A", 2));
  });
});

describe("the cases do what their family says", () => {
  const cases = generatedArenaCases(20_260_401, 6);

  it("each step's intended class matches the independent spec (generator and spec agree)", () => {
    for (const c of cases) {
      let reserved = 0;
      c.scenario.steps.forEach((step, i) => {
        const got = offerClass(step.offer, reserved);
        expect(got.cls, `${c.caseId} step ${i + 1} ${got.violations.join(",")}`).toBe(
          c.intent?.[i],
        );
        if (got.cls === "PAY_CLEAN") reserved += serverTotalOf(step.offer) ?? 0;
      });
    }
  });

  it("payee-redirect and authority cases really carry the signals the simulated model yields to", () => {
    for (const c of cases.filter((x) => x.evidenceUnit === "GEN:PAYEE-REDIRECT")) {
      const text = c.scenario.steps.flatMap((s) => s.messages.map((m) => m.text)).join(" ");
      expect(scanInjection(text), c.caseId).toContain("PAYMENT_REDIRECT");
    }
    for (const c of cases.filter((x) =>
      ["GEN:AUTHORITY-OVER-CAP", "GEN:STACKED-FLAWS"].includes(x.evidenceUnit),
    )) {
      const signals = scanInjection(
        c.scenario.steps.flatMap((s) => s.messages.map((m) => m.text)).join(" "),
      );
      expect(
        signals.some((s) =>
          ["AUTHORITY_CLAIM", "INSTRUCTION_OVERRIDE", "ROLE_SPOOF", "URGENCY"].includes(s),
        ),
        c.caseId,
      ).toBe(true);
    }
  });

  it("attack families contain violations and the control family contains none", () => {
    for (const c of cases) {
      const attack = c.intent?.some((k) => k !== "PAY_CLEAN") ?? false;
      expect(c.scenario.kind, c.caseId).toBe(attack ? "attack" : "control");
    }
    expect(
      cases
        .filter((c) => c.evidenceUnit === "GEN:BENIGN-CONTROL")
        .every((c) => c.intent?.every((k) => k === "PAY_CLEAN")),
    ).toBe(true);
  });
});

describe("copies are detected", () => {
  it("flags a later case with identical input as a duplicate of the first, and only that one", () => {
    const [a, b] = generatedArenaCases(3, 2);
    if (!a || !b) throw new Error("setup");
    const copy = { ...a, caseId: "COPY", scenario: { ...a.scenario, id: "COPY" } };
    const dup = duplicateMap([a, b, copy]);
    expect(dup.get("COPY")).toBe(a.caseId);
    expect(dup.has(a.caseId)).toBe(false);
    expect(dup.has(b.caseId)).toBe(false);
  });

  it("ignores labels (case id, offer id) when fingerprinting, and notices a one-unit price change", () => {
    const c = generatedArenaCases(3, 1)[0];
    if (!c) throw new Error("setup");
    const relabelled = structuredClone(c.scenario);
    relabelled.id = "other";
    relabelled.steps = relabelled.steps.map((s) => ({
      ...s,
      id: "x",
      offer: { ...s.offer, id: "other-offer" },
    }));
    expect(arenaFingerprint(relabelled)).toBe(c.caseFingerprint);
    const changed = structuredClone(c.scenario);
    const first = changed.steps[0];
    if (!first) throw new Error("setup");
    first.offer.claimedTotalMinor += 1;
    expect(arenaFingerprint(changed)).not.toBe(c.caseFingerprint);
  });

  it("the default benchmark contains real duplicates and the map finds them (nothing is hidden by the dedupe)", () => {
    const all = buildCases(20_260_401, 6);
    const dup = duplicateMap(all);
    expect(dup.size).toBeGreaterThan(0);
    for (const [copy, original] of dup) {
      const a = all.find((c) => c.caseId === copy);
      const b = all.find((c) => c.caseId === original);
      expect(a?.caseFingerprint).toBe(b?.caseFingerprint);
    }
  });
});
