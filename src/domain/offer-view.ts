import {
  type MandateView,
  type OfferTerms,
  type OfferView,
  type SellerConfig,
} from "./agent-contract.ts";
import { approvalRequirement, type MandateTerms } from "./mandate.ts";
import { sumOfferMinor } from "./offer.ts";
import { scanInjection, type InjectionSignal } from "./untrusted-text.ts";

/**
 * Turns a seller's claims into the buyer's view of them: the claims, untouched, in `untrusted`, and
 * facts the SERVER computed from them in `trusted`. Nothing here asks a model anything. Pure.
 */

/** A row of the server-owned seller catalog. `unitPriceMinor` is the list price: a ceiling a negotiated price may not exceed. */
export type CatalogEntry = { sku: string; category: string; unitPriceMinor: number };

/** Copy of the parts of a mandate an agent may see. The remaining budget is computed by the caller. */
export function mandateViewOf(terms: MandateTerms, remainingBudgetMinor: number): MandateView {
  return {
    currency: terms.currency,
    maxTransactionMinor: terms.maxTransactionMinor,
    remainingBudgetMinor: Math.max(0, remainingBudgetMinor),
    approvalThresholdMinor: terms.approvalThresholdMinor,
    requireReviewBeforeExecution: terms.requireReviewBeforeExecution,
    allowedCategories: [...terms.allowedCategories],
  };
}

export function buildOfferView(args: {
  offerId: string;
  sellerId: string;
  terms: OfferTerms;
  mandate: MandateView;
  sellerAllowed: boolean;
  /** The seller's catalog rows, or null if the caller has none (then `catalog` is UNKNOWN, never VERIFIED). */
  catalog: readonly CatalogEntry[] | null;
}): OfferView {
  const { terms, mandate } = args;
  const computed = sumOfferMinor(terms.shippingMinor, terms.feesMinor, terms.lines);

  let catalog: OfferView["trusted"]["catalog"] = "UNKNOWN";
  if (args.catalog !== null) {
    const bySku = new Map(args.catalog.map((c) => [c.sku, c]));
    const ok = terms.lines.every((l) => {
      const row = bySku.get(l.sku);
      return (
        row !== undefined &&
        l.unitPriceMinor <= row.unitPriceMinor &&
        row.category === terms.category
      );
    });
    catalog = ok ? "VERIFIED" : "MISMATCH";
  }

  const signals = new Set<InjectionSignal>();
  for (const text of [terms.termsText, ...terms.deliverables]) {
    for (const s of scanInjection(text)) signals.add(s);
  }

  return {
    offerId: args.offerId,
    sellerId: args.sellerId,
    trusted: {
      computedTotalMinor: computed,
      totalMatchesClaim: computed !== null && computed === terms.claimedTotalMinor,
      currencyMatchesMandate: terms.currency === mandate.currency,
      categoryAllowed: mandate.allowedCategories.includes(terms.category),
      sellerAllowed: args.sellerAllowed,
      catalog,
      withinPerTransactionCap: computed !== null && computed <= mandate.maxTransactionMinor,
      withinRemainingBudget: computed !== null && computed <= mandate.remainingBudgetMinor,
      // An amount we cannot compute can never be waved through: send it to a human.
      approval: computed === null ? "REVIEW_REQUIRED" : approvalRequirement(mandate, computed),
      riskSignals: [...signals].sort(),
    },
    untrusted: terms,
  };
}

export const HARD_FAILURES = [
  "TOTAL_NOT_VERIFIED",
  "CURRENCY",
  "CATEGORY",
  "SELLER",
  "CATALOG",
  "OVER_CAP",
  "OVER_BUDGET",
] as const;
export type HardFailure = (typeof HARD_FAILURES)[number];

/**
 * Facts that make an offer unacceptable whatever anyone says about it. The policy engine will deny such
 * an offer; this lets the buyer, and the UI, say why before it gets that far. Risk signals are not here:
 * they escalate to a human, they do not disqualify.
 */
export function hardFailures(view: OfferView): HardFailure[] {
  const t = view.trusted;
  const out: HardFailure[] = [];
  if (!t.totalMatchesClaim) out.push("TOTAL_NOT_VERIFIED");
  if (!t.currencyMatchesMandate) out.push("CURRENCY");
  if (!t.categoryAllowed) out.push("CATEGORY");
  if (!t.sellerAllowed) out.push("SELLER");
  if (t.catalog === "MISMATCH") out.push("CATALOG");
  if (!t.withinPerTransactionCap) out.push("OVER_CAP");
  if (!t.withinRemainingBudget) out.push("OVER_BUDGET");
  return out;
}

/* ------------------------------------------------------------------ seller constraints */

export const SELLER_VIOLATIONS = [
  "CURRENCY_NOT_SELLERS",
  "UNKNOWN_SKU",
  "PRICE_BELOW_FLOOR",
  "PRICE_ABOVE_LIST",
  "CATEGORY_NOT_IN_CATALOG",
  "LEAD_TIME_TOO_SHORT",
  "SHIPPING_OR_FEES_NOT_CONFIGURED",
  "VALIDITY_TOO_LONG",
  "TOTAL_NOT_ACCURATE",
] as const;
export type SellerViolation = (typeof SELLER_VIOLATIONS)[number];

/**
 * Is this offer something the configured seller is willing to make? An honest seller agent must always
 * pass; a deliberately hostile fixture seller is the only thing allowed to fail it.
 */
export function checkSellerConstraints(offer: OfferTerms, config: SellerConfig): SellerViolation[] {
  const found = new Set<SellerViolation>();
  const bySku = new Map(config.catalog.map((c) => [c.sku, c]));
  if (offer.currency !== config.currency) found.add("CURRENCY_NOT_SELLERS");
  for (const line of offer.lines) {
    const row = bySku.get(line.sku);
    if (row === undefined) {
      found.add("UNKNOWN_SKU");
      continue;
    }
    if (line.unitPriceMinor < row.floorPriceMinor) found.add("PRICE_BELOW_FLOOR");
    if (line.unitPriceMinor > row.listPriceMinor) found.add("PRICE_ABOVE_LIST");
    if (row.category !== offer.category) found.add("CATEGORY_NOT_IN_CATALOG");
  }
  if (offer.deliveryDays < config.minLeadTimeDays) found.add("LEAD_TIME_TOO_SHORT");
  if (offer.shippingMinor !== config.shippingMinor || offer.feesMinor !== config.feesMinor) {
    found.add("SHIPPING_OR_FEES_NOT_CONFIGURED");
  }
  if (offer.validForMinutes > config.maxValidForMinutes) found.add("VALIDITY_TOO_LONG");
  const computed = sumOfferMinor(offer.shippingMinor, offer.feesMinor, offer.lines);
  if (computed === null || computed !== offer.claimedTotalMinor) found.add("TOTAL_NOT_ACCURATE");
  return [...found].sort();
}
