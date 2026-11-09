import { describe, expect, it } from "vitest";

import { insertMandateVersion } from "@/adapters/sqlite/store";
import { ConflictError, ForbiddenError, NotFoundError, UpstreamError } from "@/domain/errors";
import { RECONCILE_QUIET_MS } from "@/domain/payment";
import { ProviderError } from "@/ports/payment-provider";

import { AGENT, ANON, SYSTEM } from "../negotiation/world";
import { rejected, unknownFailure } from "./fake-paypal";
import { setup, type Harness } from "./harness";

/**
 * Capture (the charge) and void (release the hold), against a scripted fake PayPal. These tests show how OUR code
 * reacts to the shapes PayPal documents, including lost responses and races. They prove nothing about PayPal itself.
 */

async function hold(opts: Parameters<typeof setup>[0] = {}): Promise<Harness> {
  const h = setup(opts);
  const r = await h.startToHold();
  expect(r.view.state).toBe("AUTHORIZED");
  return h;
}
const calls = (h: Harness, op: string) => h.fake.calls.filter((c) => c.op === op);
const attemptsOf = (h: Harness, action: string) => h.attempts().filter((a) => a.action === action);
const stateChanges = (h: Harness): string[] =>
  (
    h.w.db
      .prepare(
        "SELECT payload FROM audit_events WHERE transaction_id = ? AND type = 'TX_STATE_CHANGED' ORDER BY seq",
      )
      .all(h.tx) as { payload: string }[]
  ).map((r) => {
    const p = JSON.parse(r.payload) as { from: string; to: string };
    return `${p.from}>${p.to}`;
  });
const decisions = (h: Harness) =>
  h.w.db
    .prepare(
      "SELECT subject, verdict, reason_codes AS codes FROM policy_decisions WHERE transaction_id = ? ORDER BY rowid",
    )
    .all(h.tx) as { subject: string; verdict: string; codes: string }[];
const slow = (h: Harness) => {
  const real = h.fake.provider.getOrder.bind(h.fake.provider);
  h.fake.provider.getOrder = async (id) => {
    await new Promise((r) => setTimeout(r, 5));
    return real(id);
  };
};

describe("capture: the charge, built from stored facts and believed only when PayPal's order says so", () => {
  it("captures the agreed total from the stored hold and is 'paid' only after reading a COMPLETED capture", async () => {
    const h = await hold();
    h.fake.calls.length = 0;
    const authId = h.row().paypal_authorization_id as string;

    const r = await h.capture();

    expect(r.performed).toBe(true);
    expect(r.view.state).toBe("CAPTURED");
    expect(r.view.moneyMoved).toBe(true);
    expect(r.view.headline).toMatch(/Captured/);
    expect(r.view.capture).toMatchObject({ amountText: "80.00 USD" });
    // read first, then the capture, then the read-back that is the evidence
    expect(h.fake.calls.map((c) => c.op)).toEqual(["getOrder", "captureAuthorization", "getOrder"]);
    expect(calls(h, "captureAuthorization")[0]).toMatchObject({
      authorizationId: authId,
      amountMinor: 8000,
      currency: "USD",
      requestId: `pp:${h.tx}:CAPTURE:1`,
    });
    expect(h.row()).toMatchObject({ state: "CAPTURED", captured_minor: 8000 });
    expect(typeof h.row().paypal_capture_id).toBe("string");
    expect(attemptsOf(h, "CAPTURE")).toEqual([
      expect.objectContaining({ seq: 1, status: "SUCCEEDED", httpStatus: 201 }),
    ]);
    expect(decisions(h).map((d) => `${d.subject}:${d.verdict}`)).toContain("CAPTURE:ALLOW");
    expect(stateChanges(h).slice(-2)).toEqual(["AUTHORIZED>CAPTURING", "CAPTURING>CAPTURED"]);
    expect(h.chainOk()).toBe(true);
  });

  it("the service cannot be told an amount, an authorization or a payee: it takes the actor and the negotiation id", async () => {
    const h = await hold();
    expect(h.service.capture.length).toBeLessThanOrEqual(2);
    expect(h.service.voidHold.length).toBeLessThanOrEqual(2);
  });

  it("a 2xx answer whose order does not yet show the capture is NOT paid: it stays unknown", async () => {
    const h = await hold();
    h.fake.behaviour.staleReads = true;
    const r = await h.capture();
    expect(r.view.state).toBe("NEEDS_RECONCILIATION");
    expect(r.view.moneyMoved).toBe(false);
    expect(r.notes.join(" ")).toMatch(/does not show its effect yet/);
    expect(attemptsOf(h, "CAPTURE")[0]?.status).toBe("UNKNOWN");
    expect(h.row().paypal_capture_id).toBeNull();

    // the read catches up: the existing capture is found; nothing is captured twice
    h.fake.behaviour.staleReads = false;
    const after = await h.refresh();
    expect(after.view.state).toBe("CAPTURED");
    expect(attemptsOf(h, "CAPTURE")[0]?.status).toBe("SUCCEEDED");
    expect(calls(h, "captureAuthorization")).toHaveLength(1);
    expect(h.fake.only().captures).toHaveLength(1);
  });

  it("if the read is stale for longer than the quiet period, a second capture is stopped by PayPal's own limit and reconciled, not doubled", async () => {
    const h = await hold();
    h.fake.behaviour.staleReads = true;
    await h.capture(); // took effect at PayPal, but reads cannot see it
    h.afterSeconds(RECONCILE_QUIET_MS / 1000 + 1);
    const settled = await h.refresh();
    expect(settled.view.state).toBe("AUTHORIZED"); // believed "nothing happened" (the documented limit of this rule)

    const again = await h.capture(); // a NEW request id; PayPal refuses: the authorization is already used up
    expect(again.view.state).toBe("NEEDS_RECONCILIATION");
    expect(calls(h, "captureAuthorization").map((c) => c.requestId)).toEqual([
      `pp:${h.tx}:CAPTURE:1`,
      `pp:${h.tx}:CAPTURE:2`,
    ]);
    expect(h.fake.only().captures).toHaveLength(1);

    h.fake.behaviour.staleReads = false;
    const fin = await h.refresh();
    expect(fin.view.state).toBe("CAPTURED");
    expect(h.fake.only().captures).toHaveLength(1);
    expect(h.row().captured_minor).toBe(8000);
  });
});

describe("only an authorized hold can be captured or released", () => {
  const early: [string, (h: Harness) => Promise<void>][] = [
    ["AGREED", async () => {}],
    [
      "ORDER_CREATED",
      async (h) => {
        await h.start();
      },
    ],
    [
      "ORDER_APPROVED",
      async (h) => {
        await h.startAndApprove();
        await h.refresh();
      },
    ],
    [
      "NEEDS_RECONCILIATION",
      async (h) => {
        h.fake.failNext({ op: "createOrder", when: "before", error: unknownFailure("NETWORK") });
        await h.start();
      },
    ],
    [
      "AUTHORIZATION_PENDING",
      async (h) => {
        await h.startAndApprove();
        h.fake.behaviour.authorizationStatus = "PENDING";
        await h.authorize();
      },
    ],
    [
      "FAILED",
      async (h) => {
        await h.startAndApprove();
        h.fake.behaviour.authorizationStatus = "DENIED";
        await h.authorize();
      },
    ],
  ];

  it.each(early)(
    "%s: capture and void are refused and nothing is sent to PayPal",
    async (state, reach) => {
      const h = setup();
      await reach(h);
      expect(h.state()).toBe(state);
      const before = h.fake.calls.length;
      await expect(h.capture()).rejects.toBeInstanceOf(ConflictError);
      await expect(h.voidHold()).rejects.toBeInstanceOf(ConflictError);
      expect(h.fake.calls).toHaveLength(before);
      expect(h.state()).toBe(state);
    },
  );

  it("a payment that FAILED after it had a hold (the hold vanished during a capture) can be neither captured nor released again", async () => {
    const h = await hold();
    h.fake.provider.captureAuthorization = () => {
      h.fake.patchAuthorization(h.fake.only().id, { status: "VOIDED" });
      return Promise.reject(rejected("PAYEE_BLOCKED_TRANSACTION"));
    };
    expect((await h.capture()).view.state).toBe("FAILED");
    expect(h.row().paypal_authorization_id).not.toBeNull();
    const before = h.fake.calls.length;
    await expect(h.capture()).rejects.toThrow(/state FAILED/);
    await expect(h.voidHold()).rejects.toThrow(/state FAILED/);
    expect(h.fake.calls).toHaveLength(before);
  });

  it("a released hold cannot be captured, and a captured payment cannot be released", async () => {
    const h = await hold();
    await h.voidHold();
    await expect(h.capture()).rejects.toThrow(/cannot be captured|released/);
    const g = await hold();
    await g.capture();
    await expect(g.voidHold()).rejects.toThrow(/captured/);
    expect(calls(g, "voidAuthorization")).toHaveLength(0);
  });
});

describe("unauthorized capture and void", () => {
  it("only the signed-in operator may run them; agents, the system and strangers are refused before PayPal is asked", async () => {
    const h = await hold();
    h.fake.calls.length = 0;
    for (const actor of [AGENT, SYSTEM, ANON]) {
      await expect(h.service.capture(actor, h.negotiationId)).rejects.toBeInstanceOf(
        ForbiddenError,
      );
      await expect(h.service.voidHold(actor, h.negotiationId)).rejects.toBeInstanceOf(
        ForbiddenError,
      );
    }
    expect(h.fake.calls).toHaveLength(0);
    expect(h.state()).toBe("AUTHORIZED");
  });

  it("an unknown negotiation is not found, and PayPal not configured is refused before any state changes", async () => {
    const h = await hold();
    await expect(h.service.capture(h.OP, "missing")).rejects.toBeInstanceOf(NotFoundError);
    const g = setup({ noProvider: true });
    await expect(g.capture()).rejects.toBeInstanceOf(UpstreamError);
    await expect(g.voidHold()).rejects.toBeInstanceOf(UpstreamError);
    expect(g.state()).toBe("AGREED");
  });

  it("a revoked mandate stops the capture: a recorded DENY, nothing sent, the hold still releasable", async () => {
    const h = await hold();
    insertMandateVersion(h.w.db, {
      id: "M1",
      ownerId: "op1",
      perTxCapMinor: 10_000,
      totalBudgetMinor: 15_000,
      approvalThresholdMinor: 10_000,
      requireReview: false,
      currency: "USD",
      allowedCategories: ["COMPUTE"],
      allowedSellerIds: ["seller_acme", "seller_other"],
      expiresAt: "2027-06-01T00:00:00.000Z",
      status: "REVOKED",
      now: h.w.clock.iso(),
    });
    const before = calls(h, "captureAuthorization").length;
    const r = await h.capture();
    expect(r.performed).toBe(false);
    expect(r.policy?.verdict).toBe("DENY");
    expect(r.policy?.reasonCodes).toContain("MANDATE_REVOKED");
    expect(calls(h, "captureAuthorization")).toHaveLength(before);
    expect(h.state()).toBe("AUTHORIZED");
    expect(decisions(h).at(-1)).toMatchObject({ subject: "CAPTURE", verdict: "DENY" });
    expect(h.auditTypes()).toContain("PAYMENT_POLICY_DENIED");

    // releasing only reduces exposure, so it is still allowed
    expect((await h.voidHold()).view.state).toBe("VOIDED");
  });

  it("a newer, non-revoked mandate version does not block capturing a hold the agreement already froze (policy 1.1.0 decision)", async () => {
    const h = await hold();
    insertMandateVersion(h.w.db, {
      id: "M1",
      ownerId: "op1",
      perTxCapMinor: 20_000,
      totalBudgetMinor: 30_000,
      approvalThresholdMinor: 10_000,
      requireReview: false,
      currency: "USD",
      allowedCategories: ["COMPUTE"],
      allowedSellerIds: ["seller_acme", "seller_other"],
      expiresAt: "2027-06-01T00:00:00.000Z",
      status: "ACTIVE",
      now: h.w.clock.iso(),
    });
    expect((await h.capture()).view.state).toBe("CAPTURED");
    expect(decisions(h).at(-1)).toMatchObject({ subject: "CAPTURE", verdict: "ALLOW" });
  });

  it("a hold older than its honor period (less a safety margin) is not captured, but can still be released", async () => {
    const h = await hold();
    h.afterSeconds(3 * 24 * 3600 - 3600); // exactly the margin before expiry
    const r = await h.capture();
    expect(r.policy?.reasonCodes).toContain("HONOR_PERIOD_ENDED");
    expect(calls(h, "captureAuthorization")).toHaveLength(0);
    expect(h.state()).toBe("AUTHORIZED");
    expect((await h.voidHold()).view.state).toBe("VOIDED");
  });

  it("just inside the honor period the capture still goes through", async () => {
    const h = await hold();
    h.afterSeconds(3 * 24 * 3600 - 3600 - 60);
    expect((await h.capture()).view.state).toBe("CAPTURED");
  });

  it("an agreement whose payment has started cannot be replaced by a new offer, so the held payment stays reachable", async () => {
    const h = await hold();
    expect(() => h.w.offer(h.negotiationId, "seller_acme", h.w.priced(7000))).toThrow(
      /already started/,
    );
    expect((await h.capture()).view.state).toBe("CAPTURED");
  });
});

describe("what PayPal reports must match our records, or nothing is captured", () => {
  const cases: [string, (h: Harness) => void, string][] = [
    [
      "authorization amount differs",
      (h) => h.fake.patchAuthorization(h.fake.only().id, { amountMinor: 7999 }),
      "AUTHORIZATION_AMOUNT_MISMATCH",
    ],
    [
      "authorization currency differs",
      (h) => h.fake.patchAuthorization(h.fake.only().id, { currency: "EUR" }),
      "AUTHORIZATION_CURRENCY_MISMATCH",
    ],
    [
      "a different authorization id",
      (h) => h.fake.patchAuthorization(h.fake.only().id, { id: "AUTHOTHER" }),
      "AUTHORIZATION_ID_MISMATCH",
    ],
    [
      "authorization carries another custom id",
      (h) => h.fake.patchAuthorization(h.fake.only().id, { customId: "tx_other" }),
      "AUTHORIZATION_CUSTOM_ID_MISMATCH",
    ],
    [
      "order amount differs",
      (h) => h.fake.patch(h.fake.only().id, { amountMinor: 9000 }),
      "AMOUNT_MISMATCH",
    ],
    [
      "payee differs",
      (h) => h.fake.patch(h.fake.only().id, { payeeMerchantId: "EVILMERCHANT" }),
      "PAYEE_MISMATCH",
    ],
    [
      "order custom id differs",
      (h) => h.fake.patch(h.fake.only().id, { customId: "tx_other" }),
      "CUSTOM_ID_MISMATCH",
    ],
    [
      "authorization status the flow does not know",
      (h) => h.fake.patchAuthorization(h.fake.only().id, { status: "SURPRISE" }),
      "AUTHORIZATION_STATUS_UNEXPECTED",
    ],
  ];

  it.each(cases)(
    "%s: refused with a recorded anomaly, no capture, the hold untouched",
    async (_name, tamper, finding) => {
      const h = await hold();
      tamper(h);
      const r = await h.capture();
      expect(r.performed).toBe(false);
      expect(r.notes.join(" ")).toMatch(/does not match the agreement/);
      expect(calls(h, "captureAuthorization")).toHaveLength(0);
      expect(h.state()).toBe("AUTHORIZED");
      expect(attemptsOf(h, "CAPTURE")).toHaveLength(0);
      const anomaly = h.w.db
        .prepare(
          "SELECT payload FROM audit_events WHERE transaction_id = ? AND type = 'PAYPAL_ANOMALY' ORDER BY seq DESC LIMIT 1",
        )
        .get(h.tx) as { payload: string };
      expect(anomaly.payload).toContain(finding);
      expect(h.chainOk()).toBe(true);
    },
  );

  it("if the stored agreement is tampered with after the hold, the hold no longer matches it and is not captured", async () => {
    const h = await hold();
    h.w.db.exec("DROP TRIGGER agreements_no_update"); // simulates a record changed outside the application
    h.w.db
      .prepare(
        "UPDATE agreements SET total_minor = 7900 WHERE id = (SELECT agreement_id FROM transactions WHERE id = ?)",
      )
      .run(h.tx);
    const r = await h.capture();
    expect(r.performed).toBe(false);
    expect(r.notes.join(" ")).toMatch(/does not match the agreement/);
    expect(calls(h, "captureAuthorization")).toHaveLength(0);
    expect(h.state()).toBe("AUTHORIZED");
  });

  it("PayPal stops reporting the payee: the destination can no longer be verified, so the policy refuses the capture", async () => {
    const h = await hold();
    h.fake.patch(h.fake.only().id, { payeeMerchantId: null });
    const r = await h.capture();
    expect(r.performed).toBe(false);
    expect(r.policy?.reasonCodes).toContain("PAYEE_MISMATCH");
    expect(calls(h, "captureAuthorization")).toHaveLength(0);
    expect(h.state()).toBe("AUTHORIZED");
    expect(decisions(h).at(-1)).toMatchObject({ subject: "CAPTURE", verdict: "DENY" });
  });

  it("someone else already captured the hold: nothing is sent and the difference is recorded, not applied", async () => {
    const h = await hold();
    h.fake.addCapture(h.fake.only().id);
    const r = await h.capture();
    expect(r.performed).toBe(false);
    expect(r.notes.join(" ")).toMatch(/does not show a usable hold|cannot record/);
    expect(calls(h, "captureAuthorization")).toHaveLength(0);
    expect(h.state()).toBe("AUTHORIZED");
    expect(h.auditTypes()).toContain("PAYPAL_OBSERVATION_NOT_APPLIED");
  });

  it("the hold lapsed at PayPal: a capture is refused without a request", async () => {
    const h = await hold();
    h.fake.patchAuthorization(h.fake.only().id, { status: "VOIDED" });
    const r = await h.capture();
    expect(r.performed).toBe(false);
    expect(r.notes.join(" ")).toMatch(/does not show a usable hold \(it reports voided\)/);
    expect(calls(h, "captureAuthorization")).toHaveLength(0);
    expect(r.view.moneyMoved).toBe(false);
  });

  it("PayPal cannot be reached for the pre-check: an upstream error, nothing changed", async () => {
    const h = await hold();
    h.fake.failNext({ op: "getOrder", when: "before", error: unknownFailure("NETWORK") });
    await expect(h.capture()).rejects.toBeInstanceOf(UpstreamError);
    expect(h.state()).toBe("AUTHORIZED");
    expect(attemptsOf(h, "CAPTURE")).toHaveLength(0);
  });

  it("a capture PayPal records for a different amount, or not as final, is never read as paid", async () => {
    for (const [tweak, finding] of [
      [(h: Harness) => (h.fake.behaviour.captureAmountDelta = -1), "CAPTURE_AMOUNT_MISMATCH"],
      [(h: Harness) => (h.fake.behaviour.captureFinal = false), "CAPTURE_NOT_FINAL"],
    ] as const) {
      const h = await hold();
      tweak(h);
      const r = await h.capture();
      expect(r.view.state).toBe("NEEDS_RECONCILIATION");
      expect(r.view.moneyMoved).toBe(false);
      expect(h.row().paypal_capture_id).toBeNull();
      expect(
        (
          h.w.db
            .prepare(
              "SELECT payload FROM audit_events WHERE type = 'PAYPAL_ANOMALY' ORDER BY seq DESC",
            )
            .get() as { payload: string }
        ).payload,
      ).toContain(finding);
    }
  });
});

describe("duplicate submissions and concurrent requests", () => {
  it("submitting twice sends one capture; the second is a no-op that says why", async () => {
    const h = await hold();
    const first = await h.capture();
    const second = await h.capture();
    expect(first.performed).toBe(true);
    expect(second.performed).toBe(false);
    expect(second.notes.join(" ")).toMatch(/already captured/);
    expect(second.view.state).toBe("CAPTURED");
    expect(calls(h, "captureAuthorization")).toHaveLength(1);
    expect(attemptsOf(h, "CAPTURE")).toHaveLength(1);
  });

  it("six simultaneous captures send exactly one request to PayPal", async () => {
    const h = await hold();
    slow(h);
    const out = await Promise.allSettled(Array.from({ length: 6 }, () => h.capture()));
    expect(out.every((o) => o.status === "fulfilled")).toBe(true);
    expect(out.filter((o) => o.status === "fulfilled" && o.value.performed)).toHaveLength(1);
    expect(calls(h, "captureAuthorization")).toHaveLength(1);
    expect(h.fake.only().captures).toHaveLength(1);
    expect(attemptsOf(h, "CAPTURE")).toHaveLength(1);
    expect(h.state()).toBe("CAPTURED");
    expect(h.chainOk()).toBe(true);
  });

  it("six simultaneous releases send exactly one request", async () => {
    const h = await hold();
    slow(h);
    const out = await Promise.allSettled(Array.from({ length: 6 }, () => h.voidHold()));
    expect(out.every((o) => o.status === "fulfilled")).toBe(true);
    expect(calls(h, "voidAuthorization")).toHaveLength(1);
    expect(h.state()).toBe("VOIDED");
  });

  it("a capture and a release at the same time: exactly one wins, never both", async () => {
    for (const order of ["capture-first", "void-first"] as const) {
      const h = await hold();
      slow(h);
      const a = order === "capture-first" ? h.capture() : h.voidHold();
      const b = order === "capture-first" ? h.voidHold() : h.capture();
      const out = await Promise.allSettled([a, b]);
      expect(out.filter((o) => o.status === "fulfilled")).toHaveLength(1);
      expect(
        (out.find((o) => o.status === "rejected") as PromiseRejectedResult).reason,
      ).toBeInstanceOf(ConflictError);
      expect(calls(h, "captureAuthorization").length + calls(h, "voidAuthorization").length).toBe(
        1,
      );
      expect(h.state()).toBe(order === "capture-first" ? "CAPTURED" : "VOIDED");
    }
  });

  it("the database refuses a second live capture attempt on its own", async () => {
    const h = await hold();
    await h.capture();
    expect(() =>
      h.w.db
        .prepare(
          "INSERT INTO payment_attempts (id, transaction_id, action, seq, request_id, request_hash, status, tries, started_at) VALUES ('x', ?, 'CAPTURE', 2, ?, ?, 'IN_FLIGHT', 1, ?)",
        )
        .run(h.tx, `pp:${h.tx}:CAPTURE:2`, "a".repeat(64), h.w.clock.iso()),
    ).toThrow();
  });
});

describe("timeouts and ambiguous outcomes: reconcile before anything is repeated", () => {
  it.each([
    "NETWORK",
    "TIMEOUT",
    "SERVER",
    "RATE_LIMITED",
    "CONFLICT",
    "ACCEPTED_INCOMPLETE",
    "MALFORMED",
  ] as const)(
    "%s on the capture request: unknown, not paid, not repeatable until a status check",
    async (kind) => {
      const h = await hold();
      h.fake.failNext({ op: "captureAuthorization", when: "before", error: unknownFailure(kind) });
      const r = await h.capture();
      expect(r.view.state).toBe("NEEDS_RECONCILIATION");
      expect(r.view.moneyMoved).toBe(false);
      expect(attemptsOf(h, "CAPTURE")[0]?.status).toBe("UNKNOWN");
      await expect(h.capture()).rejects.toThrow(/unresolved/);
      expect(calls(h, "captureAuthorization")).toHaveLength(1);
    },
  );

  it("timeout that never reached PayPal: a check too soon changes nothing; after the quiet period the hold is usable and a NEW attempt captures once", async () => {
    const h = await hold();
    h.fake.failNext({
      op: "captureAuthorization",
      when: "before",
      error: unknownFailure("TIMEOUT"),
    });
    await h.capture();

    h.afterSeconds(10);
    const soon = await h.refresh();
    expect(soon.view.state).toBe("NEEDS_RECONCILIATION");
    expect(soon.notes.join(" ")).toMatch(/less than a minute|unresolved/);
    expect(attemptsOf(h, "CAPTURE")[0]?.status).toBe("UNKNOWN");
    await expect(h.capture()).rejects.toBeInstanceOf(ConflictError);

    h.afterSeconds(RECONCILE_QUIET_MS / 1000);
    const later = await h.refresh();
    expect(later.view.state).toBe("AUTHORIZED");
    expect(attemptsOf(h, "CAPTURE")[0]?.status).toBe("FAILED_DEFINITE");

    const done = await h.capture();
    expect(done.view.state).toBe("CAPTURED");
    expect(attemptsOf(h, "CAPTURE").map((a) => [a.seq, a.status])).toEqual([
      [1, "FAILED_DEFINITE"],
      [2, "SUCCEEDED"],
    ]);
    expect(h.fake.only().captures).toHaveLength(1);
    expect(calls(h, "captureAuthorization").map((c) => c.requestId)).toEqual([
      `pp:${h.tx}:CAPTURE:1`,
      `pp:${h.tx}:CAPTURE:2`,
    ]);
    expect(h.chainOk()).toBe(true);
  });

  it("timeout AFTER PayPal captured: the read finds it at once and nothing is sent again", async () => {
    const h = await hold();
    h.fake.failNext({
      op: "captureAuthorization",
      when: "after",
      error: unknownFailure("TIMEOUT"),
    });
    const r = await h.capture();
    expect(r.view.state).toBe("NEEDS_RECONCILIATION");
    expect(r.view.moneyMoved).toBe(false);

    const fin = await h.refresh();
    expect(fin.view.state).toBe("CAPTURED");
    expect(fin.view.moneyMoved).toBe(true);
    expect(attemptsOf(h, "CAPTURE")[0]?.status).toBe("SUCCEEDED");
    expect(calls(h, "captureAuthorization")).toHaveLength(1);
    expect(h.fake.only().captures).toHaveLength(1);
    expect(stateChanges(h).slice(-3)).toEqual([
      "AUTHORIZED>CAPTURING",
      "CAPTURING>NEEDS_RECONCILIATION",
      "NEEDS_RECONCILIATION>CAPTURED",
    ]);
  });

  it("the capture worked but the confirming read failed: unknown, then found by the next check", async () => {
    const h = await hold();
    const real = h.fake.provider.getOrder.bind(h.fake.provider);
    let captured = false;
    let failed = false;
    const cap = h.fake.provider.captureAuthorization.bind(h.fake.provider);
    h.fake.provider.captureAuthorization = async (req) => {
      const res = await cap(req);
      captured = true;
      return res;
    };
    h.fake.provider.getOrder = async (id) => {
      if (captured && !failed) {
        failed = true;
        throw unknownFailure("NETWORK");
      }
      return real(id);
    };
    const r = await h.capture();
    expect(r.view.state).toBe("NEEDS_RECONCILIATION");
    expect(r.view.moneyMoved).toBe(false);
    expect(h.auditTypes()).toContain("PAYPAL_READ_FAILED");
    expect((await h.refresh()).view.state).toBe("CAPTURED");
    expect(calls(h, "captureAuthorization")).toHaveLength(1);
  });

  it("a definite refusal (hold expired): the hold is checked, found intact, and capture can be tried again with a new attempt; the honor clock is not restarted", async () => {
    const h = await hold();
    const before = h.row();
    h.fake.failNext({
      op: "captureAuthorization",
      when: "before",
      error: rejected("AUTHORIZATION_EXPIRED"),
    });
    const r = await h.capture();
    expect(r.view.state).toBe("AUTHORIZED");
    expect(r.notes.join(" ")).toMatch(/refused/);
    expect(attemptsOf(h, "CAPTURE")[0]).toMatchObject({
      status: "FAILED_DEFINITE",
      httpStatus: 422,
    });
    expect(h.auditTypes()).toContain("PAYPAL_CALL_REFUSED");
    expect(h.row().authorized_at).toBe(before.authorized_at);
    expect(h.row().honor_expires_at).toBe(before.honor_expires_at);

    expect((await h.capture()).view.state).toBe("CAPTURED");
    expect(attemptsOf(h, "CAPTURE").map((a) => a.seq)).toEqual([1, 2]);
  });

  it("after three refusals no fourth request is made; the operator is told to release instead", async () => {
    const h = await hold();
    for (let i = 0; i < 3; i++) {
      h.fake.failNext({
        op: "captureAuthorization",
        when: "before",
        error: rejected("PAYEE_BLOCKED_TRANSACTION"),
      });
      expect((await h.capture()).view.state).toBe("AUTHORIZED");
    }
    const r = await h.capture();
    expect(r.performed).toBe(false);
    expect(r.notes.join(" ")).toMatch(/refused the capture three times/);
    expect(calls(h, "captureAuthorization")).toHaveLength(3);
    expect((await h.voidHold()).view.state).toBe("VOIDED");
  });

  it("a definite refusal while the hold has been voided meanwhile ends in FAILED, not in a usable hold", async () => {
    const h = await hold();
    h.fake.provider.captureAuthorization = () => {
      h.fake.patchAuthorization(h.fake.only().id, { status: "VOIDED" });
      return Promise.reject(rejected("PAYEE_BLOCKED_TRANSACTION"));
    };
    const r = await h.capture();
    expect(r.view.state).toBe("FAILED");
    expect(r.view.moneyMoved).toBe(false);
    expect(attemptsOf(h, "CAPTURE")[0]?.status).toBe("FAILED_DEFINITE");
    expect(stateChanges(h).slice(-2)).toEqual([
      "CAPTURING>NEEDS_RECONCILIATION",
      "NEEDS_RECONCILIATION>FAILED",
    ]);
    expect(h.chainOk()).toBe(true);
  });

  it("PayPal saying the authorization is voided is reconciled, not trusted: unknown first, then FAILED once the read agrees", async () => {
    const h = await hold();
    const cap = h.fake.provider.captureAuthorization.bind(h.fake.provider);
    h.fake.provider.captureAuthorization = (req) => {
      h.fake.patchAuthorization(h.fake.only().id, { status: "VOIDED" });
      return cap(req); // the fake answers 422 AUTHORIZATION_VOIDED
    };
    const r = await h.capture();
    expect(r.view.state).toBe("NEEDS_RECONCILIATION");
    const fin = await h.refresh();
    expect(fin.view.state).toBe("FAILED");
    expect(fin.view.moneyMoved).toBe(false);
    expect(attemptsOf(h, "CAPTURE")[0]?.status).toBe("FAILED_DEFINITE");
  });

  it("a declined capture that PayPal lists (with a 2xx answer) is only believed after the quiet period", async () => {
    const h = await hold();
    h.fake.behaviour.captureStatus = "DECLINED";
    const r = await h.capture();
    expect(r.view.state).toBe("NEEDS_RECONCILIATION");
    h.afterSeconds(RECONCILE_QUIET_MS / 1000 + 1);
    h.fake.behaviour.captureStatus = "COMPLETED";
    const back = await h.refresh();
    expect(back.view.state).toBe("AUTHORIZED");
    expect(back.view.moneyMoved).toBe(false);
  });
});

describe("pending, declined and refunded captures", () => {
  it("PENDING is not paid; a repeat sends nothing; COMPLETED later makes it paid", async () => {
    const h = await hold();
    h.fake.behaviour.captureStatus = "PENDING";
    const r = await h.capture();
    expect(r.view.state).toBe("CAPTURE_PENDING");
    expect(r.view.moneyMoved).toBe(false);
    expect(r.view.headline).toMatch(/not paid yet/);
    expect(h.row().paypal_capture_id).toBeNull();
    expect(attemptsOf(h, "CAPTURE")[0]?.status).toBe("UNKNOWN");

    const again = await h.capture();
    expect(again.performed).toBe(false);
    expect(again.notes.join(" ")).toMatch(/pending/);
    expect((await h.refresh()).view.state).toBe("CAPTURE_PENDING");
    await expect(h.voidHold()).rejects.toBeInstanceOf(ConflictError);

    h.fake.settleCapture(h.fake.only().id, "COMPLETED");
    const fin = await h.refresh();
    expect(fin.view.state).toBe("CAPTURED");
    expect(fin.view.moneyMoved).toBe(true);
    expect(attemptsOf(h, "CAPTURE")[0]?.status).toBe("SUCCEEDED");
    expect(calls(h, "captureAuthorization")).toHaveLength(1);
  });

  it("a pending capture that PayPal then declines returns to a usable hold, and capture may be tried again", async () => {
    const h = await hold();
    h.fake.behaviour.captureStatus = "PENDING";
    await h.capture();
    h.fake.settleCapture(h.fake.only().id, "DECLINED");
    const back = await h.refresh();
    expect(back.view.state).toBe("AUTHORIZED");
    expect(attemptsOf(h, "CAPTURE")[0]?.status).toBe("FAILED_DEFINITE");

    h.fake.behaviour.captureStatus = "COMPLETED";
    expect((await h.capture()).view.state).toBe("CAPTURED");
    expect(attemptsOf(h, "CAPTURE").map((a) => a.seq)).toEqual([1, 2]);
  });

  it("a pending capture that simply vanishes from PayPal's order is not taken as a decline", async () => {
    const h = await hold();
    h.fake.behaviour.captureStatus = "PENDING";
    await h.capture();
    h.fake.only().captures.length = 0;
    const r = await h.refresh();
    expect(r.view.state).toBe("CAPTURE_PENDING");
    expect(r.notes.join(" ")).toMatch(/cannot record/);
    expect(attemptsOf(h, "CAPTURE")[0]?.status).toBe("UNKNOWN");
  });

  it("a pending capture whose hold then disappears ends FAILED", async () => {
    const h = await hold();
    h.fake.behaviour.captureStatus = "PENDING";
    await h.capture();
    h.fake.settleCapture(h.fake.only().id, "DECLINED");
    h.fake.patchAuthorization(h.fake.only().id, { status: "VOIDED" });
    expect((await h.refresh()).view.state).toBe("FAILED");
  });

  it("a captured payment that PayPal later reports refunded is no longer shown as paid", async () => {
    const h = await hold();
    await h.capture();
    h.fake.refundCapture(h.fake.only().id);
    const r = await h.refresh();
    expect(r.view.state).toBe("REVERSED");
    expect(r.view.moneyMoved).toBe(false);
    expect(r.view.headline).toMatch(/refunded or reversed/);
    await expect(h.capture()).resolves.toMatchObject({ performed: false });
  });

  it("refreshing a captured payment changes nothing while PayPal still says completed", async () => {
    const h = await hold();
    await h.capture();
    const r = await h.refresh();
    expect(r.view.state).toBe("CAPTURED");
    expect(calls(h, "captureAuthorization")).toHaveLength(1);
  });
});

describe("void: releasing the hold", () => {
  it("releases an authorized hold with a stable request id, reads the order back, and charges nothing", async () => {
    const h = await hold();
    h.fake.calls.length = 0;
    const authId = h.row().paypal_authorization_id as string;
    const r = await h.voidHold();
    expect(r.view.state).toBe("VOIDED");
    expect(r.view.moneyMoved).toBe(false);
    expect(r.view.headline).toMatch(/hold was released/);
    expect(h.fake.calls.map((c) => c.op)).toEqual(["getOrder", "voidAuthorization", "getOrder"]);
    expect(calls(h, "voidAuthorization")[0]).toMatchObject({
      authorizationId: authId,
      requestId: `pp:${h.tx}:VOID:1`,
    });
    expect(attemptsOf(h, "VOID")).toEqual([
      expect.objectContaining({ seq: 1, status: "SUCCEEDED", httpStatus: 204 }),
    ]);
    expect(decisions(h).map((d) => `${d.subject}:${d.verdict}`)).toContain("VOID:ALLOW");
    expect(stateChanges(h).slice(-2)).toEqual(["AUTHORIZED>VOIDING", "VOIDING>VOIDED"]);
    expect(h.row().paypal_capture_id).toBeNull();
    expect(h.chainOk()).toBe(true);
  });

  it("works whichever order status PayPal shows after a void (COMPLETED or VOIDED)", async () => {
    const h = await hold();
    h.fake.behaviour.voidOrderStatus = "VOIDED";
    expect((await h.voidHold()).view.state).toBe("VOIDED");
  });

  it("a repeat is a no-op, and a released hold is never captured", async () => {
    const h = await hold();
    await h.voidHold();
    const again = await h.voidHold();
    expect(again.performed).toBe(false);
    expect(again.notes.join(" ")).toMatch(/already released/);
    expect(calls(h, "voidAuthorization")).toHaveLength(1);
    await expect(h.capture()).rejects.toBeInstanceOf(ConflictError);
  });

  it("an unknown outcome (timeout after PayPal released it) is settled by reading, with no second request", async () => {
    const h = await hold();
    h.fake.failNext({ op: "voidAuthorization", when: "after", error: unknownFailure("TIMEOUT") });
    const r = await h.voidHold();
    expect(r.view.state).toBe("NEEDS_RECONCILIATION");
    await expect(h.voidHold()).rejects.toThrow(/unresolved/);
    await expect(h.capture()).rejects.toThrow(/unresolved/);
    const fin = await h.refresh();
    expect(fin.view.state).toBe("VOIDED");
    expect(attemptsOf(h, "VOID")[0]?.status).toBe("SUCCEEDED");
    expect(calls(h, "voidAuthorization")).toHaveLength(1);
  });

  it("an unknown outcome where the request never arrived: after the quiet period the hold is usable and a new release works", async () => {
    const h = await hold();
    h.fake.failNext({ op: "voidAuthorization", when: "before", error: unknownFailure("NETWORK") });
    await h.voidHold();
    h.afterSeconds(5);
    expect((await h.refresh()).view.state).toBe("NEEDS_RECONCILIATION");
    h.afterSeconds(RECONCILE_QUIET_MS / 1000);
    expect((await h.refresh()).view.state).toBe("AUTHORIZED");
    expect((await h.voidHold()).view.state).toBe("VOIDED");
    expect(attemptsOf(h, "VOID").map((a) => [a.seq, a.status])).toEqual([
      [1, "FAILED_DEFINITE"],
      [2, "SUCCEEDED"],
    ]);
  });

  it("the release loses a race with a capture: PayPal refuses, the read shows the capture, the payment is CAPTURED", async () => {
    const h = await hold();
    const voidCall = h.fake.provider.voidAuthorization.bind(h.fake.provider);
    h.fake.provider.voidAuthorization = (authId, requestId) => {
      h.fake.addCapture(h.fake.only().id); // captured elsewhere just before the void arrives
      return voidCall(authId, requestId);
    };
    const r = await h.voidHold();
    expect(r.view.state).toBe("NEEDS_RECONCILIATION"); // PREVIOUSLY_CAPTURED says something already happened
    const fin = await h.refresh();
    expect(fin.view.state).toBe("CAPTURED");
    expect(fin.view.moneyMoved).toBe(true);
    expect(attemptsOf(h, "VOID")[0]?.status).toBe("FAILED_DEFINITE");
    expect(h.row().captured_minor).toBe(8000);
  });

  it("a definite refusal of the release leaves the hold usable after a check (no extra click needed)", async () => {
    const h = await hold();
    h.fake.failNext({
      op: "voidAuthorization",
      when: "before",
      error: rejected("PERMISSION_DENIED", 403),
    });
    const r = await h.voidHold();
    expect(r.view.state).toBe("AUTHORIZED");
    expect(attemptsOf(h, "VOID")[0]?.status).toBe("FAILED_DEFINITE");
    expect(h.chainOk()).toBe(true);
    expect((await h.voidHold()).view.state).toBe("VOIDED");
  });

  it("the hold already lapsed at PayPal: it is recorded without sending a release", async () => {
    const h = await hold();
    h.fake.patchAuthorization(h.fake.only().id, { status: "VOIDED" });
    const r = await h.voidHold();
    expect(r.view.state).toBe("VOIDED");
    expect(calls(h, "voidAuthorization")).toHaveLength(0);
    expect(h.auditTypes()).toContain("PAYPAL_VOID_NOT_NEEDED");
    expect(attemptsOf(h, "VOID")[0]).toMatchObject({ status: "SUCCEEDED", httpStatus: null });
  });

  it("PayPal shows the hold captured although we never captured: refused, nothing sent", async () => {
    const h = await hold();
    h.fake.addCapture(h.fake.only().id);
    const r = await h.voidHold();
    expect(r.performed).toBe(false);
    expect(calls(h, "voidAuthorization")).toHaveLength(0);
    expect(h.state()).toBe("AUTHORIZED");
  });

  it("an anomaly in the order refuses the release too (the order is not the one we made)", async () => {
    const h = await hold();
    h.fake.patch(h.fake.only().id, { payeeMerchantId: "EVILMERCHANT" });
    const r = await h.voidHold();
    expect(r.performed).toBe(false);
    expect(calls(h, "voidAuthorization")).toHaveLength(0);
  });

  it("releasing is allowed after the honor period (it only reduces exposure)", async () => {
    const h = await hold();
    h.afterSeconds(5 * 24 * 3600);
    expect((await h.voidHold()).view.state).toBe("VOIDED");
  });

  it("releasing frees the budget the hold reserved", async () => {
    const h = await hold({ threshold: 10_000 });
    await h.voidHold();
    const neg2 = h.w.open();
    const o = h.w.offer(neg2.id, "seller_acme", h.w.priced(8000));
    expect(h.w.accept(neg2.id, o.id).accepted).toBe(true); // 80 + 80 would exceed 150 if the first were still reserved
  });
});

describe("correlation, audit and secrets", () => {
  it("every capture and release has a correlation id in the audit trail; the trail holds no secret-looking text", async () => {
    const h = await hold();
    const r = await h.capture();
    const rows = h.w.db
      .prepare("SELECT payload FROM audit_events WHERE transaction_id = ?")
      .all(h.tx) as { payload: string }[];
    expect(rows.some((x) => x.payload.includes(r.correlationId))).toBe(true);
    for (const x of rows)
      expect(x.payload).not.toMatch(/secret|password|bearer|client_id|access_token/i);
    expect(h.chainOk()).toBe(true);
  });

  it("a provider error carries only a kind, a status and a reference, never provider text", () => {
    const e = new ProviderError("REJECTED", "x", {
      httpStatus: 422,
      issues: ["AUTHORIZATION_EXPIRED"],
    });
    expect(e.outcome).toBe("DEFINITE_FAILURE");
    for (const issue of ["PREVIOUSLY_CAPTURED", "MAX_CAPTURE_AMOUNT_EXCEEDED"]) {
      expect(new ProviderError("REJECTED", "x", { httpStatus: 422, issues: [issue] }).outcome).toBe(
        "UNKNOWN",
      );
    }
  });
});
