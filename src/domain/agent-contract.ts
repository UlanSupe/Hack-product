import { z } from "zod";

import {
  CATEGORY_CODES,
  CURRENCY_CODES,
  type ServiceCategory,
  type SupportedCurrency,
} from "./mandate.ts";
import { MAX_MINOR } from "./money.ts";
import { INJECTION_SIGNALS, sanitizeUntrusted } from "./untrusted-text.ts";

/**
 * The typed contract between the application and the buyer / seller agents (docs/AGENTS.md).
 *
 * Every agent OUTPUT is parsed with a strict schema before anything looks at it: unknown keys are an
 * error, oversize text is an error, numbers must be safe integers in minor units. Outputs can only
 * PROPOSE: there is no kind that approves a mandate, authorizes, captures, releases or pays, and
 * offers are referenced by id, so a recommendation has nowhere to carry an amount of authority.
 *
 * Every INPUT is built from two clearly separate parts: `trusted` (facts the server computed) and
 * `untrusted` (anything a seller or a model wrote).
 */

export const AGENT_RUNTIME_LIMITS = {
  timeoutMs: { min: 100, max: 120_000, default: 15_000 },
  maxAttempts: { min: 1, max: 5, default: 3 },
  totalDeadlineMs: { min: 100, max: 600_000, default: 45_000 },
  backoffBaseMs: { min: 0, max: 10_000, default: 250 },
  backoffMaxMs: { min: 0, max: 60_000, default: 2_000 },
  maxRounds: { min: 1, max: 6, default: 4 },
  /** Per-attempt timeout when a real model provider is configured and AGENT_TIMEOUT_MS is not set (thinking models can be slow). */
  llmDefaultTimeoutMs: 60_000,
  /** The provider's output budget (thinking tokens count toward it on current models). */
  maxOutputTokens: { min: 1024, max: 32_000, default: 8192 },
  /** A model reply longer than this is rejected unread. */
  maxOutputChars: 8_000,
} as const;

/* ------------------------------------------------------------------ primitives */

const Minor = z.number().int().min(0).max(MAX_MINOR);
const Id = z
  .string()
  .regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,63}$/, { error: "must be a short identifier" });
const Sku = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/, { error: "must be a SKU" });
const Currency = z.string().regex(/^[A-Z]{3}$/, { error: "must be a 3-letter uppercase code" });
const Category = z.enum(CATEGORY_CODES as [ServiceCategory, ...ServiceCategory[]]);
const Round = z.number().int().min(1).max(AGENT_RUNTIME_LIMITS.maxRounds.max);

/** Oversize text is rejected (not silently truncated); invisible and control characters are stripped. */
export const CleanText = (max: number, min = 0) =>
  z
    .string()
    .max(max, { error: `must be at most ${max} characters` })
    .transform((s) => sanitizeUntrusted(s, max))
    .refine((s) => s.length >= min, {
      error: min === 1 ? "must not be empty" : `must have at least ${min} characters`,
    });

/* ------------------------------------------------------------------ shared records */

/** What the buyer wants, as interpreted from the user's words. All of it is a negotiating position. */
export const ServiceRequestSchema = z.strictObject({
  category: Category,
  quantity: z.number().int().min(1).max(1000),
  summary: CleanText(300, 1),
  /** The buyer's own target. Advisory: the mandate, not this number, bounds spending. */
  maxTotalMinor: Minor.nullable(),
  neededWithinDays: z.number().int().min(0).max(365).nullable(),
  requiredDeliverables: z.array(CleanText(200, 1)).max(10),
});
export type ServiceRequest = z.infer<typeof ServiceRequestSchema>;

/** The non-secret part of the mandate an agent may see. Read-only by construction: it is a copy. */
export const MandateViewSchema = z.strictObject({
  currency: z.enum(CURRENCY_CODES as [SupportedCurrency, ...SupportedCurrency[]]),
  maxTransactionMinor: Minor,
  remainingBudgetMinor: Minor,
  approvalThresholdMinor: Minor,
  requireReviewBeforeExecution: z.boolean(),
  allowedCategories: z.array(Category).max(16),
});
export type MandateView = z.infer<typeof MandateViewSchema>;

export const OfferLineSchema = z.strictObject({
  sku: Sku,
  qty: z.number().int().min(1).max(1000),
  unitPriceMinor: Minor,
});

/** Terms proposed by a seller. Every field is a CLAIM; none is authority. */
export const OfferTermsSchema = z.strictObject({
  currency: Currency,
  lines: z.array(OfferLineSchema).min(1).max(20),
  shippingMinor: Minor,
  feesMinor: Minor,
  claimedTotalMinor: Minor,
  category: Category,
  deliveryDays: z.number().int().min(0).max(365),
  deliverables: z.array(CleanText(200, 1)).min(1).max(10),
  termsText: CleanText(1000),
  validForMinutes: z.number().int().min(1).max(10_080),
});
export type OfferTerms = z.infer<typeof OfferTermsSchema>;

export const APPROVAL_REQUIREMENTS = [
  "NOT_REQUIRED",
  "ABOVE_THRESHOLD",
  "REVIEW_REQUIRED",
] as const;

/** One offer as the buyer sees it: server-computed facts apart from seller-written claims. */
export const OfferViewSchema = z.strictObject({
  offerId: Id,
  sellerId: Id,
  trusted: z.strictObject({
    /** Server arithmetic over the structured lines; null if it would overflow. */
    computedTotalMinor: Minor.nullable(),
    totalMatchesClaim: z.boolean(),
    currencyMatchesMandate: z.boolean(),
    categoryAllowed: z.boolean(),
    sellerAllowed: z.boolean(),
    /** Skus, prices and category checked against the server's seller catalog, when it was available. */
    catalog: z.enum(["VERIFIED", "MISMATCH", "UNKNOWN"]),
    withinPerTransactionCap: z.boolean(),
    withinRemainingBudget: z.boolean(),
    approval: z.enum(APPROVAL_REQUIREMENTS),
    /** Advisory scan of the seller's free text. */
    riskSignals: z.array(z.enum(INJECTION_SIGNALS)).max(INJECTION_SIGNALS.length),
  }),
  untrusted: OfferTermsSchema,
});
export type OfferView = z.infer<typeof OfferViewSchema>;

const AnsweredQuestion = z.strictObject({
  offerId: Id,
  question: CleanText(300, 1),
  /** Written by the seller. */
  answer: CleanText(1000),
});

/* ------------------------------------------------------------------ buyer */

export const BuyerInterpretInputSchema = z.strictObject({
  task: z.literal("INTERPRET"),
  userRequest: CleanText(2000, 1),
  mandate: MandateViewSchema,
});
export type BuyerInterpretInput = z.infer<typeof BuyerInterpretInputSchema>;

export const BuyerCompareInputSchema = z.strictObject({
  task: z.literal("COMPARE"),
  request: ServiceRequestSchema,
  offers: z.array(OfferViewSchema).max(10),
  mandate: MandateViewSchema,
  round: Round,
  maxRounds: Round,
  answers: z.array(AnsweredQuestion).max(10),
});
export type BuyerCompareInput = z.infer<typeof BuyerCompareInputSchema>;

export const APPROVAL_REASONS = [
  "ABOVE_THRESHOLD",
  "REVIEW_REQUIRED",
  "RISK_SIGNALS",
  "NEAR_LIMIT",
  "OTHER",
] as const;

const None = z.strictObject({ kind: z.literal("NONE"), reason: CleanText(200) });
const AskUser = z.strictObject({ kind: z.literal("ASK_USER"), question: CleanText(300, 1) });

export const InterpretOutputSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("INTERPRETED"), request: ServiceRequestSchema }),
  AskUser,
  None,
]);
export type InterpretOutput = z.infer<typeof InterpretOutputSchema>;

export const CompareOutputSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("RECOMMEND"),
    offerId: Id,
    /** Best first. May be empty; if present its first entry must be `offerId`. */
    ranking: z.array(Id).max(10),
    rationale: CleanText(600, 1),
  }),
  z.strictObject({
    kind: z.literal("COUNTER"),
    offerId: Id,
    /** A negotiating proposal to the seller, never a payment amount. */
    targetTotalMinor: Minor,
    note: CleanText(300),
  }),
  z.strictObject({ kind: z.literal("ASK_SELLER"), offerId: Id, question: CleanText(300, 1) }),
  AskUser,
  z.strictObject({
    kind: z.literal("REQUEST_HUMAN_APPROVAL"),
    offerId: Id,
    reasons: z.array(z.enum(APPROVAL_REASONS)).min(1).max(APPROVAL_REASONS.length),
    note: CleanText(300),
  }),
  z.strictObject({ kind: z.literal("REJECT_ALL"), reason: CleanText(300, 1) }),
  None,
]);
export type CompareOutput = z.infer<typeof CompareOutputSchema>;

/* ------------------------------------------------------------------ seller */

export const SellerOpenInputSchema = z.strictObject({
  task: z.literal("OPEN"),
  request: ServiceRequestSchema,
});
export const SellerCounterInputSchema = z.strictObject({
  task: z.literal("COUNTER"),
  request: ServiceRequestSchema,
  currentOffer: OfferTermsSchema,
  targetTotalMinor: Minor,
  note: CleanText(300),
  round: Round,
  maxRounds: Round,
});
export const SellerAnswerInputSchema = z.strictObject({
  task: z.literal("ANSWER"),
  request: ServiceRequestSchema,
  currentOffer: OfferTermsSchema.nullable(),
  question: CleanText(300, 1),
});
export type SellerOpenInput = z.infer<typeof SellerOpenInputSchema>;
export type SellerCounterInput = z.infer<typeof SellerCounterInputSchema>;
export type SellerAnswerInput = z.infer<typeof SellerAnswerInputSchema>;

const SellerOffer = z.strictObject({
  kind: z.literal("OFFER"),
  offer: OfferTermsSchema,
  /** A courtesy note. Models often leave it out; a missing note is an empty one, never a reason to drop a valid offer. */
  message: CleanText(500).default(""),
});
const SellerDecline = z.strictObject({ kind: z.literal("DECLINE"), reason: CleanText(300, 1) });

/** For OPEN and COUNTER. */
export const SellerOfferOutputSchema = z.discriminatedUnion("kind", [
  SellerOffer,
  SellerDecline,
  None,
]);
export type SellerOfferOutput = z.infer<typeof SellerOfferOutputSchema>;
/** For ANSWER. */
export const SellerAnswerOutputSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("ANSWER"), text: CleanText(1000, 1) }),
  None,
]);
export type SellerAnswerOutput = z.infer<typeof SellerAnswerOutputSchema>;

/** A seller's own business rules: what it is willing to offer. Trusted configuration, never model output. */
export const SellerConfigSchema = z.strictObject({
  sellerId: Id,
  currency: Currency,
  shippingMinor: Minor,
  feesMinor: Minor,
  minLeadTimeDays: z.number().int().min(0).max(365),
  maxValidForMinutes: z.number().int().min(1).max(10_080),
  maxRounds: z.number().int().min(1).max(AGENT_RUNTIME_LIMITS.maxRounds.max),
  catalog: z
    .array(
      z
        .strictObject({
          sku: Sku,
          name: CleanText(80, 1),
          category: Category,
          listPriceMinor: Minor,
          floorPriceMinor: Minor,
          deliverables: z.array(CleanText(200, 1)).min(1).max(10),
        })
        .refine((i) => i.floorPriceMinor <= i.listPriceMinor, {
          error: "floor price must not exceed list price",
        }),
    )
    .min(1)
    .max(20),
});
export type SellerConfig = z.infer<typeof SellerConfigSchema>;
