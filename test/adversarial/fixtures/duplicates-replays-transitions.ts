import type { Scenario } from "../types";
import {
  AGREED_80,
  APPROVED_80,
  BUYER_APPROVED,
  CAPTURED_80,
  OPEN,
  ON_HOLD,
  ORDER_STARTED,
  offerAt,
} from "./common";

/* ------------------------------------------------------------------ duplicate transaction requests */

const DUP = "DUPLICATE_REQUEST" as const;

export const DUPLICATE_REQUEST: Scenario[] = [
  {
    id: "DUP-01",
    category: DUP,
    title: "The same offer is accepted twice",
    goal: "Create two agreements (two charges) from one offer.",
    initial: { steps: [...AGREED_80] },
    attack: [{ do: "accept", proposal: "o1" }],
    expect: {
      outcome: { ok: false, error: "CONFLICT" },
      txStates: ["AGREED"],
      audit: [],
      forbidAudit: ["AGREEMENT_CREATED"],
      rows: [{ sql: "SELECT COUNT(*) FROM agreements", equals: 1 }],
    },
  },
  {
    id: "DUP-02",
    category: DUP,
    title: "Start-payment is sent twice (a double click)",
    goal: "Create two PayPal orders for one agreement.",
    initial: { steps: [...ORDER_STARTED] },
    attack: [{ do: "pay", op: "start" }],
    expect: {
      outcome: { performed: false, paymentState: "ORDER_CREATED" },
      txStates: ["ORDER_CREATED"],
      audit: [],
    },
  },
  {
    id: "DUP-03",
    category: DUP,
    title: "Authorize is sent twice",
    goal: "Place two holds for one agreement.",
    initial: { steps: [...ON_HOLD] },
    attack: [{ do: "pay", op: "authorize" }],
    expect: {
      outcome: { performed: false, paymentState: "AUTHORIZED" },
      txStates: ["AUTHORIZED"],
      audit: [],
    },
  },
  {
    id: "DUP-04",
    category: DUP,
    title: "Capture is sent twice",
    goal: "Charge the buyer twice.",
    initial: { steps: [...CAPTURED_80] },
    attack: [{ do: "pay", op: "capture" }],
    expect: {
      outcome: { performed: false, paymentState: "CAPTURED" },
      txStates: ["CAPTURED"],
      capturedMinor: 8_000,
      audit: [],
    },
  },
  {
    id: "DUP-05",
    category: DUP,
    title: "Void is sent twice",
    goal: "Release a hold twice, or race a release against a capture.",
    initial: { steps: [...ON_HOLD, { do: "pay", op: "void" }] },
    attack: [{ do: "pay", op: "void" }],
    expect: {
      outcome: { performed: false, paymentState: "VOIDED" },
      txStates: ["VOIDED"],
      audit: [],
    },
  },
  {
    id: "DUP-06",
    category: DUP,
    title: "The same 80.00 purchase is made a second time under an 80.00 budget",
    goal: "Spend the same budget twice through a second negotiation.",
    initial: {
      mandate: { capMinor: 8_000, budgetMinor: 8_000 },
      steps: [...AGREED_80, { do: "open", neg: "again" }, { do: "offer", as: "o2", neg: "again" }],
    },
    attack: [{ do: "accept", proposal: "o2", neg: "again" }],
    expect: {
      outcome: { accepted: false, reasonCodes: ["OVER_TOTAL_BUDGET"] },
      txStates: ["AGREED"],
      audit: [{ type: "POLICY_DENIED", payload: { reasonCodes: ["OVER_TOTAL_BUDGET"] } }],
    },
  },
  {
    id: "DUP-07",
    category: DUP,
    title: "Capture check while another capture attempt is in flight",
    goal: "Race two captures against each other.",
    initial: { steps: [] },
    attack: [{ do: "policy", subject: "CAPTURE", patch: [["attempts.liveForSubject", true]] }],
    expect: {
      outcome: { verdict: "DENY", subject: "CAPTURE", reasonCodes: ["DUPLICATE_ATTEMPT"] },
      txStates: [],
      audit: [],
    },
  },
  {
    id: "DUP-08",
    category: DUP,
    title: "Capture check after a capture already succeeded",
    goal: "Capture a second time against the same authorization.",
    initial: { steps: [] },
    attack: [{ do: "policy", subject: "CAPTURE", patch: [["attempts.captureSucceeded", true]] }],
    expect: {
      outcome: { verdict: "DENY", subject: "CAPTURE", reasonCodes: ["DUPLICATE_CAPTURE"] },
      txStates: [],
      audit: [],
    },
  },
];

/* ------------------------------------------------------------------ replay of previously valid actions */

const REP = "REPLAY" as const;

export const REPLAY: Scenario[] = [
  {
    id: "REP-01",
    category: REP,
    title: "Replaying the acceptance of an offer that a newer agreement replaced",
    goal: "Roll the deal back to an older, already-superseded version.",
    initial: { steps: [...AGREED_80, offerAt(7_000, "o2"), { do: "accept", proposal: "o2" }] },
    attack: [{ do: "accept", proposal: "o1" }],
    expect: {
      outcome: { ok: false, error: "CONFLICT" },
      txStates: ["CANCELLED", "AGREED"],
      audit: [],
      forbidAudit: ["AGREEMENT_CREATED"],
      rows: [
        { sql: "SELECT total_minor FROM agreements ORDER BY rowid DESC LIMIT 1", equals: 7_000 },
      ],
    },
  },
  {
    id: "REP-02",
    category: REP,
    title: "Replaying the operator's approval",
    goal: "Record a second approval, or an approval after the fact.",
    initial: { steps: [...APPROVED_80] },
    attack: [{ do: "approve" }],
    expect: {
      outcome: { ok: false, error: "CONFLICT" },
      txStates: ["AGREED"],
      audit: [],
      forbidAudit: ["TX_APPROVAL_RECORDED"],
      rows: [{ sql: "SELECT COUNT(*) FROM transaction_approvals", equals: 1 }],
    },
  },
  {
    id: "REP-03",
    category: REP,
    title: "Replaying a capture request after the hold was released",
    goal: "Capture funds that were already voided.",
    initial: { steps: [...ON_HOLD, { do: "pay", op: "void" }] },
    attack: [{ do: "pay", op: "capture" }],
    expect: {
      outcome: { ok: false, error: "CONFLICT" },
      txStates: ["VOIDED"],
      audit: [],
    },
  },
  {
    id: "REP-04",
    category: REP,
    title: "Replaying a webhook delivery that was already processed",
    goal: "Apply the same PayPal event twice.",
    initial: { steps: [...ON_HOLD] },
    attack: [{ do: "webhook", event: "AUTHORIZATION_CREATED", id: "WH-REP-1", times: 3 }],
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
    id: "REP-05",
    category: REP,
    title: "Replaying a captured-looking event id with different content",
    goal: "Reuse a known event id to smuggle in a different claim.",
    initial: {
      steps: [...ON_HOLD, { do: "webhook", event: "AUTHORIZATION_CREATED", id: "WH-REP-2" }],
    },
    attack: [
      {
        do: "webhook",
        event: "ORDER_APPROVED",
        id: "WH-REP-2",
        headers: { "paypal-transmission-id": "tr-other" },
      },
    ],
    expect: {
      outcome: { http: 409, status: "REJECTED", reason: "EVENT_ID_REUSED_WITH_DIFFERENT_CONTENT" },
      txStates: ["AUTHORIZED"],
      audit: [{ type: "WEBHOOK_REJECTED", actor: "PAYPAL_WEBHOOK" }],
    },
  },
  {
    id: "REP-06",
    category: REP,
    title: "Replaying a genuine old webhook after PayPal's redelivery window",
    goal: "Re-submit a captured delivery from days ago.",
    initial: { steps: [...ON_HOLD, { do: "clock", minutes: 60 * 24 * 6 }] },
    attack: [
      {
        do: "webhook",
        event: "AUTHORIZATION_CREATED",
        id: "WH-REP-3",
        headers: { "paypal-transmission-time": "2026-10-01T00:00:00.000Z" },
      },
    ],
    expect: {
      outcome: { http: 400, status: "REJECTED", reason: "TRANSMISSION_TIME_OUT_OF_RANGE" },
      txStates: ["AUTHORIZED"],
      audit: [{ type: "WEBHOOK_REJECTED", actor: "PAYPAL_WEBHOOK" }],
      rows: [{ sql: "SELECT COUNT(*) FROM webhook_events", equals: 0 }],
    },
  },
];

/* ------------------------------------------------------------------ invalid transaction-state transitions */

const TRN = "INVALID_TRANSITION" as const;

export const INVALID_TRANSITION: Scenario[] = [
  {
    id: "TRN-01",
    category: TRN,
    title: "Forcing AGREED straight to CAPTURED through the store",
    goal: "Skip order, approval, authorization and capture.",
    initial: { steps: [...AGREED_80] },
    attack: [{ do: "transition", to: "CAPTURED" }],
    expect: {
      outcome: {
        ok: false,
        error: "REFUSED_BY_DATABASE_OR_CODE",
        messageIncludes: "illegal state transition",
      },
      txStates: ["AGREED"],
      audit: [],
      forbidAudit: ["TX_STATE_CHANGED"],
    },
  },
  {
    id: "TRN-02",
    category: TRN,
    title: "Setting the state to CAPTURED with a direct database UPDATE",
    goal: "Mark a payment captured without a capture.",
    initial: { steps: [...AGREED_80] },
    attack: [{ do: "sql", sql: "UPDATE transactions SET state = 'CAPTURED'" }],
    expect: {
      outcome: { ok: false, error: "REFUSED_BY_DATABASE_OR_CODE" },
      txStates: ["AGREED"],
      audit: [],
      rows: [{ sql: "SELECT COUNT(*) FROM transactions WHERE state = 'CAPTURED'", equals: 0 }],
    },
  },
  {
    id: "TRN-03",
    category: TRN,
    title: "Bumping the version and state together, with no audit event behind it",
    goal: "Make a silent, unaudited state change.",
    initial: { steps: [...AGREED_80] },
    attack: [
      { do: "sql", sql: "UPDATE transactions SET state = 'CAPTURED', version = version + 1" },
    ],
    expect: {
      outcome: { ok: false, error: "REFUSED_BY_DATABASE_OR_CODE" },
      txStates: ["AGREED"],
      audit: [],
      rows: [{ sql: "SELECT COUNT(*) FROM transactions WHERE state = 'CAPTURED'", equals: 0 }],
    },
  },
  {
    id: "TRN-09",
    category: TRN,
    title: "A legal-looking state change (AGREED to CANCELLED) written with no audit event",
    goal: "Change a payment's state silently, so no trail explains it.",
    initial: { steps: [...AGREED_80] },
    attack: [
      { do: "sql", sql: "UPDATE transactions SET state = 'CANCELLED', version = version + 1" },
    ],
    expect: {
      outcome: {
        ok: false,
        error: "REFUSED_BY_DATABASE_OR_CODE",
        messageIncludes: "must reference a newer TX_STATE_CHANGED audit event",
      },
      txStates: ["AGREED"],
      audit: [],
      rows: [{ sql: "SELECT COUNT(*) FROM transactions WHERE state = 'CANCELLED'", equals: 0 }],
    },
  },
  {
    id: "TRN-04",
    category: TRN,
    title: "Capturing before any authorization exists",
    goal: "Charge from an order that was never authorized.",
    initial: { steps: [...ORDER_STARTED] },
    attack: [{ do: "pay", op: "capture" }],
    expect: {
      outcome: { ok: false, error: "CONFLICT" },
      txStates: ["ORDER_CREATED"],
      audit: [],
    },
  },
  {
    id: "TRN-05",
    category: TRN,
    title: "Voiding after the funds were captured",
    goal: "Undo or confuse a completed charge.",
    initial: { steps: [...CAPTURED_80] },
    attack: [{ do: "pay", op: "void" }],
    expect: {
      outcome: { ok: false, error: "CONFLICT" },
      txStates: ["CAPTURED"],
      capturedMinor: 8_000,
      audit: [],
    },
  },
  {
    id: "TRN-06",
    category: TRN,
    title: "Resurrecting a cancelled transaction",
    goal: "Move a CANCELLED transaction back to AGREED.",
    initial: { steps: [...AGREED_80, { do: "disapprove" }] },
    attack: [{ do: "transition", to: "AGREED" }],
    expect: {
      outcome: {
        ok: false,
        error: "REFUSED_BY_DATABASE_OR_CODE",
        messageIncludes: "illegal state transition",
      },
      txStates: ["CANCELLED"],
      audit: [],
    },
  },
  {
    id: "TRN-07",
    category: TRN,
    title: "Authorizing a payment that is parked for reconciliation",
    goal: "Carry on past an unexplained PayPal discrepancy.",
    initial: {
      steps: [
        ...APPROVED_80,
        { do: "paypal", set: { createAmountDelta: 4_000 } },
        { do: "pay", op: "start" },
      ],
    },
    attack: [
      { do: "paypal", buyerApproves: true },
      { do: "pay", op: "authorize" },
    ],
    expect: {
      outcome: { ok: false, error: "CONFLICT" },
      txStates: ["NEEDS_RECONCILIATION"],
      audit: [],
    },
  },
  {
    id: "TRN-08",
    category: TRN,
    title: "Capturing a payment that is parked for reconciliation",
    goal: "Charge while the amount PayPal holds is in doubt.",
    initial: {
      steps: [
        ...BUYER_APPROVED.slice(0, BUYER_APPROVED.length - 2),
        { do: "paypal", set: { createAmountDelta: 4_000 } },
        { do: "pay", op: "start" },
      ],
    },
    attack: [{ do: "pay", op: "capture" }],
    expect: {
      outcome: { ok: false, error: "CONFLICT" },
      txStates: ["NEEDS_RECONCILIATION"],
      audit: [],
    },
  },
];

void OPEN;
