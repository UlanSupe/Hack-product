import { sha256Hex } from "../domain/canonical.ts";
import {
  isWebhookEventType,
  judgeEvent,
  MAX_READ_BEHIND_ATTEMPTS,
  CLAIM_STALE_MS,
  parseWebhookEvent,
  type WebhookReason,
} from "../domain/webhook.ts";
import type { WebhookHeaders, WebhookVerifier } from "../ports/webhook-verifier.ts";
import type { WebhookStore } from "../ports/webhook-store.ts";
import type { PaymentService } from "./payments.ts";

/**
 * Handles one PayPal webhook delivery. The order of the checks IS the security model:
 *
 *  1. the webhook is configured (id from OUR configuration, never from the message), else nothing is read;
 *  2. the headers and body are well formed and bounded (cheap, before any network call);
 *  3. PayPal's own verification service says the signature is good, over the body exactly as received. An unverified
 *     delivery is never stored, never audited under its own claimed event id, and never changes anything;
 *  4. the event id is claimed in the database: a repeat is a no-op, a concurrent copy is told to retry, a failed one is
 *     retried, an id reused with different content is refused;
 *  5. the event is only a TRIGGER: the order is read from PayPal and the read is what is applied (the payment service's
 *     own rules decide what the transition table allows). The event is then judged against that read, so an old,
 *     early, contradicted or unconfirmable event cannot move anything.
 *
 * It answers 2xx only when the event is finished (processed, ignored or already seen) and non-2xx when PayPal should
 * deliver it again (it retries for days). Nothing here logs; responses carry codes only.
 */

export type WebhookRequest = {
  /** Header lookup, case-insensitive. */
  header: (name: string) => string | null;
  /** The body exactly as received. */
  rawBody: string;
};

export type WebhookResponse = {
  http: 200 | 400 | 401 | 409 | 413 | 429 | 500 | 503;
  status: "PROCESSED" | "IGNORED" | "DUPLICATE" | "REJECTED" | "RETRY" | "NOT_CONFIGURED";
  reason: string;
};

export type WebhookDeps = {
  store: WebhookStore;
  /** Null when PayPal credentials are not configured. */
  verifier: WebhookVerifier | null;
  /** PAYPAL_WEBHOOK_ID. Null: webhooks are refused (503) because nothing can be verified. */
  webhookId: string | null;
  payments: Pick<PaymentService, "reconcileOrder">;
  now: () => Date;
  newId: (prefix: string) => string;
};

export const MAX_WEBHOOK_BODY_BYTES = 256 * 1024;
/** PayPal retries for 3 days; allow that, plus clock slack the other way. */
const MAX_AGE_MS = 4 * 24 * 3600 * 1000;
const MAX_SKEW_MS = 5 * 60 * 1000;
/** At most this many rejections are written to the audit trail per minute (a flood must not fill it). */
const REJECTION_AUDITS_PER_MINUTE = 20;
/**
 * At most this many deliveries per minute are sent to PayPal's verification service. The endpoint is unauthenticated, so
 * without a cap anyone could make this server spend its PayPal API quota (and get its credentials rate-limited, which
 * would stop real payments). Genuine traffic is a few events per payment; PayPal redelivers anything answered with 429.
 */
export const VERIFICATIONS_PER_MINUTE = 120;

const TOKEN = /^[A-Za-z0-9._:-]{1,128}$/;
const SIGNATURE = /^[A-Za-z0-9+/=_-]{1,2048}$/;
const ALGO = /^[A-Za-z0-9_-]{1,32}$/;

/** The certificate URL is only forwarded to PayPal's verifier, but it must at least be https on paypal.com. */
function certUrlOk(value: string): boolean {
  try {
    const u = new URL(value);
    return (
      u.protocol === "https:" && (u.hostname === "paypal.com" || u.hostname.endsWith(".paypal.com"))
    );
  } catch {
    return false;
  }
}

export function createWebhookService(deps: WebhookDeps) {
  const system = { kind: "SYSTEM", id: "paypal-webhook" } as const;
  const rejections: number[] = [];
  const verifications: number[] = [];

  const audit = (
    type: string,
    subjectId: string,
    payload: Record<string, unknown>,
    tx?: string | null,
  ) =>
    deps.store.transaction((ops) =>
      ops.audit({
        ts: deps.now().toISOString(),
        type,
        subjectId,
        transactionId: tx ?? null,
        payload,
      }),
    );

  const reject = (
    http: 400 | 401 | 409 | 413,
    reason: string,
    subjectId: string,
    extra: Record<string, unknown> = {},
  ): WebhookResponse => {
    const t = deps.now().getTime();
    while (rejections.length > 0 && (rejections[0] as number) < t - 60_000) rejections.shift();
    if (rejections.length < REJECTION_AUDITS_PER_MINUTE) {
      rejections.push(t);
      audit("WEBHOOK_REJECTED", subjectId, { reason, ...extra });
    }
    return { http, status: "REJECTED", reason };
  };

  return {
    async handle(req: WebhookRequest): Promise<WebhookResponse> {
      if (deps.webhookId === null || deps.verifier === null) {
        return { http: 503, status: "NOT_CONFIGURED", reason: "WEBHOOK_NOT_CONFIGURED" };
      }

      // 2. well formed and bounded
      if (new TextEncoder().encode(req.rawBody).length > MAX_WEBHOOK_BODY_BYTES) {
        return reject(413, "BODY_TOO_LARGE", "unknown");
      }
      const transmissionId = req.header("paypal-transmission-id") ?? "";
      const subject = TOKEN.test(transmissionId) ? transmissionId : "unknown";
      const headers: WebhookHeaders = {
        transmissionId,
        transmissionTime: req.header("paypal-transmission-time") ?? "",
        certUrl: req.header("paypal-cert-url") ?? "",
        transmissionSig: req.header("paypal-transmission-sig") ?? "",
        authAlgo: req.header("paypal-auth-algo") ?? "",
      };
      const sentAt = Date.parse(headers.transmissionTime);
      const nowMs = deps.now().getTime();
      if (
        !TOKEN.test(headers.transmissionId) ||
        !SIGNATURE.test(headers.transmissionSig) ||
        !ALGO.test(headers.authAlgo) ||
        !certUrlOk(headers.certUrl) ||
        !Number.isFinite(sentAt)
      ) {
        return reject(400, "MALFORMED_HEADERS", subject);
      }
      if (sentAt > nowMs + MAX_SKEW_MS || sentAt < nowMs - MAX_AGE_MS) {
        return reject(400, "TRANSMISSION_TIME_OUT_OF_RANGE", subject);
      }
      let rawEvent: unknown;
      try {
        rawEvent = JSON.parse(req.rawBody);
      } catch {
        return reject(400, "MALFORMED_EVENT", subject);
      }
      const parsed = parseWebhookEvent(rawEvent);
      if (!parsed.ok) return reject(400, "MALFORMED_EVENT", subject);
      const event = parsed.event;

      // 3. PayPal's own verification, over the exact bytes (bounded: see VERIFICATIONS_PER_MINUTE)
      while (verifications.length > 0 && (verifications[0] as number) < nowMs - 60_000)
        verifications.shift();
      if (verifications.length >= VERIFICATIONS_PER_MINUTE) {
        return { http: 429, status: "RETRY", reason: "RATE_LIMITED" };
      }
      verifications.push(nowMs);
      let verdict: "VERIFIED" | "REJECTED";
      try {
        verdict = await deps.verifier.verify({
          headers,
          webhookId: deps.webhookId,
          rawBody: req.rawBody,
        });
      } catch {
        // Could not find out (network, PayPal down, credentials): not a pass, not a verdict. PayPal will retry.
        return { http: 503, status: "RETRY", reason: "VERIFICATION_UNAVAILABLE" };
      }
      if (verdict !== "VERIFIED") return reject(401, "INVALID_SIGNATURE", subject);

      // 4. claim the event id
      const payloadHash = sha256Hex(req.rawBody);
      const nowIso = deps.now().toISOString();
      const claim = deps.store.transaction((ops) =>
        ops.claim({
          id: deps.newId("whe"),
          paypalEventId: event.eventId,
          eventType: event.eventType,
          resourceId: event.resourceId,
          paypalOrderId: event.orderId,
          transmissionId,
          payloadHash,
          now: nowIso,
          staleBefore: new Date(deps.now().getTime() - CLAIM_STALE_MS).toISOString(),
        }),
      );
      if (claim.kind === "DUPLICATE") {
        audit(
          "WEBHOOK_DUPLICATE",
          claim.record.paypalEventId,
          {
            eventType: claim.record.eventType,
            status: claim.record.status,
            deliveries: claim.record.deliveries,
          },
          claim.record.transactionId,
        );
        return {
          http: 200,
          status: "DUPLICATE",
          reason: claim.record.reason ?? claim.record.status,
        };
      }
      if (claim.kind === "BUSY")
        return { http: 503, status: "RETRY", reason: "ALREADY_PROCESSING" };
      if (claim.kind === "HASH_MISMATCH") {
        audit("WEBHOOK_REJECTED", claim.record.paypalEventId, {
          reason: "EVENT_ID_REUSED_WITH_DIFFERENT_CONTENT",
          eventType: event.eventType,
        });
        return { http: 409, status: "REJECTED", reason: "EVENT_ID_REUSED_WITH_DIFFERENT_CONTENT" };
      }
      const { record } = claim;

      // 5. act on it: read PayPal, apply the read, judge the event against it
      let transactionId = null as string | null;
      let outcome: { status: "PROCESSED" | "IGNORED" | "FAILED"; reason: WebhookReason };
      try {
        outcome = await (async () => {
          if (!isWebhookEventType(event.eventType)) {
            return { status: "IGNORED", reason: "UNSUPPORTED_EVENT_TYPE" } as const;
          }
          if (event.orderId === null) return { status: "IGNORED", reason: "NO_ORDER_ID" } as const;
          let result: Awaited<ReturnType<typeof deps.payments.reconcileOrder>>;
          try {
            result = await deps.payments.reconcileOrder(system, event.orderId);
          } catch {
            return { status: "FAILED", reason: "READ_FAILED" } as const;
          }
          if (result.kind === "UNKNOWN_ORDER")
            return { status: "IGNORED", reason: "UNKNOWN_ORDER" } as const;
          transactionId = result.transactionId;
          if (result.kind === "TERMINAL")
            return { status: "IGNORED", reason: "TERMINAL_STATE" } as const;
          switch (judgeEvent(event.eventType, event.resourceId, result.observed)) {
            case "CONSISTENT":
              return {
                status: "PROCESSED",
                reason: result.after !== result.before ? "APPLIED" : "CONSISTENT",
              } as const;
            case "AHEAD":
              return record.attempts >= MAX_READ_BEHIND_ATTEMPTS
                ? ({ status: "IGNORED", reason: "READ_NEVER_CAUGHT_UP" } as const)
                : ({ status: "FAILED", reason: "READ_BEHIND" } as const);
            case "SUPERSEDED":
              return { status: "IGNORED", reason: "SUPERSEDED" } as const;
            case "CONTRADICTED":
              return { status: "IGNORED", reason: "CONTRADICTED" } as const;
            case "NOT_CONFIRMABLE":
              return { status: "IGNORED", reason: "NOT_CONFIRMABLE" } as const;
          }
        })();
      } catch {
        outcome = { status: "FAILED", reason: "PROCESSING_ERROR" };
      }

      deps.store.transaction((ops) => {
        const ts = deps.now().toISOString();
        ops.finish({
          id: record.id,
          status: outcome.status,
          reason: outcome.reason,
          transactionId,
          now: ts,
        });
        ops.audit({
          ts,
          type: `WEBHOOK_${outcome.status}`,
          subjectId: event.eventId,
          transactionId,
          payload: {
            eventType: event.eventType,
            status: outcome.status,
            reason: outcome.reason,
            attempts: record.attempts,
          },
        });
      });

      if (outcome.status === "FAILED") {
        return {
          http: outcome.reason === "PROCESSING_ERROR" ? 500 : 503,
          status: "RETRY",
          reason: outcome.reason,
        };
      }
      return { http: 200, status: outcome.status, reason: outcome.reason };
    },
  };
}

export type WebhookService = ReturnType<typeof createWebhookService>;
