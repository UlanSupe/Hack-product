import { describe, expect, it } from "vitest";

import {
  deriveJourney,
  hrefFor,
  NO_FACTS,
  PLAIN_STEPS,
  SCENARIOS,
  STEP_IDS,
  type JourneyFacts,
  type StepId,
  type StepStatus,
} from "@/domain/journey";

/**
 * The journey's progress is a pure function of stored facts. These tests state, fact by fact, what the screen must
 * say, and that it can never say more than the facts support.
 */

type Neg = NonNullable<JourneyFacts["negotiation"]>;
type Agr = NonNullable<Neg["agreement"]>;

const neg = (over: Partial<Neg> = {}): Neg => ({
  id: "neg_1",
  status: "OPEN",
  offers: 0,
  counters: 0,
  agentProposals: 0,
  refusal: null,
  agreement: null,
  pendingRevisions: 0,
  ...over,
});
const agr = (over: Partial<Agr> = {}): Agr => ({
  version: 1,
  totalText: "80.00 USD",
  approval: "NOT_REQUIRED",
  eligibility: "ELIGIBLE",
  eligibilityHeadline: "Allowed",
  transactionId: "tx_1",
  ...over,
});
const facts = (over: Partial<JourneyFacts> = {}): JourneyFacts => ({
  ...NO_FACTS,
  mandateApproved: true,
  paypalConfigured: true,
  ...over,
});

const statusOf = (f: JourneyFacts) =>
  Object.fromEntries(deriveJourney(f).steps.map((s) => [s.id, s.status])) as Record<
    StepId,
    StepStatus
  >;

describe("the nine steps", () => {
  it("are always nine, in order, and the ninth is always a simulation", () => {
    const j = deriveJourney(NO_FACTS);
    expect(j.steps.map((s) => s.id)).toEqual([...STEP_IDS]);
    expect(j.steps.map((s) => s.number)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]);
    expect(j.steps[8]).toMatchObject({ id: "replay", status: "SIMULATION" });
    expect(j.steps[8]?.detail).toMatch(/does not use your mandate, database or PayPal/);
  });

  it("have plain links that work with no state at all", () => {
    expect(PLAIN_STEPS.map((s) => s.id)).toEqual([...STEP_IDS]);
    expect(PLAIN_STEPS.find((s) => s.id === "replay")?.href).toBe("/flagship");
    expect(PLAIN_STEPS.find((s) => s.id === "mandate")?.href).toBe("/mandate");
  });
});

describe("what each fact changes", () => {
  it("nothing started: the task is the next step (the scenario is the way in to it), and no later step claims progress", () => {
    const j = deriveJourney(facts());
    expect(j.currentId).toBe("task");
    expect(statusOf(facts())).toMatchObject({
      scenario: "TODO",
      mandate: "DONE",
      task: "CURRENT",
      offers: "TODO",
      payment: "TODO",
      verify: "TODO",
    });
    expect(j.complete).toBe(false);
    expect(j.negotiationId).toBeNull();
  });

  it("no approved mandate: the mandate and the task are blocked, and the reason is stated", () => {
    const j = deriveJourney(facts({ mandateApproved: false }));
    const by = Object.fromEntries(j.steps.map((s) => [s.id, s]));
    expect(by["mandate"]).toMatchObject({ status: "BLOCKED" });
    expect(by["mandate"]?.detail).toMatch(/No approved mandate/);
    expect(by["task"]).toMatchObject({ status: "BLOCKED" });
    expect(j.currentId).toBe("mandate");
  });

  it("a submitted task completes steps 1 and 3 and points at the offers", () => {
    const j = deriveJourney(facts({ negotiation: neg() }));
    expect(statusOf(facts({ negotiation: neg() }))).toMatchObject({
      scenario: "DONE",
      task: "DONE",
      offers: "CURRENT",
    });
    expect(j.currentId).toBe("offers");
    expect(j.next?.href).toBe("/negotiations?n=neg_1#threads-h");
  });

  it("offers completes step 4; agent proposals complete step 5; counters alone also count", () => {
    expect(statusOf(facts({ negotiation: neg({ offers: 2 }) }))).toMatchObject({
      offers: "DONE",
      negotiation: "TODO",
    });
    expect(
      statusOf(facts({ negotiation: neg({ offers: 1, agentProposals: 1 }) })).negotiation,
    ).toBe("DONE");
    expect(statusOf(facts({ negotiation: neg({ offers: 1, counters: 1 }) })).negotiation).toBe(
      "DONE",
    );
  });

  it("an agreement reached by hand says no agent was run instead of pretending one was", () => {
    const f = facts({ negotiation: neg({ status: "AGREED", offers: 1, agreement: agr() }) });
    const step = deriveJourney(f).steps.find((s) => s.id === "negotiation");
    expect(step?.status).toBe("DONE");
    expect(step?.detail).toMatch(/No agent was run/);
  });

  it("a policy refusal blocks the agreement and the payment, and names the reason code", () => {
    const f = facts({
      negotiation: neg({
        offers: 1,
        refusal: { code: "OVER_PER_TX_CAP", headline: "Over the per-transaction cap." },
      }),
    });
    const j = deriveJourney(f);
    const by = Object.fromEntries(j.steps.map((s) => [s.id, s]));
    expect(by["agreement"]?.status).toBe("BLOCKED");
    expect(by["agreement"]?.detail).toContain("OVER_PER_TX_CAP");
    expect(by["payment"]?.status).toBe("BLOCKED");
    expect(j.currentId).toBe("agreement");
    expect(j.complete).toBe(false);
  });

  it("an agreement that needs approval is the current step; payment waits", () => {
    const f = facts({
      negotiation: neg({
        status: "AGREED",
        offers: 1,
        agentProposals: 1,
        agreement: agr({ eligibility: "AWAITING_APPROVAL", approval: "REQUIRED" }),
      }),
    });
    expect(statusOf(f)).toMatchObject({ agreement: "CURRENT", payment: "TODO" });
    expect(deriveJourney(f).currentId).toBe("agreement");
  });

  it("an agreement the policy engine blocks is blocked, with the engine's own headline", () => {
    const f = facts({
      negotiation: neg({
        status: "AGREED",
        offers: 1,
        agreement: agr({ eligibility: "BLOCKED", eligibilityHeadline: "Mandate revoked." }),
      }),
    });
    const by = Object.fromEntries(deriveJourney(f).steps.map((s) => [s.id, s]));
    expect(by["agreement"]).toMatchObject({ status: "BLOCKED", detail: "Mandate revoked." });
    expect(by["payment"]?.status).toBe("BLOCKED");
  });

  it("payment: unavailable without credentials (and says nothing is simulated), current with them", () => {
    const base = neg({ status: "AGREED", offers: 1, agentProposals: 1, agreement: agr() });
    const without = deriveJourney(facts({ paypalConfigured: false, negotiation: base }));
    const step = without.steps.find((s) => s.id === "payment");
    expect(step?.status).toBe("UNAVAILABLE");
    expect(step?.detail).toMatch(/Nothing is simulated in its place/);
    expect(without.currentId).toBe("verify"); // an unavailable step is skipped, not claimed
    expect(deriveJourney(facts({ negotiation: base })).currentId).toBe("payment");
  });

  it("a held payment is current; a captured one is done only if PayPal's capture was observed", () => {
    const base = neg({ status: "AGREED", offers: 1, agentProposals: 1, agreement: agr() });
    const held = facts({
      negotiation: base,
      payment: { state: "AUTHORIZED", moneyMoved: false, headline: "Funds are on hold." },
    });
    expect(statusOf(held).payment).toBe("CURRENT");
    expect(deriveJourney(held).steps.find((s) => s.id === "payment")?.detail).toBe(
      "Funds are on hold.",
    );
    const captured = facts({
      negotiation: base,
      payment: { state: "CAPTURED", moneyMoved: true, headline: "Paid." },
      audit: "VERIFIED",
    });
    const j = deriveJourney(captured);
    expect(statusOf(captured)).toMatchObject({ payment: "DONE", verify: "DONE" });
    expect(j.complete).toBe(true);
    expect(j.next).toBeNull();
  });

  it("a voided hold is final but says nothing was charged", () => {
    const f = facts({
      negotiation: neg({ status: "AGREED", offers: 1, agentProposals: 1, agreement: agr() }),
      payment: { state: "VOIDED", moneyMoved: false, headline: "Released." },
      audit: "VERIFIED",
    });
    const step = deriveJourney(f).steps.find((s) => s.id === "payment");
    expect(step?.status).toBe("DONE");
    expect(step?.detail).toMatch(/Nothing was charged/);
  });

  it.each(["FAILED", "REJECTED", "CANCELLED", "NEEDS_RECONCILIATION", "REVERSED"])(
    "payment state %s is never shown as done",
    (state) => {
      const f = facts({
        negotiation: neg({ status: "AGREED", offers: 1, agreement: agr() }),
        payment: { state, moneyMoved: false, headline: `State ${state}.` },
      });
      expect(statusOf(f).payment).toBe("BLOCKED");
      expect(deriveJourney(f).complete).toBe(false);
    },
  );

  it("a broken audit chain blocks verification even after a capture", () => {
    const f = facts({
      negotiation: neg({ status: "AGREED", offers: 1, agentProposals: 1, agreement: agr() }),
      payment: { state: "CAPTURED", moneyMoved: true, headline: "Paid." },
      audit: "BROKEN",
    });
    const j = deriveJourney(f);
    expect(statusOf(f).verify).toBe("BLOCKED");
    expect(j.complete).toBe(false);
    expect(j.currentId).toBe("verify");
  });

  it("a verified chain is not enough while the payment is not final", () => {
    const f = facts({
      negotiation: neg({ status: "AGREED", offers: 1, agentProposals: 1, agreement: agr() }),
      payment: { state: "AUTHORIZED", moneyMoved: false, headline: "Hold." },
      audit: "VERIFIED",
    });
    expect(statusOf(f).verify).toBe("TODO");
  });

  it("a closed negotiation without an agreement is blocked with its status", () => {
    const f = facts({ negotiation: neg({ status: "TIMED_OUT", offers: 1 }) });
    const step = deriveJourney(f).steps.find((s) => s.id === "agreement");
    expect(step?.status).toBe("BLOCKED");
    expect(step?.detail).toMatch(/timed out/);
  });
});

describe("links carry the transaction", () => {
  const f = facts({
    negotiation: neg({ id: "neg_a-b_9", agreement: agr({ transactionId: "tx_77" }) }),
  });
  it("every page link keeps ?n= so the progress bar finds the same transaction again", () => {
    expect(hrefFor("scenario", f)).toBe("/?n=neg_a-b_9");
    expect(hrefFor("mandate", f)).toBe("/mandate?n=neg_a-b_9");
    expect(hrefFor("replay", f)).toBe("/flagship?n=neg_a-b_9");
    expect(hrefFor("verify", f)).toBe("/cockpit/tx%3Atx_77?n=neg_a-b_9");
    expect(hrefFor("payment", f)).toBe("/negotiations?n=neg_a-b_9#pay-h");
  });
  it("without a transaction the links are plain and the task link opens the default scenario", () => {
    expect(hrefFor("verify", NO_FACTS)).toBe("/cockpit");
    expect(hrefFor("task", NO_FACTS)).toBe("/negotiations?scenario=compute-within-budget");
  });
  it("an id is encoded, never trusted as markup", () => {
    const hostile = facts({ negotiation: neg({ id: "a b&c" }) });
    expect(hrefFor("mandate", hostile)).toBe("/mandate?n=a%20b%26c");
  });
});

describe("derivation is total and consistent", () => {
  const MANDATE = [true, false];
  const PAYPAL = [true, false];
  const NEGS: (Neg | null)[] = [
    null,
    neg(),
    neg({ offers: 2 }),
    neg({ offers: 1, agentProposals: 1, counters: 1 }),
    neg({ offers: 1, refusal: { code: "X", headline: "x" } }),
    neg({ status: "CANCELLED" }),
    neg({ status: "AGREED", offers: 1, agreement: agr() }),
    neg({ status: "AGREED", offers: 1, agreement: agr({ eligibility: "AWAITING_APPROVAL" }) }),
    neg({ status: "AGREED", offers: 1, agreement: agr({ eligibility: "BLOCKED" }) }),
    neg({ status: "AGREED", offers: 1, agreement: agr({ eligibility: null }) }),
  ];
  const PAYMENTS = [
    null,
    { state: "ORDER_CREATED", moneyMoved: false, headline: "h" },
    { state: "AUTHORIZED", moneyMoved: false, headline: "h" },
    { state: "CAPTURED", moneyMoved: true, headline: "h" },
    { state: "VOIDED", moneyMoved: false, headline: "h" },
    { state: "FAILED", moneyMoved: false, headline: "h" },
  ];
  const AUDITS: JourneyFacts["audit"][] = [null, "VERIFIED", "BROKEN", "NO_EVENTS", "UNKNOWN"];

  it("every combination yields nine steps, a current step among the real eight, and a coherent flag", () => {
    let count = 0;
    for (const mandateApproved of MANDATE)
      for (const paypalConfigured of PAYPAL)
        for (const negotiation of NEGS)
          for (const payment of PAYMENTS)
            for (const audit of AUDITS) {
              const f: JourneyFacts = {
                mandateApproved,
                paypalConfigured,
                negotiation,
                payment,
                audit,
              };
              const j = deriveJourney(f);
              count++;
              expect(j.steps).toHaveLength(9);
              expect(STEP_IDS.slice(0, 8)).toContain(j.currentId);
              expect(j.complete).toBe(j.steps.slice(0, 8).every((s) => s.status === "DONE"));
              expect(j.next === null).toBe(j.complete);
              expect(j.steps[8]?.status).toBe("SIMULATION");
              // the simulation never counts toward completion
              expect(
                j.steps.filter((s) => s.status === "DONE").some((s) => s.id === "replay"),
              ).toBe(false);
              // money is only ever "paid" when the payment fact says captured
              if (j.steps.find((s) => s.id === "payment")?.status === "DONE" && payment)
                expect(["CAPTURED", "VOIDED"]).toContain(payment.state);
              if (j.complete) {
                expect(payment?.state).toMatch(/^(CAPTURED|VOIDED)$/);
                expect(audit).toBe("VERIFIED");
                expect(negotiation?.agreement).not.toBeNull();
              }
            }
    expect(count).toBe(2 * 2 * NEGS.length * PAYMENTS.length * AUDITS.length);
  });
});

describe("scenario fixtures", () => {
  it("are labelled by kind, and only the operator-transaction one carries task values", () => {
    expect(SCENARIOS.map((s) => s.kind)).toEqual(["OPERATOR_TRANSACTION", "SIMULATED_REPLAY"]);
    expect(SCENARIOS[0]?.task).toBeDefined();
    expect(SCENARIOS[1]?.task).toBeUndefined();
  });
  it("the fixture task stays inside the seeded mandate (so the demo path is not a policy trap)", () => {
    const t = SCENARIOS[0]?.task;
    expect(t?.category).toBe("COMPUTE");
    expect(t?.sellerIds).toEqual(["seller_acme"]);
    expect(Number(t?.maxTotal)).toBeLessThanOrEqual(100); // the seeded per-transaction cap
  });
});
