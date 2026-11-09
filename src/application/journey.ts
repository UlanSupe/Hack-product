import {
  deriveJourney,
  type AuditFact,
  type JourneyFacts,
  type JourneyState,
} from "../domain/journey.ts";
import type { NegotiationDetail } from "./negotiation-views.ts";
import type { NegotiationOverview } from "./negotiations.ts";
import type { PaymentView } from "./payment-views.ts";

/**
 * Assembles the journey's facts from the views the consoles already show. It reads nothing itself and adds no
 * state of its own: the journey is a different way of looking at the same stored records, so the progress bar and the
 * consoles cannot disagree. A fact the views do not hold stays null; it is never guessed.
 */
export type JourneyInputs = {
  overview: Pick<NegotiationOverview, "mandates">;
  detail: NegotiationDetail | null;
  payment: PaymentView | null;
  paypalConfigured: boolean;
  /** The audit-chain state of the agreement's transaction, as the Cockpit computes it, or null if not known. */
  audit: AuditFact | null;
};

export function journeyFactsOf(input: JourneyInputs): JourneyFacts {
  const d = input.detail;
  const active = d?.active ?? null;

  const refusals = (d?.checks ?? []).filter(
    (c) => c.subject === "ACCEPT_OFFER" && c.policy.verdict === "DENY",
  );
  const latest = refusals.reduce<(typeof refusals)[number] | null>(
    (best, c) =>
      best === null || (c.policy.decidedAt ?? "") >= (best.policy.decidedAt ?? "") ? c : best,
    null,
  );

  return {
    mandateApproved: input.overview.mandates.length > 0,
    paypalConfigured: input.paypalConfigured,
    negotiation: d
      ? {
          id: d.id,
          status: d.status,
          offers: d.sellers.reduce((n, s) => n + s.offers.length, 0),
          counters: d.sellers.reduce((n, s) => n + s.counters.length, 0),
          agentProposals: d.sellers.reduce(
            (n, s) => n + [...s.offers, ...s.counters].filter((p) => p.actor === "AGENT").length,
            0,
          ),
          refusal: latest
            ? {
                code: latest.policy.reasonCodes[0] ?? "DENIED",
                headline: latest.policy.headline,
              }
            : null,
          agreement: active
            ? {
                version: active.version,
                totalText: active.totalText,
                approval: active.approval.state,
                eligibility: active.eligibility?.state ?? null,
                eligibilityHeadline: active.eligibility?.policy.headline ?? null,
                transactionId: active.transactionId,
              }
            : null,
          pendingRevisions: d.pendingRevisions.length,
        }
      : null,
    payment: input.payment
      ? {
          state: input.payment.state,
          moneyMoved: input.payment.moneyMoved,
          headline: input.payment.headline,
        }
      : null,
    audit: input.audit,
  };
}

/** A transaction the operator can come back to: the way to recover a lost place in the journey. */
export type RecentNegotiation = {
  id: string;
  summary: string;
  status: string;
  createdAt: string;
  agreement: string | null;
};

export function recentOf(overview: Pick<NegotiationOverview, "negotiations">): RecentNegotiation[] {
  return overview.negotiations.slice(0, 5).map((n) => ({
    id: n.id,
    summary: n.summary,
    status: n.status,
    createdAt: n.createdAt,
    agreement: n.activeAgreement
      ? `v${n.activeAgreement.version} ${n.activeAgreement.totalText}`
      : null,
  }));
}

export function buildJourney(input: JourneyInputs): JourneyState {
  return deriveJourney(journeyFactsOf(input));
}
