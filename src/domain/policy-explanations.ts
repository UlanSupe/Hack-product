import type { ReasonCode } from "./policy.ts";

/**
 * Human wording for the policy engine's stable reason codes, for the UI. The engine's own descriptions are
 * terse and technical; these say what happened, why the rule exists, and what a person can do. Static text:
 * it never includes anything a seller wrote. `Record<ReasonCode, ...>` makes a missing code a compile error.
 */
export type Guidance = { title: string; detail: string; next: string };

export const GUIDANCE: Record<ReasonCode, Guidance> = {
  INPUT_INVALID: {
    title: "The check could not be run",
    detail:
      "The information handed to the policy check was incomplete or malformed, so nothing was allowed.",
    next: "This is a system problem, not a seller problem. Retry; if it persists, report it.",
  },
  POLICY_ERROR: {
    title: "The check failed safely",
    detail: "The policy check hit an internal error and refused, as it always does when unsure.",
    next: "Retry. Nothing was approved or paid.",
  },
  ACTOR_NOT_PERMITTED: {
    title: "That kind of requester may not do this",
    detail: "Some steps, such as releasing funds, are reserved for the human operator.",
    next: "Ask the operator to do it.",
  },
  STATE_NOT_PERMITTED: {
    title: "Not possible at this stage",
    detail:
      "The transaction is not in a state where this step is allowed (for example it was already cancelled or already in progress).",
    next: "Check the transaction status; start a new negotiation if this one is finished.",
  },
  TRANSACTION_MISMATCH: {
    title: "Wrong transaction",
    detail: "The request pointed at a different transaction than the one being decided.",
    next: "Reload and try again from the right negotiation.",
  },
  MANDATE_MISMATCH: {
    title: "Not the mandate this deal belongs to",
    detail: "The rules presented are not the mandate this transaction was started under.",
    next: "Open the negotiation again so it uses the correct mandate.",
  },
  MANDATE_VERSION_MISMATCH: {
    title: "Wrong version of the mandate",
    detail:
      "A mandate version other than the one this transaction is pinned to was presented. A client cannot choose which version applies.",
    next: "Use the current negotiation page; do not reuse an old request.",
  },
  MANDATE_STALE: {
    title: "The mandate has a newer version",
    detail:
      "You approved newer rules after this deal began, so the older ones no longer authorize new spending.",
    next: "Start the deal again under the current mandate.",
  },
  MANDATE_REVOKED: {
    title: "The mandate was revoked",
    detail: "The operator withdrew this spending authority. Nothing under it can proceed.",
    next: "Approve a new mandate first.",
  },
  MANDATE_EXPIRED: {
    title: "The mandate has expired",
    detail: "The spending authority ran out before this step.",
    next: "Approve a new mandate version, then start again.",
  },
  MANDATE_INTEGRITY: {
    title: "The mandate rules do not match the approved version",
    detail:
      "The rules supplied differ from what was actually approved (for example a draft or a tampered copy). They are not used.",
    next: "Reload; if this repeats, treat it as a fault and investigate.",
  },
  OFFER_REQUIRED: {
    title: "There is no offer",
    detail: "A decision needs a concrete offer to look at.",
    next: "Wait for a seller offer.",
  },
  OFFER_NOT_OPEN: {
    title: "That offer is no longer open",
    detail: "It was replaced by a newer version, rejected, expired or already accepted.",
    next: "Look at the seller's latest offer.",
  },
  OFFER_NOT_ACCEPTED: {
    title: "The offer behind this agreement is not accepted",
    detail: "The agreement and its offer disagree about whether the offer was accepted.",
    next: "Treat as a fault: do not pay; start again.",
  },
  OFFER_EXPIRED: {
    title: "The offer has expired",
    detail: "Offers are only good for a limited time. This one ran out before it was accepted.",
    next: "Ask the seller for a fresh offer.",
  },
  OFFER_EMPTY: {
    title: "The offer lists nothing",
    detail: "An offer must say what is being sold.",
    next: "Ask the seller for an itemised offer.",
  },
  AGREEMENT_REQUIRED: {
    title: "Nothing has been agreed yet",
    detail: "Payment steps need an accepted agreement first.",
    next: "Accept a seller offer first.",
  },
  AGREEMENT_EXISTS: {
    title: "Already agreed",
    detail: "This deal already has an agreement. A second one is not created.",
    next: "Use the existing agreement, or reopen the negotiation to change the terms.",
  },
  AGREEMENT_MISMATCH: {
    title: "The agreement does not match",
    detail: "The agreement is not the one attached to this transaction or this offer.",
    next: "Reload; do not proceed with a mismatched agreement.",
  },
  TERMS_HASH_MISMATCH: {
    title: "The terms were altered",
    detail:
      "The terms in front of us are not the terms that were recorded and agreed. Any change must be a new version that is approved again.",
    next: "Reject this version, or accept it as a new version and approve it again.",
  },
  PRICE_NOT_IN_CATALOG: {
    title: "Priced above the catalog, or not in the catalog",
    detail:
      "The seller's catalog price is the most a line may cost. This line is above it, or the item is not sold by this seller.",
    next: "Ask for a price at or below the catalog price, or a catalog item.",
  },
  TOTAL_MISMATCH: {
    title: "The total does not add up",
    detail:
      "The total the seller stated differs from the sum of its own lines, shipping and fees. We use our own sum.",
    next: "Ask the seller to correct the offer.",
  },
  AMOUNT_NOT_POSITIVE: {
    title: "The amount must be more than zero",
    detail: "A free or negative deal is not a valid payment.",
    next: "Ask for a priced offer.",
  },
  AMOUNT_OVERFLOW: {
    title: "The amount is too large",
    detail: "The total is beyond what the system can represent exactly.",
    next: "Ask for a realistic quantity or price.",
  },
  AMOUNT_MISMATCH: {
    title: "The amounts do not match",
    detail:
      "An amount presented differs from the amount on record. The recorded amount always wins.",
    next: "Reload and check the agreed price.",
  },
  CURRENCY_MISMATCH: {
    title: "Wrong currency",
    detail:
      "The offer is in a different currency than your mandate. Numbers in different currencies are never treated as equal.",
    next: "Ask the seller to quote in the mandate's currency.",
  },
  PAYEE_NOT_ALLOWED: {
    title: "This seller is not on your allow-list",
    detail: "Your mandate only permits payments to the sellers it lists.",
    next: "Add the seller in a new mandate version, or choose another seller.",
  },
  PAYEE_MISMATCH: {
    title: "The payee does not match the catalog",
    detail:
      "The payee on this proposal is not the one the seller catalog lists. The payee can only ever come from the catalog, so a substituted payee is refused.",
    next: "Reject the proposal. Do not pay anyone the catalog does not name.",
  },
  CATEGORY_NOT_ALLOWED: {
    title: "Category not allowed by your mandate",
    detail: "At least one item belongs to a service category your mandate does not permit.",
    next: "Choose different items, or allow the category in a new mandate version.",
  },
  CATEGORY_UNKNOWN: {
    title: "An item has no known category",
    detail: "Items that are not in the seller's catalog cannot be matched to an allowed category.",
    next: "Ask for catalog items only.",
  },
  OVER_PER_TX_CAP: {
    title: "Over the per-transaction limit",
    detail: "The total is more than the largest single payment your mandate allows.",
    next: "Negotiate a lower total, or raise the limit in a new mandate version.",
  },
  OVER_TOTAL_BUDGET: {
    title: "Over your total budget",
    detail: "With what is already reserved or spent, this would exceed your overall budget.",
    next: "Wait for reservations to be released, lower the price, or raise the budget in a new mandate version.",
  },
  EXPOSURE_INVALID: {
    title: "Spending could not be totalled safely",
    detail: "The records used to add up spending were inconsistent, so the check refused.",
    next: "Report this; nothing was approved.",
  },
  APPROVAL_REQUIRED: {
    title: "Waiting for your approval",
    detail:
      "Your mandate requires a human to approve this amount (or every deal) before any payment step.",
    next: "Review the terms and approve, or reject, the agreement.",
  },
  APPROVAL_REJECTED: {
    title: "You rejected this agreement",
    detail: "A recorded rejection blocks the payment steps.",
    next: "Negotiate new terms; they will need a fresh approval.",
  },
  APPROVAL_NOT_HUMAN: {
    title: "The approval was not from the operator",
    detail:
      "Only the human operator's approval counts. An approval claimed by anything else is ignored.",
    next: "The operator must approve it themselves.",
  },
  APPROVAL_MISMATCH: {
    title: "The approval is for something else",
    detail:
      "An approval belongs to exactly one agreement. It does not carry over to changed terms.",
    next: "Approve the current agreement.",
  },
  DUPLICATE_ATTEMPT: {
    title: "Already in progress",
    detail: "The same step has already been started for this transaction.",
    next: "Wait for the first attempt to finish.",
  },
  DUPLICATE_CAPTURE: {
    title: "Already paid",
    detail: "A payment was already collected for this transaction.",
    next: "Nothing more to do.",
  },
  VOID_AFTER_CAPTURE: {
    title: "Cannot cancel a payment that was collected",
    detail: "Once funds are captured the hold cannot be voided.",
    next: "This build cannot release a collected payment; refunds are not built.",
  },
  OBSERVATION_REQUIRED: {
    title: "Waiting for a fresh check with PayPal",
    detail: "The server must read the payment's current state from PayPal before this step.",
    next: "Retry shortly.",
  },
  HONOR_WINDOW_UNKNOWN: {
    title: "Hold time unknown",
    detail: "We do not know how long the payment hold lasts, so capture is refused.",
    next: "Void the hold and start again.",
  },
  HONOR_PERIOD_ENDED: {
    title: "The payment hold has run out",
    detail: "The hold is too old (or about to be) to collect safely.",
    next: "Void the hold and start again.",
  },
};

export type Explanation = {
  verdict: "ALLOW" | "DENY";
  headline: string;
  items: { code: string; title: string; detail: string; next: string }[];
};

/** Turns a decision's codes into a headline plus one plain-language item per code. Unknown codes are shown, never hidden. */
export function explainCodes(
  verdict: "ALLOW" | "DENY",
  codes: readonly string[],
  subject: string,
): Explanation {
  const items = codes.map((code) => {
    const g = (GUIDANCE as Record<string, Guidance | undefined>)[code];
    return g
      ? { code, ...g }
      : {
          code,
          title: "Refused",
          detail: `The policy check refused with code ${code}.`,
          next: "Contact the operator.",
        };
  });
  const what =
    subject === "ACCEPT_OFFER"
      ? "accepting this offer"
      : subject === "AUTHORIZE"
        ? "placing the hold"
        : subject === "CAPTURE"
          ? "collecting the payment (capture)"
          : subject === "VOID"
            ? "releasing the hold"
            : "starting payment";
  return {
    verdict,
    headline:
      verdict === "ALLOW"
        ? `Policy check passed for ${what}.`
        : items.length === 1
          ? `Policy check refused ${what}: ${items[0]?.title ?? "refused"}.`
          : `Policy check refused ${what} for ${items.length} reasons.`,
    items,
  };
}
