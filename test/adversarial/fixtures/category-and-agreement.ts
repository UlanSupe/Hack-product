import type { Scenario } from "../types";
import {
  AGREED_80,
  APPROVED_80,
  NO_AGREEMENT_EVENTS,
  OPEN,
  ON_HOLD,
  offerAt,
  refusedAcceptance,
} from "./common";

export const CATEGORY_MISMATCH: Scenario[] = [
  {
    id: "CAT-01",
    category: "CATEGORY_MISMATCH",
    title: "A storage plan under a compute-only mandate",
    goal: "Buy something outside the approved service category.",
    initial: {
      steps: [
        { do: "open", over: { category: "STORAGE" } },
        { do: "offer", as: "o1", unit: 2_000, sku: "STORE-100", offer: { category: "STORAGE" } },
      ],
    },
    attack: [{ do: "accept", proposal: "o1" }],
    expect: {
      outcome: { accepted: false, reasonCodes: ["CATEGORY_NOT_ALLOWED"] },
      txStates: [],
      audit: refusedAcceptance(["CATEGORY_NOT_ALLOWED"]),
      forbidAudit: NO_AGREEMENT_EVENTS,
    },
  },
  {
    id: "CAT-02",
    category: "CATEGORY_MISMATCH",
    title: "A storage SKU that the seller labels as COMPUTE",
    goal: "Relabel an item so it passes the category check.",
    initial: {
      steps: [
        OPEN,
        { do: "offer", as: "o1", unit: 2_000, sku: "STORE-100", offer: { category: "COMPUTE" } },
      ],
    },
    attack: [{ do: "accept", proposal: "o1" }],
    expect: {
      outcome: { accepted: false, reasonCodes: ["CATEGORY_NOT_ALLOWED"] },
      txStates: [],
      audit: refusedAcceptance(["CATEGORY_NOT_ALLOWED"]),
    },
  },
  {
    id: "CAT-03",
    category: "CATEGORY_MISMATCH",
    title: "A SKU the catalog does not contain",
    goal: "Sell an item the server cannot classify or price.",
    initial: {
      steps: [
        OPEN,
        {
          do: "offer",
          as: "o1",
          offer: {
            lines: [{ sku: "MYSTERY-BOX", qty: 1, unitPriceMinor: 3_000 }],
            claimedTotalMinor: 3_000,
          },
        },
      ],
    },
    attack: [{ do: "accept", proposal: "o1" }],
    expect: {
      outcome: { accepted: false, reasonCodes: ["CATEGORY_UNKNOWN", "PRICE_NOT_IN_CATALOG"] },
      txStates: [],
      audit: refusedAcceptance(["CATEGORY_UNKNOWN", "PRICE_NOT_IN_CATALOG"]),
    },
  },
  {
    id: "CAT-04",
    category: "CATEGORY_MISMATCH",
    title: "A basket mixing an allowed compute line with a storage line",
    goal: "Hide a forbidden item inside an allowed purchase.",
    initial: {
      steps: [
        OPEN,
        {
          do: "offer",
          as: "o1",
          offer: {
            lines: [
              { sku: "GPU-MINI", qty: 1, unitPriceMinor: 4_000 },
              { sku: "STORE-100", qty: 1, unitPriceMinor: 2_000 },
            ],
            claimedTotalMinor: 6_000,
          },
        },
      ],
    },
    attack: [{ do: "accept", proposal: "o1" }],
    expect: {
      outcome: { accepted: false, reasonCodes: ["CATEGORY_NOT_ALLOWED"] },
      txStates: [],
      audit: refusedAcceptance(["CATEGORY_NOT_ALLOWED"]),
    },
  },
  {
    id: "CAT-05",
    category: "CATEGORY_MISMATCH",
    title: "Hostile seller swaps the category label",
    goal: "Get the buyer agent to treat a different category as the requested one.",
    initial: { steps: [] },
    attack: [{ do: "agentRun", script: "CATEGORY_SWAP" }],
    expect: {
      outcome: { agentStatus: "NO_DEAL", authority: "ADVISORY_ONLY" },
      txStates: [],
      audit: [],
    },
  },
];

export const CHANGED_AGREEMENT: Scenario[] = [
  {
    id: "CHG-01",
    category: "CHANGED_AGREEMENT",
    title: "Approved at one seller, switched to another seller's cheaper offer",
    goal: "Keep the approval while the payee and price change.",
    initial: { steps: [...APPROVED_80] },
    attack: [
      offerAt(7_500, "o2", { seller: "seller_other" }),
      { do: "accept", proposal: "o2" },
      { do: "pay", op: "start" },
    ],
    expect: {
      outcome: { verdict: "DENY", reasonCodes: ["APPROVAL_REQUIRED"], paymentState: "AGREED" },
      txStates: ["CANCELLED", "AGREED"],
      audit: [
        { type: "AGREEMENT_RETIRED", payload: { to: "INVALIDATED", approvalInvalidated: true } },
        { type: "AGREEMENT_CREATED", payload: { version: 2, totalMinor: 7_500 } },
        {
          type: "PAYMENT_POLICY_DENIED",
          payload: { subject: "CREATE_ORDER", reasonCodes: ["APPROVAL_REQUIRED"] },
        },
      ],
      forbidAudit: ["PAYPAL_ORDER_OBSERVED"],
    },
  },
  {
    id: "CHG-02",
    category: "CHANGED_AGREEMENT",
    title: "Approved at 80.00, the same seller cuts the price to 70.00",
    goal: "Reuse an approval for different terms.",
    initial: { steps: [...APPROVED_80] },
    attack: [offerAt(7_000, "o2"), { do: "accept", proposal: "o2" }, { do: "pay", op: "start" }],
    expect: {
      outcome: { verdict: "DENY", reasonCodes: ["APPROVAL_REQUIRED"] },
      txStates: ["CANCELLED", "AGREED"],
      audit: [
        { type: "AGREEMENT_RETIRED", payload: { approvalInvalidated: true } },
        { type: "PAYMENT_POLICY_DENIED", payload: { reasonCodes: ["APPROVAL_REQUIRED"] } },
      ],
    },
  },
  {
    id: "CHG-03",
    category: "CHANGED_AGREEMENT",
    title: "A cheaper revision is submitted first; payment starts; then it is accepted",
    goal: "Change the agreement after the order already exists at PayPal.",
    initial: { steps: [...APPROVED_80, offerAt(7_000, "o2"), { do: "pay", op: "start" }] },
    attack: [{ do: "accept", proposal: "o2" }],
    expect: {
      outcome: { ok: false, error: "CONFLICT" },
      txStates: ["ORDER_CREATED"],
      audit: [],
      forbidAudit: ["AGREEMENT_RETIRED", "AGREEMENT_CREATED"],
    },
  },
  {
    id: "CHG-04",
    category: "CHANGED_AGREEMENT",
    title: "A new offer is submitted while the funds are on hold",
    goal: "Open a second set of terms once money is reserved.",
    initial: { steps: [...ON_HOLD] },
    attack: [offerAt(9_500, "o2")],
    expect: {
      outcome: { ok: false, error: "CONFLICT" },
      txStates: ["AUTHORIZED"],
      audit: [],
      forbidAudit: ["OFFER_RECORDED"],
    },
  },
  {
    id: "CHG-05",
    category: "CHANGED_AGREEMENT",
    title: "Accepting a revision is refused, then capture charges only the agreed 80.00",
    goal: "Capture an amount different from the agreement.",
    initial: { steps: [...APPROVED_80, offerAt(7_000, "o2"), { do: "pay", op: "start" }] },
    attack: [
      { do: "accept", proposal: "o2" },
      { do: "paypal", buyerApproves: true },
      { do: "pay", op: "authorize" },
      { do: "pay", op: "capture" },
    ],
    expect: {
      outcome: { performed: true, paymentState: "CAPTURED" },
      txStates: ["CAPTURED"],
      capturedMinor: 8_000,
      paypalCalls: ["authorizeOrder", "captureAuthorization"],
      audit: [{ type: "TX_STATE_CHANGED", payload: { to: "CAPTURED" } }],
    },
  },
  {
    id: "CHG-06",
    category: "CHANGED_AGREEMENT",
    title: "Re-sending identical terms to look like a new agreement",
    goal: "Reset the approval by resubmitting the same terms.",
    initial: { steps: [...APPROVED_80, { do: "offer", as: "o2" }] },
    attack: [{ do: "accept", proposal: "o2" }],
    expect: {
      outcome: { ok: false, error: "CONFLICT" },
      txStates: ["AGREED"],
      audit: [],
      forbidAudit: ["AGREEMENT_RETIRED", "AGREEMENT_CREATED"],
    },
  },
  {
    id: "CHG-07",
    category: "CHANGED_AGREEMENT",
    title: "Capture check: the offer's terms no longer match what was agreed",
    goal: "Capture under an agreement whose terms hash was altered.",
    initial: { steps: [] },
    attack: [
      { do: "policy", subject: "CAPTURE", patch: [["agreement.termsHash", "f".repeat(64)]] },
    ],
    expect: {
      outcome: { verdict: "DENY", subject: "CAPTURE", reasonCodes: ["TERMS_HASH_MISMATCH"] },
      txStates: [],
      audit: [],
    },
  },
  {
    id: "CHG-08",
    category: "CHANGED_AGREEMENT",
    title: "Capture check: the agreement belongs to a different offer",
    goal: "Attach a stranger's agreement to this transaction.",
    initial: { steps: [] },
    attack: [{ do: "policy", subject: "CAPTURE", patch: [["agreement.offerId", "off_stranger"]] }],
    expect: {
      outcome: { verdict: "DENY", subject: "CAPTURE", reasonCodes: ["AGREEMENT_MISMATCH"] },
      txStates: [],
      audit: [],
    },
  },
  {
    id: "CHG-09",
    category: "CHANGED_AGREEMENT",
    title: "Editing the stored agreement price directly in the database",
    goal: "Lower or raise the agreed price behind the application's back.",
    initial: { steps: [...AGREED_80] },
    attack: [{ do: "sql", sql: "UPDATE agreements SET total_minor = 100" }],
    expect: {
      outcome: {
        ok: false,
        error: "REFUSED_BY_DATABASE_OR_CODE",
        messageIncludes: "agreements are immutable",
      },
      txStates: ["AGREED"],
      audit: [],
      rows: [{ sql: "SELECT total_minor FROM agreements", equals: 8_000 }],
    },
  },
  {
    id: "CHG-10",
    category: "CHANGED_AGREEMENT",
    title: "Editing the accepted offer's terms directly in the database",
    goal: "Rewrite what the seller offered after acceptance.",
    initial: { steps: [...AGREED_80] },
    attack: [{ do: "sql", sql: "UPDATE offers SET claimed_total_minor = 1" }],
    expect: {
      outcome: {
        ok: false,
        error: "REFUSED_BY_DATABASE_OR_CODE",
        messageIncludes: "offer terms are immutable",
      },
      txStates: ["AGREED"],
      audit: [],
    },
  },
];
