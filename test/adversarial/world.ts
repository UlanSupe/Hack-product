import { createSqliteMandateStore } from "@/adapters/sqlite/mandate-store";
import { createSqlitePaymentStore } from "@/adapters/sqlite/payment-store";
import { createSqliteWebhookStore } from "@/adapters/sqlite/webhook-store";
import { createMandateService } from "@/application/mandates";
import { createPaymentService, type PaymentConfig } from "@/application/payments";
import { createWebhookService } from "@/application/webhooks";

import { makeWorld } from "../negotiation/world";
import { createFakePayPal } from "../payments/fake-paypal";
import { createFakeVerifier, WEBHOOK_ID } from "../payments/webhook-harness";
import type { Scenario } from "./types";

export const MERCHANT = "MERCHANT01";

/**
 * One scenario's world: the real negotiation, mandate, payment and webhook services over a fresh in-memory
 * database, a controllable clock, sequential ids, a scripted fake PayPal and a fake webhook verifier.
 * Every random or time-dependent input is injected, so a scenario replays identically.
 */
export function buildWorld(initial: Scenario["initial"]) {
  const m = initial.mandate ?? {};
  const w = makeWorld({
    ...(m.capMinor !== undefined ? { cap: m.capMinor } : {}),
    ...(m.budgetMinor !== undefined ? { budget: m.budgetMinor } : {}),
    ...(m.thresholdMinor !== undefined ? { threshold: m.thresholdMinor } : {}),
    ...(m.categories ? { categories: m.categories as never } : {}),
    ...(m.review !== undefined ? { review: m.review } : {}),
  });

  const fake = createFakePayPal({
    merchantId: initial.paypalPayee === undefined ? MERCHANT : initial.paypalPayee,
  });
  const config: PaymentConfig = {
    returnUrl: "https://app.example.test/api/paypal/return",
    cancelUrl: "https://app.example.test/negotiations",
    merchantId: MERCHANT,
  };
  let n = 0;
  const payments = createPaymentService({
    store: createSqlitePaymentStore(w.db),
    provider: fake.provider,
    now: w.clock.now,
    newId: (p) => `pay_${p}_${++n}`,
    config,
  });
  const fv = createFakeVerifier();
  const webhooks = createWebhookService({
    store: createSqliteWebhookStore(w.db),
    verifier: fv.verifier,
    webhookId: WEBHOOK_ID,
    payments,
    now: w.clock.now,
    newId: (p) => `wh_${p}_${++n}`,
  });
  const mandates = createMandateService({
    store: createSqliteMandateStore(w.db),
    now: w.clock.now,
    newId: (p) => `${p}_adv_${++n}`,
  });

  return { w, fake, fv, payments, webhooks, mandates, nextId: () => ++n };
}

export type AdversarialWorld = ReturnType<typeof buildWorld>;
