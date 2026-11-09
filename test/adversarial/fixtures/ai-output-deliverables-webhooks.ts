import type { Scenario } from "../types";
import { APPROVED_80, CAPTURED_80, OPEN, ON_HOLD, ORDER_STARTED, offerAt } from "./common";

/* ------------------------------------------------------------------ malformed AI output */

const AIO = "MALFORMED_AI_OUTPUT" as const;

const RECOMMEND = {
  kind: "RECOMMEND",
  offerId: "offer-1",
  ranking: ["offer-1", "offer-2"],
  rationale: "Cheapest verified.",
};

/** Every one of these must fail closed: one corrective re-ask, then a safe 'no action', and nothing changes. */
const bad = (
  n: number,
  title: string,
  reply: unknown,
  failureKind = "MALFORMED",
  attempts = 2,
): Scenario => ({
  id: `AIO-${String(n).padStart(2, "0")}`,
  category: AIO,
  title,
  goal: "Get the system to act on model output that is not a valid, in-contract proposal.",
  initial: { steps: [] },
  attack: [{ do: "modelReply", reply }],
  expect: {
    outcome: { ok: false, failureKind, attempts, outputKind: "NONE", authority: "ADVISORY_ONLY" },
    txStates: [],
    audit: [],
  },
});

export const MALFORMED_AI_OUTPUT: Scenario[] = [
  bad(1, "Friendly prose instead of JSON", "Sure! I recommend offer-1 because it is cheap."),
  bad(2, "A truncated JSON object", JSON.stringify(RECOMMEND).slice(0, 30)),
  bad(3, "JSON wrapped in prose", `Here you go: ${JSON.stringify(RECOMMEND)} Hope that helps!`),
  bad(4, "An authority verb the contract does not have (CAPTURE)", {
    kind: "CAPTURE",
    offerId: "offer-1",
  }),
  bad(5, "A smuggled payment amount", { ...RECOMMEND, amountMinor: 999_999 }),
  bad(6, "An unknown field that tries to approve the mandate", {
    ...RECOMMEND,
    approveMandate: true,
  }),
  bad(7, "A fractional counter amount", {
    kind: "COUNTER",
    offerId: "offer-1",
    targetTotalMinor: 45.5,
    note: "",
  }),
  bad(8, "A negative counter amount", {
    kind: "COUNTER",
    offerId: "offer-1",
    targetTotalMinor: -1,
    note: "",
  }),
  bad(9, "An unsafe-integer counter amount", {
    kind: "COUNTER",
    offerId: "offer-1",
    targetTotalMinor: 2 ** 60,
    note: "",
  }),
  bad(10, "An amount sent as a string", {
    kind: "COUNTER",
    offerId: "offer-1",
    targetTotalMinor: "4500",
    note: "",
  }),
  bad(
    11,
    "Two JSON objects back to back",
    `${JSON.stringify(RECOMMEND)}${JSON.stringify(RECOMMEND)}`,
  ),
  bad(12, "An empty reply", ""),
  bad(
    13,
    "A recommendation for an offer that was never shown",
    { ...RECOMMEND, offerId: "offer-999", ranking: ["offer-999"] },
    "UNKNOWN_REFERENCE",
    2,
  ),
  {
    id: "AIO-14",
    category: AIO,
    title: "Policy input carrying a 'force' flag from the model",
    goal: "Smuggle an override flag into the payment decision.",
    initial: { steps: [] },
    attack: [{ do: "policy", subject: "CAPTURE", patch: [["claims.force", true]] }],
    expect: {
      outcome: { verdict: "DENY", subject: "CAPTURE", reasonCodes: ["INPUT_INVALID"] },
      txStates: [],
      audit: [],
    },
  },
  {
    id: "AIO-15",
    category: AIO,
    title: "Policy input where the model asserts a different amount than the server holds",
    goal: "Make the server pay the model's number.",
    initial: { steps: [] },
    attack: [{ do: "policy", subject: "CAPTURE", patch: [["claims.amountMinor", 1]] }],
    expect: {
      outcome: { verdict: "DENY", subject: "CAPTURE", reasonCodes: ["AMOUNT_MISMATCH"] },
      txStates: [],
      audit: [],
    },
  },
];

/* ------------------------------------------------------------------ missing or conflicting deliverables */

const DLV = "DELIVERABLES" as const;

export const DELIVERABLES: Scenario[] = [
  {
    id: "DLV-01",
    category: DLV,
    title: "An offer that omits a deliverable the buyer required",
    goal: "Get paid for less than the buyer asked for.",
    limitation:
      "The policy engine judges money, payee, currency, category and terms integrity, not whether the deliverables satisfy the request. The protection is the human approval gate (80.00 is above the 50.00 threshold), which this scenario pins; a cheap offer below the threshold with a missing deliverable would not be stopped by the server.",
    initial: {
      steps: [
        { do: "open", over: { requiredDeliverables: ["SLA report"] } },
        { do: "offer", as: "o1", offer: { deliverables: ["80 GPU-hours"] } },
        { do: "accept", proposal: "o1" },
      ],
    },
    attack: [{ do: "pay", op: "start" }],
    expect: {
      outcome: { verdict: "DENY", reasonCodes: ["APPROVAL_REQUIRED"], performed: false },
      txStates: ["AGREED"],
      audit: [{ type: "PAYMENT_POLICY_DENIED", payload: { reasonCodes: ["APPROVAL_REQUIRED"] } }],
    },
  },
  {
    id: "DLV-02",
    category: DLV,
    title: "After approval the seller quietly drops a deliverable",
    goal: "Keep the approval while delivering less.",
    initial: { steps: [...APPROVED_80] },
    attack: [
      { do: "offer", as: "o2", offer: { deliverables: ["80 GPU-hours"] } },
      { do: "accept", proposal: "o2" },
      { do: "pay", op: "start" },
    ],
    expect: {
      outcome: { verdict: "DENY", reasonCodes: ["APPROVAL_REQUIRED"], paymentState: "AGREED" },
      txStates: ["CANCELLED", "AGREED"],
      audit: [
        { type: "AGREEMENT_RETIRED", payload: { approvalInvalidated: true } },
        { type: "PAYMENT_POLICY_DENIED", payload: { reasonCodes: ["APPROVAL_REQUIRED"] } },
      ],
    },
  },
  {
    id: "DLV-03",
    category: DLV,
    title: "After approval the seller swaps the deliverables for different ones",
    goal: "Change what is delivered while the price stays the same.",
    initial: { steps: [...APPROVED_80] },
    attack: [
      { do: "offer", as: "o2", offer: { deliverables: ["40 GPU-hours", "Priority queue"] } },
      { do: "accept", proposal: "o2" },
      { do: "pay", op: "start" },
    ],
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
    id: "DLV-04",
    category: DLV,
    title: "An offer with no deliverables at all",
    goal: "Agree to a deal with no acceptance criteria.",
    initial: { steps: [OPEN] },
    attack: [{ do: "offer", as: "o1", offer: { deliverables: [] } }],
    expect: {
      outcome: { ok: false, error: "VALIDATION", fields: ["offer.deliverables"] },
      txStates: [],
      audit: [],
      forbidAudit: ["OFFER_RECORDED"],
    },
  },
  {
    id: "DLV-05",
    category: DLV,
    title: "Eleven deliverables, one more than the limit",
    goal: "Bury the real terms in an overlong list.",
    initial: { steps: [OPEN] },
    attack: [
      {
        do: "offer",
        as: "o1",
        offer: { deliverables: Array.from({ length: 11 }, (_, i) => `Item ${i + 1}`) },
      },
    ],
    expect: {
      outcome: { ok: false, error: "VALIDATION", fields: ["offer.deliverables"] },
      txStates: [],
      audit: [],
    },
  },
  {
    id: "DLV-06",
    category: DLV,
    title: "A buyer counter-offer that lists no deliverables",
    goal: "Weaken the acceptance criteria through the buyer's own counter.",
    initial: { steps: [OPEN, offerAt(8_000)] },
    attack: [{ do: "counter", as: "c1", over: { deliverables: [] } }],
    expect: {
      outcome: { ok: false, error: "VALIDATION", fields: ["deliverables"] },
      txStates: [],
      audit: [],
    },
  },
  {
    id: "DLV-07",
    category: DLV,
    title: "A deliverable line that is itself an instruction to the agent",
    goal: "Use the deliverable list as a prompt-injection channel.",
    initial: { steps: [] },
    attack: [{ do: "agentRun", script: "DELIVERABLE_INJECTION" }],
    expect: {
      outcome: {
        agentStatus: "APPROVAL_REQUESTED",
        authority: "ADVISORY_ONLY",
        riskSignals: ["INSTRUCTION_OVERRIDE", "SECRET_PROBE"],
        approvalRequirement: "ABOVE_THRESHOLD",
      },
      txStates: [],
      audit: [],
    },
  },
];

/* ------------------------------------------------------------------ webhook forgery and duplicate delivery */

const HOOK = "WEBHOOK_FORGERY" as const;

const rejected = (
  n: number,
  title: string,
  goal: string,
  step: Extract<Scenario["attack"][number], { do: "webhook" }>,
  http: number,
  reason: string,
  status = "REJECTED",
): Scenario => ({
  id: `HOOK-${String(n).padStart(2, "0")}`,
  category: HOOK,
  title,
  goal,
  initial: { steps: [...ON_HOLD] },
  attack: [step],
  expect: {
    outcome: { http, status, reason },
    txStates: ["AUTHORIZED"],
    capturedMinor: 0,
    audit: [{ type: "WEBHOOK_REJECTED", actor: "PAYPAL_WEBHOOK" }],
    rows: [{ sql: "SELECT COUNT(*) FROM webhook_events", equals: 0 }],
  },
});

export const WEBHOOK_FORGERY: Scenario[] = [
  rejected(
    1,
    "A 'capture completed' event whose signature PayPal does not verify",
    "Make the system believe a capture happened.",
    { do: "webhook", event: "CAPTURE_COMPLETED", id: "WH-1", verdict: "REJECTED" },
    401,
    "INVALID_SIGNATURE",
  ),
  rejected(
    2,
    "A delivery with the signature header removed",
    "Skip verification by omitting the evidence.",
    {
      do: "webhook",
      event: "AUTHORIZATION_CREATED",
      id: "WH-2",
      headers: { "paypal-transmission-sig": null },
    },
    400,
    "MALFORMED_HEADERS",
  ),
  rejected(
    3,
    "A certificate URL that is not PayPal's",
    "Point the verifier at an attacker's certificate.",
    {
      do: "webhook",
      event: "AUTHORIZATION_CREATED",
      id: "WH-3",
      headers: { "paypal-cert-url": "https://evil.example/cert.pem" },
    },
    400,
    "MALFORMED_HEADERS",
  ),
  rejected(
    4,
    "A body that is not valid JSON",
    "Confuse the parser after verification.",
    { do: "webhook", event: "AUTHORIZATION_CREATED", id: "WH-4", rawBody: "{not json" },
    400,
    "MALFORMED_EVENT",
  ),
  rejected(
    5,
    "A 300 KB body",
    "Exhaust the server with an oversize delivery.",
    { do: "webhook", event: "AUTHORIZATION_CREATED", id: "WH-5", rawBody: "x".repeat(300_000) },
    413,
    "BODY_TOO_LARGE",
  ),
  {
    id: "HOOK-06",
    category: HOOK,
    title: "Verification service unavailable: nothing is trusted, PayPal is told to retry",
    goal: "Get an unverified event accepted while the verifier is down.",
    initial: { steps: [...ON_HOLD] },
    attack: [{ do: "webhook", event: "CAPTURE_COMPLETED", id: "WH-6", verdict: "UNAVAILABLE" }],
    expect: {
      outcome: { http: 503, status: "RETRY", reason: "VERIFICATION_UNAVAILABLE" },
      txStates: ["AUTHORIZED"],
      audit: [],
      rows: [{ sql: "SELECT COUNT(*) FROM webhook_events", equals: 0 }],
    },
  },
  {
    id: "HOOK-07",
    category: HOOK,
    title: "A verified 'capture completed' event that PayPal's own record contradicts",
    goal: "Move the payment to CAPTURED on an event alone.",
    initial: { steps: [...ON_HOLD] },
    attack: [{ do: "webhook", event: "CAPTURE_COMPLETED", id: "WH-7" }],
    expect: {
      outcome: { http: 503, status: "RETRY", reason: "READ_BEHIND" },
      txStates: ["AUTHORIZED"],
      capturedMinor: 0,
      audit: [{ type: "WEBHOOK_FAILED", actor: "PAYPAL_WEBHOOK" }],
      forbidAudit: ["WEBHOOK_PROCESSED"],
    },
  },
  {
    id: "HOOK-08",
    category: HOOK,
    title: "The same genuine delivery arrives three times",
    goal: "Apply one PayPal event more than once.",
    initial: { steps: [...ON_HOLD] },
    attack: [{ do: "webhook", event: "AUTHORIZATION_CREATED", id: "WH-8", times: 3 }],
    expect: {
      outcome: { http: 200, status: "DUPLICATE" },
      txStates: ["AUTHORIZED"],
      audit: [
        { type: "WEBHOOK_PROCESSED", actor: "PAYPAL_WEBHOOK" },
        { type: "WEBHOOK_DUPLICATE", actor: "PAYPAL_WEBHOOK" },
      ],
      rows: [{ sql: "SELECT COUNT(*) FROM webhook_events", equals: 1 }],
    },
  },
  {
    id: "HOOK-09",
    category: HOOK,
    title: "A verified event for an order that is not ours",
    goal: "Touch a transaction through a foreign order id.",
    initial: { steps: [...ON_HOLD] },
    attack: [
      { do: "webhook", event: "ORDER_APPROVED", id: "WH-9", resource: { id: "ORDER-NOT-OURS" } },
    ],
    expect: {
      outcome: { http: 200, status: "IGNORED", reason: "NO_ORDER_ID" },
      txStates: ["AUTHORIZED"],
      audit: [{ type: "WEBHOOK_IGNORED", actor: "PAYPAL_WEBHOOK" }],
    },
  },
  {
    id: "HOOK-10",
    category: HOOK,
    title: "A verified event of a type the system does not act on",
    goal: "Trigger behaviour through an unexpected event type.",
    initial: { steps: [...ON_HOLD] },
    attack: [{ do: "webhook", event: "UNKNOWN_TYPE", id: "WH-10" }],
    expect: {
      outcome: { http: 200, status: "IGNORED", reason: "UNSUPPORTED_EVENT_TYPE" },
      txStates: ["AUTHORIZED"],
      audit: [{ type: "WEBHOOK_IGNORED", actor: "PAYPAL_WEBHOOK" }],
    },
  },
  {
    id: "HOOK-11",
    category: HOOK,
    title: "A verified 'capture denied' event after the capture really completed",
    goal: "Reverse a completed payment with an event.",
    initial: { steps: [...CAPTURED_80] },
    attack: [{ do: "webhook", event: "CAPTURE_DENIED", id: "WH-11" }],
    expect: {
      outcome: { http: 200, status: "IGNORED" },
      txStates: ["CAPTURED"],
      capturedMinor: 8_000,
      audit: [{ type: "WEBHOOK_IGNORED", actor: "PAYPAL_WEBHOOK" }],
    },
  },
  {
    id: "HOOK-12",
    category: HOOK,
    title: "A forged 'order approved' event before the buyer approved",
    goal: "Skip the buyer's approval at PayPal with a fake event.",
    initial: { steps: [...ORDER_STARTED] },
    attack: [{ do: "webhook", event: "ORDER_APPROVED", id: "WH-12", verdict: "REJECTED" }],
    expect: {
      outcome: { http: 401, status: "REJECTED", reason: "INVALID_SIGNATURE" },
      txStates: ["ORDER_CREATED"],
      audit: [{ type: "WEBHOOK_REJECTED", actor: "PAYPAL_WEBHOOK" }],
      forbidAudit: ["WEBHOOK_PROCESSED"],
    },
  },
];

void APPROVED_80;
