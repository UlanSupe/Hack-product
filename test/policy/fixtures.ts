import { mandateContentHash } from "@/domain/mandate-hash";
import { termsHashOf } from "@/domain/offer";
import type { PolicyInput, PolicySubject } from "@/domain/policy";

/**
 * A small synthetic world. Every `valid(subject)` input is an ALLOW; tests break exactly one thing.
 *
 *   mandate M1 v2 (USD): budget 150.00, cap 100.00, approval above 50.00, review not forced,
 *   categories COMPUTE + STORAGE, sellers seller_a + seller_b.
 *   offer: 1 x GPU-PACK @ 40.00 + 5.00 shipping = 45.00 (below the approval threshold).
 */

export const NOW = "2026-10-12T12:00:00.000Z";
export const NOW_MS = Date.parse(NOW);
export const iso = (ms: number) => new Date(ms).toISOString();

const SELLER = "seller_a";
const PAYEE = "payee_seller_a";
const LINES = [
  {
    sku: "GPU-PACK",
    qty: 1,
    unitPriceMinor: 4000,
    catalogUnitPriceMinor: 4000,
    category: "COMPUTE",
  },
];
const SHIPPING = 500;
export const TOTAL = 4500;
const TERMS_HASH = termsHashOf({
  sellerId: SELLER,
  currency: "USD",
  shippingMinor: SHIPPING,
  feesMinor: 0,
  lines: LINES,
});

export const STATE_FOR: Record<PolicySubject, PolicyInput["transaction"]["state"]> = {
  ACCEPT_OFFER: "NEGOTIATING",
  CREATE_ORDER: "AGREED",
  AUTHORIZE: "ORDER_APPROVED",
  CAPTURE: "AUTHORIZED",
  VOID: "AUTHORIZED",
};

function build(subject: PolicySubject): PolicyInput {
  const accepting = subject === "ACCEPT_OFFER";
  const post = !accepting;
  return {
    subject,
    now: NOW,
    actor: subject === "CAPTURE" ? "OPERATOR" : subject === "ACCEPT_OFFER" ? "AGENT" : "SYSTEM",
    transaction: {
      id: "tx_1",
      state: STATE_FOR[subject],
      mandateId: "M1",
      mandateVersion: 2,
      agreementId: post ? "agr_1" : null,
      honorExpiresAt: subject === "CAPTURE" ? iso(NOW_MS + 3 * 86_400_000) : null,
    },
    mandate: {
      id: "M1",
      version: 2,
      ownerId: "demo_operator",
      status: "ACTIVE",
      contentHash: "0".repeat(64), // sealed below
      expiresAt: "2026-11-11T00:00:00.000Z",
      terms: {
        currency: "USD",
        totalBudgetMinor: 15000,
        maxTransactionMinor: 10000,
        approvalThresholdMinor: 5000,
        allowedCategories: ["COMPUTE", "STORAGE"],
        allowedSellerIds: ["seller_a", "seller_b"],
        requireReviewBeforeExecution: false,
        validDays: 30,
      },
    },
    latestMandate: { id: "M1", version: 2, status: "ACTIVE" },
    offer: {
      id: "off_1",
      transactionId: "tx_1",
      sellerId: SELLER,
      catalogPayeeRef: PAYEE,
      currency: "USD",
      status: accepting ? "OPEN" : "ACCEPTED",
      validUntil: iso(NOW_MS + 3_600_000),
      shippingMinor: SHIPPING,
      feesMinor: 0,
      claimedTotalMinor: TOTAL,
      storedServerTotalMinor: TOTAL,
      storedTermsHash: TERMS_HASH,
      lines: structuredClone(LINES),
    },
    agreement: post
      ? {
          id: "agr_1",
          offerId: "off_1",
          termsHash: TERMS_HASH,
          mandateId: "M1",
          mandateVersion: 2,
          payeeRef: PAYEE,
          currency: "USD",
          totalMinor: TOTAL,
        }
      : null,
    others: [],
    approval: null,
    attempts: { liveForSubject: false, captureSucceeded: false },
    observed:
      subject === "AUTHORIZE" || subject === "CAPTURE"
        ? { amountMinor: TOTAL, currency: "USD", payeeRef: PAYEE }
        : null,
    claims: {},
  };
}

/** A valid ALLOW input for `subject`, with the mandate hash sealed to its terms. */
export function valid(subject: PolicySubject): PolicyInput {
  const input = build(subject);
  reseal(input);
  return input;
}

/** Recompute the mandate content hash from the terms, as the approved row would carry it. */
export function reseal(i: PolicyInput): void {
  const m = i.mandate;
  m.contentHash = mandateContentHash({
    id: m.id,
    version: m.version,
    ownerId: m.ownerId,
    perTxCapMinor: m.terms.maxTransactionMinor,
    totalBudgetMinor: m.terms.totalBudgetMinor,
    approvalThresholdMinor: m.terms.approvalThresholdMinor,
    requireReview: m.terms.requireReviewBeforeExecution,
    currency: m.terms.currency,
    allowedCategories: m.terms.allowedCategories,
    allowedSellerIds: m.terms.allowedSellerIds,
    expiresAt: m.expiresAt,
    status: m.status,
  });
}

export const MONEY_SUBJECTS: PolicySubject[] = [
  "ACCEPT_OFFER",
  "CREATE_ORDER",
  "AUTHORIZE",
  "CAPTURE",
];
export const ALL_SUBJECTS: PolicySubject[] = [...MONEY_SUBJECTS, "VOID"];
export const APPROVAL_SUBJECTS: PolicySubject[] = ["CREATE_ORDER", "AUTHORIZE", "CAPTURE"];

/**
 * Apply a change to a deep copy; the base is never touched. By default the mandate hash is re-sealed
 * afterwards (an honest change to the approved terms). Pass `reseal: false` to model a FORGED row: terms
 * or fields changed while the old hash stays.
 */
export function mutate(
  base: PolicyInput,
  change: (draft: PolicyInput) => void,
  options: { reseal?: boolean } = {},
): PolicyInput {
  const draft = structuredClone(base);
  change(draft);
  if (options.reseal ?? true) reseal(draft);
  return draft;
}

export function must<T>(v: T | null | undefined): T {
  if (v === null || v === undefined) throw new Error("fixture field unexpectedly empty");
  return v;
}

/** Recompute the offer/agreement hash after a deliberate, CONSISTENT change to the offer (so only the intended rule trips). */
export function rehash(i: PolicyInput): void {
  const o = must(i.offer);
  const h = termsHashOf({
    sellerId: o.sellerId,
    currency: o.currency,
    shippingMinor: o.shippingMinor,
    feesMinor: o.feesMinor,
    lines: o.lines,
  });
  o.storedTermsHash = h;
  if (i.agreement) i.agreement.termsHash = h;
}

/** Set a consistent total everywhere: one line at `unit`, no shipping, claimed = stored = agreement. */
export function withTotal(i: PolicyInput, total: number): void {
  const o = must(i.offer);
  o.shippingMinor = 0;
  const line = must(o.lines[0]);
  line.unitPriceMinor = total;
  line.catalogUnitPriceMinor = total;
  o.claimedTotalMinor = total;
  o.storedServerTotalMinor = total;
  rehash(i);
  if (i.agreement) i.agreement.totalMinor = total;
  if (i.observed) i.observed.amountMinor = total;
}

export const approvedBy = (agreementId = "agr_1", decidedBy = "OPERATOR") => ({
  agreementId,
  decision: "APPROVED" as const,
  decidedBy,
});
