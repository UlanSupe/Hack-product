import type {
  AttackRunFacts,
  AttemptFact,
  ChainFacts,
  DecisionFact,
  EventFact,
  RefusedOfferFacts,
  TransactionFacts,
  WebhookFact,
} from "../../domain/cockpit.ts";
import type { LiveFacts } from "../../ports/cockpit-source.ts";
import { verifyChain } from "./audit.ts";
import { all, type Db } from "./database.ts";

/**
 * Read-only queries for the Cockpit. Nothing here writes, and every value comes from a stored column: no sampling,
 * no estimation. Needs migration 0008 (audit provenance); the caller checks that first.
 */

const parseCodes = (json: string): string[] => {
  try {
    const v: unknown = JSON.parse(json);
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
};

function group<T extends { key: string }>(rows: readonly T[]): Map<string, T[]> {
  const m = new Map<string, T[]>();
  for (const r of rows) m.set(r.key, [...(m.get(r.key) ?? []), r]);
  return m;
}

export function readChain(db: Db): ChainFacts {
  try {
    const v = verifyChain(db);
    return v.status === "VERIFIED"
      ? { status: "VERIFIED", count: v.count }
      : { status: "FAILED", count: v.count, firstBadSeq: v.firstBadSeq, code: v.code };
  } catch (e) {
    return {
      status: "UNREADABLE",
      message: e instanceof Error ? e.message.slice(0, 160) : "unknown error",
    };
  }
}

export function readTransactions(db: Db): TransactionFacts[] {
  const txs = all<{
    id: string;
    state: string;
    created_at: string;
    updated_at: string;
    currency: string;
    mandate_id: string;
    mandate_version: number;
    paypal_order_id: string | null;
    authorized_minor: number | null;
    captured_minor: number | null;
    agreement_id: string | null;
    agreement_total: number | null;
    payee_ref: string | null;
    negotiation_id: string | null;
    agreement_version: number | null;
    category: string | null;
    claimed_total: number | null;
    server_total: number | null;
  }>(
    db,
    `SELECT t.id, t.state, t.created_at, t.updated_at, t.currency, t.mandate_id, t.mandate_version, t.paypal_order_id,
            t.authorized_minor, t.captured_minor, t.agreement_id,
            a.total_minor AS agreement_total, a.payee_ref,
            l.negotiation_id, l.version AS agreement_version, n.category,
            p.claimed_total_minor AS claimed_total, p.total_minor AS server_total
       FROM transactions t
       LEFT JOIN agreements a ON a.id = t.agreement_id
       LEFT JOIN negotiation_agreements l ON l.transaction_id = t.id
       LEFT JOIN negotiations n ON n.id = l.negotiation_id
       LEFT JOIN negotiation_proposals p ON p.id = l.proposal_id
      ORDER BY t.updated_at DESC, t.id`,
  );

  const decisions = group(
    all<{
      key: string;
      id: string;
      subject: string;
      verdict: "ALLOW" | "DENY";
      codes: string;
      at: string;
    }>(
      db,
      "SELECT transaction_id AS key, id, subject, verdict, reason_codes AS codes, decided_at AS at FROM policy_decisions",
    ),
  );
  const events = group(
    all<{
      key: string;
      seq: number;
      ts: string;
      type: string;
      actor: string;
      provenance: string | null;
    }>(
      db,
      "SELECT transaction_id AS key, seq, ts, type, actor, provenance FROM audit_events WHERE transaction_id IS NOT NULL ORDER BY seq",
    ),
  );
  const attempts = group(
    all<{
      key: string;
      action: string;
      seq: number;
      status: string;
      http: number | null;
      at: string;
    }>(
      db,
      "SELECT transaction_id AS key, action, seq, status, http_status AS http, started_at AS at FROM payment_attempts ORDER BY started_at, seq",
    ),
  );
  const webhooks = group(
    all<{ key: string; event: string; type: string; status: string; reason: string | null }>(
      db,
      "SELECT transaction_id AS key, paypal_event_id AS event, event_type AS type, status, reason FROM webhook_events WHERE transaction_id IS NOT NULL ORDER BY received_at",
    ),
  );
  const approvals = new Map(
    all<{ key: string; decision: "APPROVED" | "REJECTED"; at: string }>(
      db,
      "SELECT transaction_id AS key, decision, decided_at AS at FROM transaction_approvals",
    ).map((a) => [a.key, a]),
  );

  return txs.map((t): TransactionFacts => {
    const ap = approvals.get(t.id);
    return {
      txId: t.id,
      state: t.state,
      createdAt: t.created_at,
      updatedAt: t.updated_at,
      currency: t.currency,
      mandateId: t.mandate_id,
      mandateVersion: t.mandate_version,
      negotiationId: t.negotiation_id,
      category: t.category,
      proposedMinor: t.claimed_total ?? t.server_total,
      agreement:
        t.agreement_id !== null && t.agreement_total !== null
          ? {
              id: t.agreement_id,
              totalMinor: t.agreement_total,
              payeeRef: t.payee_ref ?? "",
              version: t.agreement_version,
            }
          : null,
      approval: ap ? { decision: ap.decision, decidedAt: ap.at } : null,
      paypalOrderId: t.paypal_order_id,
      authorizedMinor: t.authorized_minor,
      capturedMinor: t.captured_minor,
      decisions: (decisions.get(t.id) ?? []).map((d): DecisionFact => ({
        id: d.id,
        subject: d.subject,
        verdict: d.verdict,
        reasonCodes: parseCodes(d.codes),
        decidedAt: d.at,
      })),
      events: (events.get(t.id) ?? []).map((e): EventFact => ({
        seq: e.seq,
        ts: e.ts,
        type: e.type,
        actor: e.actor,
        provenance: e.provenance,
      })),
      attempts: (attempts.get(t.id) ?? []).map((a): AttemptFact => ({
        action: a.action,
        seq: a.seq,
        status: a.status,
        httpStatus: a.http,
        startedAt: a.at,
      })),
      webhooks: (webhooks.get(t.id) ?? []).map((w): WebhookFact => ({
        paypalEventId: w.event,
        eventType: w.type,
        status: w.status,
        reason: w.reason,
      })),
    };
  });
}

/** Refusals of an offer: a policy DENY on ACCEPT_OFFER. No transaction exists for these, which is why they get their own rows. */
export function readRefusedOffers(db: Db): RefusedOfferFacts[] {
  const rows = all<{
    id: string;
    negotiation_id: string;
    proposal_id: string;
    decided_at: string;
    reason_codes: string;
    policy_version: string;
    actor: string;
    explanation: string;
    category: string | null;
    currency: string;
    claimed_total: number | null;
    server_total: number | null;
  }>(
    db,
    `SELECT c.id, c.negotiation_id, c.proposal_id, c.decided_at, c.reason_codes, c.policy_version, c.actor, c.explanation,
            n.category, n.currency, p.claimed_total_minor AS claimed_total, p.total_minor AS server_total
       FROM negotiation_policy_checks c
       JOIN negotiations n ON n.id = c.negotiation_id
       LEFT JOIN negotiation_proposals p ON p.id = c.proposal_id
      WHERE c.verdict = 'DENY' AND c.subject = 'ACCEPT_OFFER' AND c.proposal_id IS NOT NULL
      ORDER BY c.decided_at DESC, c.id`,
  );
  return rows.map((r): RefusedOfferFacts => ({
    checkId: r.id,
    negotiationId: r.negotiation_id,
    proposalId: r.proposal_id,
    decidedAt: r.decided_at,
    category: r.category,
    currency: r.currency,
    proposedMinor: r.claimed_total ?? r.server_total,
    reasonCodes: parseCodes(r.reason_codes),
    policyVersion: r.policy_version,
    actor: r.actor,
    explanation: r.explanation,
    events: all<EventFact>(
      db,
      `SELECT seq, ts, type, actor, provenance FROM audit_events
        WHERE type = 'POLICY_DENIED' AND subject_id = ? ORDER BY seq`,
      [r.id],
    ),
  }));
}

export function readAttackRuns(db: Db): AttackRunFacts[] {
  const runs = all<{
    id: string;
    scenario_id: string;
    fixture_version: string;
    seed: string;
    mode: "UNSAFE_BASELINE" | "PROTECTED";
    provider: "SIMULATED" | "PAYPAL_SANDBOX";
    transaction_id: string | null;
    currency: string;
    mandate_cap_minor: number;
    money_moved_minor: number;
    invariants_violated: string;
    started_at: string;
    finished_at: string | null;
    audit_from_seq: number | null;
    audit_to_seq: number | null;
  }>(db, "SELECT * FROM attack_runs ORDER BY started_at DESC, id");
  const steps = group(
    all<{
      key: string;
      n: number;
      outcome: "EXECUTED" | "BLOCKED" | "NO_ACTION";
      codes: string | null;
    }>(
      db,
      `SELECT s.run_id AS key, s.n, s.outcome, d.reason_codes AS codes
         FROM attack_run_steps s LEFT JOIN policy_decisions d ON d.id = s.policy_decision_id ORDER BY s.run_id, s.n`,
    ),
  );
  return runs.map((r): AttackRunFacts => ({
    id: r.id,
    scenarioId: r.scenario_id,
    fixtureVersion: r.fixture_version,
    seed: r.seed,
    mode: r.mode,
    provider: r.provider,
    transactionId: r.transaction_id,
    currency: r.currency,
    mandateCapMinor: r.mandate_cap_minor,
    moneyMovedMinor: r.money_moved_minor,
    invariantsViolated: parseCodes(r.invariants_violated),
    startedAt: r.started_at,
    finishedAt: r.finished_at,
    auditFromSeq: r.audit_from_seq,
    auditToSeq: r.audit_to_seq,
    steps: (steps.get(r.id) ?? []).map((s) => ({
      n: s.n,
      outcome: s.outcome,
      reasonCodes: s.codes === null ? [] : parseCodes(s.codes),
    })),
  }));
}

export function readLiveFacts(db: Db): LiveFacts {
  return {
    transactions: readTransactions(db),
    refusedOffers: readRefusedOffers(db),
    attackRuns: readAttackRuns(db),
    chain: readChain(db),
  };
}
