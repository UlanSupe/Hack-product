import { formatMinor, type SupportedCurrency } from "../domain/mandate.ts";
import type { PayeeCheck } from "../domain/payment.ts";
import type { TxState } from "../domain/transaction-states.ts";
import type { AttemptInfo, HistoryRow, PaymentContext } from "../ports/payment-store.ts";

/**
 * What the screen shows about a payment. Everything is derived from stored, server-verified state: a screen never
 * reads PayPal and never takes an amount from the browser. `moneyMoved` is true in exactly one state, CAPTURED,
 * which the server enters only after reading a capture that PayPal reports COMPLETED for the agreed total. Every other
 * state (including a pending capture and a hold) is "not paid". Nothing here describes escrow or a refund promise:
 * an authorization is a hold that can lapse, and a capture is a charge.
 */

export type PaymentNextAction =
  "START" | "OPEN_APPROVAL" | "CHECK" | "AUTHORIZE" | "CAPTURE_OR_VOID" | "RECONCILE" | "NONE";

export type PaymentTone = "info" | "success" | "warning" | "danger";

/** One line of the transaction history, derived from the tamper-evident audit trail. Never raw payloads. */
export type HistoryEntry = {
  seq: number;
  at: string;
  actor: string;
  title: string;
  detail: string;
};

export type PaymentView = {
  negotiationId: string;
  transactionId: string;
  agreementVersion: number;
  environment: "PayPal Sandbox (test money)";
  state: TxState;
  headline: string;
  detail: string;
  tone: PaymentTone;
  nextAction: PaymentNextAction;
  amountText: string;
  currency: string;
  paypalOrderId: string | null;
  /** Only while the buyer still has to approve; always https on a paypal.com host. */
  approveUrl: string | null;
  authorization: {
    id: string;
    amountText: string;
    authorizedAt: string | null;
    honorExpiresAt: string | null;
  } | null;
  /** Set only when PayPal's capture is COMPLETED (the state is CAPTURED, or REVERSED after a refund). */
  capture: { id: string; amountText: string } | null;
  payeeCheck: PayeeCheck | null;
  warnings: string[];
  attempts: {
    action: string;
    seq: number;
    status: string;
    httpStatus: number | null;
    debugId: string | null;
    startedAt: string;
  }[];
  /** True only in the CAPTURED state: PayPal reported a completed capture of the agreed total. */
  moneyMoved: boolean;
  /** The latest audit events of this transaction, oldest first (state changes, policy decisions, PayPal reads, webhooks). */
  history: HistoryEntry[];
};

type Text = { headline: string; detail: string; tone: PaymentTone; next: PaymentNextAction };

const TEXT: Partial<Record<TxState, Text>> = {
  AGREED: {
    headline: "Ready to start the PayPal sandbox payment",
    detail:
      "The agreement passed the policy check. Starting creates a PayPal sandbox order for the agreed total. The buyer must then approve it at PayPal.",
    tone: "info",
    next: "START",
  },
  CREATING_ORDER: {
    headline: "Creating the PayPal order…",
    detail: "A request to PayPal is in progress. Check the status in a moment.",
    tone: "info",
    next: "CHECK",
  },
  ORDER_CREATED: {
    headline: "Waiting for the buyer to approve at PayPal",
    detail:
      "The order exists at PayPal but nothing is held yet. Open the approval page, log in as the sandbox buyer and approve, then check the status. Coming back from PayPal proves nothing by itself: the server asks PayPal.",
    tone: "info",
    next: "OPEN_APPROVAL",
  },
  ORDER_APPROVED: {
    headline: "PayPal says the buyer approved",
    detail:
      "The server confirmed the approval with PayPal. Funds are not held yet. Authorizing places a hold on the buyer's funds; it does not charge them.",
    tone: "info",
    next: "AUTHORIZE",
  },
  AUTHORIZING: {
    headline: "Authorizing…",
    detail: "The authorization request is in progress. Check the status in a moment.",
    tone: "info",
    next: "CHECK",
  },
  AUTHORIZATION_PENDING: {
    headline: "PayPal has not finished the authorization",
    detail:
      "PayPal reports the authorization as pending (for example under review). No funds are held yet. Check the status again later.",
    tone: "warning",
    next: "CHECK",
  },
  AUTHORIZED: {
    headline: "Funds are on hold (authorized), not charged",
    detail:
      "PayPal confirmed an authorization for the agreed total. The buyer has not been charged and nothing has been paid out. Capture charges the buyer's sandbox account and pays the merchant account; releasing (voiding) the hold charges nothing. A hold is not escrow: it can lapse or be declined when captured, so capture inside the hold period.",
    tone: "success",
    next: "CAPTURE_OR_VOID",
  },
  CAPTURING: {
    headline: "Capturing…",
    detail:
      "The capture request is in progress. It is not paid until PayPal reports it completed. Check the status in a moment; do not send it again.",
    tone: "info",
    next: "CHECK",
  },
  CAPTURE_PENDING: {
    headline: "PayPal has not completed the capture: not paid yet",
    detail:
      "PayPal reports the capture as pending (for example under review). The buyer has not been charged for certain and nothing counts as paid. Check the status again later.",
    tone: "warning",
    next: "CHECK",
  },
  CAPTURED: {
    headline: "Captured: PayPal reports the payment completed",
    detail:
      "PayPal reports a completed capture for the agreed total in the sandbox (test money). This is a charge, not escrow, and nothing here promises a refund. The seller has not been paid out: payouts are separate and not built.",
    tone: "success",
    next: "CHECK",
  },
  VOIDING: {
    headline: "Releasing the hold…",
    detail:
      "The release request is in progress. Check the status in a moment; do not send it again.",
    tone: "info",
    next: "CHECK",
  },
  REVERSED: {
    headline: "The captured payment was refunded or reversed at PayPal",
    detail:
      "PayPal reports the capture as refunded. It no longer counts as paid. This build cannot start refunds; it only records what PayPal reports.",
    tone: "danger",
    next: "NONE",
  },
  NEEDS_RECONCILIATION: {
    headline: "The outcome is unknown: needs a status check",
    detail:
      "A request to PayPal may or may not have taken effect. Nothing is treated as done. Use “Check status” so the server can ask PayPal what really happened.",
    tone: "warning",
    next: "RECONCILE",
  },
  FAILED: {
    headline: "The payment failed; nothing was charged",
    detail:
      "PayPal refused the request or the authorization was denied. This agreement cannot be paid any more; negotiate a new one.",
    tone: "danger",
    next: "NONE",
  },
  CANCELLED: {
    headline: "The payment was cancelled",
    detail: "The order was cancelled or voided before any funds were held.",
    tone: "danger",
    next: "NONE",
  },
  VOIDED: {
    headline: "The hold was released",
    detail: "PayPal reports the authorization as voided. Nothing was charged.",
    tone: "info",
    next: "NONE",
  },
};

const FALLBACK: Text = {
  headline: "Payment state",
  detail: "See the state below.",
  tone: "info",
  next: "NONE",
};

const TITLES: Record<string, string> = {
  TX_STATE_CHANGED: "State changed",
  PAYMENT_POLICY_DENIED: "Policy refused a payment step",
  PAYPAL_ORDER_OBSERVED: "Read the order from PayPal",
  PAYPAL_ANOMALY: "PayPal's record did not match the agreement",
  PAYPAL_CALL_REFUSED: "PayPal refused a request",
  PAYPAL_CALL_STILL_UNKNOWN: "A request's outcome is still unknown",
  PAYPAL_READ_FAILED: "Could not read the order from PayPal",
  PAYPAL_OBSERVATION_NOT_APPLIED: "A PayPal state could not be recorded",
  PAYPAL_VOID_NOT_NEEDED: "The hold was already released at PayPal",
  WEBHOOK_PROCESSED: "PayPal webhook processed",
  WEBHOOK_IGNORED: "PayPal webhook ignored",
  WEBHOOK_FAILED: "PayPal webhook processing failed (PayPal will retry)",
  WEBHOOK_DUPLICATE: "PayPal webhook delivered again (no change)",
};

/** Only these payload keys reach the screen, and only as short strings. */
const DETAIL_KEYS = [
  "from",
  "to",
  "subject",
  "reasonCodes",
  "findings",
  "eventType",
  "status",
  "reason",
  "target",
  "authorizationStatus",
  "captureStatus",
  "observedOrderStatus",
  "providerError",
  "httpStatus",
] as const;

const short = (v: unknown): string | null => {
  if (typeof v === "string") return v.slice(0, 80);
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  if (Array.isArray(v)) {
    const parts = v.filter((x): x is string => typeof x === "string").map((x) => x.slice(0, 40));
    return parts.length > 0 ? parts.slice(0, 8).join(", ") : null;
  }
  return null;
};

export function buildHistory(rows: HistoryRow[]): HistoryEntry[] {
  return rows.map((r) => {
    let payload: Record<string, unknown> = {};
    try {
      const p: unknown = JSON.parse(r.payload);
      if (p !== null && typeof p === "object" && !Array.isArray(p))
        payload = p as Record<string, unknown>;
    } catch {
      // an unreadable payload shows no detail
    }
    const from = short(payload.from);
    const to = short(payload.to);
    const detail =
      r.type === "TX_STATE_CHANGED" && from !== null && to !== null
        ? `${from} → ${to}`
        : DETAIL_KEYS.map((k) => {
            const v = short(payload[k]);
            return v === null ? null : `${k}: ${v}`;
          })
            .filter((x): x is string => x !== null)
            .join(" · ");
    return {
      seq: r.seq,
      at: r.ts,
      actor: r.actor,
      title: TITLES[r.type] ?? r.type.toLowerCase().replaceAll("_", " "),
      detail,
    };
  });
}

export function buildPaymentView(args: {
  context: PaymentContext;
  attempts: AttemptInfo[];
  history?: HistoryRow[];
  approveUrl: string | null;
  payeeCheck: PayeeCheck | null;
  warnings: string[];
}): PaymentView {
  const { context: c } = args;
  const text = TEXT[c.txState] ?? FALLBACK;
  const money = (minor: number) =>
    `${formatMinor(minor, c.currency as SupportedCurrency)} ${c.currency}`;
  return {
    negotiationId: c.negotiationId,
    transactionId: c.transactionId,
    agreementVersion: c.agreementVersion,
    environment: "PayPal Sandbox (test money)",
    state: c.txState,
    headline: text.headline,
    detail: text.detail,
    tone: text.tone,
    nextAction: c.txState === "ORDER_CREATED" && args.approveUrl === null ? "CHECK" : text.next,
    amountText: money(c.totalMinor),
    currency: c.currency,
    paypalOrderId: c.paypalOrderId,
    approveUrl: c.txState === "ORDER_CREATED" ? args.approveUrl : null,
    authorization:
      c.paypalAuthorizationId !== null && c.authorizedMinor !== null
        ? {
            id: c.paypalAuthorizationId,
            amountText: money(c.authorizedMinor),
            authorizedAt: c.authorizedAt,
            honorExpiresAt: c.honorExpiresAt,
          }
        : null,
    capture:
      c.paypalCaptureId !== null && c.capturedMinor !== null
        ? { id: c.paypalCaptureId, amountText: money(c.capturedMinor) }
        : null,
    payeeCheck: args.payeeCheck,
    warnings: args.warnings,
    attempts: args.attempts.map((a) => ({
      action: a.action,
      seq: a.seq,
      status: a.status,
      httpStatus: a.httpStatus,
      debugId: a.debugId,
      startedAt: a.startedAt,
    })),
    moneyMoved: c.txState === "CAPTURED",
    history: buildHistory(args.history ?? []),
  };
}
