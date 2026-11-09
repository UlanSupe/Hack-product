import type {
  AttackRunFacts,
  ChainFacts,
  RefusedOfferFacts,
  TransactionFacts,
} from "@/domain/cockpit";

/** Hand-built source records for the mapping tests. Every value is obvious by inspection. */

export const CHAIN_OK: ChainFacts = { status: "VERIFIED", count: 40 };
export const chainBrokenAt = (firstBadSeq: number): ChainFacts => ({
  status: "FAILED",
  count: 40,
  firstBadSeq,
  code: "HASH_MISMATCH",
});

export function tx(over: Partial<TransactionFacts> = {}): TransactionFacts {
  return {
    txId: "tx_1",
    state: "AGREED",
    createdAt: "2026-10-12T09:00:00.000Z",
    updatedAt: "2026-10-12T09:05:00.000Z",
    currency: "USD",
    mandateId: "M1",
    mandateVersion: 1,
    negotiationId: "neg_1",
    category: "COMPUTE",
    proposedMinor: 8_000,
    agreement: { id: "agr_1", totalMinor: 8_000, payeeRef: "payee_acme", version: 1 },
    approval: null,
    paypalOrderId: null,
    authorizedMinor: null,
    capturedMinor: null,
    decisions: [
      {
        id: "dec_1",
        subject: "ACCEPT_OFFER",
        verdict: "ALLOW",
        reasonCodes: [],
        decidedAt: "2026-10-12T09:01:00.000Z",
      },
    ],
    events: [
      {
        seq: 3,
        ts: "2026-10-12T09:01:00.000Z",
        type: "POLICY_ALLOWED",
        actor: "OPERATOR",
        provenance: "LOCAL_DECISION",
      },
      {
        seq: 4,
        ts: "2026-10-12T09:01:01.000Z",
        type: "TX_STATE_CHANGED",
        actor: "OPERATOR",
        provenance: "LOCAL_DECISION",
      },
    ],
    attempts: [],
    webhooks: [],
    ...over,
  };
}

export function refused(over: Partial<RefusedOfferFacts> = {}): RefusedOfferFacts {
  return {
    checkId: "chk_1",
    negotiationId: "neg_2",
    proposalId: "ofr_9",
    decidedAt: "2026-10-12T10:00:00.000Z",
    category: "COMPUTE",
    currency: "USD",
    proposedMinor: 45_000,
    reasonCodes: ["OVER_PER_TX_CAP", "PRICE_NOT_IN_CATALOG"],
    policyVersion: "pactpay-policy/1.1.0",
    actor: "AGENT",
    explanation: "Refused.",
    events: [
      {
        seq: 12,
        ts: "2026-10-12T10:00:00.000Z",
        type: "POLICY_DENIED",
        actor: "AGENT",
        provenance: "LOCAL_DECISION",
      },
    ],
    ...over,
  };
}

export function attackRun(over: Partial<AttackRunFacts> = {}): AttackRunFacts {
  return {
    id: "run_1",
    scenarioId: "S1",
    fixtureVersion: "arena-ab/1.0.0",
    seed: "s",
    mode: "PROTECTED",
    provider: "SIMULATED",
    transactionId: null,
    currency: "USD",
    mandateCapMinor: 10_000,
    moneyMovedMinor: 0,
    invariantsViolated: [],
    startedAt: "2026-10-12T11:00:00.000Z",
    finishedAt: "2026-10-12T11:00:05.000Z",
    auditFromSeq: null,
    auditToSeq: null,
    steps: [{ n: 1, outcome: "BLOCKED", reasonCodes: ["OVER_PER_TX_CAP"] }],
    ...over,
  };
}
