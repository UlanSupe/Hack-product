import { z } from "zod";

import type { ObservedCapture, ObservedOrder } from "./payment.ts";

/**
 * What a PayPal webhook delivery may tell us, and how to judge it against the order PayPal reports afterwards.
 * Pure: no I/O, no clock. A verified webhook is only a TRIGGER to look. It is never evidence of a state: the state
 * change comes from a fresh authenticated read of the order (docs/PAYPAL_INTEGRATION.md section 8), and this module
 * only decides whether the event is consistent with that read, behind it, superseded by it, or contradicted by it.
 *
 * Event names are from PayPal's webhook event-names page (read 2026-10-13). Field paths (`resource.id`,
 * `resource.supplementary_data.related_ids.order_id`) are from PayPal's OpenAPI examples; unverified against live
 * deliveries.
 */

export const WEBHOOK_EVENT_TYPES = [
  "CHECKOUT.ORDER.APPROVED",
  "PAYMENT.AUTHORIZATION.CREATED",
  "PAYMENT.AUTHORIZATION.VOIDED",
  "PAYMENT.CAPTURE.COMPLETED",
  "PAYMENT.CAPTURE.PENDING",
  "PAYMENT.CAPTURE.DECLINED",
  "PAYMENT.CAPTURE.REFUNDED",
  "PAYMENT.CAPTURE.REVERSED",
] as const;
export type WebhookEventType = (typeof WEBHOOK_EVENT_TYPES)[number];

export const isWebhookEventType = (t: string): t is WebhookEventType =>
  (WEBHOOK_EVENT_TYPES as readonly string[]).includes(t);

/** Why a verified event ended up PROCESSED, IGNORED or FAILED. Stored as the `reason` column. */
export const WEBHOOK_REASONS = {
  APPLIED: "The event was confirmed by a fresh read and changed the transaction.",
  CONSISTENT: "The event matched what PayPal reports and our records already agreed.",
  UNSUPPORTED_EVENT_TYPE: "This event type is not one this flow acts on.",
  NO_ORDER_ID: "The event does not identify a PayPal order.",
  UNKNOWN_ORDER: "No transaction here belongs to that PayPal order.",
  TERMINAL_STATE: "The transaction is finished; nothing was asked of PayPal.",
  SUPERSEDED: "PayPal now reports a later state than this event describes.",
  CONTRADICTED: "PayPal's current record contradicts this event.",
  NOT_CONFIRMABLE: "The order read cannot confirm this kind of event, so it changed nothing.",
  READ_BEHIND: "PayPal's order does not yet show what the event announced; asked to retry.",
  READ_NEVER_CAUGHT_UP: "PayPal's order never showed what the event announced.",
  READ_FAILED: "PayPal could not be read; asked to retry.",
  PROCESSING_ERROR: "An internal error stopped processing; asked to retry.",
} as const;
export type WebhookReason = keyof typeof WEBHOOK_REASONS;

/** After this many failed processing attempts a "read is behind" event stops asking for redelivery. */
export const MAX_READ_BEHIND_ATTEMPTS = 5;
/** A claim older than this is treated as abandoned (the worker died) and may be taken over. */
export const CLAIM_STALE_MS = 5 * 60 * 1000;

/* ------------------------------------------------------------------ parsing */

const ORDER_ID = /^[A-Z0-9]{1,36}$/;
const Id = z.string().min(1).max(128);

const EventSchema = z.object({
  id: Id,
  event_type: z.string().min(1).max(80),
  create_time: z.string().max(64).optional(),
  resource_type: z.string().max(64).optional(),
  resource: z
    .object({
      id: Id.optional(),
      supplementary_data: z
        .object({ related_ids: z.object({ order_id: z.string().max(64).optional() }).optional() })
        .optional(),
    })
    .optional(),
});

export type ParsedWebhookEvent = {
  eventId: string;
  eventType: string;
  resourceId: string | null;
  /** The PayPal order the event concerns, if it names one in the documented way and it looks like an order id. */
  orderId: string | null;
};

export function parseWebhookEvent(
  raw: unknown,
): { ok: true; event: ParsedWebhookEvent } | { ok: false } {
  const parsed = EventSchema.safeParse(raw);
  if (!parsed.success) return { ok: false };
  const e = parsed.data;
  const resourceId = e.resource?.id ?? null;
  const fromRelated = e.resource?.supplementary_data?.related_ids?.order_id;
  // For order events the resource IS the order; for authorization and capture events the order is a related id.
  const candidate = e.event_type.startsWith("CHECKOUT.ORDER.")
    ? (resourceId ?? undefined)
    : fromRelated;
  return {
    ok: true,
    event: {
      eventId: e.id,
      eventType: e.event_type,
      resourceId,
      orderId: candidate !== undefined && ORDER_ID.test(candidate) ? candidate : null,
    },
  };
}

/* ------------------------------------------------------------------ judging against the fresh read */

export type Judgement = "CONSISTENT" | "AHEAD" | "SUPERSEDED" | "CONTRADICTED" | "NOT_CONFIRMABLE";

const captureOf = (o: ObservedOrder, id: string | null): ObservedCapture | undefined =>
  id === null ? undefined : o.captures.find((c) => c.id === id);

const REFUNDED = ["REFUNDED", "PARTIALLY_REFUNDED"];

/**
 * Compares what the event announced with what the order read shows now.
 *  - CONSISTENT: the read shows it.
 *  - AHEAD: the event is ahead of the read (PayPal's read may lag): worth asking for redelivery.
 *  - SUPERSEDED: the read shows something later; the event is old news.
 *  - CONTRADICTED: the read shows something incompatible.
 *  - NOT_CONFIRMABLE: the order read cannot show this kind of fact at all.
 */
export function judgeEvent(
  type: WebhookEventType,
  resourceId: string | null,
  o: ObservedOrder,
): Judgement {
  const auth = o.authorizations[0];
  switch (type) {
    case "CHECKOUT.ORDER.APPROVED":
      return o.status === "CREATED" || o.status === "SAVED" || o.status === "PAYER_ACTION_REQUIRED"
        ? "AHEAD"
        : "CONSISTENT"; // APPROVED, or anything that can only follow approval
    case "PAYMENT.AUTHORIZATION.CREATED":
      return auth === undefined ? "AHEAD" : auth.status === "CREATED" ? "CONSISTENT" : "SUPERSEDED";
    case "PAYMENT.AUTHORIZATION.VOIDED":
      if (auth === undefined) return "AHEAD";
      if (auth.status === "VOIDED") return "CONSISTENT";
      return auth.status === "CREATED" || auth.status === "PENDING" ? "AHEAD" : "CONTRADICTED";
    case "PAYMENT.CAPTURE.COMPLETED": {
      const c = captureOf(o, resourceId);
      if (c === undefined || c.status === "PENDING") return "AHEAD";
      if (c.status === "COMPLETED") return "CONSISTENT";
      return REFUNDED.includes(c.status) ? "SUPERSEDED" : "CONTRADICTED";
    }
    case "PAYMENT.CAPTURE.PENDING": {
      const c = captureOf(o, resourceId);
      if (c === undefined) return "AHEAD";
      if (c.status === "PENDING") return "CONSISTENT";
      return "SUPERSEDED";
    }
    case "PAYMENT.CAPTURE.DECLINED": {
      const c = captureOf(o, resourceId);
      if (c === undefined || c.status === "PENDING") return "AHEAD";
      if (c.status === "DECLINED" || c.status === "FAILED") return "CONSISTENT";
      return "CONTRADICTED";
    }
    case "PAYMENT.CAPTURE.REFUNDED": {
      const c = captureOf(o, resourceId);
      if (c === undefined || c.status === "COMPLETED" || c.status === "PENDING") return "AHEAD";
      return REFUNDED.includes(c.status) ? "CONSISTENT" : "CONTRADICTED";
    }
    case "PAYMENT.CAPTURE.REVERSED":
      // A reversal (chargeback) is not a capture status the order read documents, so it is recorded but never applied.
      return "NOT_CONFIRMABLE";
  }
}
