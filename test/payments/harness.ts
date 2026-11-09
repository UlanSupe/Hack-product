import { verifyChain } from "@/adapters/sqlite/audit";
import { createSqlitePaymentStore } from "@/adapters/sqlite/payment-store";
import { createPaymentService, type PaymentConfig } from "@/application/payments";

import { OP, makeWorld } from "../negotiation/world";
import { createFakePayPal } from "./fake-paypal";

export const MERCHANT = "MERCHANT01";

/** A world with one agreed, payable negotiation (80.00 USD) and a fake PayPal. */
export function setup(
  opts: {
    /** Approval threshold in minor units. Default 100.00, so 80.00 needs no approval. */
    threshold?: number;
    /** Configured merchant. `null` = not configured. */
    merchantId?: string | null;
    /** What the fake PayPal reports as payee (default: the configured merchant). */
    paypalPayee?: string | null;
    noProvider?: boolean;
  } = {},
) {
  const w = makeWorld({ threshold: opts.threshold ?? 10_000 });
  const merchantId = opts.merchantId === undefined ? MERCHANT : opts.merchantId;
  const fake = createFakePayPal({
    merchantId: opts.paypalPayee === undefined ? merchantId : opts.paypalPayee,
  });
  const config: PaymentConfig = {
    returnUrl: "https://app.example.test/api/paypal/return",
    cancelUrl: "https://app.example.test/negotiations",
    merchantId,
  };
  let n = 0;
  const service = createPaymentService({
    store: createSqlitePaymentStore(w.db),
    provider: opts.noProvider ? null : fake.provider,
    now: w.clock.now,
    newId: (p) => `pay_${p}_${++n}`,
    config,
  });
  const deal = w.agreed();
  const negotiationId = deal.neg.id;
  const tx = w.cell<string>(
    "SELECT transaction_id FROM negotiation_agreements WHERE negotiation_id = ? AND status = 'ACTIVE'",
    negotiationId,
  );
  return {
    w,
    fake,
    service,
    config,
    negotiationId,
    tx,
    OP,
    state: () => w.cell<string>("SELECT state FROM transactions WHERE id = ?", tx),
    attempts: () =>
      w.db
        .prepare(
          "SELECT action, seq, request_id AS requestId, status, tries, http_status AS httpStatus, paypal_debug_id AS debugId FROM payment_attempts WHERE transaction_id = ? ORDER BY action, seq",
        )
        .all(tx) as {
        action: string;
        seq: number;
        requestId: string;
        status: string;
        tries: number;
        httpStatus: number | null;
        debugId: string | null;
      }[],
    auditTypes: () =>
      (
        w.db
          .prepare("SELECT type FROM audit_events WHERE transaction_id = ? ORDER BY seq")
          .all(tx) as {
          type: string;
        }[]
      ).map((r) => r.type),
    chainOk: () => verifyChain(w.db).status === "VERIFIED",
    start: () => service.start(OP, negotiationId),
    refresh: () => service.refresh(OP, negotiationId),
    authorize: () => service.authorize(OP, negotiationId),
    capture: () => service.capture(OP, negotiationId),
    voidHold: () => service.voidHold(OP, negotiationId),
    /** start + approve + authorize: a hold exists. */
    async startToHold() {
      await service.start(OP, negotiationId);
      fake.approve(fake.only().id);
      return service.authorize(OP, negotiationId);
    },
    /** The txn row, for assertions about what is stored. */
    row: () =>
      w.db.prepare("SELECT * FROM transactions WHERE id = ?").get(tx) as Record<string, unknown>,
    /** Seconds since the base time are controlled by the clock; this moves it. */
    afterSeconds: (s: number) => w.clock.advanceMs(s * 1000),
    /** start + the buyer approves at PayPal. */
    async startAndApprove() {
      const started = await service.start(OP, negotiationId);
      const order = fake.only();
      fake.approve(order.id);
      return { started, order };
    },
  };
}

export type Harness = ReturnType<typeof setup>;
