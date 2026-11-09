import { describe, expect, it } from "vitest";

import { ConflictError, ForbiddenError, UpstreamError } from "@/domain/errors";

import { AGENT, ANON } from "../negotiation/world";
import { rejected, unknownFailure } from "./fake-paypal";
import { setup } from "./harness";

describe("the happy path: create, read back, approve (at PayPal), authorize", () => {
  it("creates an order from the agreement's stored facts and reaches ORDER_CREATED only after reading it back", async () => {
    const h = setup();
    const r = await h.start();

    expect(r.performed).toBe(true);
    expect(r.view.state).toBe("ORDER_CREATED");
    expect(r.view.nextAction).toBe("OPEN_APPROVAL");
    expect(r.view.approveUrl).toMatch(/^https:\/\/www\.sandbox\.paypal\.com\//);
    expect(r.view.moneyMoved).toBe(false);
    expect(r.view.amountText).toBe("80.00 USD");

    const order = h.fake.only();
    expect(order).toMatchObject({
      amountMinor: 8000,
      currency: "USD",
      customId: h.tx,
      invoiceId: `INV-${h.tx}-1`,
      intent: "AUTHORIZE",
    });
    // The create call and the confirming read both happened, in that order.
    expect(h.fake.calls.map((c) => c.op)).toEqual(["createOrder", "getOrder"]);
    expect(h.fake.calls[0]?.requestId).toBe(`pp:${h.tx}:CREATE_ORDER:1`);
    expect(h.attempts()).toEqual([
      expect.objectContaining({
        action: "CREATE_ORDER",
        seq: 1,
        status: "SUCCEEDED",
        httpStatus: 201,
        debugId: "dbg_create_ok",
      }),
    ]);
    expect(h.w.cell("SELECT paypal_order_id FROM transactions WHERE id = ?", h.tx)).toBe(order.id);
    expect(h.chainOk()).toBe(true);
  });

  it("will not authorize before PayPal says the buyer approved", async () => {
    const h = setup();
    await h.start();
    const r = await h.authorize();
    expect(r.performed).toBe(false);
    expect(r.notes.join(" ")).toMatch(/has not approved/);
    expect(h.state()).toBe("ORDER_CREATED");
    expect(h.fake.count("authorizeOrder")).toBe(0);
  });

  it("a status check records the approval without authorizing anything", async () => {
    const h = setup();
    await h.startAndApprove();
    const r = await h.refresh();
    expect(r.view.state).toBe("ORDER_APPROVED");
    expect(r.view.nextAction).toBe("AUTHORIZE");
    expect(h.fake.count("authorizeOrder")).toBe(0);
  });

  it("authorizes after approval: a hold, not a charge, confirmed by reading the order again", async () => {
    const h = setup();
    await h.startAndApprove();
    const r = await h.authorize();

    expect(r.view.state).toBe("AUTHORIZED");
    expect(r.view.headline).toMatch(/not charged/);
    expect(r.view.moneyMoved).toBe(false);
    expect(r.view.authorization).toMatchObject({ amountText: "80.00 USD" });
    expect(h.fake.calls.map((c) => c.op)).toEqual([
      "createOrder",
      "getOrder",
      "getOrder",
      "authorizeOrder",
      "getOrder",
    ]);
    expect(h.fake.calls.find((c) => c.op === "authorizeOrder")?.requestId).toBe(
      `pp:${h.tx}:AUTHORIZE:1`,
    );

    const row = h.w.db.prepare("SELECT * FROM transactions WHERE id = ?").get(h.tx) as Record<
      string,
      unknown
    >;
    expect(row).toMatchObject({
      state: "AUTHORIZED",
      authorized_minor: 8000,
      captured_minor: null,
      paypal_capture_id: null,
    });
    expect(typeof row.paypal_authorization_id).toBe("string");
    // 3-day honor period from the moment we observed the hold
    expect(
      Date.parse(row.honor_expires_at as string) - Date.parse(row.authorized_at as string),
    ).toBe(3 * 24 * 3600 * 1000);
    expect(h.attempts().map((a) => [a.action, a.status])).toEqual([
      ["AUTHORIZE", "SUCCEEDED"],
      ["CREATE_ORDER", "SUCCEEDED"],
    ]);
    expect(h.chainOk()).toBe(true);
  });

  it("every operation has a correlation id that is in the audit trail, and the trail holds no secret-looking text", async () => {
    const h = setup();
    const r = await h.start();
    const rows = h.w.db
      .prepare("SELECT payload FROM audit_events WHERE transaction_id = ?")
      .all(h.tx) as { payload: string }[];
    expect(r.correlationId).toMatch(/^pay_corr_/);
    expect(rows.some((x) => x.payload.includes(r.correlationId))).toBe(true);
    for (const x of rows)
      expect(x.payload).not.toMatch(/secret|password|bearer|client_id|access_token/i);
  });
});

describe("amounts, currency, payee and identity come from stored records, never from a caller", () => {
  it("the service has no way to be told an amount: it only takes the actor and the negotiation id", async () => {
    const h = setup();
    expect(h.service.start.length).toBeLessThanOrEqual(2);
    await h.service.start(h.OP, h.negotiationId);
    expect(h.fake.only().amountMinor).toBe(8000);
  });

  it("pays the ACTIVE agreement version after a re-negotiation, and the retired one is not payable", async () => {
    const h = setup();
    const v2 = h.w.offer(h.negotiationId, "seller_acme", h.w.priced(7000));
    const out = h.w.accept(h.negotiationId, v2.id);
    expect(out.accepted).toBe(true);
    const newTx = h.w.cell<string>(
      "SELECT transaction_id FROM negotiation_agreements WHERE negotiation_id = ? AND status = 'ACTIVE'",
      h.negotiationId,
    );
    expect(newTx).not.toBe(h.tx);

    const r = await h.start();
    expect(r.view.agreementVersion).toBe(2);
    expect(h.fake.only()).toMatchObject({ amountMinor: 7000, customId: newTx });
    expect(h.w.cell("SELECT state FROM transactions WHERE id = ?", h.tx)).toBe("CANCELLED");
  });

  it("only the signed-in operator may run payments; agents and anonymous callers cannot, and nothing is sent", async () => {
    const h = setup();
    for (const who of [AGENT, ANON]) {
      await expect(h.service.start(who, h.negotiationId)).rejects.toThrow(ForbiddenError);
      await expect(h.service.refresh(who, h.negotiationId)).rejects.toThrow(ForbiddenError);
      await expect(h.service.authorize(who, h.negotiationId)).rejects.toThrow(ForbiddenError);
      expect(() => h.service.view(who, h.negotiationId)).toThrow(ForbiddenError);
    }
    expect(h.fake.calls).toHaveLength(0);
    expect(h.state()).toBe("AGREED");
  });
});

describe("the policy engine decides before PayPal is called", () => {
  it("an amount above the approval threshold is refused until the operator approves; no PayPal call is made", async () => {
    const h = setup({ threshold: 5000 });
    const denied = await h.start();
    expect(denied.performed).toBe(false);
    expect(denied.policy?.reasonCodes).toEqual(["APPROVAL_REQUIRED"]);
    expect(h.fake.calls).toHaveLength(0);
    expect(h.state()).toBe("AGREED");
    expect(h.w.count("policy_decisions", "subject = 'CREATE_ORDER' AND verdict = 'DENY'")).toBe(1);

    h.w.ok(h.w.svc.approve(h.OP, { negotiationId: h.negotiationId }));
    const ok = await h.start();
    expect(ok.view.state).toBe("ORDER_CREATED");
    expect(h.w.count("policy_decisions", "subject = 'CREATE_ORDER' AND verdict = 'ALLOW'")).toBe(1);
  });

  it("an operator REJECTION retires the agreement, so there is nothing to pay and nothing is sent", async () => {
    const h = setup({ threshold: 5000 });
    h.w.ok(h.w.svc.disapprove(h.OP, { negotiationId: h.negotiationId }));
    await expect(h.start()).rejects.toThrow(/not found/);
    expect(h.fake.calls).toHaveLength(0);
  });

  it("authorizing is a second policy decision, recorded", async () => {
    const h = setup();
    await h.startAndApprove();
    await h.authorize();
    expect(h.w.count("policy_decisions", "subject = 'AUTHORIZE' AND verdict = 'ALLOW'")).toBe(1);
  });

  it("without a configured merchant the payee cannot be verified, so authorization is refused by the engine", async () => {
    const h = setup({ merchantId: null, paypalPayee: "SOMEONEELSE1" });
    const r = await h.start();
    expect(r.view.state).toBe("ORDER_CREATED");
    expect(r.view.warnings.join(" ")).toMatch(/PAYPAL_MERCHANT_ID/);
    h.fake.approve(h.fake.only().id);
    const a = await h.authorize();
    expect(a.performed).toBe(false);
    expect(a.policy?.reasonCodes).toEqual(["PAYEE_MISMATCH"]);
    expect(h.fake.count("authorizeOrder")).toBe(0);
    expect(h.state()).toBe("ORDER_APPROVED");
  });

  it("PayPal not reporting the payee at all is also refused", async () => {
    const h = setup({ paypalPayee: null });
    await h.startAndApprove();
    const a = await h.authorize();
    expect(a.policy?.reasonCodes).toEqual(["PAYEE_MISMATCH"]);
    expect(h.fake.count("authorizeOrder")).toBe(0);
  });
});

describe("mismatches: a different amount, currency, identity or payee is never accepted", () => {
  const cases: [string, (h: ReturnType<typeof setup>) => void, string][] = [
    ["a different amount", (h) => (h.fake.behaviour.createAmountDelta = 1), "AMOUNT_MISMATCH"],
    ["a different currency", (h) => (h.fake.behaviour.createCurrency = "EUR"), "CURRENCY_MISMATCH"],
    [
      "someone else's custom_id",
      (h) => (h.fake.behaviour.createCustomId = "tx_other"),
      "CUSTOM_ID_MISMATCH",
    ],
    ["no custom_id", (h) => (h.fake.behaviour.createCustomId = null), "CUSTOM_ID_MISMATCH"],
    [
      "a different invoice_id",
      (h) => (h.fake.behaviour.createInvoiceId = "INV-other-1"),
      "INVOICE_ID_MISMATCH",
    ],
    ["intent CAPTURE", (h) => (h.fake.behaviour.createIntent = "CAPTURE"), "INTENT_NOT_AUTHORIZE"],
    ["two purchase units", (h) => (h.fake.behaviour.createPurchaseUnits = 2), "UNIT_COUNT"],
    [
      "another merchant as payee",
      (h) => (h.fake.behaviour.payeeMerchantId = "ATTACKER001"),
      "PAYEE_MISMATCH",
    ],
  ];

  it.each(cases)(
    "create answered with %s: NEEDS_RECONCILIATION, never ORDER_CREATED",
    async (_name, tamper, finding) => {
      const h = setup();
      tamper(h);
      const r = await h.start();
      expect(r.view.state).toBe("NEEDS_RECONCILIATION");
      expect(r.view.approveUrl).toBeNull();
      expect(r.view.warnings.join(" ")).toContain(finding);
      expect(h.attempts()[0]?.status).toBe("UNKNOWN");
      // the order exists at PayPal, so its id is recorded, but it can never be authorized
      await expect(h.authorize()).rejects.toThrow(ConflictError);
      expect(h.fake.count("authorizeOrder")).toBe(0);
    },
  );

  it("a later read that shows the order fixed lets reconciliation finish; a persistent mismatch keeps it blocked", async () => {
    const h = setup();
    h.fake.behaviour.createAmountDelta = 100;
    await h.start();
    const again = await h.refresh();
    expect(again.view.state).toBe("NEEDS_RECONCILIATION");
    h.fake.patch(h.fake.only().id, { amountMinor: 8000 });
    const fixed = await h.refresh();
    expect(fixed.view.state).toBe("ORDER_CREATED");
    expect(h.attempts()[0]?.status).toBe("SUCCEEDED");
  });

  it("an order tampered with AFTER creation is caught at authorize time and nothing is authorized", async () => {
    const h = setup();
    const { order } = await h.startAndApprove();
    h.fake.patch(order.id, { amountMinor: 8001 });
    const r = await h.authorize();
    expect(r.performed).toBe(false);
    expect(r.notes.join(" ")).toMatch(/does not match the agreement/);
    expect(h.fake.count("authorizeOrder")).toBe(0);
    expect(h.state()).toBe("ORDER_CREATED");
  });

  it("an authorization for a different amount is not believed: NEEDS_RECONCILIATION, not AUTHORIZED", async () => {
    const h = setup();
    await h.startAndApprove();
    h.fake.behaviour.authorizationAmountDelta = -1;
    const r = await h.authorize();
    expect(r.view.state).toBe("NEEDS_RECONCILIATION");
    expect(r.view.authorization).toBeNull();
    expect(h.w.cell("SELECT authorized_minor FROM transactions WHERE id = ?", h.tx)).toBeNull();
  });

  it("an order PayPal reports COMPLETED without any authorization is not read as success", async () => {
    const h = setup();
    const { order } = await h.startAndApprove();
    h.fake.patch(order.id, { status: "COMPLETED" });
    const r = await h.refresh();
    expect(r.view.state).toBe("ORDER_CREATED");
    expect(r.notes.join(" ")).toMatch(/does not match the agreement/);
  });

  it("a capture that this build never made is an anomaly", async () => {
    const h = setup();
    const { order } = await h.startAndApprove();
    h.fake.addCapture(order.id);
    const a = await h.authorize();
    expect(a.performed).toBe(false);
    expect(h.fake.count("authorizeOrder")).toBe(0);
  });
});

describe("invalid states", () => {
  it("authorizing a payment that was never started is refused", async () => {
    const h = setup();
    await expect(h.authorize()).rejects.toThrow(ConflictError);
    expect(h.fake.calls).toHaveLength(0);
  });

  it("a status check on an unstarted payment does not call PayPal", async () => {
    const h = setup();
    const r = await h.refresh();
    expect(r.performed).toBe(false);
    expect(h.fake.calls).toHaveLength(0);
  });

  it("an order the buyer cancelled becomes CANCELLED", async () => {
    const h = setup();
    await h.start();
    h.fake.patch(h.fake.only().id, { status: "VOIDED" });
    expect((await h.refresh()).view.state).toBe("CANCELLED");
  });

  // PAYER_ACTION_REQUIRED is not here: the live sandbox reports it for a fresh order, so it reads as ORDER_CREATED.
  it.each(["SAVED", "SOMETHING_NEW"])(
    "an unexpected order status %s changes nothing",
    async (status) => {
      const h = setup();
      await h.start();
      h.fake.patch(h.fake.only().id, { status });
      const r = await h.refresh();
      expect(r.view.state).toBe("ORDER_CREATED");
      expect(r.notes.join(" ")).toMatch(/does not match/);
      expect(h.chainOk()).toBe(true);
    },
  );

  it("an authorization PayPal reports as pending is not an authorization", async () => {
    const h = setup();
    await h.startAndApprove();
    h.fake.behaviour.authorizationStatus = "PENDING";
    const r = await h.authorize();
    expect(r.view.state).toBe("AUTHORIZATION_PENDING");
    expect(r.view.authorization).toBeNull();
    expect(r.view.headline).not.toMatch(/on hold/);
    // later PayPal completes it
    h.fake.patchAuthorization(h.fake.only().id, { status: "CREATED" });
    expect((await h.refresh()).view.state).toBe("AUTHORIZED");
  });

  it("a denied authorization is a definite failure and nothing is held", async () => {
    const h = setup();
    await h.startAndApprove();
    h.fake.behaviour.authorizationStatus = "DENIED";
    const r = await h.authorize();
    expect(r.view.state).toBe("FAILED");
    expect(r.view.authorization).toBeNull();
  });

  it("an authorization that PayPal already captured is an anomaly we do not record", async () => {
    const h = setup();
    await h.startAndApprove();
    h.fake.behaviour.authorizationStatus = "CAPTURED";
    const r = await h.authorize();
    expect(r.view.state).toBe("NEEDS_RECONCILIATION");
  });

  it("with PayPal not configured, reads work and anything that would call PayPal is refused before any state changes", async () => {
    const h = setup({ noProvider: true });
    expect(h.service.view(h.OP, h.negotiationId).state).toBe("AGREED");
    for (const op of [h.start, h.authorize]) {
      await expect(op()).rejects.toMatchObject({ name: "UpstreamError", code: "NOT_CONFIGURED" });
    }
    await expect(h.service.start(h.OP, h.negotiationId)).rejects.toThrow(UpstreamError);
    expect(h.state()).toBe("AGREED");
    expect(h.attempts()).toEqual([]);
  });
});

describe("network failures and ambiguous answers", () => {
  const ambiguous = [
    "NETWORK",
    "TIMEOUT",
    "SERVER",
    "RATE_LIMITED",
    "CONFLICT",
    "ACCEPTED_INCOMPLETE",
    "MALFORMED",
  ] as const;

  it.each(ambiguous)(
    "create: %s before anything happened -> NEEDS_RECONCILIATION, then the SAME request id is replayed",
    async (kind) => {
      const h = setup();
      h.fake.failNext({ op: "createOrder", when: "before", error: unknownFailure(kind) });
      const r = await h.start();
      expect(r.view.state).toBe("NEEDS_RECONCILIATION");
      expect(r.view.nextAction).toBe("RECONCILE");
      expect(h.attempts()[0]).toMatchObject({ status: "UNKNOWN", tries: 1 });

      const settled = await h.refresh();
      expect(settled.view.state).toBe("ORDER_CREATED");
      expect(h.fake.orders.size).toBe(1);
      const sent = h.fake.calls.filter((c) => c.op === "createOrder").map((c) => c.requestId);
      expect(sent).toEqual([`pp:${h.tx}:CREATE_ORDER:1`, `pp:${h.tx}:CREATE_ORDER:1`]);
      expect(h.attempts()[0]).toMatchObject({ status: "SUCCEEDED", tries: 2 });
    },
  );

  it("create: the response is LOST after PayPal created the order -> replaying the same request id finds that order, not a second one", async () => {
    const h = setup();
    h.fake.failNext({ op: "createOrder", when: "after", error: unknownFailure("TIMEOUT") });
    const r = await h.start();
    expect(r.view.state).toBe("NEEDS_RECONCILIATION");
    expect(h.fake.orders.size).toBe(1); // it did take effect

    const settled = await h.refresh();
    expect(settled.view.state).toBe("ORDER_CREATED");
    expect(h.fake.orders.size).toBe(1); // still exactly one order
    expect(h.fake.only().id).toBe(settled.view.paypalOrderId);
  });

  it("create: a definite refusal ends the payment as FAILED with nothing charged", async () => {
    const h = setup();
    h.fake.failNext({ op: "createOrder", when: "before", error: rejected("INVALID_REQUEST", 400) });
    const r = await h.start();
    expect(r.view.state).toBe("FAILED");
    expect(h.attempts()[0]).toMatchObject({
      status: "FAILED_DEFINITE",
      httpStatus: 400,
      debugId: "dbg_rejected_1",
    });
    const again = await h.start();
    expect(again.performed).toBe(false);
    expect(h.fake.count("createOrder")).toBe(1);
  });

  it("create: a rejection that says something already happened (duplicate invoice) is NOT treated as a definite failure", async () => {
    const h = setup();
    h.fake.failNext({ op: "createOrder", when: "before", error: rejected("DUPLICATE_INVOICE_ID") });
    expect((await h.start()).view.state).toBe("NEEDS_RECONCILIATION");
  });

  it("create: after three unproductive replays the payment is given up as FAILED (no order was ever learned of)", async () => {
    const h = setup();
    h.fake.failNext({ op: "createOrder", when: "before", error: unknownFailure("NETWORK") });
    await h.start();
    for (let i = 0; i < 2; i++) {
      h.fake.failNext({ op: "createOrder", when: "before", error: unknownFailure("NETWORK") });
      expect((await h.refresh()).view.state).toBe("NEEDS_RECONCILIATION");
    }
    const last = await h.refresh();
    expect(last.view.state).toBe("FAILED");
    expect(h.fake.count("createOrder")).toBe(3);
  });

  it("create: the confirming read fails after the order was created -> NEEDS_RECONCILIATION with the order id kept; a later read settles it", async () => {
    const h = setup();
    h.fake.failNext({ op: "getOrder", when: "before", error: unknownFailure("NETWORK") });
    const r = await h.start();
    expect(r.view.state).toBe("NEEDS_RECONCILIATION");
    expect(r.view.paypalOrderId).toBe(h.fake.only().id);
    expect((await h.refresh()).view.state).toBe("ORDER_CREATED");
    expect(h.fake.count("createOrder")).toBe(1); // reconciled by a READ, no second create
  });

  it("a status check that cannot reach PayPal changes nothing and says so", async () => {
    const h = setup();
    await h.start();
    h.fake.failNext({ op: "getOrder", when: "before", error: unknownFailure("TIMEOUT") });
    await expect(h.refresh()).rejects.toMatchObject({ name: "UpstreamError", code: "UNAVAILABLE" });
    expect(h.state()).toBe("ORDER_CREATED");
  });

  it("authorize: the response is LOST after the hold was placed -> a status check finds exactly one authorization", async () => {
    const h = setup();
    await h.startAndApprove();
    h.fake.failNext({ op: "authorizeOrder", when: "after", error: unknownFailure("TIMEOUT") });
    const r = await h.authorize();
    expect(r.view.state).toBe("NEEDS_RECONCILIATION");
    expect(r.view.authorization).toBeNull();

    const settled = await h.refresh();
    expect(settled.view.state).toBe("AUTHORIZED");
    expect(h.fake.count("authorizeOrder")).toBe(1);
    expect(h.attempts().find((a) => a.action === "AUTHORIZE")?.status).toBe("SUCCEEDED");
  });

  it("authorize: the call never reached PayPal -> reconcile back to ORDER_APPROVED, then a NEW attempt with a new request id", async () => {
    const h = setup();
    await h.startAndApprove();
    h.fake.failNext({ op: "authorizeOrder", when: "before", error: unknownFailure("NETWORK") });
    expect((await h.authorize()).view.state).toBe("NEEDS_RECONCILIATION");
    expect((await h.refresh()).view.state).toBe("ORDER_APPROVED");
    expect(h.attempts().find((a) => a.action === "AUTHORIZE")).toMatchObject({
      seq: 1,
      status: "FAILED_DEFINITE",
    });

    const second = await h.authorize();
    expect(second.view.state).toBe("AUTHORIZED");
    expect(h.fake.calls.filter((c) => c.op === "authorizeOrder").map((c) => c.requestId)).toEqual([
      `pp:${h.tx}:AUTHORIZE:1`,
      `pp:${h.tx}:AUTHORIZE:2`,
    ]);
  });

  it("authorize: 202 (accepted, not finished) is unknown, not success", async () => {
    const h = setup();
    await h.startAndApprove();
    h.fake.failNext({
      op: "authorizeOrder",
      when: "before",
      error: unknownFailure("ACCEPTED_INCOMPLETE"),
    });
    expect((await h.authorize()).view.state).toBe("NEEDS_RECONCILIATION");
  });

  it("authorize: a definite refusal (instrument declined) ends as FAILED, nothing held", async () => {
    const h = setup();
    await h.startAndApprove();
    h.fake.failNext({
      op: "authorizeOrder",
      when: "before",
      error: rejected("INSTRUMENT_DECLINED"),
    });
    const r = await h.authorize();
    expect(r.view.state).toBe("FAILED");
    expect(r.view.authorization).toBeNull();
  });

  it("the confirming read after a successful authorize fails -> NEEDS_RECONCILIATION, and a later read gives AUTHORIZED", async () => {
    const h = setup();
    await h.startAndApprove();
    let reads = 0;
    const real = h.fake.provider.getOrder.bind(h.fake.provider);
    h.fake.provider.getOrder = (id) =>
      ++reads === 2 ? Promise.reject(unknownFailure("NETWORK")) : real(id);
    const r = await h.authorize();
    expect(r.view.state).toBe("NEEDS_RECONCILIATION");
    expect(h.fake.count("authorizeOrder")).toBe(1);
    expect((await h.refresh()).view.state).toBe("AUTHORIZED");
  });
});

describe("records that change underneath an operation", () => {
  it("authorize refuses to act on an observation if the payment changed while PayPal was being asked", async () => {
    const h = setup();
    const { order } = await h.startAndApprove();
    const real = h.fake.provider.getOrder.bind(h.fake.provider);
    let first = true;
    h.fake.provider.getOrder = async (id) => {
      const observed = await real(id);
      if (first) {
        first = false;
        await h.refresh(); // someone else records the approval while this request was waiting
      }
      return observed;
    };
    await expect(h.authorize()).rejects.toThrow(/changed while you were working/);
    expect(h.fake.count("authorizeOrder")).toBe(0);
    expect(h.state()).toBe("ORDER_APPROVED");
    // trying again, with fresh facts, works
    h.fake.provider.getOrder = real;
    expect((await h.authorize()).view.state).toBe("AUTHORIZED");
    expect(order.id).toBe(h.fake.only().id);
  });

  it("a replay is abandoned if the stored request no longer matches what was first attempted", async () => {
    const h = setup();
    h.fake.failNext({ op: "createOrder", when: "before", error: unknownFailure("NETWORK") });
    await h.start();
    expect(h.state()).toBe("NEEDS_RECONCILIATION");
    // simulate a changed record: the attempt row no longer matches the agreement (needs the immutability trigger out of the way)
    h.w.db.exec("DROP TRIGGER payment_attempts_update_rules");
    h.w.db
      .prepare("UPDATE payment_attempts SET request_hash = ? WHERE transaction_id = ?")
      .run("0".repeat(64), h.tx);
    const r = await h.refresh();
    expect(r.view.state).toBe("FAILED");
    expect(h.fake.count("createOrder")).toBe(1); // nothing was replayed
  });
});

describe("repeated and concurrent requests", () => {
  it("a repeated start never creates a second order", async () => {
    const h = setup();
    await h.start();
    const again = await h.start();
    expect(again.performed).toBe(false);
    expect(again.notes.join(" ")).toMatch(/already started/);
    expect(h.fake.count("createOrder")).toBe(1);
    expect(h.fake.orders.size).toBe(1);
  });

  it("two simultaneous starts (a double click) make exactly one PayPal order", async () => {
    const h = setup();
    const [a, b] = await Promise.all([h.start(), h.start()]);
    expect(h.fake.count("createOrder")).toBe(1);
    expect(h.fake.orders.size).toBe(1);
    expect([a.performed, b.performed].sort()).toEqual([false, true]);
    expect(h.state()).toBe("ORDER_CREATED");
    expect(h.w.count("payment_attempts", "action = 'CREATE_ORDER'")).toBe(1);
  });

  it("two simultaneous authorizations place exactly one hold", async () => {
    const h = setup();
    await h.startAndApprove();
    const results = await Promise.allSettled([h.authorize(), h.authorize()]);
    expect(h.fake.count("authorizeOrder")).toBe(1);
    expect(h.state()).toBe("AUTHORIZED");
    expect(results.some((r) => r.status === "fulfilled")).toBe(true);
  });

  it("authorizing again after AUTHORIZED sends nothing", async () => {
    const h = setup();
    await h.startAndApprove();
    await h.authorize();
    const before = h.fake.calls.length;
    const again = await h.authorize();
    expect(again.performed).toBe(false);
    expect(h.fake.calls.length).toBe(before);
  });

  it("repeated status checks are harmless and do not change state", async () => {
    const h = setup();
    await h.startAndApprove();
    await h.refresh();
    const first = h.w.cell<number>("SELECT version FROM transactions WHERE id = ?", h.tx);
    await h.refresh();
    await h.refresh();
    expect(h.w.cell<number>("SELECT version FROM transactions WHERE id = ?", h.tx)).toBe(first);
    expect(h.state()).toBe("ORDER_APPROVED");
  });
});

describe("the return redirect is not evidence", () => {
  it("coming back from PayPal only triggers a read: an unapproved order stays ORDER_CREATED", async () => {
    const h = setup();
    const started = await h.start();
    const r = await h.service.confirmReturn(h.OP, started.view.paypalOrderId as string);
    expect(r.view.state).toBe("ORDER_CREATED");
    expect(h.fake.count("authorizeOrder")).toBe(0);
  });

  it("after the buyer really approved, the same return moves to ORDER_APPROVED (still not authorized)", async () => {
    const h = setup();
    const { order } = await h.startAndApprove();
    const r = await h.service.confirmReturn(h.OP, order.id);
    expect(r.view.state).toBe("ORDER_APPROVED");
    expect(h.fake.count("authorizeOrder")).toBe(0);
  });

  it("an order id we never created is refused before any PayPal call", async () => {
    const h = setup();
    await h.start();
    const before = h.fake.calls.length;
    await expect(h.service.confirmReturn(h.OP, "FORGED123456")).rejects.toThrow(/not found/);
    expect(h.fake.calls.length).toBe(before);
  });
});

describe("the amount a request could try to smuggle in never reaches PayPal", () => {
  it("the create request is built only from the stored agreement", async () => {
    const h = setup();
    const seen: unknown[] = [];
    const real = h.fake.provider.createOrder.bind(h.fake.provider);
    h.fake.provider.createOrder = (req) => {
      seen.push(req);
      return real(req);
    };
    await h.start();
    expect(seen).toEqual([
      {
        requestId: `pp:${h.tx}:CREATE_ORDER:1`,
        amountMinor: 8000,
        currency: "USD",
        customId: h.tx,
        invoiceId: `INV-${h.tx}-1`,
        // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment -- vitest asymmetric matcher
        description: expect.stringMatching(/^PactPay Arena sandbox payment /),
        returnUrl: "https://app.example.test/api/paypal/return",
        cancelUrl: "https://app.example.test/negotiations",
      },
    ]);
  });

  it("untrusted seller text never goes to PayPal: the description is fixed text plus our agreement id", async () => {
    const h = setup();
    const seen: { description: string }[] = [];
    const real = h.fake.provider.createOrder.bind(h.fake.provider);
    h.fake.provider.createOrder = (req) => {
      seen.push(req);
      return real(req);
    };
    await h.start();
    const agreementId = h.w.cell<string>(
      "SELECT agreement_id FROM transactions WHERE id = ?",
      h.tx,
    );
    expect(seen[0]?.description).toBe(`PactPay Arena sandbox payment ${agreementId}`);
    expect(JSON.stringify(seen)).not.toContain("Fixed price");
  });
});
