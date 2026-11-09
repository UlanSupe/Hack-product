import { ConflictError, ForbiddenError, NotFoundError } from "../domain/errors.ts";
import { parseDecimalAmount, type FieldError, type SupportedCurrency } from "../domain/mandate.ts";
import {
  NegotiationRefSchema,
  OpenNegotiationSchema,
  ProposalRefSchema,
  SubmitCounterSchema,
  SubmitOfferSchema,
  deliverBy,
  describeChanges,
  diffTerms,
  parseStrict,
  proposalHash,
  type AgreementLink,
  type NegotiationActor,
  type NegotiationRecord,
  type ParseResult,
  type ProposalKind,
  type ProposalRecord,
  type ProposalTerms,
} from "../domain/negotiation.ts";
import { sumOfferMinor } from "../domain/offer.ts";
import type { PolicyDecision } from "../domain/policy.ts";
import type {
  AuditActorKind,
  NegotiationOps,
  NegotiationStore,
} from "../ports/negotiation-store.ts";
import {
  auditActorOf,
  eligibilityState,
  evaluateAcceptance,
  evaluateEligibility,
  explanationOf,
  type EligibilityState,
  type PolicyExplanation,
} from "./negotiation-policy.ts";
import {
  buildDetail,
  buildSummary,
  negotiationStatusText,
  type AgreementView,
  type NegotiationDetail,
  type NegotiationSummary,
  type ProposalView,
} from "./negotiation-views.ts";

/**
 * Negotiation and agreement use cases (docs/NEGOTIATION.md).
 *
 * Authority
 *   - The human OPERATOR opens negotiations, approves or rejects an agreement, closes a negotiation.
 *   - Agents and the system may record offers and counter-offers and ask for an acceptance. They can never
 *     approve: an acceptance only happens if the deterministic policy engine ALLOWs it, and even then it creates
 *     an agreement that still needs the operator's approval when the mandate says so, before any payment step.
 *   - Every offer and counter-offer is stored as an immutable version. Terms are never edited.
 *
 * What invalidates an approval
 *   An approval belongs to exactly one agreement version. Accepting any proposal whose terms differ (price,
 *   payee, scope, currency, category, deliverables, deadline) retires the current version, cancels its
 *   transaction, records that its approval was invalidated, and creates version n + 1, which needs its own approval.
 *   A new version that merely sits unaccepted changes nothing: payment always uses the agreed version.
 */

export type { NegotiationActor } from "../domain/negotiation.ts";

type Kind = NegotiationActor["kind"];
function requireKind(
  actor: NegotiationActor,
  allowed: readonly Kind[],
  action: string,
): AuditActorKind {
  if (typeof actor !== "object" || actor === null || !allowed.includes(actor.kind)) {
    const who =
      typeof actor === "object" && actor !== null && "kind" in actor
        ? String(actor.kind).toLowerCase()
        : "unknown";
    throw new ForbiddenError(
      `only ${allowed.map((k) => k.toLowerCase()).join(" or ")} callers may ${action}; ${who} callers cannot`,
    );
  }
  if (actor.kind !== "ANONYMOUS" && (typeof actor.id !== "string" || actor.id === "")) {
    throw new ForbiddenError(`only an identified caller may ${action}`);
  }
  return auditActorOf(actor);
}

export type Result<T> = ParseResult<T>;

export type AcceptOutcome = {
  accepted: boolean;
  policy: PolicyExplanation;
  /** The agreement version this acceptance retired, if the deal was already agreed. */
  retired: AgreementView | null;
  negotiation: NegotiationDetail;
};

export type EligibilityOutcome = {
  state: EligibilityState | "NOT_AGREED";
  policy: PolicyExplanation | null;
  negotiation: NegotiationDetail;
};

export type NegotiationOverview = {
  negotiations: NegotiationSummary[];
  sellers: { id: string; displayName: string }[];
  mandates: {
    id: string;
    version: number;
    currency: string;
    allowedCategories: string[];
    allowedSellerIds: string[];
  }[];
  /** Added by the API route (the service knows nothing about model providers). */
  agents?: { modelAvailable: boolean };
};

export type NegotiationServiceDeps = {
  store: NegotiationStore;
  now: () => Date;
  newId: (prefix: string) => string;
};

const MIN = 60_000;

export function createNegotiationService({ store, now, newId }: NegotiationServiceDeps) {
  const stamp = () => now().toISOString();
  const plusMinutes = (iso: string, m: number) => new Date(Date.parse(iso) + m * MIN).toISOString();
  const fail = (field: string, message: string): { ok: false; errors: FieldError[] } => ({
    ok: false,
    errors: [{ field, message }],
  });

  /* ---------------------------------------------------------------- shared steps (inside a transaction) */

  /** Applies timeouts: the negotiation's deadline, and (optionally) each open proposal's own validity. */
  function applyTimeouts(
    ops: NegotiationOps,
    start: NegotiationRecord,
    at: string,
    actor: AuditActorKind,
    options: { proposals: boolean } = { proposals: true },
  ): NegotiationRecord {
    let n = start;
    if (n.status === "OPEN" && at >= n.expiresAt) {
      n = ops.setNegotiationStatus({
        id: n.id,
        to: "TIMED_OUT",
        expectedVersion: n.version,
        closedReason: `No agreement was reached by ${n.expiresAt}.`,
        now: at,
        actor,
      });
      for (const p of ops.listProposals(n.id)) {
        if (p.status === "OPEN") {
          ops.setProposalStatus({
            id: p.id,
            to: "EXPIRED",
            reason: "The negotiation timed out.",
            now: at,
            actor,
          });
        }
      }
    } else if (options.proposals) {
      for (const p of ops.listProposals(n.id)) {
        if (p.status === "OPEN" && p.validUntil <= at) {
          ops.setProposalStatus({
            id: p.id,
            to: "EXPIRED",
            reason: `Its validity ended at ${p.validUntil}.`,
            now: at,
            actor,
          });
        }
      }
    }
    return n;
  }

  function load(ops: NegotiationOps, id: string): NegotiationRecord {
    const n = ops.getNegotiation(id);
    if (!n) throw new NotFoundError(`negotiation ${id}`);
    return n;
  }

  /** The negotiation as it must be to take part in it: not closed, and not already paying. */
  function liveNegotiation(
    ops: NegotiationOps,
    id: string,
    at: string,
    actor: AuditActorKind,
    options?: { proposals: boolean },
  ): NegotiationRecord {
    const n = applyTimeouts(ops, load(ops, id), at, actor, options);
    if (n.status !== "OPEN" && n.status !== "AGREED") {
      throw new ConflictError(`This negotiation is closed. ${negotiationStatusText(n)}`);
    }
    return n;
  }

  const activeLink = (ops: NegotiationOps, id: string): AgreementLink | undefined =>
    ops.listAgreements(id).find((l) => l.status === "ACTIVE");

  /** A changed deal can be negotiated only until payment steps start. */
  function assertRenegotiable(ops: NegotiationOps, link: AgreementLink | undefined) {
    if (!link) return;
    const tx = ops.getTransaction(link.transactionId);
    if (tx && tx.state !== "AGREED") {
      throw new ConflictError(
        `Payment steps have already started for the agreed version (${tx.state}). Its terms can no longer be changed; void or cancel the payment first.`,
      );
    }
  }

  function appendProposal(
    ops: NegotiationOps,
    n: NegotiationRecord,
    a: {
      kind: ProposalKind;
      terms: ProposalTerms;
      claimedTotalMinor: number | null;
      respondsToId: string | null;
      validForMinutes: number;
      actor: AuditActorKind;
      at: string;
    },
  ): ProposalRecord {
    const all = ops.listProposals(n.id);
    const chain = all.filter((p) => p.kind === a.kind && p.terms.sellerId === a.terms.sellerId);
    const prev = chain[chain.length - 1];
    const version = (prev?.version ?? 0) + 1;
    const record: ProposalRecord = {
      id: newId(a.kind === "SELLER_OFFER" ? "ofr" : "ctr"),
      negotiationId: n.id,
      seq: (all[all.length - 1]?.seq ?? 0) + 1,
      kind: a.kind,
      version,
      supersedesId: prev?.id ?? null,
      respondsToId: a.respondsToId,
      status: "OPEN",
      statusReason: null,
      decidedAt: null,
      terms: a.terms,
      claimedTotalMinor: a.claimedTotalMinor,
      validUntil: plusMinutes(a.at, a.validForMinutes),
      deliverBy: deliverBy(a.at, a.terms.deliveryDays),
      termsHash: proposalHash(a.kind, a.terms),
      changes: diffTerms(prev?.terms ?? null, a.terms),
      actor: a.actor,
      createdAt: a.at,
    };
    ops.insertProposal(record);
    if (prev?.status === "OPEN") {
      ops.setProposalStatus({
        id: prev.id,
        to: "SUPERSEDED",
        reason: `Replaced by version ${version}.`,
        now: a.at,
        actor: a.actor,
      });
    }
    return record;
  }

  function recordCheck(
    ops: NegotiationOps,
    a: {
      negotiationId: string;
      proposalId: string | null;
      linkId: string | null;
      subject: "ACCEPT_OFFER" | "CREATE_ORDER";
      decision: PolicyDecision;
      actor: AuditActorKind;
      at: string;
    },
  ): void {
    ops.recordPolicyCheck({
      id: newId("chk"),
      negotiationId: a.negotiationId,
      proposalId: a.proposalId,
      agreementLinkId: a.linkId,
      subject: a.subject,
      verdict: a.decision.verdict,
      reasonCodes: [...a.decision.reasonCodes],
      explanation: a.decision.explanation.slice(0, 1500),
      policyVersion: a.decision.policyVersion,
      inputsHash: a.decision.inputsHash,
      mandateId: a.decision.mandateRef?.id ?? null,
      mandateVersion: a.decision.mandateRef?.version ?? null,
      actor: a.actor,
      decidedAt: a.at,
    });
  }

  const viewOf = (ops: NegotiationOps, id: string, at: string) =>
    buildDetail(ops, load(ops, id), at);

  /* ---------------------------------------------------------------- the service */

  return {
    /** Every negotiation, newest first, with what the operator needs to open a new one. */
    overview(actor: NegotiationActor): NegotiationOverview {
      requireKind(actor, ["OPERATOR"], "view negotiations");
      const at = stamp();
      return store.transaction((ops) => {
        for (const n of ops.listNegotiations()) applyTimeouts(ops, n, at, "SYSTEM");
        return {
          negotiations: ops.listNegotiations().map((n) => buildSummary(ops, n)),
          sellers: ops.listSellers().map((s) => ({ id: s.id, displayName: s.displayName })),
          mandates: ops.listMandates().map((m) => ({
            id: m.id,
            version: m.version,
            currency: m.terms.currency,
            allowedCategories: [...m.terms.allowedCategories],
            allowedSellerIds: [...m.terms.allowedSellerIds],
          })),
        };
      });
    },

    detail(actor: NegotiationActor, id: string): NegotiationDetail {
      requireKind(actor, ["OPERATOR"], "view a negotiation");
      const at = stamp();
      return store.transaction((ops) => {
        applyTimeouts(ops, load(ops, id), at, "SYSTEM");
        return viewOf(ops, id, at);
      });
    },

    /** The buyer's request and constraints, with a deadline. Only the operator can make one. */
    open(actor: NegotiationActor, raw: unknown): Result<NegotiationDetail> {
      const who = requireKind(actor, ["OPERATOR"], "open a negotiation");
      const parsed = parseStrict(OpenNegotiationSchema, raw);
      if (!parsed.ok) return parsed;
      const v = parsed.value;
      const at = stamp();
      return store.transaction((ops) => {
        const mandate = ops.latestMandate(v.mandateId);
        if (!mandate) throw new NotFoundError(`mandate ${v.mandateId}`);
        const currency: SupportedCurrency = mandate.terms.currency;

        const errors: FieldError[] = [];
        let maxTotalMinor: number | null = null;
        if (v.maxTotal !== null) {
          const r = parseDecimalAmount(v.maxTotal, currency);
          if (!r.ok) errors.push({ field: "maxTotal", message: r.reason });
          else if (r.minor === 0)
            errors.push({ field: "maxTotal", message: "must be greater than zero" });
          else maxTotalMinor = r.minor;
        }
        const known = new Set(ops.listSellers().map((s) => s.id));
        const unknown = v.invitedSellerIds.filter((s) => !known.has(s));
        if (unknown.length > 0)
          errors.push({
            field: "invitedSellerIds",
            message: `unknown sellers: ${unknown.join(", ")}`,
          });
        if (new Set(v.invitedSellerIds).size !== v.invitedSellerIds.length) {
          errors.push({ field: "invitedSellerIds", message: "must not contain duplicates" });
        }
        if (errors.length > 0) return { ok: false as const, errors };

        const record: NegotiationRecord = {
          id: newId("neg"),
          ownerId: actor.kind === "ANONYMOUS" ? "unknown" : actor.id,
          mandateId: mandate.id,
          status: "OPEN",
          currency,
          request: {
            category: v.category,
            quantity: v.quantity,
            summary: v.summary,
            maxTotalMinor,
            neededWithinDays: v.neededWithinDays,
            requiredDeliverables: v.requiredDeliverables,
          },
          invitedSellerIds: v.invitedSellerIds,
          expiresAt: plusMinutes(at, v.timeoutMinutes),
          closedReason: null,
          version: 1,
          createdAt: at,
          updatedAt: at,
        };
        ops.insertNegotiation(record, who);
        return { ok: true as const, value: viewOf(ops, record.id, at) };
      });
    },

    /** A seller's offer: a new immutable version of that seller's terms. */
    submitOffer(actor: NegotiationActor, raw: unknown): Result<ProposalView> {
      const who = requireKind(actor, ["AGENT", "SYSTEM", "OPERATOR"], "record a seller offer");
      const parsed = parseStrict(SubmitOfferSchema, raw);
      if (!parsed.ok) return parsed;
      const v = parsed.value;
      const at = stamp();
      return store.transaction((ops) => {
        const n = liveNegotiation(ops, v.negotiationId, at, who);
        assertRenegotiable(ops, activeLink(ops, n.id));
        const seller = ops.getSeller(v.sellerId);
        if (!seller) throw new NotFoundError(`seller ${v.sellerId}`);
        if (!n.invitedSellerIds.includes(seller.id))
          return fail("sellerId", "this seller was not invited to the negotiation");
        const o = v.offer;
        const total = sumOfferMinor(o.shippingMinor, o.feesMinor, o.lines);
        if (total === null)
          return fail("offer.lines", "the total is outside the representable money range");

        if (v.respondsToId) {
          const counter = ops.getProposal(v.respondsToId);
          if (
            !counter ||
            counter.negotiationId !== n.id ||
            counter.kind !== "BUYER_COUNTER" ||
            counter.terms.sellerId !== seller.id
          ) {
            return fail(
              "respondsToId",
              "must be a counter-offer addressed to this seller in this negotiation",
            );
          }
        }
        const record = appendProposal(ops, n, {
          kind: "SELLER_OFFER",
          terms: {
            sellerId: seller.id,
            payeeRef: seller.payeeRef, // from the catalog, never from the caller
            currency: o.currency,
            category: o.category,
            lines: o.lines.map((l) => ({
              sku: l.sku,
              qty: l.qty,
              unitPriceMinor: l.unitPriceMinor,
            })),
            shippingMinor: o.shippingMinor,
            feesMinor: o.feesMinor,
            totalMinor: total,
            deliverables: o.deliverables,
            deliveryDays: o.deliveryDays,
            termsText: o.termsText,
          },
          claimedTotalMinor: o.claimedTotalMinor,
          respondsToId: v.respondsToId ?? null,
          validForMinutes: o.validForMinutes,
          actor: who,
          at,
        });
        if (v.respondsToId) {
          const counter = ops.getProposal(v.respondsToId);
          if (counter?.status === "OPEN") {
            ops.setProposalStatus({
              id: counter.id,
              to: "SUPERSEDED",
              reason: `Answered by offer version ${record.version}.`,
              now: at,
              actor: who,
            });
          }
        }
        const view = viewOf(ops, n.id, at)
          .sellers.flatMap((s) => s.offers)
          .find((p) => p.id === record.id);
        return { ok: true as const, value: view as ProposalView };
      });
    },

    /** The buyer's structured counter-offer to one seller: an explicit total, currency, category, deliverables and deadline. */
    submitCounter(actor: NegotiationActor, raw: unknown): Result<ProposalView> {
      const who = requireKind(actor, ["AGENT", "OPERATOR"], "record a counter-offer");
      const parsed = parseStrict(SubmitCounterSchema, raw);
      if (!parsed.ok) return parsed;
      const v = parsed.value;
      const at = stamp();
      return store.transaction((ops) => {
        const n = liveNegotiation(ops, v.negotiationId, at, who);
        assertRenegotiable(ops, activeLink(ops, n.id));
        const seller = ops.getSeller(v.sellerId);
        if (!seller) throw new NotFoundError(`seller ${v.sellerId}`);
        if (!n.invitedSellerIds.includes(seller.id))
          return fail("sellerId", "this seller was not invited to the negotiation");
        if (v.targetTotalMinor === 0) return fail("targetTotalMinor", "must be greater than zero");

        const offers = ops
          .listProposals(n.id)
          .filter((p) => p.kind === "SELLER_OFFER" && p.terms.sellerId === seller.id);
        const latest = offers[offers.length - 1];
        if (!latest || (latest.status !== "OPEN" && latest.status !== "ACCEPTED")) {
          throw new ConflictError(
            "There is no open offer from this seller to counter. Ask the seller for an offer first.",
          );
        }
        const record = appendProposal(ops, n, {
          kind: "BUYER_COUNTER",
          terms: {
            sellerId: seller.id,
            payeeRef: seller.payeeRef,
            currency: v.currency,
            category: v.category,
            lines: null,
            shippingMinor: 0,
            feesMinor: 0,
            totalMinor: v.targetTotalMinor,
            deliverables: v.deliverables,
            deliveryDays: v.deliveryDays,
            termsText: v.note,
          },
          claimedTotalMinor: null,
          respondsToId: latest.id,
          validForMinutes: v.validForMinutes,
          actor: who,
          at,
        });
        const view = viewOf(ops, n.id, at)
          .sellers.flatMap((s) => s.counters)
          .find((p) => p.id === record.id);
        return { ok: true as const, value: view as ProposalView };
      });
    },

    /**
     * Try to accept a seller offer. The deterministic policy engine decides, from stored rows. A refusal is a
     * normal answer (`accepted: false`) with the reasons in words; the proposal is then closed and the evidence kept.
     */
    accept(actor: NegotiationActor, raw: unknown): Result<AcceptOutcome> {
      const who = requireKind(actor, ["OPERATOR", "SYSTEM", "AGENT"], "request an acceptance");
      const parsed = parseStrict(ProposalRefSchema, raw);
      if (!parsed.ok) return parsed;
      const at = stamp();
      return store.transaction((ops) => {
        // the proposal's own validity is judged by the policy engine (so an expired offer is a recorded denial)
        const n = liveNegotiation(ops, parsed.value.negotiationId, at, who, { proposals: false });
        const p = ops.getProposal(parsed.value.proposalId);
        if (!p || p.negotiationId !== n.id)
          throw new NotFoundError(`proposal ${parsed.value.proposalId}`);
        if (p.kind !== "SELLER_OFFER")
          throw new ConflictError(
            "Only a seller's offer can be accepted; a counter-offer is the buyer's own proposal.",
          );
        if (p.status !== "OPEN") {
          throw new ConflictError(
            `This offer is no longer open (${p.status.toLowerCase()}${p.statusReason ? `: ${p.statusReason}` : ""}).`,
          );
        }
        const current = activeLink(ops, n.id);
        if (current && current.proposalHash === p.termsHash) {
          throw new ConflictError(
            "These terms are identical to the agreed version; the existing agreement and its approval stay valid.",
          );
        }
        assertRenegotiable(ops, current);

        const ids = {
          link: newId("agl"),
          transaction: newId("tx"),
          offer: newId("off"),
          agreement: newId("agr"),
          decision: newId("dec"),
        };
        const decision = evaluateAcceptance(ops, {
          proposal: p,
          negotiation: n,
          transactionId: ids.transaction,
          offerId: ids.offer,
          ignoreTransactionIds: current ? [current.transactionId] : [],
          now: at,
          actor: who,
        });
        recordCheck(ops, {
          negotiationId: n.id,
          proposalId: p.id,
          linkId: null,
          subject: "ACCEPT_OFFER",
          decision,
          actor: who,
          at,
        });
        const policy = explanationOf(decision, "ACCEPT_OFFER", "PREVIEW", at);

        if (decision.verdict === "DENY") {
          const expired = decision.reasonCodes.includes("OFFER_EXPIRED");
          ops.setProposalStatus({
            id: p.id,
            to: expired ? "EXPIRED" : "REJECTED",
            reason: `Policy check refused: ${decision.reasonCodes.join(", ")}.`.slice(0, 500),
            now: at,
            actor: who,
          });
          return {
            ok: true as const,
            value: {
              accepted: false,
              policy: { ...policy, source: "RECORDED" as const },
              retired: null,
              negotiation: viewOf(ops, n.id, at),
            },
          };
        }

        let retiredId: string | null = null;
        let open = n;
        if (current) {
          const before = ops.getProposal(current.proposalId);
          const changes = before ? describeChanges(before.terms, p.terms) : [];
          const hadApproval = ops.approvalFor(current.transactionId)?.decision === "APPROVED";
          ops.retireAgreement({
            link: current,
            to: "INVALIDATED",
            reason:
              `Replaced by a different version of the deal. ${changes.join(" ")}${hadApproval ? ` The earlier approval no longer applies${decision.approvalRequirement === "NOT_REQUIRED" ? "." : "; the new version needs its own."}` : ""}`.slice(
                0,
                500,
              ),
            byProposalId: p.id,
            now: at,
            actor: who,
          });
          retiredId = current.id;
          open = ops.setNegotiationStatus({
            id: n.id,
            to: "OPEN",
            expectedVersion: n.version,
            closedReason: null,
            now: at,
            actor: who,
          });
        }
        ops.commitAgreement({
          negotiation: open,
          proposal: p,
          ids,
          decision: { inputsHash: decision.inputsHash },
          now: at,
          actor: who,
        });
        ops.setNegotiationStatus({
          id: n.id,
          to: "AGREED",
          expectedVersion: open.version,
          closedReason: null,
          now: at,
          actor: who,
        });

        const view = viewOf(ops, n.id, at);
        return {
          ok: true as const,
          value: {
            accepted: true,
            policy: { ...policy, source: "RECORDED" as const },
            retired: retiredId ? (view.agreements.find((a) => a.id === retiredId) ?? null) : null,
            negotiation: view,
          },
        };
      });
    },

    /** Reject one open proposal (seller offer or counter-offer). The negotiation carries on. */
    reject(actor: NegotiationActor, raw: unknown): Result<NegotiationDetail> {
      const who = requireKind(actor, ["OPERATOR", "SYSTEM"], "reject a proposal");
      const parsed = parseStrict(ProposalRefSchema, raw);
      if (!parsed.ok) return parsed;
      const at = stamp();
      return store.transaction((ops) => {
        const n = liveNegotiation(ops, parsed.value.negotiationId, at, who);
        const p = ops.getProposal(parsed.value.proposalId);
        if (!p || p.negotiationId !== n.id)
          throw new NotFoundError(`proposal ${parsed.value.proposalId}`);
        if (p.status !== "OPEN")
          throw new ConflictError(`This proposal is no longer open (${p.status.toLowerCase()}).`);
        ops.setProposalStatus({
          id: p.id,
          to: "REJECTED",
          reason: parsed.value.reason || "Rejected by the operator.",
          now: at,
          actor: who,
        });
        return { ok: true as const, value: viewOf(ops, n.id, at) };
      });
    },

    /** The operator approves the CURRENT agreement version, then the engine is asked whether payment may start. */
    approve(actor: NegotiationActor, raw: unknown): Result<EligibilityOutcome> {
      requireKind(actor, ["OPERATOR"], "approve an agreement");
      const parsed = parseStrict(NegotiationRefSchema, raw);
      if (!parsed.ok) return parsed;
      const at = stamp();
      return store.transaction((ops) => {
        const n = liveNegotiation(ops, parsed.value.negotiationId, at, "OPERATOR");
        const link = activeLink(ops, n.id);
        if (!link)
          throw new ConflictError(
            "There is no active agreement to approve. Accept an offer first.",
          );
        const tx = ops.getTransaction(link.transactionId);
        if (!tx || tx.state !== "AGREED")
          throw new ConflictError("Payment steps have already started for this agreement.");
        if (ops.approvalFor(tx.id))
          throw new ConflictError(
            "A decision has already been recorded for this agreement version.",
          );
        ops.recordApproval({
          id: newId("apr"),
          transactionId: tx.id,
          decision: "APPROVED",
          reason: parsed.value.reason || null,
          now: at,
        });
        return { ok: true as const, value: eligibility(ops, n.id, link, at, "OPERATOR") };
      });
    },

    /** The operator rejects the current agreement version. It is cancelled; the negotiation reopens. */
    disapprove(actor: NegotiationActor, raw: unknown): Result<NegotiationDetail> {
      requireKind(actor, ["OPERATOR"], "reject an agreement");
      const parsed = parseStrict(NegotiationRefSchema, raw);
      if (!parsed.ok) return parsed;
      const at = stamp();
      return store.transaction((ops) => {
        const n = liveNegotiation(ops, parsed.value.negotiationId, at, "OPERATOR");
        const link = activeLink(ops, n.id);
        if (!link) throw new ConflictError("There is no active agreement to reject.");
        const tx = ops.getTransaction(link.transactionId);
        if (!tx || tx.state !== "AGREED")
          throw new ConflictError("Payment steps have already started for this agreement.");
        if (ops.approvalFor(tx.id))
          throw new ConflictError(
            "A decision has already been recorded for this agreement version.",
          );
        ops.recordApproval({
          id: newId("apr"),
          transactionId: tx.id,
          decision: "REJECTED",
          reason: parsed.value.reason || null,
          now: at,
        });
        ops.retireAgreement({
          link,
          to: "CANCELLED",
          reason: parsed.value.reason || "The operator rejected this agreement.",
          byProposalId: null,
          now: at,
          actor: "OPERATOR",
        });
        ops.setNegotiationStatus({
          id: n.id,
          to: "OPEN",
          expectedVersion: n.version,
          closedReason: null,
          now: at,
          actor: "OPERATOR",
        });
        return { ok: true as const, value: viewOf(ops, n.id, at) };
      });
    },

    /** Ask the engine whether the current agreement may start payment. Records the answer. */
    checkEligibility(actor: NegotiationActor, raw: unknown): Result<EligibilityOutcome> {
      const who = requireKind(actor, ["OPERATOR", "SYSTEM", "AGENT"], "check payment eligibility");
      const parsed = parseStrict(NegotiationRefSchema, raw);
      if (!parsed.ok) return parsed;
      const at = stamp();
      return store.transaction((ops) => {
        const n = applyTimeouts(ops, load(ops, parsed.value.negotiationId), at, who);
        const link = activeLink(ops, n.id);
        return {
          ok: true as const,
          value: link
            ? eligibility(ops, n.id, link, at, who)
            : { state: "NOT_AGREED" as const, policy: null, negotiation: viewOf(ops, n.id, at) },
        };
      });
    },

    /** Close the whole negotiation: REJECTED (no deal) or CANCELLED. Open proposals are closed with it. */
    close(
      actor: NegotiationActor,
      raw: unknown,
      outcome: "REJECTED" | "CANCELLED",
    ): Result<NegotiationDetail> {
      requireKind(actor, ["OPERATOR"], "close a negotiation");
      const parsed = parseStrict(NegotiationRefSchema, raw);
      if (!parsed.ok) return parsed;
      const at = stamp();
      return store.transaction((ops) => {
        const n = liveNegotiation(ops, parsed.value.negotiationId, at, "OPERATOR");
        const link = activeLink(ops, n.id);
        if (link) {
          ops.retireAgreement({
            link,
            to: "CANCELLED",
            reason: `The negotiation was ${outcome.toLowerCase()}.`,
            byProposalId: null,
            now: at,
            actor: "OPERATOR",
          });
        }
        ops.setNegotiationStatus({
          id: n.id,
          to: outcome,
          expectedVersion: n.version,
          closedReason:
            parsed.value.reason ||
            (outcome === "REJECTED"
              ? "The operator rejected every offer."
              : "Cancelled by the operator."),
          now: at,
          actor: "OPERATOR",
        });
        for (const p of ops.listProposals(n.id)) {
          if (p.status === "OPEN") {
            ops.setProposalStatus({
              id: p.id,
              to: outcome === "REJECTED" ? "REJECTED" : "WITHDRAWN",
              reason: `The negotiation was ${outcome.toLowerCase()}.`,
              now: at,
              actor: "OPERATOR",
            });
          }
        }
        return { ok: true as const, value: viewOf(ops, n.id, at) };
      });
    },

    /** Applies deadlines to every live negotiation. Safe to call at any time. */
    sweep(actor: NegotiationActor): { timedOut: number; expiredProposals: number } {
      const who = requireKind(actor, ["OPERATOR", "SYSTEM"], "sweep timeouts");
      const at = stamp();
      return store.transaction((ops) => {
        let timedOut = 0;
        let expiredProposals = 0;
        for (const n of ops.listNegotiations()) {
          const openBefore = ops.listProposals(n.id).filter((p) => p.status === "OPEN").length;
          const after = applyTimeouts(ops, n, at, who);
          if (after.status === "TIMED_OUT" && n.status !== "TIMED_OUT") timedOut++;
          expiredProposals +=
            openBefore - ops.listProposals(n.id).filter((p) => p.status === "OPEN").length;
        }
        return { timedOut, expiredProposals };
      });
    },
  };

  /** Evaluates and records CREATE_ORDER eligibility for a link (inside a transaction). */
  function eligibility(
    ops: NegotiationOps,
    negotiationId: string,
    link: AgreementLink,
    at: string,
    actor: AuditActorKind,
  ): EligibilityOutcome {
    // Eligibility is a property of the agreement, not of who asks: judge it as the system would start the
    // order, and record who actually asked.
    const decision = evaluateEligibility(ops, {
      transactionId: link.transactionId,
      now: at,
      actor: "SYSTEM",
    });
    recordCheck(ops, {
      negotiationId,
      proposalId: null,
      linkId: link.id,
      subject: "CREATE_ORDER",
      decision,
      actor,
      at,
    });
    const tx = ops.getTransaction(link.transactionId);
    return {
      state: eligibilityState(decision, tx?.state ?? "UNKNOWN"),
      policy: explanationOf(decision, "CREATE_ORDER", "RECORDED", at),
      negotiation: viewOf(ops, negotiationId, at),
    };
  }
}

export type NegotiationService = ReturnType<typeof createNegotiationService>;
