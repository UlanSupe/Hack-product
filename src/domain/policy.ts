import { z } from "zod";

import { canonicalJson, sha256Hex } from "./canonical.ts";
import {
  approvalRequirement,
  CATEGORY_CODES,
  CURRENCY_CODES,
  formatMinor,
  type ApprovalRequirement,
  type ServiceCategory,
  type SupportedCurrency,
} from "./mandate.ts";
import { mandateContentHash } from "./mandate-hash.ts";
import { MAX_MINOR } from "./money.ts";
import { sumOfferMinor, termsHashOf } from "./offer.ts";
import { canTransition, TX_STATES, type TxState } from "./transaction-states.ts";

/**
 * The deterministic Policy Engine (docs/POLICY_ENGINE.md).
 *
 * `evaluatePolicy(input)` is a pure, total function: no I/O, no clock, no randomness, no network,
 * no payment call. It never throws and it never mutates its input. Anything that is not a fully
 * valid, strictly shaped input is DENIED.
 *
 * Authority model. The input separates two kinds of data:
 *   - FACTS: rows the server loaded itself (transaction, mandate versions, offer, agreement,
 *     approval, other transactions' exposure, attempts, observed PayPal values).
 *   - CLAIMS: values a client or an agent asserted. They are never used to compute anything; they
 *     are only compared with the facts, and any difference is a DENY.
 * The schema is strict, so there is no field in which a model recommendation, an "override" or a
 * "force" flag could travel: such an input is rejected as INPUT_INVALID.
 */

export const POLICY_VERSION = "pactpay-policy/1.1.0";

/** Capture is refused this long before the authorization honor period ends (state machine section 6). */
export const HONOR_MARGIN_MS = 60 * 60 * 1000;

/* ------------------------------------------------------------------ vocabulary */

export const POLICY_SUBJECTS = [
  "ACCEPT_OFFER",
  "CREATE_ORDER",
  "AUTHORIZE",
  "CAPTURE",
  "VOID",
] as const;
export type PolicySubject = (typeof POLICY_SUBJECTS)[number];

export const ACTORS = ["OPERATOR", "SYSTEM", "AGENT"] as const;
export type Actor = (typeof ACTORS)[number];

/** Stable reason codes. Adding one is fine; renaming or removing one breaks stored decisions. */
export const REASON_CODES = {
  INPUT_INVALID: "The policy input is malformed, has unknown fields, or has out-of-range values.",
  POLICY_ERROR: "The engine hit an unexpected internal error and failed closed.",
  ACTOR_NOT_PERMITTED: "This kind of requester may not perform this action.",
  STATE_NOT_PERMITTED: "The transaction is not in a state from which this action is legal.",
  TRANSACTION_MISMATCH: "A transaction id does not match the transaction being acted on.",
  MANDATE_MISMATCH: "The mandate presented is not the mandate this transaction is pinned to.",
  MANDATE_VERSION_MISMATCH: "The mandate version presented is not the pinned version.",
  MANDATE_STALE:
    "A newer version of the mandate exists; the pinned version no longer authorizes new spend.",
  MANDATE_REVOKED: "The mandate has been revoked.",
  MANDATE_EXPIRED: "The mandate has expired.",
  MANDATE_INTEGRITY:
    "The mandate terms are not exactly the approved version (their content hash does not match).",
  OFFER_REQUIRED: "No offer was supplied.",
  OFFER_NOT_OPEN: "The offer is not open (superseded, expired, rejected or already accepted).",
  OFFER_NOT_ACCEPTED: "The offer behind this agreement is not in the accepted state.",
  OFFER_EXPIRED: "The offer's validity time has passed.",
  OFFER_EMPTY: "The offer has no line items.",
  AGREEMENT_REQUIRED: "No agreement exists for this transaction.",
  AGREEMENT_EXISTS: "An agreement already exists; an offer cannot be accepted twice.",
  AGREEMENT_MISMATCH: "The agreement does not belong to this transaction or offer.",
  TERMS_HASH_MISMATCH: "The offer's terms no longer match the hash that was agreed.",
  PRICE_NOT_IN_CATALOG:
    "A line is priced above the seller's catalog price, or the item is not in the catalog.",
  TOTAL_MISMATCH: "The seller's stated total differs from the server-computed total.",
  AMOUNT_NOT_POSITIVE: "The amount must be greater than zero.",
  AMOUNT_OVERFLOW: "The amount is outside the representable money range.",
  AMOUNT_MISMATCH: "An amount differs from the server-held amount.",
  CURRENCY_MISMATCH: "A currency differs from the mandate or agreement currency.",
  PAYEE_NOT_ALLOWED: "The seller is not on the mandate's allow-list.",
  PAYEE_MISMATCH: "A payee reference differs from the one in the seller catalog or agreement.",
  CATEGORY_NOT_ALLOWED: "A line is outside the mandate's allowed service categories.",
  CATEGORY_UNKNOWN: "A line has no known service category, so it cannot be allowed.",
  OVER_PER_TX_CAP: "The amount exceeds the mandate's maximum transaction amount.",
  OVER_TOTAL_BUDGET: "Reserved and spent amounts plus this one would exceed the total budget.",
  EXPOSURE_INVALID: "The data used to compute cumulative spending is inconsistent.",
  APPROVAL_REQUIRED: "Human approval is required by the mandate and has not been given.",
  APPROVAL_REJECTED: "A human rejected this transaction.",
  APPROVAL_NOT_HUMAN: "The approval was not recorded by the human operator.",
  APPROVAL_MISMATCH: "The approval does not belong to this agreement.",
  DUPLICATE_ATTEMPT: "A live attempt for this action already exists.",
  DUPLICATE_CAPTURE: "A capture has already succeeded for this transaction.",
  VOID_AFTER_CAPTURE: "A captured authorization cannot be voided.",
  OBSERVATION_REQUIRED: "A fresh server-side observation of the PayPal object is required.",
  HONOR_WINDOW_UNKNOWN: "The authorization honor period is unknown.",
  HONOR_PERIOD_ENDED: "The authorization honor period has ended or is about to.",
} as const;
export type ReasonCode = keyof typeof REASON_CODES;

export type Finding = { readonly code: ReasonCode; readonly message: string };

export type PolicyDecision = Readonly<{
  verdict: "ALLOW" | "DENY";
  /** null only when the input was too malformed to know. */
  subject: PolicySubject | null;
  /** Sorted, unique. Empty exactly when the verdict is ALLOW. */
  reasonCodes: readonly ReasonCode[];
  /** One entry per violated rule, in the fixed order the engine checks them. */
  findings: readonly Finding[];
  explanation: string;
  policyVersion: string;
  /** The mandate version that was evaluated; null when the input was unusable. */
  mandateRef: Readonly<{ id: string; version: number }> | null;
  /** Whether the mandate demands human approval for this amount (null for VOID or unusable input). */
  approvalRequirement: ApprovalRequirement | null;
  /** SHA-256 over the canonical evaluated input: lets a stored decision be matched to its inputs. */
  inputsHash: string;
}>;

/* ------------------------------------------------------------------ exposure (cumulative spending) */

/**
 * Does a transaction in this state count against the cumulative budget? Mirrors the table in
 * TRANSACTION_STATE_MACHINE.md section 1. Anything unresolved counts (NEEDS_RECONCILIATION), and so
 * does REVERSED ("recorded, not re-spendable in the MVP"). `satisfies` makes a new state a compile error.
 */
const COUNTS_AGAINST_BUDGET = {
  NEGOTIATING: false,
  AGREED: true,
  CREATING_ORDER: true,
  ORDER_CREATED: true,
  ORDER_APPROVED: true,
  AUTHORIZING: true,
  AUTHORIZATION_PENDING: true,
  AUTHORIZED: true,
  CAPTURING: true,
  CAPTURE_PENDING: true,
  CAPTURED: true,
  VOIDING: true,
  VOIDED: false,
  REJECTED: false,
  CANCELLED: false,
  FAILED: false,
  NEEDS_RECONCILIATION: true,
  REVERSED: true,
} as const satisfies Record<TxState, boolean>;

export function exposureCounts(state: TxState): boolean {
  return COUNTS_AGAINST_BUDGET[state];
}

/* ------------------------------------------------------------------ per-subject rules */

const TARGET_STATE = {
  ACCEPT_OFFER: "AGREED",
  CREATE_ORDER: "CREATING_ORDER",
  AUTHORIZE: "AUTHORIZING",
  CAPTURE: "CAPTURING",
  VOID: "VOIDING",
} as const satisfies Record<PolicySubject, TxState>;

type Rules = {
  readonly actors: readonly Actor[];
  /** Evaluate mandate, offer, agreement, money, category and payee rules. False only for VOID. */
  readonly spend: boolean;
  /** Deny when a newer mandate version exists or the mandate expired. */
  readonly freshMandate: boolean;
  readonly needsAgreement: boolean;
  readonly approval: boolean;
  readonly observed: boolean;
  readonly honor: boolean;
};

const RULES: Record<PolicySubject, Rules> = {
  // An agent may recommend acceptance; the acceptance is still decided here, never by the agent.
  ACCEPT_OFFER: {
    actors: ["OPERATOR", "SYSTEM", "AGENT"],
    spend: true,
    freshMandate: true,
    needsAgreement: false,
    approval: false,
    observed: false,
    honor: false,
  },
  CREATE_ORDER: {
    actors: ["OPERATOR", "SYSTEM"],
    spend: true,
    freshMandate: true,
    needsAgreement: true,
    approval: true,
    observed: false,
    honor: false,
  },
  AUTHORIZE: {
    actors: ["OPERATOR", "SYSTEM"],
    spend: true,
    freshMandate: true,
    needsAgreement: true,
    approval: true,
    observed: true,
    honor: false,
  },
  // Money-out is a human action. A newer (non-revoked) mandate version or an expired one does not block
  // capturing an already-authorized hold, because the human decides now and the amount is frozen in
  // the agreement; revocation does block it (G2). See POLICY_ENGINE.md "Decisions you may want to flip".
  CAPTURE: {
    actors: ["OPERATOR"],
    spend: true,
    freshMandate: false,
    needsAgreement: true,
    approval: true,
    observed: true,
    honor: true,
  },
  // Void only ever reduces exposure and has no amount, so only authority, state and duplicates apply.
  VOID: {
    actors: ["OPERATOR", "SYSTEM", "AGENT"],
    spend: false,
    freshMandate: false,
    needsAgreement: false,
    approval: false,
    observed: false,
    honor: false,
  },
};

/* ------------------------------------------------------------------ input schema (strict) */

const Id = z.string().min(1).max(64);
const Minor = z.number().int().min(0).max(MAX_MINOR); // safe, non-negative, integer: never a float
const Currency = z.string().regex(/^[A-Z]{3}$/);
const Sha256 = z.string().regex(/^[0-9a-f]{64}$/);
const MandateVersionNo = z.number().int().min(1).max(1_000_000);

/** UTC timestamp with a real calendar date (Date.parse alone would roll 30 Feb over to 2 Mar). */
const IsoUtc = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/)
  .refine((s) => {
    const ms = Date.parse(s);
    return !Number.isNaN(ms) && new Date(ms).toISOString().slice(0, 19) === s.slice(0, 19);
  });

const Terms = z.strictObject({
  currency: z.enum(CURRENCY_CODES as [SupportedCurrency, ...SupportedCurrency[]]),
  totalBudgetMinor: Minor,
  maxTransactionMinor: Minor,
  approvalThresholdMinor: Minor,
  allowedCategories: z
    .array(z.enum(CATEGORY_CODES as [ServiceCategory, ...ServiceCategory[]]))
    .max(16),
  allowedSellerIds: z.array(Id).max(20),
  requireReviewBeforeExecution: z.boolean(),
  validDays: z.number().int().min(1).max(365),
});

const InputSchema = z.strictObject({
  subject: z.enum(POLICY_SUBJECTS),
  /** Injected clock (ISO UTC). The engine never reads the real time. */
  now: IsoUtc,
  /** Who is asking. Set by the server from the authenticated route, never from a request body. */
  actor: z.enum(ACTORS),

  transaction: z.strictObject({
    id: Id,
    state: z.enum(TX_STATES),
    mandateId: Id,
    mandateVersion: MandateVersionNo,
    agreementId: Id.nullable(),
    honorExpiresAt: IsoUtc.nullable(),
  }),

  /** The mandate version the transaction is pinned to, loaded by (id, version). */
  mandate: z.strictObject({
    id: Id,
    version: MandateVersionNo,
    ownerId: Id,
    status: z.enum(["ACTIVE", "REVOKED"]),
    expiresAt: IsoUtc,
    /** The stored hash of the approved version. The engine recomputes it from the terms it is given. */
    contentHash: Sha256,
    terms: Terms,
  }),
  /** The newest version of the same mandate. */
  latestMandate: z.strictObject({
    id: Id,
    version: MandateVersionNo,
    status: z.enum(["ACTIVE", "REVOKED"]),
  }),

  offer: z
    .strictObject({
      id: Id,
      transactionId: Id,
      sellerId: Id,
      /** The payee reference from the SELLER CATALOG for sellerId. Never from a message. */
      catalogPayeeRef: Id,
      currency: Currency,
      status: z.enum(["OPEN", "SUPERSEDED", "EXPIRED", "ACCEPTED", "REJECTED"]),
      validUntil: IsoUtc,
      shippingMinor: Minor,
      feesMinor: Minor,
      /** The seller's own number. Untrusted; compared, never used. */
      claimedTotalMinor: Minor,
      storedServerTotalMinor: Minor,
      storedTermsHash: Sha256,
      lines: z
        .array(
          z.strictObject({
            sku: Id,
            qty: z.number().int().min(1).max(1_000_000),
            unitPriceMinor: Minor,
            /** The seller catalog's price for this sku: a CEILING for negotiation. Null if the sku is not in the catalog. */
            catalogUnitPriceMinor: Minor.nullable(),
            /** The catalog's category for this sku, or null if unknown. Never taken from the offer. */
            category: z.string().min(1).max(40).nullable(),
          }),
        )
        .max(100),
    })
    .nullable(),

  agreement: z
    .strictObject({
      id: Id,
      offerId: Id,
      termsHash: Sha256,
      mandateId: Id,
      mandateVersion: MandateVersionNo,
      payeeRef: Id,
      currency: Currency,
      totalMinor: Minor,
    })
    .nullable(),

  /** Every OTHER transaction under the same mandate id (any version). The engine sums their exposure. */
  others: z
    .array(
      z.strictObject({ id: Id, state: z.enum(TX_STATES), currency: Currency, totalMinor: Minor }),
    )
    .max(1000),

  /** The operator's recorded decision for this agreement, if any. */
  approval: z
    .strictObject({
      agreementId: Id,
      decision: z.enum(["APPROVED", "REJECTED"]),
      decidedBy: z.string().min(1).max(32),
    })
    .nullable(),

  attempts: z.strictObject({
    /** An attempt for THIS action exists that is in flight, succeeded or unknown. */
    liveForSubject: z.boolean(),
    /** A capture has already succeeded for this transaction. */
    captureSucceeded: z.boolean(),
  }),

  /** What a fresh server-side read of the PayPal object showed (AUTHORIZE, CAPTURE). The caller does the read. */
  observed: z.strictObject({ amountMinor: Minor, currency: Currency, payeeRef: Id }).nullable(),

  /** Values a client or agent asserted. Compared with the facts above; never used as facts. */
  claims: z.strictObject({
    transactionId: z.unknown().optional(),
    mandateId: z.unknown().optional(),
    mandateVersion: z.unknown().optional(),
    offerId: z.unknown().optional(),
    agreementId: z.unknown().optional(),
    sellerId: z.unknown().optional(),
    payeeRef: z.unknown().optional(),
    currency: z.unknown().optional(),
    amountMinor: z.unknown().optional(),
    termsHash: z.unknown().optional(),
  }),
});

export type PolicyInput = z.infer<typeof InputSchema>;

/* ------------------------------------------------------------------ helpers */

const clip = (v: unknown) => String(v).slice(0, 40);

/** Claims may hold anything, including values JSON cannot represent. Make them hashable without losing the fact. */
function jsonSafe(v: unknown): unknown {
  try {
    canonicalJson(v);
    return v;
  } catch {
    return { unrepresentable: typeof v === "number" ? String(v) : typeof v };
  }
}

function hashInput(value: unknown): string {
  try {
    return sha256Hex(canonicalJson(value));
  } catch {
    return sha256Hex("unhashable-input");
  }
}

function hashParsed(i: PolicyInput): string {
  const claims: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(i.claims)) claims[k] = jsonSafe(v);
  return hashInput({ ...i, claims });
}

const unique = <T>(xs: readonly T[]): T[] => [...new Set(xs)];

/* ------------------------------------------------------------------ the rules */

type Evaluation = { findings: Finding[]; requirement: ApprovalRequirement | null };

function evaluate(i: PolicyInput): Evaluation {
  const findings: Finding[] = [];
  const add = (code: ReasonCode, message: string) => {
    findings.push({ code, message });
  };
  const rules = RULES[i.subject];
  const t = i.transaction;
  const now = Date.parse(i.now);

  // 1. Authority, state, identity, duplicates (every subject).
  if (!rules.actors.includes(i.actor)) {
    add("ACTOR_NOT_PERMITTED", `A requester of kind ${i.actor} may not perform ${i.subject}.`);
  }
  const target = TARGET_STATE[i.subject];
  if (!canTransition(t.state, target)) {
    add("STATE_NOT_PERMITTED", `${i.subject} is not legal while the transaction is ${t.state}.`);
  }
  if (i.claims.transactionId !== undefined && i.claims.transactionId !== t.id) {
    add(
      "TRANSACTION_MISMATCH",
      "The request names a different transaction than the one being acted on.",
    );
  }
  if (i.subject !== "ACCEPT_OFFER" && i.attempts.liveForSubject) {
    add("DUPLICATE_ATTEMPT", `A ${i.subject} attempt already exists for this transaction.`);
  }
  if (i.attempts.captureSucceeded) {
    if (i.subject === "CAPTURE")
      add("DUPLICATE_CAPTURE", "A capture already succeeded for this transaction.");
    if (i.subject === "VOID")
      add("VOID_AFTER_CAPTURE", "The authorization was already captured; it cannot be voided.");
  }
  if (!rules.spend) return { findings, requirement: null };

  const m = i.mandate;
  const terms = m.terms;
  const lm = i.latestMandate;
  const money = (n: number) => `${formatMinor(n, terms.currency)} ${terms.currency}`;
  const accepting = i.subject === "ACCEPT_OFFER";
  const { offer, agreement } = i;

  // 2. Mandate identity, integrity, version, status, freshness.
  const sealed = mandateContentHash({
    id: m.id,
    version: m.version,
    ownerId: m.ownerId,
    perTxCapMinor: terms.maxTransactionMinor,
    totalBudgetMinor: terms.totalBudgetMinor,
    approvalThresholdMinor: terms.approvalThresholdMinor,
    requireReview: terms.requireReviewBeforeExecution,
    currency: terms.currency,
    allowedCategories: terms.allowedCategories,
    allowedSellerIds: terms.allowedSellerIds,
    expiresAt: m.expiresAt,
    status: m.status,
  });
  if (sealed !== m.contentHash) {
    add(
      "MANDATE_INTEGRITY",
      "The mandate terms differ from the approved version they claim to be (draft, stale or forged terms).",
    );
  }
  if (m.id !== lm.id || t.mandateId !== m.id) {
    add("MANDATE_MISMATCH", "The mandate loaded is not the mandate this transaction is pinned to.");
  }
  if (t.mandateVersion !== m.version || lm.version < m.version) {
    add(
      "MANDATE_VERSION_MISMATCH",
      `The transaction is pinned to version ${t.mandateVersion}, not version ${m.version}.`,
    );
  }
  if (agreement !== null) {
    if (agreement.mandateId !== m.id)
      add("MANDATE_MISMATCH", "The agreement was made under a different mandate.");
    if (agreement.mandateVersion !== m.version) {
      add(
        "MANDATE_VERSION_MISMATCH",
        `The agreement was made under version ${agreement.mandateVersion}, not version ${m.version}.`,
      );
    }
  }
  if (i.claims.mandateId !== undefined && i.claims.mandateId !== m.id) {
    add("MANDATE_MISMATCH", "The request names a different mandate than the pinned one.");
  }
  if (i.claims.mandateVersion !== undefined && i.claims.mandateVersion !== m.version) {
    add(
      "MANDATE_VERSION_MISMATCH",
      `The request presents a mandate version other than the pinned version ${m.version}.`,
    );
  }
  if (m.status === "REVOKED" || lm.status === "REVOKED") {
    add("MANDATE_REVOKED", "The mandate has been revoked.");
  }
  if (rules.freshMandate) {
    if (lm.version > m.version) {
      add(
        "MANDATE_STALE",
        `Version ${lm.version} of the mandate exists; version ${m.version} no longer authorizes new spend.`,
      );
    }
    if (now >= Date.parse(m.expiresAt)) add("MANDATE_EXPIRED", "The mandate has expired.");
  }

  // 3. Offer and agreement presence and integrity.
  if (accepting) {
    if (agreement !== null || t.agreementId !== null) {
      add("AGREEMENT_EXISTS", "This transaction already has an agreement.");
    }
  } else if (agreement === null) {
    add("AGREEMENT_REQUIRED", "There is no agreement for this transaction.");
  } else if (t.agreementId !== agreement.id) {
    add("AGREEMENT_MISMATCH", "The agreement is not the one attached to this transaction.");
  }
  if (i.claims.agreementId !== undefined && i.claims.agreementId !== (agreement?.id ?? null)) {
    add("AGREEMENT_MISMATCH", "The request names a different agreement.");
  }

  let recomputed: number | null = null;
  if (offer === null) {
    add("OFFER_REQUIRED", "No offer was supplied.");
  } else {
    if (offer.transactionId !== t.id)
      add("TRANSACTION_MISMATCH", "The offer belongs to a different transaction.");
    if (accepting) {
      if (offer.status !== "OPEN") add("OFFER_NOT_OPEN", `The offer is ${offer.status}, not OPEN.`);
      if (now >= Date.parse(offer.validUntil))
        add("OFFER_EXPIRED", "The offer is past its validity time.");
    } else if (offer.status !== "ACCEPTED") {
      add("OFFER_NOT_ACCEPTED", `The offer behind the agreement is ${offer.status}, not ACCEPTED.`);
    }
    if (offer.currency !== terms.currency) {
      add(
        "CURRENCY_MISMATCH",
        `The offer is priced in ${offer.currency}; the mandate is in ${terms.currency}.`,
      );
    }
    if (!terms.allowedSellerIds.includes(offer.sellerId)) {
      add("PAYEE_NOT_ALLOWED", "The seller is not on the mandate's allow-list.");
    }
    if (offer.lines.length === 0) add("OFFER_EMPTY", "The offer has no line items.");
    offer.lines.forEach((line, n) => {
      if (line.category === null) {
        add("CATEGORY_UNKNOWN", `Line ${n + 1} has no catalog category.`);
      } else if (!(terms.allowedCategories as readonly string[]).includes(line.category)) {
        add(
          "CATEGORY_NOT_ALLOWED",
          `Line ${n + 1} is in category ${clip(line.category)}, which the mandate does not allow.`,
        );
      }
      // v1.1.0: the catalog price is a ceiling, so a negotiated discount is allowed and a mark-up never is.
      if (line.catalogUnitPriceMinor === null || line.unitPriceMinor > line.catalogUnitPriceMinor) {
        add("PRICE_NOT_IN_CATALOG", `Line ${n + 1} is priced above the seller's catalog price.`);
      }
    });
    recomputed = sumOfferMinor(offer.shippingMinor, offer.feesMinor, offer.lines);
    if (recomputed === null) {
      add("AMOUNT_OVERFLOW", "The offer total is outside the representable money range.");
    } else {
      if (recomputed !== offer.storedServerTotalMinor) {
        add("TOTAL_MISMATCH", "The stored server total differs from the recomputed total.");
      }
      if (recomputed !== offer.claimedTotalMinor) {
        add(
          "TOTAL_MISMATCH",
          `The seller states ${money(offer.claimedTotalMinor)}; the server computes ${money(recomputed)}.`,
        );
      }
      if (recomputed === 0) add("AMOUNT_NOT_POSITIVE", "The offer total is zero.");
    }
    const hash = termsHashOf({
      sellerId: offer.sellerId,
      currency: offer.currency,
      shippingMinor: offer.shippingMinor,
      feesMinor: offer.feesMinor,
      lines: offer.lines,
    });
    if (hash !== offer.storedTermsHash) {
      add(
        "TERMS_HASH_MISMATCH",
        "The offer's terms do not match their stored hash; they were altered.",
      );
    }
    if (agreement !== null) {
      if (agreement.offerId !== offer.id)
        add("AGREEMENT_MISMATCH", "The agreement was made for a different offer.");
      if (agreement.termsHash !== offer.storedTermsHash || agreement.termsHash !== hash) {
        add("TERMS_HASH_MISMATCH", "The agreed terms hash differs from the offer's terms.");
      }
      if (recomputed !== null && agreement.totalMinor !== recomputed) {
        add("AMOUNT_MISMATCH", "The agreement total differs from the offer's recomputed total.");
      }
      if (agreement.currency !== offer.currency) {
        add("CURRENCY_MISMATCH", "The agreement currency differs from the offer currency.");
      }
      if (agreement.payeeRef !== offer.catalogPayeeRef) {
        add("PAYEE_MISMATCH", "The agreement payee differs from the seller catalog payee.");
      }
    }
  }
  if (agreement !== null && agreement.currency !== terms.currency) {
    add(
      "CURRENCY_MISMATCH",
      `The agreement is in ${agreement.currency}; the mandate is in ${terms.currency}.`,
    );
  }

  // 4. The amount and payee the action would use are ours, never the client's.
  const total = accepting ? recomputed : (agreement?.totalMinor ?? null);
  const payee = accepting ? (offer?.catalogPayeeRef ?? null) : (agreement?.payeeRef ?? null);
  const c = i.claims;
  if (c.amountMinor !== undefined && c.amountMinor !== total) {
    add("AMOUNT_MISMATCH", "The amount in the request differs from the server-held amount.");
  }
  if (c.currency !== undefined && c.currency !== terms.currency) {
    add("CURRENCY_MISMATCH", "The currency in the request differs from the mandate currency.");
  }
  if (c.payeeRef !== undefined && c.payeeRef !== payee) {
    add("PAYEE_MISMATCH", "The payee in the request differs from the server-held payee.");
  }
  if (c.sellerId !== undefined && c.sellerId !== (offer?.sellerId ?? null)) {
    add("PAYEE_MISMATCH", "The seller in the request differs from the offer's seller.");
  }
  if (c.offerId !== undefined && c.offerId !== (offer?.id ?? null)) {
    add("AGREEMENT_MISMATCH", "The offer in the request differs from the offer on record.");
  }
  if (
    c.termsHash !== undefined &&
    c.termsHash !== (agreement?.termsHash ?? offer?.storedTermsHash ?? null)
  ) {
    add("TERMS_HASH_MISMATCH", "The terms hash in the request differs from the one on record.");
  }

  // 5. Per-transaction cap and cumulative budget.
  let requirement: ApprovalRequirement | null = null;
  if (total !== null) {
    if (total <= 0) add("AMOUNT_NOT_POSITIVE", "The amount must be greater than zero.");
    if (total > terms.maxTransactionMinor) {
      add(
        "OVER_PER_TX_CAP",
        `${money(total)} exceeds the maximum transaction amount of ${money(terms.maxTransactionMinor)}.`,
      );
    }
    let others = 0n;
    let exposureOk = true;
    const seen = new Set<string>();
    for (const o of i.others) {
      if (seen.has(o.id)) exposureOk = false;
      seen.add(o.id);
      if (o.id === t.id || !exposureCounts(o.state)) continue; // this transaction is counted once, as `total`
      if (o.currency !== terms.currency) exposureOk = false;
      others += BigInt(o.totalMinor);
    }
    if (!exposureOk) {
      add(
        "EXPOSURE_INVALID",
        "Other transactions are duplicated or in a different currency; spending cannot be summed safely.",
      );
    }
    if (others + BigInt(total) > BigInt(terms.totalBudgetMinor)) {
      add(
        "OVER_TOTAL_BUDGET",
        `${money(total)} plus the amounts already reserved or spent would exceed the budget of ${money(terms.totalBudgetMinor)}.`,
      );
    }
    requirement = approvalRequirement(terms, total);
  }

  // 6. Human approval.
  const a = i.approval;
  if (accepting) {
    if (a !== null) add("APPROVAL_MISMATCH", "An approval cannot exist before an agreement does.");
  } else if (rules.approval) {
    if (a !== null) {
      if (a.decision === "REJECTED")
        add("APPROVAL_REJECTED", "The operator rejected this transaction.");
      if (a.decidedBy !== "OPERATOR")
        add("APPROVAL_NOT_HUMAN", "The approval was not recorded by the operator.");
      if (agreement !== null && a.agreementId !== agreement.id) {
        add("APPROVAL_MISMATCH", "The approval was recorded for a different agreement.");
      }
    } else if (requirement !== null && requirement !== "NOT_REQUIRED") {
      add(
        "APPROVAL_REQUIRED",
        requirement === "REVIEW_REQUIRED"
          ? "The mandate requires every transaction to be reviewed and approved."
          : "The amount is above the mandate's approval threshold.",
      );
    }
  }

  // 7. Fresh observation of the PayPal object must agree with the agreement.
  if (rules.observed) {
    const ob = i.observed;
    if (ob === null) {
      add(
        "OBSERVATION_REQUIRED",
        "No fresh server-side observation of the PayPal object was supplied.",
      );
    } else if (agreement !== null) {
      if (ob.amountMinor !== agreement.totalMinor)
        add("AMOUNT_MISMATCH", "The PayPal object's amount differs from the agreement.");
      if (ob.currency !== agreement.currency)
        add("CURRENCY_MISMATCH", "The PayPal object's currency differs from the agreement.");
      if (ob.payeeRef !== agreement.payeeRef)
        add("PAYEE_MISMATCH", "The PayPal object's payee differs from the agreement.");
    }
  }

  // 8. Honor period.
  if (rules.honor) {
    if (t.honorExpiresAt === null) {
      add("HONOR_WINDOW_UNKNOWN", "The authorization honor period is not recorded.");
    } else if (now >= Date.parse(t.honorExpiresAt) - HONOR_MARGIN_MS) {
      add(
        "HONOR_PERIOD_ENDED",
        "The authorization honor period has ended or ends within the safety margin.",
      );
    }
  }

  return { findings, requirement };
}

/* ------------------------------------------------------------------ public entry point */

function decide(
  subject: PolicySubject | null,
  findings: Finding[],
  mandateRef: { id: string; version: number } | null,
  requirement: ApprovalRequirement | null,
  inputsHash: string,
): PolicyDecision {
  const reasonCodes = unique(findings.map((f) => f.code)).sort();
  const verdict = reasonCodes.length === 0 ? "ALLOW" : "DENY";
  const what = subject ?? "request";
  const explanation =
    verdict === "ALLOW"
      ? `ALLOW ${what}: every policy check passed${mandateRef ? ` under mandate ${mandateRef.id} version ${mandateRef.version}` : ""} (${POLICY_VERSION}).`
      : `DENY ${what}: ${findings.map((f) => f.message).join(" ")}`.slice(0, 1200);
  return Object.freeze({
    verdict,
    subject,
    reasonCodes: Object.freeze(reasonCodes),
    findings: Object.freeze(findings.map((f) => Object.freeze({ ...f }))),
    explanation,
    policyVersion: POLICY_VERSION,
    mandateRef: mandateRef ? Object.freeze({ ...mandateRef }) : null,
    approvalRequirement: requirement,
    inputsHash,
  });
}

function subjectOf(raw: unknown): PolicySubject | null {
  try {
    if (raw === null || typeof raw !== "object") return null;
    const s = (raw as { subject?: unknown }).subject;
    return (POLICY_SUBJECTS as readonly unknown[]).includes(s) ? (s as PolicySubject) : null;
  } catch {
    return null; // a hostile getter must not make the engine throw
  }
}

/**
 * Evaluate a proposed action. Total and fail-closed: malformed or hostile input, or an internal error,
 * yields a DENY decision, never an exception and never an ALLOW.
 */
export function evaluatePolicy(raw: unknown): PolicyDecision {
  try {
    const parsed = InputSchema.safeParse(raw);
    if (!parsed.success) {
      const where = unique(
        parsed.error.issues.flatMap((issue) =>
          issue.code === "unrecognized_keys"
            ? issue.keys.map((k) => `${[...issue.path, clip(k)].join(".")} (unknown field)`)
            : [issue.path.join(".") || "(root)"],
        ),
      ).slice(0, 8);
      return decide(
        subjectOf(raw),
        [
          {
            code: "INPUT_INVALID",
            message: `The policy input is invalid at: ${where.join(", ")}.`,
          },
        ],
        null,
        null,
        hashInput(raw),
      );
    }
    const input = parsed.data;
    const { findings, requirement } = evaluate(input);
    return decide(
      input.subject,
      findings,
      { id: input.mandate.id, version: input.mandate.version },
      requirement,
      hashParsed(input),
    );
  } catch {
    return decide(
      subjectOf(raw),
      [
        {
          code: "POLICY_ERROR",
          message: "The policy engine failed closed after an internal error.",
        },
      ],
      null,
      null,
      sha256Hex("policy-error"),
    );
  }
}
