import { describe, expect, it } from "vitest";

import {
  auditStateOf,
  decisionOfOutcome,
  detailHref,
  detailOfAttackRun,
  detailOfRefused,
  detailOfTransaction,
  formatAmount,
  mapAttackRun,
  mapBenchmarkRun,
  mapRefusedOffer,
  mapTransaction,
  paypalVerificationOf,
  type BenchmarkRun,
} from "@/domain/cockpit";

import { CHAIN_OK, attackRun, chainBrokenAt, refused, tx } from "./facts";

describe("transactions", () => {
  it("maps an agreed transaction to every column from stored fields", () => {
    expect(mapTransaction(tx(), CHAIN_OK)).toEqual({
      id: "tx:tx_1",
      source: "TRANSACTION",
      timestamp: "2026-10-12T09:05:00.000Z",
      refId: "tx_1",
      scenario: "neg_1",
      category: "COMPUTE",
      buyerMode: "PROTECTED",
      currency: "USD",
      proposedMinor: 8_000,
      approvedMinor: 8_000,
      movedMinor: 0,
      decision: "ALLOWED",
      reasonCodes: [],
      reasonSource: null,
      paymentStatus: "AGREED",
      verification: "NOT_APPLICABLE",
      verificationBasis: "NONE",
      auditChain: "VERIFIED",
    });
  });

  it("keeps the seller's proposed amount apart from the approved one, and never invents an approval", () => {
    const r = mapTransaction(tx({ proposedMinor: 9_500, agreement: null }), CHAIN_OK);
    expect(r.proposedMinor).toBe(9_500);
    expect(r.approvedMinor).toBeNull();
  });

  it("uses the NEWEST policy decision and reads 'only a human is missing' as held, not denied", () => {
    const held = mapTransaction(
      tx({
        decisions: [
          {
            id: "a",
            subject: "ACCEPT_OFFER",
            verdict: "ALLOW",
            reasonCodes: [],
            decidedAt: "2026-10-12T09:00:00.000Z",
          },
          {
            id: "b",
            subject: "CREATE_ORDER",
            verdict: "DENY",
            reasonCodes: ["APPROVAL_REQUIRED"],
            decidedAt: "2026-10-12T09:10:00.000Z",
          },
        ],
      }),
      CHAIN_OK,
    );
    expect(held).toMatchObject({
      decision: "HELD_FOR_HUMAN",
      reasonCodes: ["APPROVAL_REQUIRED"],
      reasonSource: "POLICY",
    });
    const denied = mapTransaction(
      tx({
        decisions: [
          {
            id: "b",
            subject: "CREATE_ORDER",
            verdict: "DENY",
            reasonCodes: ["APPROVAL_REQUIRED", "MANDATE_STALE"],
            decidedAt: "2026-10-12T09:10:00.000Z",
          },
        ],
      }),
      CHAIN_OK,
    );
    expect(denied.decision).toBe("DENIED");
    expect(mapTransaction(tx({ decisions: [] }), CHAIN_OK).decision).toBe("NOT_EVALUATED");
  });

  describe("PayPal verification is never stronger than what was recorded", () => {
    const observed = {
      seq: 9,
      ts: "t",
      type: "PAYPAL_ORDER_OBSERVED",
      actor: "PAYPAL_API",
      provenance: "OBSERVED_EXTERNAL",
    };
    const base = { state: "ORDER_CREATED", paypalOrderId: "ORD1", events: [], webhooks: [] };
    it.each([
      ["no PayPal order", { ...base, paypalOrderId: null }, "NOT_APPLICABLE"],
      ["an order with nothing observed", base, "UNVERIFIED"],
      ["an order we read back", { ...base, events: [observed] }, "OBSERVED"],
      [
        "a read-back that is only a local note",
        { ...base, events: [{ ...observed, provenance: "LOCAL_DECISION" }] },
        "UNVERIFIED",
      ],
      [
        "a read-back and a processed webhook",
        {
          ...base,
          events: [observed],
          webhooks: [{ paypalEventId: "e", eventType: "x", status: "PROCESSED", reason: null }],
        },
        "WEBHOOK_VERIFIED",
      ],
      [
        "a webhook alone, never read back",
        {
          ...base,
          webhooks: [{ paypalEventId: "e", eventType: "x", status: "PROCESSED", reason: null }],
        },
        "UNVERIFIED",
      ],
      [
        "an ignored webhook does not count",
        {
          ...base,
          events: [observed],
          webhooks: [{ paypalEventId: "e", eventType: "x", status: "IGNORED", reason: "r" }],
        },
        "OBSERVED",
      ],
      [
        "a payment parked for reconciliation",
        { ...base, state: "NEEDS_RECONCILIATION", events: [observed] },
        "NEEDS_RECONCILIATION",
      ],
    ] as const)("%s", (_n, facts, want) => {
      expect(paypalVerificationOf(facts as never)).toBe(want);
    });
  });

  it("carries the PayPal payment status as the stored state, whatever it is", () => {
    for (const state of ["CAPTURE_PENDING", "AUTHORIZED", "CAPTURED", "VOIDED"])
      expect(mapTransaction(tx({ state, paypalOrderId: "O" }), CHAIN_OK).paymentStatus).toBe(state);
  });
});

describe("the audit chain, per row", () => {
  const span = { firstSeq: 3, lastSeq: 4, count: 2 };
  it.each([
    ["verifies and the row has events", CHAIN_OK, span, "VERIFIED"],
    ["fails after the row's last event", chainBrokenAt(5), span, "VERIFIED"],
    ["fails exactly at the row's last event", chainBrokenAt(4), span, "BROKEN"],
    ["fails before the row", chainBrokenAt(1), span, "BROKEN"],
    ["has no events", CHAIN_OK, null, "NO_EVENTS"],
    ["has an empty event list", CHAIN_OK, { firstSeq: 0, lastSeq: 0, count: 0 }, "NO_EVENTS"],
    ["could not be read", { status: "UNREADABLE", message: "x" } as const, span, "UNKNOWN"],
    [
      "could not be read and the row has no events",
      { status: "UNREADABLE", message: "x" } as const,
      null,
      "UNKNOWN",
    ],
  ] as const)("a chain that %s -> %s", (_n, chain, events, want) => {
    expect(auditStateOf(chain, events)).toBe(want);
  });

  it("marks a transaction BROKEN when the chain's first bad event is one of its own", () => {
    expect(mapTransaction(tx(), chainBrokenAt(4)).auditChain).toBe("BROKEN");
    expect(mapTransaction(tx(), chainBrokenAt(99)).auditChain).toBe("VERIFIED");
  });
});

describe("refused offers", () => {
  it("is a denied row with the policy's reason codes, no transaction and no approved amount", () => {
    expect(mapRefusedOffer(refused(), CHAIN_OK)).toEqual({
      id: "refused:chk_1",
      source: "REFUSED_OFFER",
      timestamp: "2026-10-12T10:00:00.000Z",
      refId: "ofr_9",
      scenario: "neg_2",
      category: "COMPUTE",
      buyerMode: "PROTECTED",
      currency: "USD",
      proposedMinor: 45_000,
      approvedMinor: null,
      movedMinor: 0,
      decision: "DENIED",
      reasonCodes: ["OVER_PER_TX_CAP", "PRICE_NOT_IN_CATALOG"],
      reasonSource: "POLICY",
      paymentStatus: "NO_TRANSACTION",
      verification: "NOT_APPLICABLE",
      verificationBasis: "NONE",
      auditChain: "VERIFIED",
    });
  });
  it("reports NO_EVENTS when the refusal's audit event cannot be found", () => {
    expect(mapRefusedOffer(refused({ events: [] }), CHAIN_OK).auditChain).toBe("NO_EVENTS");
  });
  it("but a row that should have events and has none, in a log known to be broken, is BROKEN, not 'no events'", () => {
    expect(mapRefusedOffer(refused({ events: [] }), chainBrokenAt(12)).auditChain).toBe("BROKEN");
    expect(mapTransaction(tx({ events: [] }), chainBrokenAt(1)).auditChain).toBe("BROKEN");
    expect(mapTransaction(tx({ events: [] }), CHAIN_OK).auditChain).toBe("NO_EVENTS");
    expect(
      mapTransaction(tx({ events: [] }), { status: "UNREADABLE", message: "x" }).auditChain,
    ).toBe("UNKNOWN");
  });
});

describe("attack runs", () => {
  it.each([
    ["a protected run that was blocked", attackRun(), "DENIED"],
    [
      "an unsafe run that paid",
      attackRun({
        mode: "UNSAFE_BASELINE",
        moneyMovedMinor: 4_500,
        steps: [{ n: 1, outcome: "EXECUTED", reasonCodes: [] }],
      }),
      "EXECUTED_UNCHECKED",
    ],
    [
      "a protected run that paid",
      attackRun({ moneyMovedMinor: 800, steps: [{ n: 1, outcome: "EXECUTED", reasonCodes: [] }] }),
      "ALLOWED",
    ],
    [
      "a run with both",
      attackRun({
        steps: [
          { n: 1, outcome: "EXECUTED", reasonCodes: [] },
          { n: 2, outcome: "BLOCKED", reasonCodes: ["OVER_TOTAL_BUDGET"] },
        ],
      }),
      "MIXED",
    ],
    [
      "a run that did nothing",
      attackRun({ steps: [{ n: 1, outcome: "NO_ACTION", reasonCodes: [] }] }),
      "NO_ACTION",
    ],
    ["a run that never finished", attackRun({ finishedAt: null }), "NOT_EVALUATED"],
  ] as const)("%s -> %s", (_n, run, want) => {
    expect(mapAttackRun(run, CHAIN_OK).decision).toBe(want);
  });

  it("shows policy codes when there are some, violated invariants otherwise, and says which", () => {
    expect(mapAttackRun(attackRun(), CHAIN_OK)).toMatchObject({
      reasonCodes: ["OVER_PER_TX_CAP"],
      reasonSource: "POLICY",
    });
    const inv = mapAttackRun(
      attackRun({ steps: [], invariantsViolated: ["CAP_EXCEEDED"] }),
      CHAIN_OK,
    );
    expect(inv).toMatchObject({
      reasonCodes: ["CAP_EXCEEDED"],
      reasonSource: "INVARIANT",
      verification: "INVARIANTS_VIOLATED",
    });
  });

  it("uses the run's own audit range for the chain state, and marks the provider honestly", () => {
    const run = attackRun({ auditFromSeq: 10, auditToSeq: 14 });
    expect(mapAttackRun(run, chainBrokenAt(12)).auditChain).toBe("BROKEN");
    expect(mapAttackRun(run, chainBrokenAt(20)).auditChain).toBe("VERIFIED");
    expect(mapAttackRun(attackRun({ moneyMovedMinor: 100 }), CHAIN_OK).paymentStatus).toBe(
      "SIMULATED_PAID",
    );
    expect(mapAttackRun(attackRun({ provider: "PAYPAL_SANDBOX" }), CHAIN_OK).paymentStatus).toBe(
      "PAYPAL_SANDBOX",
    );
  });

  it("leaves the amount unset while a run is unfinished", () => {
    expect(
      mapAttackRun(attackRun({ finishedAt: null, moneyMovedMinor: 0 }), CHAIN_OK).approvedMinor,
    ).toBeNull();
  });
});

describe("benchmark runs", () => {
  const FILE = { generatedAt: "2026-11-04T10:00:00.000Z" };
  const run = (over: Partial<BenchmarkRun> = {}): BenchmarkRun => ({
    runId: "S1|PROTECTED|SUSCEPTIBLE",
    layer: "ARENA",
    caseId: "S1",
    evidenceUnit: "ARENA:S1",
    mechanism: "PROMPT_INJECTION",
    mode: "PROTECTED",
    executionMode: "SIMULATED_LEDGER",
    brain: "SUSCEPTIBLE",
    seed: null,
    caseFingerprint: "a".repeat(64),
    inputFingerprint: "b".repeat(64),
    duplicateOfCase: null,
    status: "COMPLETED",
    reason: null,
    expected: {
      intent: null,
      steps: [{ stepId: "s1", expected: "REFUSE", violations: ["OVER_BUDGET", "OVER_CAP"] }],
    },
    actual: {
      moneyMovedMinor: 0,
      harms: [],
      steps: [
        {
          stepId: "s1",
          actual: "BLOCKED",
          verdict: "AS_EXPECTED",
          policyConsulted: true,
          proposal: { amountMinor: 45_000, payeeRef: "payee_acme", currency: "USD" },
        },
      ],
    },
    verdict: "AS_EXPECTED",
    metrics: {
      attemptedViolations: 1,
      blockedViolations: 1,
      allowedViolations: 0,
      correctedViolations: 0,
      legitimateAttempts: 0,
      falseBlocks: 0,
      modelRestraint: 0,
      moneyMovedMinor: 0,
    },
    ...over,
  });

  it("maps a protected arena run: proposed amount, nothing approved, blocked, spec reasons labelled as spec", () => {
    expect(mapBenchmarkRun(run(), FILE)).toEqual({
      id: "bench:S1|PROTECTED|SUSCEPTIBLE",
      source: "BENCHMARK",
      timestamp: "2026-11-04T10:00:00.000Z",
      refId: "S1|PROTECTED|SUSCEPTIBLE",
      scenario: "S1",
      category: "PROMPT_INJECTION",
      buyerMode: "PROTECTED",
      currency: "USD",
      proposedMinor: 45_000,
      approvedMinor: 0,
      movedMinor: 0,
      decision: "DENIED",
      reasonCodes: ["OVER_BUDGET", "OVER_CAP"],
      reasonSource: "SPEC",
      paymentStatus: "NO_PAYMENT",
      verification: "AS_EXPECTED",
      verificationBasis: "BENCHMARK",
      auditChain: "NOT_RECORDED",
    });
  });

  it("maps the unsafe baseline that paid as EXECUTED_UNCHECKED with the simulated money that moved", () => {
    const r = mapBenchmarkRun(
      run({
        mode: "UNSAFE_BASELINE",
        verdict: "UNEXPECTED_ALLOWED",
        actual: {
          moneyMovedMinor: 45_000,
          harms: ["CAP_EXCEEDED"],
          steps: [
            {
              stepId: "s1",
              actual: "PAID_HARMFUL",
              verdict: "UNEXPECTED_ALLOWED",
              proposal: { amountMinor: 45_000, payeeRef: "p", currency: "USD" },
            },
          ],
        },
      }),
      FILE,
    );
    expect(r).toMatchObject({
      buyerMode: "UNSAFE_BASELINE",
      decision: "EXECUTED_UNCHECKED",
      approvedMinor: null, // the unsafe baseline has no approval
      movedMinor: 45_000,
      paymentStatus: "SIMULATED_PAID",
      verification: "UNEXPECTED_ALLOWED",
    });
  });

  it("sums the proposals of a multi-step run and calls a paid-then-blocked run MIXED", () => {
    const step = (id: string, actual: string, amountMinor: number) => ({
      stepId: id,
      actual,
      proposal: { amountMinor, payeeRef: "p", currency: "USD" },
    });
    const r = mapBenchmarkRun(
      run({
        actual: {
          moneyMovedMinor: 8_000,
          harms: [],
          steps: [step("a", "PAID_CLEAN", 8_000), step("b", "BLOCKED", 8_000)],
        },
      }),
      FILE,
    );
    expect(r).toMatchObject({ proposedMinor: 16_000, approvedMinor: 8_000, decision: "MIXED" });
  });

  it("treats a model that proposed nothing as NO_ACTION and an approval wait as HELD_FOR_HUMAN", () => {
    expect(
      mapBenchmarkRun(
        run({
          actual: {
            moneyMovedMinor: 0,
            harms: [],
            steps: [{ stepId: "s", actual: "MODEL_NO_ACTION", proposal: null }],
          },
        }),
        FILE,
      ),
    ).toMatchObject({ decision: "NO_ACTION", proposedMinor: null });
    expect(
      mapBenchmarkRun(
        run({
          actual: {
            moneyMovedMinor: 0,
            harms: [],
            steps: [
              {
                stepId: "s",
                actual: "AWAITING_APPROVAL",
                proposal: { amountMinor: 9_500, payeeRef: "p", currency: "USD" },
              },
            ],
          },
        }),
        FILE,
      ).decision,
    ).toBe("HELD_FOR_HUMAN");
  });

  it("maps a system run from its last outcome, its final transaction state and the money captured", () => {
    const r = mapBenchmarkRun(
      run({
        layer: "SYSTEM",
        mode: "PROTECTED",
        brain: null,
        runId: "APR-01|PROTECTED|-",
        caseId: "APR-01",
        mechanism: "APPROVAL_BYPASS",
        executionMode: "IN_MEMORY_SERVICES_FAKE_PAYPAL",
        expected: {},
        actual: {
          outcome: { verdict: "DENY", reasonCodes: ["APPROVAL_REQUIRED"], performed: false },
          txStates: ["AGREED"],
          capturedMinor: 0,
          paypalCalls: [],
        },
      }),
      FILE,
    );
    expect(r).toMatchObject({
      decision: "HELD_FOR_HUMAN",
      reasonCodes: ["APPROVAL_REQUIRED"],
      reasonSource: "POLICY",
      paymentStatus: "AGREED",
      approvedMinor: null,
      proposedMinor: null,
      currency: null,
    });
    const captured = mapBenchmarkRun(
      run({
        layer: "SYSTEM",
        brain: null,
        actual: { outcome: { performed: true }, txStates: ["CAPTURED"], capturedMinor: 8_000 },
      }),
      FILE,
    );
    expect(captured).toMatchObject({
      decision: "ALLOWED",
      paymentStatus: "CAPTURED",
      approvedMinor: 8_000,
    });
    const none = mapBenchmarkRun(
      run({
        layer: "SYSTEM",
        brain: null,
        actual: { outcome: {}, txStates: [], capturedMinor: 0 },
      }),
      FILE,
    );
    expect(none.paymentStatus).toBe("NO_TRANSACTION");
  });

  it("does not present runs that never produced a judged outcome as results", () => {
    const skipped = mapBenchmarkRun(
      run({
        status: "SKIPPED",
        reason: "NO_BASELINE_ANALOGUE",
        verdict: "NOT_EVALUATED",
        actual: null,
        expected: null,
        mode: "UNSAFE_BASELINE",
      }),
      FILE,
    );
    expect(skipped).toMatchObject({
      decision: "NO_ACTION",
      paymentStatus: "NOT_EXECUTED",
      verification: "SKIPPED",
      approvedMinor: null,
      reasonCodes: [],
    });
    const infra = mapBenchmarkRun(
      run({ status: "INFRASTRUCTURE_ERROR", verdict: "NOT_EVALUATED", actual: null }),
      FILE,
    );
    expect(infra).toMatchObject({
      decision: "NOT_EVALUATED",
      paymentStatus: "INFRASTRUCTURE_ERROR",
      verification: "INFRASTRUCTURE_ERROR",
    });
    const model = mapBenchmarkRun(run({ status: "MODEL_ERROR", verdict: "NOT_EVALUATED" }), FILE);
    expect(model.verification).toBe("MODEL_ERROR");
  });

  it("survives records whose expected and actual have an unexpected shape, without inventing values", () => {
    for (const actual of [null, "text", 5, [], { steps: "no" }, { steps: [null, 3] }]) {
      const r = mapBenchmarkRun(run({ actual, expected: actual }), FILE);
      expect(r.proposedMinor).toBeNull();
      expect(r.reasonCodes).toEqual([]);
    }
  });
});

describe("system outcomes read as decisions", () => {
  it.each([
    [{ verdict: "ALLOW" }, "ALLOWED"],
    [{ verdict: "DENY", reasonCodes: ["OVER_PER_TX_CAP"] }, "DENIED"],
    [{ verdict: "DENY", reasonCodes: ["APPROVAL_REQUIRED"] }, "HELD_FOR_HUMAN"],
    [{ accepted: false }, "DENIED"],
    [{ error: "FORBIDDEN" }, "DENIED"],
    [{ status: "REJECTED", http: 401 }, "DENIED"],
    [{ status: "RETRY", http: 503 }, "DENIED"],
    [{ status: "PROCESSED" }, "ALLOWED"],
    [{ status: "DUPLICATE" }, "NO_ACTION"],
    [{ status: "IGNORED" }, "NO_ACTION"],
    [{ failureKind: "MALFORMED" }, "NO_ACTION"],
    [{ agentStatus: "APPROVAL_REQUESTED" }, "HELD_FOR_HUMAN"],
    [{ agentStatus: "NO_DEAL" }, "NO_ACTION"],
    [{ performed: true }, "ALLOWED"],
    [{ performed: false }, "NO_ACTION"],
    [{}, "NOT_EVALUATED"],
  ] as const)("%j -> %s", (outcome, want) => {
    expect(decisionOfOutcome(outcome as never)).toBe(want);
  });
});

describe("amounts and links", () => {
  it("formats exact minor units, and says 'not recorded' rather than 0 when there is none", () => {
    expect(formatAmount(8_000, "USD")).toBe("80.00 USD");
    expect(formatAmount(5, "USD")).toBe("0.05 USD");
    expect(formatAmount(0, "USD")).toBe("0.00 USD");
    expect(formatAmount(null, "USD")).toBe("not recorded");
    expect(formatAmount(1_234, "JPY")).toBe("1234 JPY");
    expect(formatAmount(10, "XYZ")).toBe("10 minor units (XYZ)");
    expect(formatAmount(10, null)).toBe("10 minor units");
  });
  it("builds a detail link that survives every character a row id can contain", () => {
    for (const id of [
      "tx:tx_1",
      "bench:S1|PROTECTED|SUSCEPTIBLE",
      "bench:GEN-OVER-CAP-02|UNSAFE_BASELINE|CAREFUL",
      "refused:chk 1/2?x=1#y",
    ]) {
      const href = detailHref(id);
      expect(href.startsWith("/cockpit/")).toBe(true);
      expect(href.slice("/cockpit/".length)).not.toMatch(/[|:/?#\s]/);
      expect(decodeURIComponent(href.slice("/cockpit/".length))).toBe(id);
    }
  });
});

describe("details", () => {
  it("lists the decisions oldest first and carries the chain note", () => {
    const f = tx({
      decisions: [
        {
          id: "b",
          subject: "CREATE_ORDER",
          verdict: "DENY",
          reasonCodes: ["APPROVAL_REQUIRED"],
          decidedAt: "2026-10-12T09:10:00.000Z",
        },
        {
          id: "a",
          subject: "ACCEPT_OFFER",
          verdict: "ALLOW",
          reasonCodes: [],
          decidedAt: "2026-10-12T09:00:00.000Z",
        },
      ],
    });
    const d = detailOfTransaction(f, mapTransaction(f, chainBrokenAt(4)), chainBrokenAt(4));
    const decisions = d.sections.find((s) => s.title === "Policy decisions");
    expect(decisions?.items.map((i) => i.label)).toEqual([
      "2026-10-12T09:00:00.000Z ACCEPT_OFFER",
      "2026-10-12T09:10:00.000Z CREATE_ORDER",
    ]);
    expect(d.sections.find((s) => s.title === "Audit events")?.note).toMatch(/FAILS at event #4/);
    expect(d.sections[0]?.items.find((i) => i.label === "Agreement")?.value).toContain("80.00 USD");
  });
  it("describes refused offers and attack runs from their own records", () => {
    const r = refused();
    expect(
      detailOfRefused(r, mapRefusedOffer(r, CHAIN_OK), CHAIN_OK).sections[0]?.items.find(
        (i) => i.label === "Reason codes",
      )?.value,
    ).toBe("OVER_PER_TX_CAP, PRICE_NOT_IN_CATALOG");
    const a = attackRun();
    expect(detailOfAttackRun(a, mapAttackRun(a, CHAIN_OK)).sections[1]?.items[0]).toEqual({
      label: "Step 1",
      value: "BLOCKED: OVER_PER_TX_CAP",
    });
  });
});

describe("approved versus moved", () => {
  it("a captured transaction has moved what PayPal captured, and approved what the agreement says", () => {
    const r = mapTransaction(
      tx({ state: "CAPTURED", capturedMinor: 8_000, authorizedMinor: 8_000, paypalOrderId: "O" }),
      CHAIN_OK,
    );
    expect(r).toMatchObject({ approvedMinor: 8_000, movedMinor: 8_000 });
    expect(mapTransaction(tx(), CHAIN_OK).movedMinor).toBe(0);
  });
  it("the unsafe baseline moves money without any approval", () => {
    const run = attackRun({
      mode: "UNSAFE_BASELINE",
      moneyMovedMinor: 4_500,
      steps: [{ n: 1, outcome: "EXECUTED", reasonCodes: [] }],
    });
    expect(mapAttackRun(run, CHAIN_OK)).toMatchObject({ approvedMinor: null, movedMinor: 4_500 });
    expect(mapAttackRun({ ...run, mode: "PROTECTED" }, CHAIN_OK)).toMatchObject({
      approvedMinor: 4_500,
      movedMinor: 4_500,
    });
    expect(mapAttackRun({ ...run, finishedAt: null }, CHAIN_OK)).toMatchObject({
      approvedMinor: null,
      movedMinor: null,
    });
  });
});
