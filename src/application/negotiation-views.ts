import { SERVICE_CATEGORIES } from "../domain/mandate.ts";
import {
  describeChanges,
  moneyText,
  type AgreementLink,
  type ChangeKind,
  type NegotiationRecord,
  type NegotiationStatus,
  type PolicyCheckRecord,
  type ProposalRecord,
  type ProposalStatus,
} from "../domain/negotiation.ts";
import type { NegotiationOps } from "../ports/negotiation-store.ts";
import {
  eligibilityState,
  evaluateAcceptance,
  evaluateEligibility,
  explanationOf,
  explanationOfRecord,
  type EligibilityState,
  type PolicyExplanation,
} from "./negotiation-policy.ts";

/**
 * What the operator console sees: stored records turned into plain statements. Every status carries a sentence
 * saying what it means, every policy answer carries the reason in words, and nothing here includes a payee
 * reference or any seller-written text outside fields that are rendered as inert text.
 */

const PROPOSAL_STATUS_TEXT: Record<ProposalStatus, string> = {
  OPEN: "Open",
  SUPERSEDED: "Replaced by a newer version",
  ACCEPTED: "Accepted",
  REJECTED: "Rejected",
  EXPIRED: "Expired",
  WITHDRAWN: "Withdrawn",
};

export function negotiationStatusText(
  n: Pick<NegotiationRecord, "status" | "expiresAt" | "closedReason">,
): string {
  const reason = n.closedReason ? ` ${n.closedReason}` : "";
  const text: Record<NegotiationStatus, string> = {
    OPEN: `Open: offers can still be made and accepted until ${n.expiresAt}.`,
    AGREED:
      "Agreed: a version of the deal passed the policy check and is waiting for approval or payment.",
    REJECTED: `Rejected: no deal.${reason}`,
    TIMED_OUT: `Timed out: no agreement was reached by ${n.expiresAt}.`,
    CANCELLED: `Cancelled by the operator.${reason}`,
  };
  return text[n.status];
}

export type ProposalView = {
  id: string;
  kind: ProposalRecord["kind"];
  version: number;
  status: ProposalStatus;
  statusText: string;
  statusReason: string | null;
  actor: ProposalRecord["actor"];
  createdAt: string;
  sellerId: string;
  sellerName: string;
  terms: {
    currency: string;
    category: string;
    categoryLabel: string;
    totalText: string;
    shippingText: string | null;
    feesText: string | null;
    lines: { sku: string; qty: number; unitText: string }[] | null;
    deliverables: string[];
    deliveryDays: number;
    deliverBy: string;
    termsText: string;
    validUntil: string;
  };
  claimedTotalText: string | null;
  /** For offers: does the seller's stated total equal the server's sum? */
  totalMatchesClaim: boolean | null;
  changes: { kind: ChangeKind; text: string }[];
  expired: boolean;
  policy: PolicyExplanation | null;
  actions: { canAccept: boolean; canReject: boolean; note: string | null };
};

export type AgreementView = {
  id: string;
  version: number;
  status: AgreementLink["status"];
  proposalId: string;
  sellerName: string;
  totalText: string;
  deliverBy: string;
  transactionId: string;
  transactionState: string | null;
  approval: {
    state: "NOT_REQUIRED" | "REQUIRED" | "APPROVED" | "REJECTED" | "INVALIDATED";
    text: string;
  };
  eligibility: { state: EligibilityState; policy: PolicyExplanation } | null;
  retired: {
    reason: string;
    approvalWasValid: boolean;
    at: string;
    byProposalId: string | null;
  } | null;
  createdAt: string;
};

export type PolicyCheckView = {
  id: string;
  subject: PolicyCheckRecord["subject"];
  proposalId: string | null;
  agreementVersion: number | null;
  actor: PolicyCheckRecord["actor"];
  policy: PolicyExplanation;
};

export type SellerThread = {
  sellerId: string;
  sellerName: string;
  offers: ProposalView[];
  counters: ProposalView[];
};

export type NegotiationDetail = {
  id: string;
  status: NegotiationStatus;
  statusText: string;
  mandateId: string;
  currency: string;
  request: {
    categoryLabel: string;
    quantity: number;
    summary: string;
    maxTotalText: string | null;
    neededWithinDays: number | null;
    requiredDeliverables: string[];
  };
  expiresAt: string;
  closedReason: string | null;
  createdAt: string;
  sellers: SellerThread[];
  agreements: AgreementView[];
  active: AgreementView | null;
  /** Newer versions proposed while an agreement exists: accepting one retires the agreement and its approval. */
  pendingRevisions: {
    proposalId: string;
    sellerName: string;
    version: number;
    changes: string[];
  }[];
  checks: PolicyCheckView[];
};

export type NegotiationSummary = {
  id: string;
  status: NegotiationStatus;
  summary: string;
  categoryLabel: string;
  currency: string;
  expiresAt: string;
  createdAt: string;
  offers: number;
  activeAgreement: { version: number; totalText: string } | null;
};

export function buildSummary(ops: NegotiationOps, n: NegotiationRecord): NegotiationSummary {
  const proposals = ops.listProposals(n.id);
  const active = ops.listAgreements(n.id).find((a) => a.status === "ACTIVE");
  const accepted = active && proposals.find((p) => p.id === active.proposalId);
  return {
    id: n.id,
    status: n.status,
    summary: n.request.summary,
    categoryLabel: SERVICE_CATEGORIES[n.request.category],
    currency: n.currency,
    expiresAt: n.expiresAt,
    createdAt: n.createdAt,
    offers: proposals.filter((p) => p.kind === "SELLER_OFFER").length,
    activeAgreement:
      active && accepted
        ? {
            version: active.version,
            totalText: moneyText(accepted.terms.totalMinor, accepted.terms.currency),
          }
        : null,
  };
}

export function buildDetail(
  ops: NegotiationOps,
  n: NegotiationRecord,
  now: string,
): NegotiationDetail {
  const proposals = ops.listProposals(n.id);
  const links = ops.listAgreements(n.id);
  const checks = ops.listPolicyChecks(n.id);
  const sellers = new Map(ops.listSellers().map((s) => [s.id, s]));
  const byId = new Map(proposals.map((p) => [p.id, p]));
  const active = links.find((l) => l.status === "ACTIVE");
  const sellerName = (id: string) => sellers.get(id)?.displayName ?? id;
  const live = n.status === "OPEN" || n.status === "AGREED";

  const proposalView = (p: ProposalRecord): ProposalView => {
    const prev = p.supersedesId ? byId.get(p.supersedesId) : undefined;
    const t = p.terms;
    const recorded = [...checks].reverse().find((c) => c.proposalId === p.id);
    let policy: PolicyExplanation | null = recorded ? explanationOfRecord(recorded) : null;
    if (!policy && live && p.kind === "SELLER_OFFER" && p.status === "OPEN") {
      try {
        const d = evaluateAcceptance(ops, {
          proposal: p,
          negotiation: n,
          transactionId: "preview",
          offerId: "preview",
          ignoreTransactionIds: active ? [active.transactionId] : [],
          now,
          actor: "OPERATOR",
        });
        policy = explanationOf(d, "ACCEPT_OFFER", "PREVIEW", null);
      } catch {
        policy = null; // for example the mandate no longer exists; the real attempt will say so
      }
    }
    const identical =
      p.kind === "SELLER_OFFER" &&
      p.status !== "ACCEPTED" &&
      active !== undefined &&
      active.proposalHash === p.termsHash;
    const canAccept = live && p.kind === "SELLER_OFFER" && p.status === "OPEN" && !identical;
    return {
      id: p.id,
      kind: p.kind,
      version: p.version,
      status: p.status,
      statusText: PROPOSAL_STATUS_TEXT[p.status],
      statusReason: p.statusReason,
      actor: p.actor,
      createdAt: p.createdAt,
      sellerId: t.sellerId,
      sellerName: sellerName(t.sellerId),
      terms: {
        currency: t.currency,
        category: t.category,
        categoryLabel: SERVICE_CATEGORIES[t.category],
        totalText: moneyText(t.totalMinor, t.currency),
        shippingText: p.kind === "SELLER_OFFER" ? moneyText(t.shippingMinor, t.currency) : null,
        feesText: p.kind === "SELLER_OFFER" ? moneyText(t.feesMinor, t.currency) : null,
        lines:
          t.lines?.map((l) => ({
            sku: l.sku,
            qty: l.qty,
            unitText: moneyText(l.unitPriceMinor, t.currency),
          })) ?? null,
        deliverables: t.deliverables,
        deliveryDays: t.deliveryDays,
        deliverBy: p.deliverBy,
        termsText: t.termsText,
        validUntil: p.validUntil,
      },
      claimedTotalText:
        p.claimedTotalMinor === null ? null : moneyText(p.claimedTotalMinor, t.currency),
      totalMatchesClaim: p.claimedTotalMinor === null ? null : p.claimedTotalMinor === t.totalMinor,
      changes: prev
        ? p.changes.map((kind, i) => ({ kind, text: describeChanges(prev.terms, t)[i] ?? kind }))
        : [],
      expired: p.validUntil <= now,
      policy,
      actions: {
        canAccept,
        canReject: live && p.status === "OPEN",
        note: identical
          ? "Identical to the agreed terms: the existing agreement and its approval stay valid."
          : null,
      },
    };
  };

  const agreementView = (l: AgreementLink): AgreementView => {
    const p = byId.get(l.proposalId) as ProposalRecord;
    const tx = ops.getTransaction(l.transactionId);
    const approval = ops.approvalFor(l.transactionId);
    let eligibility: AgreementView["eligibility"] = null;
    let required = true;
    if (l.status === "ACTIVE") {
      const d = evaluateEligibility(ops, { transactionId: l.transactionId, now, actor: "SYSTEM" });
      required = d.approvalRequirement !== "NOT_REQUIRED";
      eligibility = {
        state: eligibilityState(d, tx?.state ?? "UNKNOWN"),
        policy: explanationOf(d, "CREATE_ORDER", "PREVIEW", null),
      };
    }
    let state: AgreementView["approval"]["state"];
    let text: string;
    if (l.status !== "ACTIVE") {
      state = "INVALIDATED";
      text = l.approvalWasValid
        ? "An operator approval was on file for this version. It no longer counts: the terms it covered were replaced."
        : "No approval had been given for this version.";
    } else if (approval?.decision === "APPROVED") {
      state = "APPROVED";
      text = `Approved by the operator at ${approval.decidedAt}.`;
    } else if (approval?.decision === "REJECTED") {
      state = "REJECTED";
      text = "The operator rejected this version.";
    } else if (required) {
      state = "REQUIRED";
      text = "The mandate requires the operator to approve this version before any payment step.";
    } else {
      state = "NOT_REQUIRED";
      text = "The mandate does not require approval for this amount.";
    }
    return {
      id: l.id,
      version: l.version,
      status: l.status,
      proposalId: l.proposalId,
      sellerName: sellerName(p.terms.sellerId),
      totalText: moneyText(p.terms.totalMinor, p.terms.currency),
      deliverBy: p.deliverBy,
      transactionId: l.transactionId,
      transactionState: tx?.state ?? null,
      approval: { state, text },
      eligibility,
      retired:
        l.status === "ACTIVE" || l.invalidatedAt === null
          ? null
          : {
              reason: l.invalidatedReason ?? "",
              approvalWasValid: l.approvalWasValid === true,
              at: l.invalidatedAt,
              byProposalId: l.invalidatedByProposalId,
            },
      createdAt: l.createdAt,
    };
  };

  const threads: SellerThread[] = n.invitedSellerIds.map((sellerId) => {
    const mine = proposals.filter((p) => p.terms.sellerId === sellerId);
    return {
      sellerId,
      sellerName: sellerName(sellerId),
      offers: mine.filter((p) => p.kind === "SELLER_OFFER").map(proposalView),
      counters: mine.filter((p) => p.kind === "BUYER_COUNTER").map(proposalView),
    };
  });

  const agreements = links.map(agreementView);
  const activeProposal = active ? byId.get(active.proposalId) : undefined;
  const pendingRevisions =
    active && activeProposal
      ? proposals
          .filter(
            (p) =>
              p.kind === "SELLER_OFFER" &&
              p.status === "OPEN" &&
              p.seq > activeProposal.seq &&
              p.termsHash !== active.proposalHash,
          )
          .map((p) => ({
            proposalId: p.id,
            sellerName: sellerName(p.terms.sellerId),
            version: p.version,
            changes: describeChanges(activeProposal.terms, p.terms),
          }))
      : [];

  return {
    id: n.id,
    status: n.status,
    statusText: negotiationStatusText(n),
    mandateId: n.mandateId,
    currency: n.currency,
    request: {
      categoryLabel: SERVICE_CATEGORIES[n.request.category],
      quantity: n.request.quantity,
      summary: n.request.summary,
      maxTotalText:
        n.request.maxTotalMinor === null ? null : moneyText(n.request.maxTotalMinor, n.currency),
      neededWithinDays: n.request.neededWithinDays,
      requiredDeliverables: n.request.requiredDeliverables,
    },
    expiresAt: n.expiresAt,
    closedReason: n.closedReason,
    createdAt: n.createdAt,
    sellers: threads,
    agreements,
    active: agreements.find((a) => a.status === "ACTIVE") ?? null,
    pendingRevisions,
    checks: [...checks].reverse().map((c) => ({
      id: c.id,
      subject: c.subject,
      proposalId: c.proposalId,
      agreementVersion: links.find((l) => l.id === c.agreementLinkId)?.version ?? null,
      actor: c.actor,
      policy: explanationOfRecord(c),
    })),
  };
}
