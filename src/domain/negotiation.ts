import { z } from "zod";

import { canonicalJson, sha256Hex } from "./canonical.ts";
import { CleanText, OfferTermsSchema } from "./agent-contract.ts";
import {
  CATEGORY_CODES,
  SUPPORTED_CURRENCIES,
  formatMinor,
  type FieldError,
  type ServiceCategory,
  type SupportedCurrency,
} from "./mandate.ts";
import { MAX_MINOR } from "./money.ts";

/**
 * The negotiation and agreement workflow (docs/NEGOTIATION.md). Pure: records, strict input schemas,
 * the hash that identifies a version of the terms, and the classification of what changed between two
 * versions. Nothing here knows about the database or the policy engine.
 *
 * Vocabulary
 *  - negotiation : one buyer request with its constraints, a deadline, and any number of sellers.
 *  - proposal    : a stored, immutable VERSION of terms. A SELLER_OFFER is a seller's terms; a BUYER_COUNTER is
 *                  the buyer's structured counter-proposal. A change is a new version, never an edit.
 *  - agreement   : version n of the deal, created only when a proposal passes the policy engine. It pins a
 *                  transaction and an approval; a different proposal produces version n + 1 and retires n.
 */

export const NEGOTIATION_STATUSES = [
  "OPEN",
  "AGREED",
  "REJECTED",
  "TIMED_OUT",
  "CANCELLED",
] as const;
export type NegotiationStatus = (typeof NEGOTIATION_STATUSES)[number];

export const PROPOSAL_KINDS = ["SELLER_OFFER", "BUYER_COUNTER"] as const;
export type ProposalKind = (typeof PROPOSAL_KINDS)[number];

export const PROPOSAL_STATUSES = [
  "OPEN",
  "SUPERSEDED",
  "ACCEPTED",
  "REJECTED",
  "EXPIRED",
  "WITHDRAWN",
] as const;
export type ProposalStatus = (typeof PROPOSAL_STATUSES)[number];

export const AGREEMENT_STATUSES = ["ACTIVE", "INVALIDATED", "CANCELLED"] as const;
export type AgreementStatus = (typeof AGREEMENT_STATUSES)[number];

/** Who is acting. The HTTP layer only ever produces OPERATOR; agents act in-process. */
export type NegotiationActor =
  | { kind: "OPERATOR"; id: string }
  | { kind: "AGENT"; id: string }
  | { kind: "SYSTEM"; id: string }
  | { kind: "ANONYMOUS" };

/** Status moves the schema also enforces (migration 0006). */
export const NEGOTIATION_TRANSITIONS: Record<NegotiationStatus, readonly NegotiationStatus[]> = {
  OPEN: ["AGREED", "REJECTED", "TIMED_OUT", "CANCELLED"],
  AGREED: ["OPEN", "CANCELLED"], // OPEN again only when the agreement is retired and the deal is reopened
  REJECTED: [],
  TIMED_OUT: [],
  CANCELLED: [],
};
export const PROPOSAL_TRANSITIONS: Record<ProposalStatus, readonly ProposalStatus[]> = {
  OPEN: ["SUPERSEDED", "ACCEPTED", "REJECTED", "EXPIRED", "WITHDRAWN"],
  SUPERSEDED: [],
  ACCEPTED: [],
  REJECTED: [],
  EXPIRED: [],
  WITHDRAWN: [],
};

/* ------------------------------------------------------------------ records */

export type RequestRecord = {
  category: ServiceCategory;
  quantity: number;
  summary: string;
  maxTotalMinor: number | null;
  neededWithinDays: number | null;
  requiredDeliverables: string[];
};

export type NegotiationRecord = {
  id: string;
  ownerId: string;
  mandateId: string;
  status: NegotiationStatus;
  currency: string;
  request: RequestRecord;
  invitedSellerIds: string[];
  /** The negotiation timeout. */
  expiresAt: string;
  closedReason: string | null;
  version: number;
  createdAt: string;
  updatedAt: string;
};

/** The comparable terms of a proposal: everything a change to which can invalidate an approval. */
export type ProposalTerms = {
  sellerId: string;
  /** From the seller catalog at the moment of submission; never supplied by a caller. */
  payeeRef: string;
  currency: string;
  category: ServiceCategory;
  /** null for a counter-offer, which states a target total rather than lines. */
  lines: { sku: string; qty: number; unitPriceMinor: number }[] | null;
  shippingMinor: number;
  feesMinor: number;
  /** Server-computed for an offer; the proposed total for a counter-offer. */
  totalMinor: number;
  deliverables: string[];
  deliveryDays: number;
  termsText: string;
};

export const CHANGE_KINDS = [
  "PRICE",
  "PAYEE",
  "SCOPE",
  "CATEGORY",
  "CURRENCY",
  "ACCEPTANCE_CRITERIA",
  "DEADLINE",
] as const;
export type ChangeKind = (typeof CHANGE_KINDS)[number];

export type ProposalRecord = {
  id: string;
  negotiationId: string;
  seq: number;
  kind: ProposalKind;
  /** 1, 2, 3... within (negotiation, seller, kind). */
  version: number;
  supersedesId: string | null;
  respondsToId: string | null;
  status: ProposalStatus;
  statusReason: string | null;
  decidedAt: string | null;
  terms: ProposalTerms;
  /** What the seller said the total was. Offers only. Never used. */
  claimedTotalMinor: number | null;
  validUntil: string;
  deliverBy: string;
  termsHash: string;
  changes: ChangeKind[];
  actor: "OPERATOR" | "AGENT" | "SYSTEM";
  createdAt: string;
};

export type AgreementLink = {
  id: string;
  negotiationId: string;
  version: number;
  proposalId: string;
  proposalHash: string;
  transactionId: string;
  agreementId: string;
  policyDecisionId: string;
  status: AgreementStatus;
  invalidatedReason: string | null;
  invalidatedByProposalId: string | null;
  /** Was an operator approval on file when the agreement was retired? */
  approvalWasValid: boolean | null;
  invalidatedAt: string | null;
  createdAt: string;
};

export type PolicyCheckRecord = {
  id: string;
  negotiationId: string;
  proposalId: string | null;
  agreementLinkId: string | null;
  subject: "ACCEPT_OFFER" | "CREATE_ORDER";
  verdict: "ALLOW" | "DENY";
  reasonCodes: string[];
  explanation: string;
  policyVersion: string;
  inputsHash: string;
  mandateId: string | null;
  mandateVersion: number | null;
  actor: "OPERATOR" | "AGENT" | "SYSTEM";
  decidedAt: string;
};

/* ------------------------------------------------------------------ hashing, deadlines, money text */

/** Identity of a version of the terms. Covers payee, scope, price, currency, category, deliverables and deadline. */
export function proposalHash(kind: ProposalKind, t: ProposalTerms): string {
  return sha256Hex(canonicalJson({ kind, ...t, deliverables: [...t.deliverables].sort() }));
}

export function deliverBy(fromIso: string, days: number): string {
  return new Date(Date.parse(fromIso) + days * 86_400_000).toISOString();
}

export function moneyText(minor: number, currency: string): string {
  return currency in SUPPORTED_CURRENCIES
    ? `${formatMinor(minor, currency as SupportedCurrency)} ${currency}`
    : `${minor} minor units of ${currency}`;
}

const sameSet = (a: readonly string[], b: readonly string[]) =>
  JSON.stringify([...a].sort()) === JSON.stringify([...b].sort());

/** Did the price of an item that is in both versions move? (Swapping one item for another is a SCOPE change.) */
const unitPriceMoved = (a: ProposalTerms, b: ProposalTerms): boolean => {
  const before = new Map((a.lines ?? []).map((l) => [l.sku, l.unitPriceMinor]));
  return (b.lines ?? []).some((l) => before.has(l.sku) && before.get(l.sku) !== l.unitPriceMinor);
};
const scopeLines = (t: ProposalTerms) =>
  JSON.stringify((t.lines ?? []).map((l) => [l.sku, l.qty]).sort());

/**
 * What changed between two versions of the same chain. The first version has no predecessor, so no changes.
 * Any change at all is relevant to an approval: an approval covers exactly one set of terms.
 */
export function diffTerms(prev: ProposalTerms | null, next: ProposalTerms): ChangeKind[] {
  if (prev === null) return [];
  const out: ChangeKind[] = [];
  if (
    prev.totalMinor !== next.totalMinor ||
    prev.shippingMinor !== next.shippingMinor ||
    prev.feesMinor !== next.feesMinor ||
    unitPriceMoved(prev, next)
  ) {
    out.push("PRICE");
  }
  if (prev.payeeRef !== next.payeeRef || prev.sellerId !== next.sellerId) out.push("PAYEE");
  if (scopeLines(prev) !== scopeLines(next) || prev.termsText !== next.termsText) out.push("SCOPE");
  if (prev.category !== next.category) out.push("CATEGORY");
  if (prev.currency !== next.currency) out.push("CURRENCY");
  if (!sameSet(prev.deliverables, next.deliverables)) out.push("ACCEPTANCE_CRITERIA");
  if (prev.deliveryDays !== next.deliveryDays) out.push("DEADLINE");
  return out;
}

/** Plain-language account of each change, for the UI and the audit trail. */
export function describeChanges(prev: ProposalTerms, next: ProposalTerms): string[] {
  const text: string[] = [];
  for (const change of diffTerms(prev, next)) {
    switch (change) {
      case "PRICE":
        text.push(
          prev.totalMinor === next.totalMinor
            ? "The price breakdown changed (unit prices, shipping or fees) although the total did not."
            : `The total price changed from ${moneyText(prev.totalMinor, prev.currency)} to ${moneyText(next.totalMinor, next.currency)}.`,
        );
        break;
      case "PAYEE":
        text.push("The payee changed. Payees come only from the seller catalog.");
        break;
      case "SCOPE":
        text.push("What is being bought changed (items, quantities or the written terms).");
        break;
      case "CATEGORY":
        text.push(`The service category changed from ${prev.category} to ${next.category}.`);
        break;
      case "CURRENCY":
        text.push(`The currency changed from ${prev.currency} to ${next.currency}.`);
        break;
      case "ACCEPTANCE_CRITERIA":
        text.push("The deliverables, which are the acceptance criteria, changed.");
        break;
      case "DEADLINE":
        text.push(
          `The delivery time changed from ${prev.deliveryDays} to ${next.deliveryDays} day(s).`,
        );
        break;
    }
  }
  return text;
}

/* ------------------------------------------------------------------ input schemas (strict) */

const Id = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,63}$/, { error: "is not a valid id" });
const Minor = z.number().int().min(0).max(MAX_MINOR);
const Days = z.number().int().min(0).max(365);
const Validity = z.number().int().min(1).max(10_080);
const CategorySchema = z.enum(CATEGORY_CODES as [ServiceCategory, ...ServiceCategory[]]);

export const MAX_NEGOTIATION_MINUTES = 10_080; // one week

export const OpenNegotiationSchema = z.strictObject({
  mandateId: Id,
  category: CategorySchema,
  quantity: z.number().int().min(1).max(1000),
  summary: CleanText(300, 1),
  /** A decimal string in the mandate's currency (never a JSON number), or null for "no target". */
  maxTotal: z.string().max(24).nullable(),
  neededWithinDays: Days.nullable(),
  requiredDeliverables: z.array(CleanText(200, 1)).max(10),
  invitedSellerIds: z.array(Id).min(1).max(5),
  timeoutMinutes: z.number().int().min(1).max(MAX_NEGOTIATION_MINUTES),
});
export type OpenNegotiationInput = z.infer<typeof OpenNegotiationSchema>;

export const SubmitOfferSchema = z.strictObject({
  negotiationId: Id,
  sellerId: Id,
  /** Optional: the open counter-offer this offer answers. */
  respondsToId: Id.nullable().optional(),
  offer: OfferTermsSchema,
});
export type SubmitOfferInput = z.infer<typeof SubmitOfferSchema>;

export const SubmitCounterSchema = z.strictObject({
  negotiationId: Id,
  sellerId: Id,
  currency: z.string().regex(/^[A-Z]{3}$/, { error: "must be a 3-letter uppercase code" }),
  category: CategorySchema,
  targetTotalMinor: Minor,
  deliverables: z.array(CleanText(200, 1)).min(1).max(10),
  deliveryDays: Days,
  note: CleanText(300),
  validForMinutes: Validity,
});
export type SubmitCounterInput = z.infer<typeof SubmitCounterSchema>;

export const ProposalRefSchema = z.strictObject({
  negotiationId: Id,
  proposalId: Id,
  reason: CleanText(500).optional(),
});
export const NegotiationRefSchema = z.strictObject({
  negotiationId: Id,
  reason: CleanText(500).optional(),
});

/** Keys that look like an attempt to name a payee. A payee is never an input: it is looked up from the catalog. */
const PAYEE_KEY =
  /payee|pay_?to|account|iban|swift|routing|beneficiar|recipient|e-?mail|paypal|wallet/i;

function payeeKeys(value: unknown, path: string, depth = 0): FieldError[] {
  if (depth > 3 || value === null || typeof value !== "object" || Array.isArray(value)) return [];
  const out: FieldError[] = [];
  for (const [k, v] of Object.entries(value)) {
    if (PAYEE_KEY.test(k)) {
      out.push({
        field: `${path}${k}`.slice(0, 60),
        message:
          "a payee cannot be supplied; it always comes from the seller catalog, so the payee of a deal cannot be changed through a proposal",
      });
    }
    out.push(...payeeKeys(v, `${path}${k}.`, depth + 1));
  }
  return out;
}

export type ParseResult<T> = { ok: true; value: T } | { ok: false; errors: FieldError[] };

/** Strict parse that reports every problem, with a clear message when a payee is smuggled in. */
export function parseStrict<S extends z.ZodType>(schema: S, raw: unknown): ParseResult<z.infer<S>> {
  const payee = payeeKeys(raw, "");
  const r = schema.safeParse(raw);
  if (r.success && payee.length === 0) return { ok: true, value: r.data };
  const errors: FieldError[] = [...payee];
  if (!r.success) {
    for (const i of r.error.issues) {
      if (i.code === "unrecognized_keys") {
        for (const k of i.keys) {
          if (!PAYEE_KEY.test(k)) {
            errors.push({
              field: [...i.path, k].join(".").slice(0, 60),
              message: "is not a recognised field and cannot be set through this request",
            });
          }
        }
      } else {
        errors.push({ field: i.path.join(".") || "(root)", message: i.message });
      }
    }
  }
  return { ok: false, errors };
}
