import { createSqliteWebhookStore } from "@/adapters/sqlite/webhook-store";
import { createWebhookService, type WebhookResponse } from "@/application/webhooks";
import { ProviderError } from "@/ports/payment-provider";
import type { WebhookVerifier } from "@/ports/webhook-verifier";

import { setup } from "./harness";

export const WEBHOOK_ID = "WH-TEST-0001";

type Verdict = "VERIFIED" | "REJECTED" | "UNAVAILABLE";

/** A stand-in for PayPal's verification service: it says what the test tells it to, and records what it was asked. */
export function createFakeVerifier() {
  const state = { verdict: "VERIFIED" as Verdict };
  const calls: Parameters<WebhookVerifier["verify"]>[0][] = [];
  const verifier: WebhookVerifier = {
    verify(input) {
      calls.push(input);
      if (state.verdict === "UNAVAILABLE")
        return Promise.reject(new ProviderError("SERVER", "down", { httpStatus: 503 }));
      return Promise.resolve(state.verdict);
    },
  };
  return { verifier, calls, state };
}

export type Delivery = {
  event: Record<string, unknown>;
  /** Overrides the serialized body (to send something that is not the event as built). */
  rawBody?: string;
  /** Header overrides; `null` removes a header. */
  headers?: Record<string, string | null>;
};

export function setupWebhooks(
  opts: Parameters<typeof setup>[0] & { webhookId?: string | null; noVerifier?: boolean } = {},
) {
  const h = setup(opts);
  const fv = createFakeVerifier();
  let n = 0;
  const webhooks = createWebhookService({
    store: createSqliteWebhookStore(h.w.db),
    verifier: opts.noVerifier ? null : fv.verifier,
    webhookId: opts.webhookId === undefined ? WEBHOOK_ID : opts.webhookId,
    payments: h.service,
    now: h.w.clock.now,
    newId: (p) => `wh_${p}_${++n}`,
  });

  const baseHeaders = (): Record<string, string> => ({
    "paypal-transmission-id": `tr-${++n}`,
    "paypal-transmission-time": h.w.clock.iso(),
    "paypal-cert-url": "https://api.sandbox.paypal.com/v1/notifications/certs/CERT-TEST",
    "paypal-transmission-sig": "c2lnbmF0dXJlLXRlc3Q=",
    "paypal-auth-algo": "SHA256withRSA",
  });

  const deliver = (d: Delivery): Promise<WebhookResponse> => {
    const headers: Record<string, string | null> = { ...baseHeaders(), ...d.headers };
    return webhooks.handle({
      header: (name) => headers[name.toLowerCase()] ?? null,
      rawBody: d.rawBody ?? JSON.stringify(d.event),
    });
  };

  const orderId = () => h.fake.only().id;
  const event = (id: string, type: string, resource: Record<string, unknown>) => ({
    id,
    event_type: type,
    resource_type: type.split(".")[1]?.toLowerCase() ?? "unknown",
    create_time: h.w.clock.iso(),
    resource,
  });
  const related = (resourceId: string) => ({
    id: resourceId,
    supplementary_data: { related_ids: { order_id: orderId() } },
  });

  const rows = () =>
    h.w.db
      .prepare(
        "SELECT paypal_event_id AS eventId, event_type AS eventType, status, reason, attempts, deliveries, paypal_order_id AS orderId, transaction_id AS tx FROM webhook_events ORDER BY received_at, rowid",
      )
      .all() as {
      eventId: string;
      eventType: string;
      status: string;
      reason: string | null;
      attempts: number;
      deliveries: number;
      orderId: string | null;
      tx: string | null;
    }[];

  return {
    ...h,
    fv,
    webhooks,
    deliver,
    rows,
    event,
    /** CHECKOUT.ORDER.APPROVED for the fake's order. */
    approvedEvent: (id: string) => event(id, "CHECKOUT.ORDER.APPROVED", { id: orderId() }),
    authEvent: (id: string, type = "PAYMENT.AUTHORIZATION.CREATED", authId?: string) =>
      event(id, type, related(authId ?? (h.fake.only().authorization?.id as string))),
    capEvent: (id: string, type = "PAYMENT.CAPTURE.COMPLETED", capId?: string) =>
      event(id, type, related(capId ?? (h.fake.only().captures.at(-1)?.id as string))),
    webhookAudit: () =>
      (
        h.w.db
          .prepare(
            "SELECT type, payload FROM audit_events WHERE actor = 'PAYPAL_WEBHOOK' ORDER BY seq",
          )
          .all() as { type: string; payload: string }[]
      ).map((r) => ({ type: r.type, payload: JSON.parse(r.payload) as Record<string, unknown> })),
    /** Counts of PayPal order reads made so far. */
    reads: () => h.fake.calls.filter((c) => c.op === "getOrder").length,
  };
}

export type WebhookHarness = ReturnType<typeof setupWebhooks>;
