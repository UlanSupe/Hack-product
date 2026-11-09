import { parseDecimalAmount, type SupportedCurrency, SUPPORTED_CURRENCIES } from "./mandate.ts";
import type { TxState } from "./transaction-states.ts";

/**
 * What PayPal said about an order and its authorization, as plain data, and what that means for us.
 * Pure: no I/O, no clock. The adapter turns PayPal's JSON into these shapes; the application layer decides
 * what to do. Nothing here trusts a value just because PayPal (or a browser) said it: every observed value is
 * compared with what our own stored records say it must be (docs/PAYPAL_INTEGRATION.md sections 5 and 6).
 *
 * Status vocabularies are from PayPal's Orders v2 / Payments v2 OpenAPI documents (read 2026-10-13).
 */

/* ------------------------------------------------------------------ provider failures */

export const PROVIDER_ERROR_KINDS = [
  "NETWORK",
  "TIMEOUT",
  "RATE_LIMITED",
  "SERVER",
  "AUTH",
  "CONFLICT",
  "ACCEPTED_INCOMPLETE",
  "REJECTED",
  "NOT_FOUND",
  "MALFORMED",
] as const;
export type ProviderErrorKind = (typeof PROVIDER_ERROR_KINDS)[number];

/**
 * Issue codes that mean "something already happened to this resource": a rejection carrying one of them proves
 * nothing about whether our earlier attempt took effect, so it is UNKNOWN and gets reconciled by a read.
 */
export const RECONCILE_ISSUES: readonly string[] = [
  "ORDER_ALREADY_AUTHORIZED",
  "ORDER_COMPLETED_OR_VOIDED",
  "PREVIOUS_REQUEST_IN_PROGRESS",
  "DUPLICATE_INVOICE_ID",
  "MAX_AUTHORIZATION_COUNT_EXCEEDED",
  // Capture and void. PREVIOUSLY_CAPTURED (void) and MAX_CAPTURE_AMOUNT_EXCEEDED (capture) are in PayPal's Payments v2
  // examples; the other two are precautions. Each can mean OUR earlier request already took effect.
  "PREVIOUSLY_CAPTURED",
  "MAX_CAPTURE_AMOUNT_EXCEEDED",
  "AUTHORIZATION_ALREADY_CAPTURED",
  "AUTHORIZATION_VOIDED",
];

export type FailureOutcome = "DEFINITE_FAILURE" | "UNKNOWN";

/**
 * TRANSACTION_STATE_MACHINE section 4.1. A definite failure means PayPal processed the request and refused it.
 * Everything that leaves the request possibly applied (network loss, timeouts, 429, 5xx, 409, 202, an
 * unparseable answer, credentials we could not refresh) is UNKNOWN and is never turned into success or failure
 * without a read.
 */
export function failureOutcome(f: {
  kind: ProviderErrorKind;
  issues: readonly string[];
}): FailureOutcome {
  if (f.kind === "REJECTED" || f.kind === "NOT_FOUND") {
    return f.issues.some((i) => RECONCILE_ISSUES.includes(i)) ? "UNKNOWN" : "DEFINITE_FAILURE";
  }
  return "UNKNOWN";
}

/* ------------------------------------------------------------------ observed objects */

export const PAYPAL_ORDER_STATUSES = [
  "CREATED",
  "SAVED",
  "APPROVED",
  "VOIDED",
  "COMPLETED",
  "PAYER_ACTION_REQUIRED",
] as const;
export type PayPalOrderStatus = (typeof PAYPAL_ORDER_STATUSES)[number];

export const PAYPAL_AUTHORIZATION_STATUSES = [
  "CREATED",
  "CAPTURED",
  "DENIED",
  "PARTIALLY_CAPTURED",
  "VOIDED",
  "PENDING",
] as const;
export type PayPalAuthorizationStatus = (typeof PAYPAL_AUTHORIZATION_STATUSES)[number];

export type ObservedMoney = { minor: number; currency: string };

export type ObservedAuthorization = {
  id: string;
  /** Verbatim from PayPal; compared with the documented set, never trusted to be one of them. */
  status: string;
  amount: ObservedMoney | null;
  customId: string | null;
  invoiceId: string | null;
  createTime: string | null;
  expirationTime: string | null;
  statusReason: string | null;
};

export const PAYPAL_CAPTURE_STATUSES = [
  "COMPLETED",
  "DECLINED",
  "PARTIALLY_REFUNDED",
  "PENDING",
  "REFUNDED",
  "FAILED",
] as const;

export type ObservedCapture = {
  id: string;
  /** Verbatim from PayPal. */
  status: string;
  amount: ObservedMoney | null;
  /** Null when PayPal did not say. */
  finalCapture: boolean | null;
  invoiceId: string | null;
  createTime: string | null;
  statusReason: string | null;
};

export type ObservedOrder = {
  id: string;
  status: string;
  intent: string | null;
  purchaseUnitCount: number;
  amount: ObservedMoney | null;
  payeeMerchantId: string | null;
  customId: string | null;
  invoiceId: string | null;
  /** The buyer-approval link, only if it is https on a paypal.com host. */
  approveUrl: string | null;
  authorizations: ObservedAuthorization[];
  captures: ObservedCapture[];
};

/** What our own records say the order must look like. Built by the server from stored rows only. */
export type OrderExpectation = {
  amountMinor: number;
  currency: string;
  customId: string;
  /** The invoice id this attempt sent. */
  invoiceId: string;
  /** The sandbox merchant that must receive the funds (PAYPAL_MERCHANT_ID); null when not configured. */
  merchantId: string | null;
  /** The authorization id we stored; once known, any other id on the order is an anomaly. */
  authorizationId?: string | null;
  /** The capture id we stored; once known, any other live capture on the order is an anomaly. */
  captureId?: string | null;
};

/* ------------------------------------------------------------------ comparing with our records */

export type PayeeCheck = "MATCH" | "MISMATCH" | "UNVERIFIABLE" | "NOT_PINNED";

export const ORDER_FINDINGS = {
  INTENT_NOT_AUTHORIZE: "PayPal reports an intent other than AUTHORIZE.",
  UNIT_COUNT: "The order does not have exactly one purchase unit.",
  AMOUNT_MISSING: "PayPal's amount is missing or not a valid decimal for the currency.",
  AMOUNT_MISMATCH: "PayPal's amount differs from the agreement total.",
  CURRENCY_MISMATCH: "PayPal's currency differs from the agreement currency.",
  CUSTOM_ID_MISMATCH: "PayPal's custom_id is not this transaction's id.",
  INVOICE_ID_MISMATCH: "PayPal's invoice_id is not the one this attempt sent.",
  PAYEE_MISMATCH: "PayPal's payee is not the configured sandbox merchant.",
  AUTHORIZATION_COUNT: "The order does not have exactly one authorization.",
  AUTHORIZATION_AMOUNT_MISMATCH: "The authorization amount differs from the agreement total.",
  AUTHORIZATION_CURRENCY_MISMATCH:
    "The authorization currency differs from the agreement currency.",
  AUTHORIZATION_CUSTOM_ID_MISMATCH: "The authorization carries a different custom_id.",
  UNEXPECTED_CAPTURE: "A capture exists that the authorization state does not account for.",
  CAPTURE_COUNT: "The order has more than one live capture.",
  CAPTURE_AMOUNT_MISMATCH: "The capture amount differs from the agreement total.",
  CAPTURE_CURRENCY_MISMATCH: "The capture currency differs from the agreement currency.",
  CAPTURE_ID_MISMATCH: "The capture is not the one this transaction recorded.",
  CAPTURE_NOT_FINAL: "The capture is not marked final, so more captures could follow.",
  CAPTURE_STATUS_UNEXPECTED: "PayPal reports a capture status that this flow does not expect.",
  AUTHORIZATION_ID_MISMATCH: "The authorization is not the one this transaction recorded.",
  UNEXPECTED_STATUS: "PayPal reports a status that this flow does not expect here.",
  AUTHORIZATION_STATUS_UNEXPECTED:
    "PayPal reports an authorization status that this flow does not expect.",
  ORDER_ON_CREATED_HAS_AUTHORIZATION: "A not-yet-approved order already has an authorization.",
} as const;
export type OrderFinding = keyof typeof ORDER_FINDINGS;

export function checkPayee(o: ObservedOrder, e: OrderExpectation): PayeeCheck {
  if (e.merchantId === null) return "NOT_PINNED";
  if (o.payeeMerchantId === null) return "UNVERIFIABLE";
  return o.payeeMerchantId === e.merchantId ? "MATCH" : "MISMATCH";
}

/** Everything that must hold for ANY observation of this order, whatever its status. */
export function checkOrder(
  o: ObservedOrder,
  e: OrderExpectation,
): { findings: OrderFinding[]; payee: PayeeCheck } {
  const findings: OrderFinding[] = [];
  if (o.intent !== "AUTHORIZE") findings.push("INTENT_NOT_AUTHORIZE");
  if (o.purchaseUnitCount !== 1) findings.push("UNIT_COUNT");
  if (o.amount === null) findings.push("AMOUNT_MISSING");
  else {
    if (o.amount.currency !== e.currency) findings.push("CURRENCY_MISMATCH");
    if (o.amount.minor !== e.amountMinor) findings.push("AMOUNT_MISMATCH");
  }
  if (o.customId !== e.customId) findings.push("CUSTOM_ID_MISMATCH");
  if (o.invoiceId !== e.invoiceId) findings.push("INVOICE_ID_MISMATCH");
  const payee = checkPayee(o, e);
  if (payee === "MISMATCH") findings.push("PAYEE_MISMATCH");
  if (o.authorizations.length === 0 && o.captures.length > 0) findings.push("UNEXPECTED_CAPTURE");
  return { findings, payee };
}

function checkAuthorization(a: ObservedAuthorization, e: OrderExpectation): OrderFinding[] {
  const findings: OrderFinding[] = [];
  if (typeof e.authorizationId === "string" && a.id !== e.authorizationId)
    findings.push("AUTHORIZATION_ID_MISMATCH");
  if (a.amount === null) findings.push("AMOUNT_MISSING");
  else {
    if (a.amount.currency !== e.currency) findings.push("AUTHORIZATION_CURRENCY_MISMATCH");
    if (a.amount.minor !== e.amountMinor) findings.push("AUTHORIZATION_AMOUNT_MISMATCH");
  }
  if (a.customId !== null && a.customId !== e.customId)
    findings.push("AUTHORIZATION_CUSTOM_ID_MISMATCH");
  return findings;
}

function checkCapture(c: ObservedCapture, e: OrderExpectation): OrderFinding[] {
  const findings: OrderFinding[] = [];
  if (c.amount === null) findings.push("AMOUNT_MISSING");
  else {
    if (c.amount.currency !== e.currency) findings.push("CAPTURE_CURRENCY_MISMATCH");
    if (c.amount.minor !== e.amountMinor) findings.push("CAPTURE_AMOUNT_MISMATCH");
  }
  if (c.finalCapture === false) findings.push("CAPTURE_NOT_FINAL");
  if (typeof e.captureId === "string" && c.id !== e.captureId) findings.push("CAPTURE_ID_MISMATCH");
  return findings;
}

/* ------------------------------------------------------------------ mapping to our states */

export type ObservedTarget =
  | "ORDER_CREATED"
  | "ORDER_APPROVED"
  | "AUTHORIZED"
  | "AUTHORIZATION_PENDING"
  | "CAPTURE_PENDING"
  | "CAPTURED"
  | "REVERSED"
  | "FAILED"
  | "VOIDED"
  | "CANCELLED";

export type Interpretation =
  | { kind: "ANOMALY"; findings: OrderFinding[] }
  | {
      kind: "OBSERVED";
      target: ObservedTarget;
      authorization: ObservedAuthorization | null;
      /** The one live (not declined, not failed) capture, if any. */
      capture: ObservedCapture | null;
      /** A capture was attempted at PayPal and declined or failed; the hold may still be usable. */
      captureDeclined: boolean;
      payee: PayeeCheck;
      /** Non-fatal observations worth showing (for example that the payee could not be verified). */
      notes: string[];
    };

const anomaly = (...findings: OrderFinding[]): Interpretation => ({ kind: "ANOMALY", findings });

/**
 * PayPal's answer -> what it would mean for our transaction (docs/PAYPAL_INTEGRATION.md section 6.2). It names the
 * target state only; whether that state is reachable from the current one is decided by the transition table.
 * Order COMPLETED is never read as success by itself: only the authorization and capture inside it count, and only
 * a capture that PayPal reports COMPLETED, for exactly the agreed amount, is read as paid.
 */
export function interpretOrder(o: ObservedOrder, e: OrderExpectation): Interpretation {
  const { findings, payee } = checkOrder(o, e);
  if (findings.length > 0) return { kind: "ANOMALY", findings };
  const notes =
    payee === "NOT_PINNED"
      ? [
          "The sandbox merchant is not configured (PAYPAL_MERCHANT_ID), so the payee was not verified.",
        ]
      : payee === "UNVERIFIABLE"
        ? ["PayPal did not report the payee, so it could not be verified."]
        : [];
  const observed = (
    target: ObservedTarget,
    authorization: ObservedAuthorization | null,
    capture: ObservedCapture | null = null,
    captureDeclined = false,
  ): Interpretation => ({
    kind: "OBSERVED",
    target,
    authorization,
    capture,
    captureDeclined,
    payee,
    notes,
  });

  if (o.status === "VOIDED" && o.authorizations.length === 0) return observed("CANCELLED", null);

  if (o.authorizations.length === 0) {
    // PAYER_ACTION_REQUIRED is what the live sandbox reports right after creation (the payer has not approved yet);
    // observed on a real order, 2026-11-08. It means the same as CREATED for this flow.
    if (o.status === "CREATED" || o.status === "PAYER_ACTION_REQUIRED")
      return observed("ORDER_CREATED", null);
    if (o.status === "APPROVED") return observed("ORDER_APPROVED", null);
    // COMPLETED without an authorization is exactly the case PayPal warns about: do not read it as success.
    return anomaly(o.status === "COMPLETED" ? "AUTHORIZATION_COUNT" : "UNEXPECTED_STATUS");
  }

  if (o.authorizations.length > 1) return anomaly("AUTHORIZATION_COUNT");
  if (o.status === "CREATED") return anomaly("ORDER_ON_CREATED_HAS_AUTHORIZATION");
  if (o.status !== "COMPLETED" && o.status !== "APPROVED" && o.status !== "VOIDED")
    return anomaly("UNEXPECTED_STATUS");

  const auth = o.authorizations[0] as ObservedAuthorization;
  const authFindings = checkAuthorization(auth, e);
  if (authFindings.length > 0) return { kind: "ANOMALY", findings: authFindings };
  // An order only reads VOIDED when its authorization is voided too.
  if (o.status === "VOIDED" && auth.status !== "VOIDED") return anomaly("UNEXPECTED_STATUS");

  // Captures. A declined or failed capture is history, not money: it does not count as a capture.
  const live = o.captures.filter((c) => c.status !== "DECLINED" && c.status !== "FAILED");
  const captureDeclined = live.length < o.captures.length;
  if (live.length > 1) return anomaly("CAPTURE_COUNT");
  const cap = live[0];
  if (cap !== undefined) {
    const capFindings = checkCapture(cap, e);
    if (capFindings.length > 0) return { kind: "ANOMALY", findings: capFindings };
    if (auth.status === "VOIDED" || auth.status === "DENIED")
      return anomaly("AUTHORIZATION_STATUS_UNEXPECTED");
    switch (cap.status) {
      case "COMPLETED":
        // The capture object says paid; the authorization must agree before we believe it.
        return auth.status === "CAPTURED"
          ? observed("CAPTURED", auth, cap, captureDeclined)
          : anomaly("AUTHORIZATION_STATUS_UNEXPECTED");
      case "PENDING":
        return auth.status === "CREATED" || auth.status === "CAPTURED"
          ? observed("CAPTURE_PENDING", auth, cap, captureDeclined)
          : anomaly("AUTHORIZATION_STATUS_UNEXPECTED");
      case "REFUNDED":
      case "PARTIALLY_REFUNDED":
        return observed("REVERSED", auth, cap, captureDeclined);
      default:
        return anomaly("CAPTURE_STATUS_UNEXPECTED");
    }
  }

  switch (auth.status) {
    case "CREATED":
      return observed("AUTHORIZED", auth, null, captureDeclined);
    case "PENDING":
      return observed("AUTHORIZATION_PENDING", auth, null, captureDeclined);
    case "DENIED":
      return observed("FAILED", auth, null, captureDeclined);
    case "VOIDED":
      return observed("VOIDED", auth, null, captureDeclined);
    case "CAPTURED":
    case "PARTIALLY_CAPTURED":
      // The authorization says captured but no capture is listed: nothing proves what was paid.
      return anomaly("UNEXPECTED_CAPTURE");
    default:
      return anomaly("AUTHORIZATION_STATUS_UNEXPECTED");
  }
}

/* ------------------------------------------------------------------ amounts and times */

/** PayPal's `{currency_code, value}` -> integer minor units, or null if it is not a valid amount for that currency. */
export function observedMoney(
  m: { currency_code: string; value: string } | undefined,
): ObservedMoney | null {
  if (m === undefined) return null;
  if (!(m.currency_code in SUPPORTED_CURRENCIES)) return null;
  const parsed = parseDecimalAmount(m.value, m.currency_code as SupportedCurrency);
  return parsed.ok ? { minor: parsed.minor, currency: m.currency_code } : null;
}

const DAY_MS = 24 * 60 * 60 * 1000;
export const HONOR_PERIOD_MS = 3 * DAY_MS;

/**
 * How long after a capture or void request was sent a read that shows NO effect is still not proof that it will have
 * none (the state machine's in-flight timeout, section 6). Until then an unknown outcome stays unknown, so a slow
 * request cannot be followed by a second one while the first is still being processed.
 */
export const RECONCILE_QUIET_MS = 60_000;

/**
 * When the hold began, as far as we can tell: the earlier of PayPal's `create_time` and our own observation time.
 * PayPal's value can only make us MORE conservative (earlier), never later; an unparseable or future value is ignored.
 */
export function authorizedAtOf(
  createTime: string | null,
  observedAt: Date,
): { authorizedAt: string; honorExpiresAt: string } {
  const ours = observedAt.getTime();
  const theirs = createTime === null ? Number.NaN : Date.parse(createTime);
  const at = Number.isFinite(theirs) && theirs < ours ? theirs : ours;
  return {
    authorizedAt: new Date(at).toISOString(),
    honorExpiresAt: new Date(at + HONOR_PERIOD_MS).toISOString(),
  };
}

/** States from which an observation of "approved" or later is a legal forward move. Used for display, not authority. */
export const PAYMENT_STATES_BEFORE_AUTHORIZATION: readonly TxState[] = [
  "AGREED",
  "CREATING_ORDER",
  "ORDER_CREATED",
  "ORDER_APPROVED",
];
