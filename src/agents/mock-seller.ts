import type {
  OfferTerms,
  SellerAnswerInput,
  SellerAnswerOutput,
  SellerConfig,
  SellerCounterInput,
  SellerOfferOutput,
  SellerOpenInput,
} from "../domain/agent-contract.ts";
import { sumOfferMinor } from "../domain/offer.ts";

/**
 * The deterministic seller used when no model provider is configured. It negotiates strictly inside
 * its SellerConfig: never below a floor price, never above list, never faster than its lead time, and
 * it never discloses a floor. Pure and repeatable. (A test proves it can never break its own rules.)
 */

const decline = (reason: string): SellerOfferOutput => ({ kind: "DECLINE", reason });

function offerFor(
  config: SellerConfig,
  category: OfferTerms["category"],
  lines: OfferTerms["lines"],
  deliverables: string[],
  termsText: string,
  message: string,
): SellerOfferOutput {
  const total = sumOfferMinor(config.shippingMinor, config.feesMinor, lines);
  if (total === null) return decline("We cannot price a request of that size.");
  const validForMinutes = Math.min(config.maxValidForMinutes, 60);
  return {
    kind: "OFFER",
    offer: {
      currency: config.currency,
      lines: lines.map((l) => ({ ...l })),
      shippingMinor: config.shippingMinor,
      feesMinor: config.feesMinor,
      claimedTotalMinor: total,
      category,
      deliveryDays: config.minLeadTimeDays,
      deliverables,
      termsText: `${termsText} Valid for ${validForMinutes} minutes.`,
      validForMinutes,
    },
    message,
  };
}

export function mockSellerOpen(config: SellerConfig, input: SellerOpenInput): SellerOfferOutput {
  const item = config.catalog
    .filter((c) => c.category === input.request.category)
    .sort((a, b) => a.listPriceMinor - b.listPriceMinor || a.sku.localeCompare(b.sku))[0];
  if (!item) return decline("We do not sell that kind of service.");
  return offerFor(
    config,
    item.category,
    [{ sku: item.sku, qty: input.request.quantity, unitPriceMinor: item.listPriceMinor }],
    item.deliverables,
    "Fixed price.",
    `Standard offer for ${item.name}.`,
  );
}

export function mockSellerCounter(
  config: SellerConfig,
  input: SellerCounterInput,
): SellerOfferOutput {
  const { currentOffer, targetTotalMinor } = input;
  const bySku = new Map(config.catalog.map((c) => [c.sku, c]));
  const currentTotal = sumOfferMinor(config.shippingMinor, config.feesMinor, currentOffer.lines);
  if (currentTotal === null || currentOffer.lines.some((l) => !bySku.has(l.sku))) {
    return decline("We cannot revise that offer.");
  }

  let floorTotal = config.shippingMinor + config.feesMinor;
  for (const l of currentOffer.lines)
    floorTotal += (bySku.get(l.sku)?.floorPriceMinor ?? 0) * l.qty;

  // How far we are willing to move: toward the target, never past the floor, never upward.
  let need = Math.max(0, currentTotal - Math.max(targetTotalMinor, floorTotal));
  const lines = currentOffer.lines.map((l) => {
    const floor = bySku.get(l.sku)?.floorPriceMinor ?? l.unitPriceMinor;
    const capacity = Math.max(0, l.unitPriceMinor - floor) * l.qty;
    const unitCut = Math.floor(Math.min(need, capacity) / l.qty);
    need -= unitCut * l.qty;
    return { sku: l.sku, qty: l.qty, unitPriceMinor: l.unitPriceMinor - unitCut };
  });

  const result = offerFor(
    config,
    currentOffer.category,
    lines,
    currentOffer.deliverables,
    "Revised price.",
    "",
  );
  if (result.kind !== "OFFER") return result;
  const reached = result.offer.claimedTotalMinor <= targetTotalMinor;
  return {
    ...result,
    // only the price moves: the written terms stay exactly as they were, so a revision is not a change of scope
    offer: { ...result.offer, termsText: currentOffer.termsText },
    message: reached ? "We can do that." : "This is our best and final price.",
  };
}

export function mockSellerAnswer(
  config: SellerConfig,
  input: SellerAnswerInput,
): SellerAnswerOutput {
  const q = input.question.toLowerCase();
  const item = config.catalog.find((c) => c.category === input.request.category);
  const deliverables = input.currentOffer?.deliverables ?? item?.deliverables ?? [];
  if (/\b(deliver|delivery|when|how long|lead|days)\b/.test(q)) {
    return {
      kind: "ANSWER",
      text: `Delivery takes ${config.minLeadTimeDays} day(s) from confirmation.`,
    };
  }
  if (/\b(include|includes|included|deliverables?|contain|cover|report)\b/.test(q)) {
    return {
      kind: "ANSWER",
      text:
        deliverables.length > 0
          ? `The offer includes: ${deliverables.join("; ")}.`
          : "Please see the offer for what is included.",
    };
  }
  if (/\b(discount|cheaper|lower|price|negotiat)/.test(q)) {
    return {
      kind: "ANSWER",
      text: "You can propose a target total and we will tell you what we can do.",
    };
  }
  if (/\b(refund|cancel)/.test(q)) {
    return { kind: "ANSWER", text: "Cancellation follows our standard terms." };
  }
  return {
    kind: "ANSWER",
    text: "I can answer questions about price, delivery time and deliverables.",
  };
}
