import type {
  AgreementLink,
  NegotiationRecord,
  NegotiationStatus,
  PolicyCheckRecord,
  ProposalRecord,
  ProposalStatus,
} from "../domain/negotiation.ts";
import type { PolicyInput } from "../domain/policy.ts";
import type { TxState } from "../domain/transaction-states.ts";
import type { MandateVersion } from "./mandate-store.ts";

/**
 * Persistence for the negotiation workflow. All work happens inside `transaction`, which is atomic and
 * synchronous: the policy decision is computed from rows read in the same transaction that acts on it, so
 * nothing can change between "allowed" and "done". Implementations write an audit event for every change.
 *
 * Errors the application relies on: `NotFoundError`, `ConflictError` (domain/errors).
 */

export type AuditActorKind = "OPERATOR" | "AGENT" | "SYSTEM";

export type SellerInfo = { id: string; displayName: string; payeeRef: string };
export type CatalogRow = {
  sku: string;
  category: string | null;
  unitPriceMinor: number;
  currency: string;
};
export type TransactionInfo = {
  id: string;
  state: TxState;
  version: number;
  mandateId: string;
  mandateVersion: number;
  agreementId: string | null;
};
export type ApprovalInfo = {
  decision: "APPROVED" | "REJECTED";
  decidedAt: string;
  reason: string | null;
};

export interface NegotiationOps {
  /* reads */
  getNegotiation(id: string): NegotiationRecord | undefined;
  listNegotiations(): NegotiationRecord[];
  listProposals(negotiationId: string): ProposalRecord[];
  getProposal(id: string): ProposalRecord | undefined;
  listAgreements(negotiationId: string): AgreementLink[];
  listPolicyChecks(negotiationId: string): PolicyCheckRecord[];
  listSellers(): SellerInfo[];
  getSeller(id: string): SellerInfo | undefined;
  catalogFor(sellerId: string): CatalogRow[];
  latestMandate(mandateId: string): MandateVersion | undefined;
  /** The latest version of every mandate. */
  listMandates(): MandateVersion[];
  /** Reserved plus spent amounts under the mandate, optionally ignoring transactions about to be retired. */
  committedMinor(mandateId: string, ignoreTransactionIds: readonly string[]): number;
  getTransaction(id: string): TransactionInfo | undefined;
  approvalFor(transactionId: string): ApprovalInfo | undefined;

  /* writes */
  insertNegotiation(record: NegotiationRecord, actor: AuditActorKind): void;
  setNegotiationStatus(args: {
    id: string;
    to: NegotiationStatus;
    expectedVersion: number;
    closedReason: string | null;
    now: string;
    actor: AuditActorKind;
  }): NegotiationRecord;
  insertProposal(record: ProposalRecord): void;
  setProposalStatus(args: {
    id: string;
    to: Exclude<ProposalStatus, "OPEN">;
    reason: string | null;
    now: string;
    actor: AuditActorKind;
  }): void;
  recordPolicyCheck(record: PolicyCheckRecord): void;

  /* policy facts, built from rows */
  /** Facts for ACCEPT_OFFER on a proposal, as a brand-new transaction would see them. */
  policyInputForAcceptance(args: {
    proposal: ProposalRecord;
    negotiation: NegotiationRecord;
    transactionId: string;
    offerId: string;
    ignoreTransactionIds: readonly string[];
    now: string;
    actor: AuditActorKind;
  }): PolicyInput;
  /** Facts for CREATE_ORDER on an agreed transaction, as they are stored right now. */
  policyInputForEligibility(args: {
    transactionId: string;
    now: string;
    actor: AuditActorKind;
  }): PolicyInput;

  /* agreements */
  /** Creates the core transaction, offer, decision and agreement from an ALLOWed proposal, and links it as the next version. */
  commitAgreement(args: {
    negotiation: NegotiationRecord;
    proposal: ProposalRecord;
    ids: { link: string; transaction: string; offer: string; agreement: string; decision: string };
    decision: { inputsHash: string };
    now: string;
    actor: AuditActorKind;
  }): AgreementLink;
  /** Retires an agreement version: cancels its transaction (if still only AGREED) and records why. */
  retireAgreement(args: {
    link: AgreementLink;
    to: "INVALIDATED" | "CANCELLED";
    reason: string;
    byProposalId: string | null;
    now: string;
    actor: AuditActorKind;
  }): AgreementLink;
  recordApproval(args: {
    id: string;
    transactionId: string;
    decision: "APPROVED" | "REJECTED";
    reason: string | null;
    now: string;
  }): void;
}

export interface NegotiationStore {
  transaction<T>(fn: (ops: NegotiationOps) => T): T;
}
