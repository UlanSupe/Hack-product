import type { OfferView, SellerConfig } from "@/domain/agent-contract";
import { termsHashOf } from "@/domain/offer";
import type { PolicyInput } from "@/domain/policy";

import { mutate, must, valid } from "../policy/fixtures";

/**
 * Test-only bridge from what the agents produced to what the Policy Engine judges: it builds the engine's
 * ACCEPT_OFFER input from an offer view and the server's seller catalog, exactly as the future
 * ActionGateway loader will. The point of the tests that use it: nothing an agent said is in this input
 * except the offer's structured terms, and the engine decides from the server's facts.
 */
export function policyInputFor(
  offer: OfferView,
  config: SellerConfig,
  change: (draft: PolicyInput) => void = () => {},
): PolicyInput {
  const t = offer.untrusted;
  const catalog = new Map(config.catalog.map((c) => [c.sku, c]));
  return mutate(valid("ACCEPT_OFFER"), (d) => {
    d.mandate.terms.allowedSellerIds = [offer.sellerId]; // the operator allowed this seller
    const base = must(d.offer);
    d.offer = {
      ...base,
      id: offer.offerId,
      sellerId: offer.sellerId,
      catalogPayeeRef: `payee_${offer.sellerId}`,
      currency: t.currency,
      shippingMinor: t.shippingMinor,
      feesMinor: t.feesMinor,
      claimedTotalMinor: t.claimedTotalMinor,
      storedServerTotalMinor: offer.trusted.computedTotalMinor ?? 0,
      storedTermsHash: termsHashOf({
        sellerId: offer.sellerId,
        currency: t.currency,
        shippingMinor: t.shippingMinor,
        feesMinor: t.feesMinor,
        lines: t.lines,
      }),
      lines: t.lines.map((l) => ({
        sku: l.sku,
        qty: l.qty,
        unitPriceMinor: l.unitPriceMinor,
        catalogUnitPriceMinor: catalog.get(l.sku)?.listPriceMinor ?? null,
        category: catalog.get(l.sku)?.category ?? null,
      })),
    };
    change(d);
  });
}
