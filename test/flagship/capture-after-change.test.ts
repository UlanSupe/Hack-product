import { describe, expect, it } from "vitest";

import { createSqlitePaymentStore } from "@/adapters/sqlite/payment-store";
import { createPaymentService } from "@/application/payments";
import { ConflictError } from "@/domain/errors";
import { evaluatePolicy } from "@/domain/policy";
import {
  FLAGSHIP_MANDATE,
  FLAGSHIP_SELLER,
  FLAGSHIP_SKU,
  seedFlagshipWorld,
} from "@/server/flagship";

import { AGENT, OP, makeWorld } from "../negotiation/world";
import { createFakePayPal } from "../payments/fake-paypal";

/**
 * Capture after the agreement changed. Real negotiation service, policy engine and SQLite database; PayPal is a
 * scripted fake (so nothing here proves how PayPal behaves, only how OUR code reacts).
 */

function setup() {
  const w = makeWorld();
  seedFlagshipWorld(w.db, "2026-01-01T00:00:00.000Z");
  const fake = createFakePayPal({ merchantId: "MERCHANT01" });
  let n = 0;
  const store = createSqlitePaymentStore(w.db);
  const service = createPaymentService({
    store,
    provider: fake.provider,
    now: w.clock.now,
    newId: (p) => `pay_${p}_${++n}`,
    config: {
      returnUrl: "https://app.example.test/api/paypal/return",
      cancelUrl: "https://app.example.test/negotiations",
      merchantId: "MERCHANT01",
    },
  });
  const neg = w.ok(
    w.svc.open(OP, {
      mandateId: FLAGSHIP_MANDATE.id,
      category: "DESIGN",
      quantity: 1,
      summary: "A logo and a one-page brand sheet",
      maxTotal: null,
      neededWithinDays: 7,
      requiredDeliverables: [],
      invitedSellerIds: [FLAGSHIP_SELLER.id],
      timeoutMinutes: 240,
    }),
  );
  const offer = (price: number, over: Record<string, unknown> = {}) =>
    w.offer(neg.id, FLAGSHIP_SELLER.id, {
      lines: [{ sku: FLAGSHIP_SKU, qty: 1, unitPriceMinor: price }],
      claimedTotalMinor: price,
      category: "DESIGN",
      deliverables: ["Logo", "Brand sheet"],
      ...over,
    });
  const activeTx = () =>
    w.cell<string>(
      "SELECT transaction_id FROM negotiation_agreements WHERE negotiation_id = ? AND status = 'ACTIVE'",
      neg.id,
    );
  const row = (tx = activeTx()) =>
    w.db.prepare("SELECT * FROM transactions WHERE id = ?").get(tx) as Record<string, unknown>;
  const proposals = () => w.count("negotiation_proposals", `negotiation_id = '${neg.id}'`);
  const captureCalls = () => fake.calls.filter((c) => c.op === "captureAuthorization");
  const h = {
    w,
    fake,
    service,
    store,
    neg,
    offer,
    activeTx,
    row,
    proposals,
    captureCalls,
    start: () => service.start(OP, neg.id),
    refresh: () => service.refresh(OP, neg.id),
    authorize: () => service.authorize(OP, neg.id),
    capture: () => service.capture(OP, neg.id),
    /** Agrees $24.00, then takes the payment to a hold. */
    async toHold() {
      const o = offer(2_400);
      expect(w.accept(neg.id, o.id).accepted).toBe(true);
      await service.start(OP, neg.id);
      fake.approve(fake.only().id);
      const r = await service.authorize(OP, neg.id);
      expect(r.view.state).toBe("AUTHORIZED");
      return o;
    },
  };
  return h;
}

describe("the agreed $24.00 is what gets captured", () => {
  it("PayPal is asked to capture exactly 24.00, and the stored capture is 24.00", async () => {
    const h = setup();
    await h.toHold();
    const r = await h.capture();
    expect(r.view.state).toBe("CAPTURED");
    expect(h.captureCalls()).toHaveLength(1);
    expect(h.captureCalls()[0]).toMatchObject({ amountMinor: 2_400, currency: "USD" });
    expect(h.row()).toMatchObject({ authorized_minor: 2_400, captured_minor: 2_400 });
  });

  it("an unaccepted $36.00 revision sitting in the negotiation changes nothing: payment always uses the agreed version", async () => {
    const h = setup();
    const o = h.offer(2_400);
    expect(h.w.accept(h.neg.id, o.id).accepted).toBe(true);
    h.offer(3_600); // OPEN, never accepted
    await h.start();
    expect(h.fake.only().amountMinor).toBe(2_400);
    h.fake.approve(h.fake.only().id);
    await h.authorize();
    await h.capture();
    expect(h.captureCalls()[0]?.amountMinor).toBe(2_400);
    expect(h.row().captured_minor).toBe(2_400);
  });
});

describe("the seller changes the agreement after payment steps began", () => {
  it("a $36.00 revision after the order exists is refused outright: no proposal is recorded", async () => {
    const h = setup();
    const o = h.offer(2_400);
    h.w.accept(h.neg.id, o.id);
    await h.start();
    expect(h.row().state).toBe("ORDER_CREATED");
    const before = h.proposals();
    expect(() => h.offer(3_600)).toThrow(ConflictError);
    expect(() => h.offer(3_600)).toThrow(/Payment steps have already started/);
    expect(h.proposals()).toBe(before);
  });

  it("a $36.00 revision after the hold is refused outright, and the capture is still for $24.00", async () => {
    const h = setup();
    await h.toHold();
    const before = h.proposals();
    expect(() => h.offer(3_600)).toThrow(/Payment steps have already started/);
    expect(h.proposals()).toBe(before);
    await h.capture();
    expect(h.captureCalls()[0]?.amountMinor).toBe(2_400);
  });

  it("an offer recorded earlier cannot be accepted once payment has started: no new agreement, no retirement", async () => {
    const h = setup();
    const o = h.offer(2_400);
    h.w.accept(h.neg.id, o.id);
    const early = h.offer(3_600); // recorded before payment started
    await h.start();
    const agreements = h.w.count("negotiation_agreements");
    expect(() => h.w.accept(h.neg.id, early.id)).toThrow(ConflictError);
    expect(h.w.count("negotiation_agreements")).toBe(agreements);
    expect(h.row().state).toBe("ORDER_CREATED");
  });
});

describe("the stored agreement or PayPal's hold no longer matches", () => {
  it("the stored agreement was altered to $36.00 after the hold: the capture is refused and no request is sent", async () => {
    const h = await (async () => {
      const x = setup();
      await x.toHold();
      return x;
    })();
    h.w.db.exec("DROP TRIGGER agreements_no_update"); // simulates a record changed outside the application
    h.w.db
      .prepare(
        "UPDATE agreements SET total_minor = 3600 WHERE id = (SELECT agreement_id FROM transactions WHERE id = ?)",
      )
      .run(h.activeTx());
    const r = await h.capture();
    expect(r.performed).toBe(false);
    expect(r.notes.join(" ")).toMatch(/does not match the agreement/);
    expect(h.captureCalls()).toHaveLength(0);
    expect(h.row().state).toBe("AUTHORIZED");
    expect(h.row().captured_minor).toBeNull();
  });

  it("PayPal's authorization is for $36.00 although the agreement is $24.00: refused, nothing captured", async () => {
    const h = setup();
    await h.toHold();
    h.fake.patchAuthorization(h.fake.only().id, { amountMinor: 3_600 });
    const r = await h.capture();
    expect(r.performed).toBe(false);
    expect(r.notes.join(" ")).toMatch(/does not match the agreement/);
    expect(h.captureCalls()).toHaveLength(0);
  });

  it("PayPal's order is for $36.00: refused, nothing captured", async () => {
    const h = setup();
    await h.toHold();
    h.fake.patch(h.fake.only().id, { amountMinor: 3_600 });
    const r = await h.capture();
    expect(r.performed).toBe(false);
    expect(h.captureCalls()).toHaveLength(0);
  });
});

describe("the agreement was replaced before any payment (the $28.00 revision)", () => {
  function replaced() {
    const h = setup();
    const o1 = h.offer(2_400);
    h.w.accept(h.neg.id, o1.id);
    const tx1 = h.activeTx();
    const o2 = h.offer(2_800);
    const out = h.w.accept(h.neg.id, o2.id);
    expect(out.accepted).toBe(true);
    expect(out.retired?.version).toBe(1);
    return { h, tx1, tx2: h.activeTx() };
  }

  it("the first transaction is cancelled, the new one is a different transaction, and the first can never be captured", () => {
    const { h, tx1, tx2 } = replaced();
    expect(tx2).not.toBe(tx1);
    expect(h.row(tx1).state).toBe("CANCELLED");
    expect(h.row(tx2).state).toBe("AGREED");
    // the policy engine, asked directly about capturing the cancelled transaction
    const decision = evaluatePolicy(
      h.store.transaction((ops) =>
        ops.policyInput({
          subject: "CAPTURE",
          transactionId: tx1,
          now: h.w.clock.iso(),
          actor: "OPERATOR",
          observed: { amountMinor: 2_400, currency: "USD", payeeRef: "payee_pixel" },
        }),
      ),
    );
    expect(decision.verdict).toBe("DENY");
    expect(decision.reasonCodes).toContain("STATE_NOT_PERMITTED");
  });

  it("asking to capture through the negotiation reaches the new, unpaid agreement: refused, and PayPal is not contacted", async () => {
    const { h } = replaced();
    await expect(h.capture()).rejects.toBeInstanceOf(ConflictError);
    await expect(h.capture()).rejects.toThrow(/only an authorized hold can be/);
    expect(h.fake.calls).toHaveLength(0);
  });

  it("the changed agreement needs its own approval before a payment can start, and the order is then for $28.00", async () => {
    const { h } = replaced();
    const denied = await h.start();
    expect(denied.performed).toBe(false);
    expect(denied.policy?.reasonCodes).toEqual(["APPROVAL_REQUIRED"]);
    expect(h.fake.calls).toHaveLength(0);
    h.w.ok(h.w.svc.approve(OP, { negotiationId: h.neg.id }));
    const started = await h.start();
    expect(started.performed).toBe(true);
    expect(h.fake.only().amountMinor).toBe(2_800);
  });

  it("an approval given to the $24.00 version does not carry over to the $28.00 version", async () => {
    const h = setup();
    const o1 = h.offer(2_400);
    h.w.accept(h.neg.id, o1.id);
    h.w.ok(h.w.svc.approve(OP, { negotiationId: h.neg.id })); // the operator approved $24.00
    const o2 = h.offer(2_800);
    h.w.accept(h.neg.id, o2.id);
    const denied = await h.start();
    expect(denied.policy?.reasonCodes).toEqual(["APPROVAL_REQUIRED"]);
    expect(h.fake.calls).toHaveLength(0);
  });

  it("a $36.00 revision is not accepted at all, so the $24.00 transaction stays the only payable one", () => {
    const h = setup();
    const o1 = h.offer(2_400);
    h.w.accept(h.neg.id, o1.id);
    const tx1 = h.activeTx();
    const o2 = h.offer(3_600);
    const out = h.w.accept(h.neg.id, o2.id);
    expect(out.accepted).toBe(false);
    expect(out.policy.reasonCodes).toEqual(["OVER_PER_TX_CAP"]);
    expect(h.activeTx()).toBe(tx1);
    expect(h.row().state).toBe("AGREED");
  });
});

describe("only the operator can capture, whatever the agreement says", () => {
  it("an agent asking to capture a $24.00 hold is refused before PayPal is asked", async () => {
    const h = setup();
    await h.toHold();
    h.fake.calls.length = 0;
    await expect(h.service.capture(AGENT, h.neg.id)).rejects.toThrow(/only the signed-in operator/);
    expect(h.fake.calls).toHaveLength(0);
    expect(h.row().state).toBe("AUTHORIZED");
  });
});
