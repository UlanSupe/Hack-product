import type { PolicyInput } from "../../domain/policy.ts";
import type {
  AttemptInfo,
  PaymentContext,
  PaymentOps,
  PaymentStore,
} from "../../ports/payment-store.ts";
import { appendAuditEvent } from "./audit.ts";
import { all, inTransaction, one, type Db } from "./database.ts";
import { createSqliteNegotiationStore } from "./negotiation-store.ts";
import {
  finishPaymentAttempt,
  recordPolicyDecision,
  retryPaymentAttempt,
  startPaymentAttempt,
  transitionTransaction,
} from "./store.ts";

type ContextRow = {
  negotiation_id: string;
  link_id: string;
  link_version: number;
  transaction_id: string;
  state: PaymentContext["txState"];
  version: number;
  reconciling_from: PaymentContext["reconcilingFrom"];
  agreement_id: string;
  total_minor: number;
  currency: string;
  payee_ref: string;
  mandate_id: string;
  mandate_version: number;
  paypal_order_id: string | null;
  paypal_authorization_id: string | null;
  authorized_minor: number | null;
  authorized_at: string | null;
  honor_expires_at: string | null;
  paypal_capture_id: string | null;
  captured_minor: number | null;
};

const CONTEXT_SQL = `
  SELECT l.negotiation_id, l.id AS link_id, l.version AS link_version, t.id AS transaction_id, t.state, t.version,
         t.reconciling_from, a.id AS agreement_id, a.total_minor, a.currency, a.payee_ref, t.mandate_id,
         t.mandate_version, t.paypal_order_id, t.paypal_authorization_id, t.authorized_minor, t.authorized_at,
         t.honor_expires_at, t.paypal_capture_id, t.captured_minor
    FROM negotiation_agreements l
    JOIN transactions t ON t.id = l.transaction_id
    JOIN agreements a ON a.id = l.agreement_id`;

const contextOf = (r: ContextRow): PaymentContext => ({
  negotiationId: r.negotiation_id,
  agreementLinkId: r.link_id,
  agreementVersion: r.link_version,
  transactionId: r.transaction_id,
  txState: r.state,
  txVersion: r.version,
  reconcilingFrom: r.reconciling_from,
  agreementId: r.agreement_id,
  totalMinor: r.total_minor,
  currency: r.currency,
  payeeRef: r.payee_ref,
  mandateId: r.mandate_id,
  mandateVersion: r.mandate_version,
  paypalOrderId: r.paypal_order_id,
  paypalAuthorizationId: r.paypal_authorization_id,
  authorizedMinor: r.authorized_minor,
  authorizedAt: r.authorized_at,
  honorExpiresAt: r.honor_expires_at,
  paypalCaptureId: r.paypal_capture_id,
  capturedMinor: r.captured_minor,
});

/**
 * SQLite implementation of the payment store. It adds no tables: it reads the agreement, transaction and approval rows
 * the negotiation workflow wrote, and writes through the same audited, constrained functions (state transitions are
 * compare-and-swap with an audit event; attempts are write-ahead with a derived request id).
 */
export function createSqlitePaymentStore(db: Db): PaymentStore {
  const negotiations = createSqliteNegotiationStore(db);

  const ops = (neg: Parameters<Parameters<typeof negotiations.transaction>[0]>[0]): PaymentOps => ({
    contextForNegotiation(negotiationId) {
      // Only the ACTIVE agreement version is ever payable: a retired one has a cancelled transaction anyway.
      const r = one<ContextRow>(
        db,
        `${CONTEXT_SQL} WHERE l.negotiation_id = ? AND l.status = 'ACTIVE'`,
        [negotiationId],
      );
      return r && contextOf(r);
    },

    contextForOrderId(paypalOrderId) {
      const r = one<ContextRow>(db, `${CONTEXT_SQL} WHERE t.paypal_order_id = ?`, [paypalOrderId]);
      return r && contextOf(r);
    },

    attempts(transactionId) {
      return all<{
        id: string;
        action: AttemptInfo["action"];
        seq: number;
        request_id: string;
        request_hash: string;
        status: AttemptInfo["status"];
        tries: number;
        http_status: number | null;
        paypal_debug_id: string | null;
        started_at: string;
      }>(
        db,
        "SELECT * FROM payment_attempts WHERE transaction_id = ? ORDER BY started_at, action, seq",
        [transactionId],
      ).map((r) => ({
        id: r.id,
        action: r.action,
        seq: r.seq,
        requestId: r.request_id,
        requestHash: r.request_hash,
        status: r.status,
        tries: r.tries,
        httpStatus: r.http_status,
        debugId: r.paypal_debug_id,
        startedAt: r.started_at,
      }));
    },

    policyInput({ subject, transactionId, now, actor, observed }): PolicyInput {
      // The eligibility builder reads every fact from stored rows; this only re-labels the subject and supplies the
      // (already server-verified) PayPal observation and the attempt counters for that subject.
      const base = neg.policyInputForEligibility({ transactionId, now, actor });
      const live = one<{ n: number }>(
        db,
        "SELECT COUNT(*) AS n FROM payment_attempts WHERE transaction_id = ? AND action = ? AND status <> 'FAILED_DEFINITE'",
        [transactionId, subject],
      );
      return {
        ...base,
        subject,
        observed,
        attempts: { ...base.attempts, liveForSubject: (live?.n ?? 0) > 0 },
      };
    },

    recordDecision(d) {
      recordPolicyDecision(db, d);
    },

    beginAttempt(a) {
      return startPaymentAttempt(db, a);
    },
    finishAttempt(a) {
      finishPaymentAttempt(db, {
        id: a.id,
        status: a.status,
        ...(a.httpStatus === undefined ? {} : { httpStatus: a.httpStatus }),
        ...(a.debugId === undefined ? {} : { paypalDebugId: a.debugId }),
        now: a.now,
      });
    },
    retryAttempt(id) {
      retryPaymentAttempt(db, id);
    },

    transition(a) {
      transitionTransaction(db, {
        id: a.transactionId,
        expectedVersion: a.expectedVersion,
        to: a.to,
        now: a.now,
        actor: a.actor,
        ...(a.patch === undefined ? {} : { patch: a.patch }),
        ...(a.details === undefined ? {} : { details: a.details }),
      });
    },

    audit(a) {
      appendAuditEvent(db, {
        ts: a.ts,
        actor: a.actor,
        type: a.type,
        subjectType: "transaction",
        subjectId: a.transactionId,
        transactionId: a.transactionId,
        payload: a.payload,
        ...(a.provenance ? { provenance: a.provenance } : {}),
      });
    },

    history(transactionId, limit) {
      return all<{ seq: number; ts: string; actor: string; type: string; payload: string }>(
        db,
        "SELECT seq, ts, actor, type, payload FROM (SELECT * FROM audit_events WHERE transaction_id = ? ORDER BY seq DESC LIMIT ?) ORDER BY seq",
        [transactionId, limit],
      );
    },

    latestAuditPayload(transactionId, type) {
      const r = one<{ payload: string }>(
        db,
        "SELECT payload FROM audit_events WHERE transaction_id = ? AND type = ? ORDER BY seq DESC LIMIT 1",
        [transactionId, type],
      );
      return r ? (JSON.parse(r.payload) as Record<string, unknown>) : undefined;
    },
  });

  return {
    transaction: (fn) => negotiations.transaction((neg) => inTransaction(db, () => fn(ops(neg)))),
  };
}
