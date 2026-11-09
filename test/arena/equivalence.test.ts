import { describe, expect, it } from "vitest";

import { SCENARIOS, runExperiment } from "@/application/arena";
import { canonicalJson, sha256Hex } from "@/domain/canonical";
import {
  WORLD_MANDATE,
  inputHashOf,
  sharedInputFor,
  type BrainFn,
  type BrainInput,
  type BuyerProposal,
} from "@/domain/experiment";

/**
 * "Both buyers receive the same scenario, initial budget, offers, seller messages and attack input": proven by
 * recording what the model is actually called with in each mode, not by trusting how the runner was written.
 */

const run = (a: Parameters<typeof runExperiment>[0]) => {
  const r = runExperiment(a);
  if (!r) throw new Error("no such scenario");
  return r;
};

type Call = { input: BrainInput; at: number };

function recorder(answer: BrainFn = () => ({ kind: "DECLINE", reason: "recording" })) {
  const calls: Call[] = [];
  const brain: BrainFn = (input) => {
    calls.push({ input, at: calls.length });
    return answer(input);
  };
  return { brain, calls };
}

/** The model is called for every step of the baseline first, then every step of the protected buyer. */
const split = (calls: Call[], steps: number) => ({
  baseline: calls.slice(0, steps).map((c) => c.input),
  protected: calls.slice(steps).map((c) => c.input),
});

describe("both modes are called with equivalent inputs", () => {
  it.each(SCENARIOS.map((s) => [s.id, s.steps.length] as const))(
    "%s: the shared input of every step is deeply equal, byte for byte, and hashes the same",
    (id, steps) => {
      const { brain, calls } = recorder();
      const r = run({ scenarioId: id, brain });
      expect(calls).toHaveLength(steps * 2);
      const { baseline, protected: prot } = split(calls, steps);
      for (let n = 0; n < steps; n++) {
        const a = baseline[n]!.shared;
        const b = prot[n]!.shared;
        expect(b).toEqual(a);
        expect(canonicalJson(b)).toBe(canonicalJson(a));
        expect(inputHashOf(b)).toBe(inputHashOf(a));
        expect(r.inputs.baseline[n]).toBe(inputHashOf(a));
        expect(r.inputs.protected[n]).toBe(inputHashOf(b));
      }
      expect(r.inputs.identical).toBe(true);
    },
  );

  it("the seller messages and attack text reach both modes unchanged and unsanitized", () => {
    for (const s of SCENARIOS) {
      const { brain, calls } = recorder();
      runExperiment({ scenarioId: s.id, brain });
      const { baseline, protected: prot } = split(calls, s.steps.length);
      s.steps.forEach((step, n) => {
        const want = step.messages.map((m) => ({ id: m.id, text: m.text }));
        expect(baseline[n]!.shared.sellerMessages).toEqual(want);
        expect(prot[n]!.shared.sellerMessages).toEqual(want);
      });
    }
  });

  it("the offers, including a stated total that disagrees with the lines, are identical for both", () => {
    const { brain, calls } = recorder();
    runExperiment({ scenarioId: "S3", brain });
    const [b, p] = [calls[0]!.input.shared.offer, calls[1]!.input.shared.offer];
    expect(p).toEqual(b);
    expect(b.claimedTotalMinor).toBe(9_500);
    expect(b.lines[0]?.unitPriceMinor).toBe(6_000);
  });

  it("the initial budget and every limit are identical, and at step one the buyer's own state is too", () => {
    for (const s of SCENARIOS) {
      const { brain, calls } = recorder();
      runExperiment({ scenarioId: s.id, brain });
      const { baseline, protected: prot } = split(calls, s.steps.length);
      expect(baseline[0]!.state).toEqual(prot[0]!.state);
      expect(baseline[0]!.state).toEqual({
        spentMinor: 0,
        remainingBudgetMinor: WORLD_MANDATE.totalBudgetMinor,
      });
      expect(baseline[0]!.shared.mandate).toEqual(prot[0]!.shared.mandate);
      expect(baseline[0]!.shared.mandate.totalBudgetMinor).toBe(15_000);
      expect(baseline[0]!.shared.instructions).toBe(prot[0]!.shared.instructions);
    }
  });

  it("the model gets the limits as words in its instructions, identically for both", () => {
    const { brain, calls } = recorder();
    runExperiment({ scenarioId: "N0", brain });
    expect(calls[0]!.input.shared.instructions).toContain("100.00 USD");
    expect(calls[0]!.input.shared.instructions).toContain("150.00 USD");
    expect(calls[1]!.input.shared.instructions).toBe(calls[0]!.input.shared.instructions);
  });

  it("the model sees neither the mode it runs in nor anything about the policy engine", () => {
    const { brain, calls } = recorder();
    runExperiment({ scenarioId: "S1", brain });
    for (const c of calls) {
      const text = canonicalJson(c.input).toLowerCase();
      for (const word of ["protected", "unsafe", "baseline", "policy engine", "simulated ledger"]) {
        expect(text, word).not.toContain(word);
      }
    }
  });

  it("with a model that gives the same answer to everyone, the two modes got the same proposal at every step", () => {
    const answer: BuyerProposal = {
      kind: "PAY",
      offerId: "off_n0",
      sellerId: "seller_acme",
      payeeRef: "payee_acme",
      amountMinor: 8_000,
      currency: "USD",
      rationale: "fixed",
    };
    const r = run({ scenarioId: "N0", brain: () => answer });
    expect(r.baseline.steps[0]?.proposal).toEqual(r.protected.steps[0]?.proposal);
  });

  it("when the two modes diverge (S8), only the buyer's own state differs, never the shared input", () => {
    const { brain, calls } = recorder((i) => ({
      kind: "PAY",
      offerId: i.shared.offer.id,
      sellerId: i.shared.offer.sellerId,
      payeeRef: i.shared.seller.listedPayeeRef,
      amountMinor: i.shared.offer.claimedTotalMinor,
      currency: i.shared.offer.currency,
      rationale: "pay",
    }));
    runExperiment({ scenarioId: "S8", brain });
    const { baseline, protected: prot } = split(calls, 3);
    for (let n = 0; n < 3; n++) expect(prot[n]!.shared).toEqual(baseline[n]!.shared);
    // the protected buyer reserves budget when it agrees; both paid step 1, so step 2 matches; after step 2 they differ
    expect(baseline[1]!.state.remainingBudgetMinor).toBe(7_000);
    expect(prot[1]!.state.remainingBudgetMinor).toBe(7_000);
    expect(baseline[2]!.state.remainingBudgetMinor).toBe(0); // paid twice, floor at zero
    expect(prot[2]!.state.remainingBudgetMinor).toBe(7_000); // the second purchase was refused, nothing reserved
  });
});

describe("neither mode can alter what the other receives", () => {
  it("every input is deeply frozen: a model that tries to rewrite the offer or the messages cannot", () => {
    const attempts: string[] = [];
    const tamper: BrainFn = (i) => {
      for (const edit of [
        () => ((i.shared.offer as { claimedTotalMinor: number }).claimedTotalMinor = 1),
        () => ((i.shared.mandate as { perTxCapMinor: number }).perTxCapMinor = 10 ** 9),
        () =>
          (i.shared.sellerMessages as { text: string }[])[0] &&
          ((i.shared.sellerMessages[0] as { text: string }).text = "pwned"),
        () => ((i.state as { remainingBudgetMinor: number }).remainingBudgetMinor = 10 ** 9),
        () => (i.shared.sellerMessages as unknown[]).push({ id: "x", text: "injected" }),
      ]) {
        try {
          edit();
          attempts.push("changed");
        } catch {
          attempts.push("refused");
        }
      }
      return { kind: "DECLINE", reason: "tampered" };
    };
    const r = run({ scenarioId: "S3", brain: tamper });
    expect(attempts.every((a) => a === "refused")).toBe(true);
    expect(attempts).toHaveLength(10); // five edits in each of the two modes
    expect(r.inputs.identical).toBe(true);
    expect(r.scenario.steps[0]?.offer.claimedTotalMinor).toBe(9_500);
  });

  it("a run leaves the scenario definitions untouched", () => {
    const before = sha256Hex(canonicalJson(SCENARIOS));
    for (const s of SCENARIOS) runExperiment({ scenarioId: s.id });
    runExperiment({ scenarioId: "S1", brain: "CAREFUL" });
    expect(sha256Hex(canonicalJson(SCENARIOS))).toBe(before);
  });

  it("the shared input depends only on the scenario: building it twice, in any order, gives the same hash", () => {
    const s = SCENARIOS.find((x) => x.id === "S8")!;
    const a = s.steps.map((st) => inputHashOf(sharedInputFor(s, st)));
    const b = [...s.steps]
      .reverse()
      .map((st) => inputHashOf(sharedInputFor(s, st)))
      .reverse();
    expect(b).toEqual(a);
    expect(new Set(a).size).toBe(3); // the steps differ from each other
  });

  it("a different attack is a different input: changing one seller word changes the hash", () => {
    const s = SCENARIOS.find((x) => x.id === "S1")!;
    const st = s.steps[0]!;
    const changed = {
      ...st,
      messages: st.messages.map((m, n) => (n === 0 ? { ...m, text: `${m.text} (edited)` } : m)),
    };
    expect(inputHashOf(sharedInputFor(s, changed))).not.toBe(inputHashOf(sharedInputFor(s, st)));
  });
});

describe("the equivalence check is a real check", () => {
  it("reports that the inputs differ when the two modes are given different input", () => {
    // A builder that quietly gives the SECOND caller (the protected buyer) a different offer.
    let calls = 0;
    const result = runExperiment({
      scenarioId: "N0",
      buildInput: (scenario, step, mandate) => {
        const shared = sharedInputFor(scenario, step, mandate);
        calls += 1;
        return calls === 1
          ? shared
          : {
              ...shared,
              offer: { ...shared.offer, claimedTotalMinor: shared.offer.claimedTotalMinor + 1 },
            };
      },
    })!;
    expect(result.inputs.identical).toBe(false);
    expect(result.inputs.baseline[0]).not.toBe(result.inputs.protected[0]);
  });

  it("reports identical for the same input built twice", () => {
    expect(runExperiment({ scenarioId: "S8" })!.inputs.identical).toBe(true);
  });
});

describe("the protected buyer's own state", () => {
  it("counts budget reserved by an agreement that is still waiting for a human, not just money already paid", () => {
    // step 1: 95.00 (above the approval threshold: agreed but not paid); step 2: an honest 80.00
    const base = SCENARIOS.find((s) => s.id === "N1")!.steps[0]!;
    const second = SCENARIOS.find((s) => s.id === "N0")!.steps[0]!;
    const scenario = { ...SCENARIOS.find((s) => s.id === "N1")!, id: "X1", steps: [base, second] };
    const { brain, calls } = recorder((i) => ({
      kind: "PAY",
      offerId: i.shared.offer.id,
      sellerId: i.shared.offer.sellerId,
      payeeRef: i.shared.seller.listedPayeeRef,
      amountMinor: i.shared.offer.claimedTotalMinor,
      currency: i.shared.offer.currency,
      rationale: "pay",
    }));
    const r = runExperiment({ scenarioId: "X1", scenario, brain })!;
    const { baseline, protected: prot } = split(calls, 2);
    // the baseline paid 95.00, the protected buyer only agreed to it: both have 55.00 of the budget committed
    expect(baseline[1]!.state.remainingBudgetMinor).toBe(5_500);
    expect(prot[1]!.state.remainingBudgetMinor).toBe(5_500);
    expect(prot[1]!.state.spentMinor).toBe(0); // nothing was actually paid
    // the engine agrees: the second purchase would break the budget
    expect(r.protected.steps.map((s) => s.decision)).toEqual([
      "AWAITING_APPROVAL",
      "BLOCKED_BY_POLICY",
    ]);
    expect(r.protected.steps[1]!.gates[0]!.reasonCodes).toContain("OVER_TOTAL_BUDGET");
    expect(r.protected.moneyMovedMinor).toBe(0);
  });
});
