import { ForbiddenError } from "../domain/errors.ts";
import type { ApprovalRequirement } from "../domain/mandate.ts";
import type {
  NegotiationActor,
  NegotiationRecord,
  PolicyCheckRecord,
  ProposalRecord,
} from "../domain/negotiation.ts";
import { evaluatePolicy, type PolicyDecision } from "../domain/policy.ts";
import { explainCodes, type Explanation } from "../domain/policy-explanations.ts";
import type { AuditActorKind, NegotiationOps } from "../ports/negotiation-store.ts";

/**
 * Running the deterministic policy engine for the workflow. These helpers build the engine's input from
 * stored rows (never from a request), evaluate it, and translate the answer for people. They do not decide
 * anything the engine did not decide.
 */

export type PolicyExplanation = Explanation & {
  policyVersion: string;
  reasonCodes: string[];
  approvalRequirement: ApprovalRequirement | null;
  decidedAt: string | null;
  /** RECORDED: a stored decision. PREVIEW: what the engine says right now; nothing was stored. */
  source: "RECORDED" | "PREVIEW";
};

/** Anonymous callers never reach the engine. */
export function auditActorOf(actor: NegotiationActor): AuditActorKind {
  if (actor.kind === "ANONYMOUS") throw new ForbiddenError("authentication is required");
  return actor.kind;
}

export function explanationOf(
  decision: Pick<
    PolicyDecision,
    "verdict" | "reasonCodes" | "policyVersion" | "approvalRequirement"
  >,
  subject: "ACCEPT_OFFER" | "CREATE_ORDER",
  source: PolicyExplanation["source"],
  decidedAt: string | null,
): PolicyExplanation {
  return {
    ...explainCodes(decision.verdict, decision.reasonCodes, subject),
    policyVersion: decision.policyVersion,
    reasonCodes: [...decision.reasonCodes],
    approvalRequirement: decision.approvalRequirement,
    decidedAt,
    source,
  };
}

export function explanationOfRecord(c: PolicyCheckRecord): PolicyExplanation {
  return {
    ...explainCodes(c.verdict, c.reasonCodes, c.subject),
    policyVersion: c.policyVersion,
    reasonCodes: c.reasonCodes,
    approvalRequirement: null,
    decidedAt: c.decidedAt,
    source: "RECORDED",
  };
}

/** Would this seller offer be accepted if someone tried now? Pure with respect to storage. */
export function evaluateAcceptance(
  ops: NegotiationOps,
  a: {
    proposal: ProposalRecord;
    negotiation: NegotiationRecord;
    transactionId: string;
    offerId: string;
    ignoreTransactionIds: readonly string[];
    now: string;
    actor: AuditActorKind;
  },
): PolicyDecision {
  return evaluatePolicy(ops.policyInputForAcceptance(a));
}

/** Is this agreed transaction allowed to start payment right now? */
export function evaluateEligibility(
  ops: NegotiationOps,
  a: { transactionId: string; now: string; actor: AuditActorKind },
): PolicyDecision {
  return evaluatePolicy(ops.policyInputForEligibility(a));
}

export type EligibilityState = "ELIGIBLE" | "AWAITING_APPROVAL" | "BLOCKED" | "IN_PROGRESS";

/** The one-word state the UI shows, derived from the engine's codes and never from anything else. */
export function eligibilityState(decision: PolicyDecision, txState: string): EligibilityState {
  if (decision.verdict === "ALLOW") return "ELIGIBLE";
  if (txState !== "AGREED") return "IN_PROGRESS";
  return decision.reasonCodes.length === 1 && decision.reasonCodes[0] === "APPROVAL_REQUIRED"
    ? "AWAITING_APPROVAL"
    : "BLOCKED";
}
