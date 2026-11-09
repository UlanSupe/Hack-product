import type { AuditProvenance } from "../domain/audit.ts";
import type { PolicyInput } from "../domain/policy.ts";
import type { InFlightState, TxState } from "../domain/transaction-states.ts";

/**
 * Persistence for the payment flow. Everything the payment service believes about WHAT to charge (amount, currency,
 * payee, agreement version, transaction identity) is read from here, from rows the negotiation workflow wrote and the
 * database constrains; nothing arrives from a browser. `transaction` is atomic and synchronous, so a policy decision,
 * the write-ahead attempt and the state change are one unit. Never call the payment provider inside it.
 */

export type PaymentContext = {
  negotiationId: string;
  agreementLinkId: string;
  agreementVersion: number;
  transactionId: string;
  txState: TxState;
  txVersion: number;
  reconcilingFrom: InFlightState | null;
  agreementId: string;
  totalMinor: number;
  currency: string;
  /** The logical payee the agreement names (from the seller catalog). */
  payeeRef: string;
  mandateId: string;
  mandateVersion: number;
  paypalOrderId: string | null;
  paypalAuthorizationId: string | null;
  authorizedMinor: number | null;
  authorizedAt: string | null;
  honorExpiresAt: string | null;
  paypalCaptureId: string | null;
  capturedMinor: number | null;
};

export type AttemptAction = "CREATE_ORDER" | "AUTHORIZE" | "CAPTURE" | "VOID";
export type AttemptStatus = "IN_FLIGHT" | "SUCCEEDED" | "FAILED_DEFINITE" | "UNKNOWN";

export type AttemptInfo = {
  id: string;
  action: AttemptAction;
  seq: number;
  /** The `PayPal-Request-Id` for this attempt. */
  requestId: string;
  requestHash: string;
  status: AttemptStatus;
  tries: number;
  httpStatus: number | null;
  debugId: string | null;
  startedAt: string;
};

export type ObservedForPolicy = { amountMinor: number; currency: string; payeeRef: string };

export type Patch = Partial<{
  paypalOrderId: string;
  paypalAuthorizationId: string;
  authorizedMinor: number;
  authorizedAt: string;
  honorExpiresAt: string;
  paypalCaptureId: string;
  capturedMinor: number;
}>;

export type HistoryRow = {
  seq: number;
  ts: string;
  actor: string;
  type: string;
  /** Canonical JSON of the audit payload. */
  payload: string;
};

export interface PaymentOps {
  contextForNegotiation(negotiationId: string): PaymentContext | undefined;
  contextForOrderId(paypalOrderId: string): PaymentContext | undefined;
  attempts(transactionId: string): AttemptInfo[];

  /** Policy facts for any payment subject, built from stored rows (the PayPal observation is the one supplied fact). */
  policyInput(args: {
    subject: AttemptAction;
    transactionId: string;
    now: string;
    actor: "OPERATOR" | "SYSTEM";
    observed: ObservedForPolicy | null;
  }): PolicyInput;
  recordDecision(d: {
    id: string;
    subject: AttemptAction;
    transactionId: string;
    verdict: "ALLOW" | "DENY";
    reasonCodes: string[];
    inputsHash: string;
    mandateId: string;
    mandateVersion: number;
    decidedAt: string;
  }): void;

  beginAttempt(a: {
    id: string;
    transactionId: string;
    action: AttemptAction;
    requestHash: string;
    now: string;
  }): { id: string; seq: number; requestId: string };
  finishAttempt(a: {
    id: string;
    status: Exclude<AttemptStatus, "IN_FLIGHT">;
    httpStatus?: number;
    debugId?: string;
    now: string;
  }): void;
  /** Re-sends an UNKNOWN attempt with the same request id. */
  retryAttempt(id: string): void;

  /** The only way a state changes: compare-and-swap on `expectedVersion`, with an audit event. */
  transition(a: {
    transactionId: string;
    expectedVersion: number;
    to: TxState;
    now: string;
    actor: "OPERATOR" | "SYSTEM" | "PAYPAL_API";
    patch?: Patch;
    details?: Record<string, unknown>;
  }): void;
  /** An audit event that is not a state change (an observation, an anomaly, a refusal). */
  audit(a: {
    ts: string;
    actor: "OPERATOR" | "SYSTEM" | "PAYPAL_API";
    type: string;
    transactionId: string;
    payload: Record<string, unknown>;
    /** Default LOCAL_DECISION. OBSERVED_EXTERNAL only for a fact PayPal reported (and only a PayPal actor). */
    provenance?: AuditProvenance;
  }): void;
  /** The newest `limit` audit events of the transaction, oldest first. */
  history(transactionId: string, limit: number): HistoryRow[];
  /** The payload of the newest audit event of this type for the transaction. */
  latestAuditPayload(transactionId: string, type: string): Record<string, unknown> | undefined;
}

export interface PaymentStore {
  transaction<T>(fn: (ops: PaymentOps) => T): T;
}
