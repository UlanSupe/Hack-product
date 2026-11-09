import "server-only";

import { createPayPalWebhookVerifier } from "@/adapters/paypal/webhook-verifier";
import { createSqliteWebhookStore } from "@/adapters/sqlite/webhook-store";
import { createWebhookService, type WebhookService } from "@/application/webhooks";
import type { WebhookVerifier } from "@/ports/webhook-verifier";
import { randomUUID } from "node:crypto";
import { getEnv } from "./env";
import { getPayments } from "./payment-service";
import { getSharedDatabase } from "./negotiation-service";

type Cached = { key: string; service: WebhookService };
const KEY = Symbol.for("pactpay.webhookService");
const holder = globalThis as unknown as Record<symbol, Cached | undefined>;

/**
 * Composition root for the PayPal webhook endpoint. The webhook id comes from the validated environment (never from a
 * message), and verification uses PayPal's own service with the sandbox credentials. With either missing the endpoint
 * answers 503 and reads nothing: there is no substitute verifier.
 */
export function getWebhooks(): WebhookService {
  const env = getEnv();
  const { path, db } = getSharedDatabase();
  const key = [
    path,
    env.PAYPAL_WEBHOOK_ID ?? "",
    env.PAYPAL_CLIENT_ID ?? "",
    env.PAYPAL_TIMEOUT_MS,
  ].join("|");
  const cached = holder[KEY];
  if (cached?.key === key) return cached.service;

  let verifier: WebhookVerifier | null = null;
  if (env.PAYPAL_CLIENT_ID !== undefined && env.PAYPAL_CLIENT_SECRET !== undefined) {
    verifier = createPayPalWebhookVerifier({
      clientId: env.PAYPAL_CLIENT_ID,
      clientSecret: env.PAYPAL_CLIENT_SECRET,
      timeoutMs: env.PAYPAL_TIMEOUT_MS,
    });
  }
  const service = createWebhookService({
    store: createSqliteWebhookStore(db),
    verifier,
    webhookId: env.PAYPAL_WEBHOOK_ID ?? null,
    payments: getPayments().service,
    now: () => new Date(),
    newId: (prefix) => `${prefix}_${randomUUID().replaceAll("-", "").slice(0, 14)}`,
  });
  holder[KEY] = { key, service };
  return service;
}
