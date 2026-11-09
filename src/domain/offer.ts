import { canonicalJson, sha256Hex } from "./canonical.ts";
import { MAX_MINOR } from "./money.ts";

/**
 * Offer arithmetic and the terms hash, shared by persistence (which stores them) and the policy
 * engine (which recomputes them). One definition, so the two cannot drift apart.
 */

export type OfferTermsLine = { sku: string; qty: number; unitPriceMinor: number };

export type OfferTerms = {
  sellerId: string;
  currency: string;
  shippingMinor: number;
  feesMinor: number;
  lines: readonly OfferTermsLine[];
};

/** SHA-256 of the canonical JSON of everything that defines the deal. Free text is excluded on purpose. */
export function termsHashOf(t: OfferTerms): string {
  return sha256Hex(
    canonicalJson({
      sellerId: t.sellerId,
      currency: t.currency,
      shippingMinor: t.shippingMinor,
      feesMinor: t.feesMinor,
      lines: t.lines.map((l) => ({ sku: l.sku, qty: l.qty, unitPriceMinor: l.unitPriceMinor })),
    }),
  );
}

const isNonNegativeSafe = (n: number) => Number.isSafeInteger(n) && n >= 0;

/**
 * shipping + fees + Σ qty × unitPrice, computed exactly (BigInt). Returns null, never a wrong number,
 * when any input is not a non-negative safe integer (qty: positive) or the sum exceeds the money range.
 */
export function sumOfferMinor(
  shippingMinor: number,
  feesMinor: number,
  lines: readonly { qty: number; unitPriceMinor: number }[],
): number | null {
  if (!isNonNegativeSafe(shippingMinor) || !isNonNegativeSafe(feesMinor)) return null;
  let total = BigInt(shippingMinor) + BigInt(feesMinor);
  for (const l of lines) {
    if (!isNonNegativeSafe(l.unitPriceMinor) || !Number.isSafeInteger(l.qty) || l.qty < 1)
      return null;
    total += BigInt(l.unitPriceMinor) * BigInt(l.qty);
  }
  return total > BigInt(MAX_MINOR) ? null : Number(total);
}
