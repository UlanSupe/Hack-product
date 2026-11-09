import type { Step } from "../types";

/**
 * Reusable initial states. Default world: mandate M1 allows COMPUTE from seller_acme and seller_other, caps one
 * transaction at 100.00 USD, the total at 150.00 USD, and wants a human approval above 50.00 USD. The catalog sells
 * "GPU-PACK" at 80.00 (acme) and 75.00 (other). All amounts are in minor units (cents).
 */
export const OPEN: Step = { do: "open" };

/** A negotiation with one valid 80.00 offer, accepted by policy: the agreement exists but is NOT yet approved. */
export const AGREED_80: readonly Step[] = [
  OPEN,
  { do: "offer", as: "o1" },
  { do: "accept", proposal: "o1" },
];
/** ...and the human operator has approved it. */
export const APPROVED_80: readonly Step[] = [...AGREED_80, { do: "approve" }];
/** ...and the PayPal order exists (the buyer has not approved at PayPal yet). */
export const ORDER_STARTED: readonly Step[] = [...APPROVED_80, { do: "pay", op: "start" }];
/** ...and the buyer approved at PayPal. */
export const BUYER_APPROVED: readonly Step[] = [
  ...ORDER_STARTED,
  { do: "paypal", buyerApproves: true },
];
/** ...and the funds are on hold (authorized, not captured). */
export const ON_HOLD: readonly Step[] = [...BUYER_APPROVED, { do: "pay", op: "authorize" }];
/** ...and captured. */
export const CAPTURED_80: readonly Step[] = [...ON_HOLD, { do: "pay", op: "capture" }];

/** A seller offer that is numerically fine for the default catalog. */
export const offerAt = (unit: number, as = "o1", extra: Record<string, unknown> = {}): Step => ({
  do: "offer",
  as,
  unit,
  ...extra,
});

/** The audit events a refused acceptance must leave behind. */
export const refusedAcceptance = (reasonCodes: readonly string[]) =>
  [
    { type: "POLICY_DENIED", payload: { subject: "ACCEPT_OFFER", reasonCodes } },
    { type: "PROPOSAL_STATUS_CHANGED", payload: { to: "REJECTED" } },
  ] as const;

/** Nothing may have been agreed, ordered or paid. */
export const NO_AGREEMENT_EVENTS = [
  "AGREEMENT_CREATED",
  "TX_STATE_CHANGED",
  "TX_APPROVAL_RECORDED",
] as const;
