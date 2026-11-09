import "server-only";

import { createPayPalProvider } from "@/adapters/paypal/provider";
import { createSqlitePaymentStore } from "@/adapters/sqlite/payment-store";
import { createPaymentService, type PaymentService } from "@/application/payments";
import type { PaymentProvider } from "@/ports/payment-provider";
import { randomUUID } from "node:crypto";
import { getEnv } from "./env";
import { getSharedDatabase } from "./negotiation-service";

type Cached = { key: string; service: PaymentService; configured: boolean };
const KEY = Symbol.for("pactpay.paymentService");
const holder = globalThis as unknown as Record<symbol, Cached | undefined>;

/**
 * Composition root for the PayPal SANDBOX payment flow. The provider exists only when both sandbox credentials are
 * set; otherwise the service still answers reads, and anything that would call PayPal is refused with a 503 before
 * any state changes. There is no substitute provider: a missing PayPal is never papered over with a fake.
 *
 * The credentials go from the validated environment straight into the provider; no route, view or log sees them.
 */
export function getPayments(): { service: PaymentService; configured: boolean } {
  const env = getEnv();
  const { path, db } = getSharedDatabase();
  const configured = env.PAYPAL_CLIENT_ID !== undefined && env.PAYPAL_CLIENT_SECRET !== undefined;
  const key = [
    path,
    configured ? "creds" : "nocreds",
    env.PAYPAL_MERCHANT_ID ?? "",
    env.PAYPAL_EXPERIENCE_CONTEXT,
    env.PAYPAL_TIMEOUT_MS,
    env.APP_BASE_URL,
  ].join("|");
  const cached = holder[KEY];
  if (cached?.key === key) return cached;

  let provider: PaymentProvider | null = null;
  if (env.PAYPAL_CLIENT_ID !== undefined && env.PAYPAL_CLIENT_SECRET !== undefined) {
    provider = createPayPalProvider({
      clientId: env.PAYPAL_CLIENT_ID,
      clientSecret: env.PAYPAL_CLIENT_SECRET,
      timeoutMs: env.PAYPAL_TIMEOUT_MS,
      experienceContext: env.PAYPAL_EXPERIENCE_CONTEXT,
    });
  }
  const base = env.APP_BASE_URL.replace(/\/+$/, "");
  const next: Cached = {
    key,
    configured: provider !== null,
    service: createPaymentService({
      store: createSqlitePaymentStore(db),
      provider,
      now: () => new Date(),
      newId: (prefix) => `${prefix}_${randomUUID().replaceAll("-", "").slice(0, 14)}`,
      config: {
        returnUrl: `${base}/api/paypal/return`,
        cancelUrl: `${base}/negotiations`,
        merchantId: env.PAYPAL_MERCHANT_ID ?? null,
      },
    }),
  };
  holder[KEY] = next;
  return next;
}
