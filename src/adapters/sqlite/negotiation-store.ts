import { ConflictError, NotFoundError } from "../../domain/errors.ts";
import type { ServiceCategory } from "../../domain/mandate.ts";
import {
  type AgreementLink,
  type ChangeKind,
  type NegotiationRecord,
  type PolicyCheckRecord,
  type ProposalRecord,
} from "../../domain/negotiation.ts";
import { sumOfferMinor, termsHashOf } from "../../domain/offer.ts";
import { exposureCounts, type PolicyInput } from "../../domain/policy.ts";
import type { TxState } from "../../domain/transaction-states.ts";
import type {
  ApprovalInfo,
  AuditActorKind,
  CatalogRow,
  NegotiationOps,
  NegotiationStore,
  SellerInfo,
  TransactionInfo,
} from "../../ports/negotiation-store.ts";
import type { MandateVersion } from "../../ports/mandate-store.ts";
import { appendAuditEvent } from "./audit.ts";
import { all, inTransaction, one, run, type Db } from "./database.ts";
import { createSqliteMandateStore } from "./mandate-store.ts";
import {
  acceptOffer,
  createTransaction,
  getTransaction,
  insertOffer,
  recordPolicyDecision,
  recordTransactionApproval,
  transitionTransaction,
} from "./store.ts";

/* ------------------------------------------------------------------ row mapping */

type NegotiationRow = {
  id: string;
  owner_id: string;
  mandate_id: string;
  status: NegotiationRecord["status"];
  currency: string;
  category: ServiceCategory;
  quantity: number;
  summary: string;
  max_total_minor: number | null;
  needed_within_days: number | null;
  required_deliverables: string;
  invited_seller_ids: string;
  expires_at: string;
  closed_reason: string | null;
  version: number;
  created_at: string;
  updated_at: string;
};

const negotiationFromRow = (r: NegotiationRow): NegotiationRecord => ({
  id: r.id,
  ownerId: r.owner_id,
  mandateId: r.mandate_id,
  status: r.status,
  currency: r.currency,
  request: {
    category: r.category,
    quantity: r.quantity,
    summary: r.summary,
    maxTotalMinor: r.max_total_minor,
    neededWithinDays: r.needed_within_days,
    requiredDeliverables: JSON.parse(r.required_deliverables) as string[],
  },
  invitedSellerIds: JSON.parse(r.invited_seller_ids) as string[],
  expiresAt: r.expires_at,
  closedReason: r.closed_reason,
  version: r.version,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});

type ProposalRow = {
  id: string;
  negotiation_id: string;
  seq: number;
  seller_id: string;
  kind: ProposalRecord["kind"];
  version: number;
  supersedes_id: string | null;
  responds_to_id: string | null;
  status: ProposalRecord["status"];
  status_reason: string | null;
  decided_at: string | null;
  currency: string;
  category: ServiceCategory;
  lines: string | null;
  shipping_minor: number;
  fees_minor: number;
  claimed_total_minor: number | null;
  total_minor: number;
  deliverables: string;
  delivery_days: number;
  deliver_by: string;
  terms_text: string;
  payee_ref: string;
  valid_until: string;
  terms_hash: string;
  changes: string;
  actor: ProposalRecord["actor"];
  created_at: string;
};

const proposalFromRow = (r: ProposalRow): ProposalRecord => ({
  id: r.id,
  negotiationId: r.negotiation_id,
  seq: r.seq,
  kind: r.kind,
  version: r.version,
  supersedesId: r.supersedes_id,
  respondsToId: r.responds_to_id,
  status: r.status,
  statusReason: r.status_reason,
  decidedAt: r.decided_at,
  terms: {
    sellerId: r.seller_id,
    payeeRef: r.payee_ref,
    currency: r.currency,
    category: r.category,
    lines:
      r.lines === null
        ? null
        : (JSON.parse(r.lines) as { sku: string; qty: number; unitPriceMinor: number }[]),
    shippingMinor: r.shipping_minor,
    feesMinor: r.fees_minor,
    totalMinor: r.total_minor,
    deliverables: JSON.parse(r.deliverables) as string[],
    deliveryDays: r.delivery_days,
    termsText: r.terms_text,
  },
  claimedTotalMinor: r.claimed_total_minor,
  validUntil: r.valid_until,
  deliverBy: r.deliver_by,
  termsHash: r.terms_hash,
  changes: JSON.parse(r.changes) as ChangeKind[],
  actor: r.actor,
  createdAt: r.created_at,
});

type LinkRow = {
  id: string;
  negotiation_id: string;
  version: number;
  proposal_id: string;
  proposal_hash: string;
  transaction_id: string;
  agreement_id: string;
  policy_decision_id: string;
  status: AgreementLink["status"];
  invalidated_reason: string | null;
  invalidated_by_proposal_id: string | null;
  approval_was_valid: number | null;
  invalidated_at: string | null;
  created_at: string;
};

const linkFromRow = (r: LinkRow): AgreementLink => ({
  id: r.id,
  negotiationId: r.negotiation_id,
  version: r.version,
  proposalId: r.proposal_id,
  proposalHash: r.proposal_hash,
  transactionId: r.transaction_id,
  agreementId: r.agreement_id,
  policyDecisionId: r.policy_decision_id,
  status: r.status,
  invalidatedReason: r.invalidated_reason,
  invalidatedByProposalId: r.invalidated_by_proposal_id,
  approvalWasValid: r.approval_was_valid === null ? null : r.approval_was_valid === 1,
  invalidatedAt: r.invalidated_at,
  createdAt: r.created_at,
});

type CheckRow = {
  id: string;
  negotiation_id: string;
  proposal_id: string | null;
  agreement_link_id: string | null;
  subject: PolicyCheckRecord["subject"];
  verdict: "ALLOW" | "DENY";
  reason_codes: string;
  explanation: string;
  policy_version: string;
  inputs_hash: string;
  mandate_id: string | null;
  mandate_version: number | null;
  actor: PolicyCheckRecord["actor"];
  decided_at: string;
};

const checkFromRow = (r: CheckRow): PolicyCheckRecord => ({
  id: r.id,
  negotiationId: r.negotiation_id,
  proposalId: r.proposal_id,
  agreementLinkId: r.agreement_link_id,
  subject: r.subject,
  verdict: r.verdict,
  reasonCodes: JSON.parse(r.reason_codes) as string[],
  explanation: r.explanation,
  policyVersion: r.policy_version,
  inputsHash: r.inputs_hash,
  mandateId: r.mandate_id,
  mandateVersion: r.mandate_version,
  actor: r.actor,
  decidedAt: r.decided_at,
});

const mandateFacts = (m: MandateVersion): PolicyInput["mandate"] => ({
  id: m.id,
  version: m.version,
  ownerId: m.ownerId,
  status: m.status,
  expiresAt: m.expiresAt,
  contentHash: m.contentHash,
  terms: m.terms,
});

/* ------------------------------------------------------------------ the store */

export function createSqliteNegotiationStore(db: Db): NegotiationStore {
  const mandates = createSqliteMandateStore(db);

  const latestMandate = (mandateId: string): MandateVersion | undefined =>
    mandates.listVersions(mandateId)[0];

  const catalogFor = (sellerId: string): CatalogRow[] =>
    all<{ sku: string; category: string | null; unit_price_minor: number; currency: string }>(
      db,
      "SELECT sku, category, unit_price_minor, currency FROM seller_catalog_items WHERE seller_id = ? ORDER BY sku",
      [sellerId],
    ).map((r) => ({
      sku: r.sku,
      category: r.category,
      unitPriceMinor: r.unit_price_minor,
      currency: r.currency,
    }));

  const getSeller = (id: string): SellerInfo | undefined => {
    const r = one<{ id: string; display_name: string; payee_ref: string }>(
      db,
      "SELECT id, display_name, payee_ref FROM sellers WHERE id = ?",
      [id],
    );
    return r && { id: r.id, displayName: r.display_name, payeeRef: r.payee_ref };
  };

  /** Every other transaction under the mandate, with its agreed total, for the engine's cumulative-budget check. */
  const othersFor = (mandateId: string, ignore: readonly string[]) =>
    all<{ id: string; state: TxState; currency: string; total: number | null }>(
      db,
      `SELECT t.id, t.state, t.currency, a.total_minor AS total FROM transactions t
         LEFT JOIN agreements a ON a.id = t.agreement_id WHERE t.mandate_id = ?`,
      [mandateId],
    )
      .filter((t) => !ignore.includes(t.id))
      .map((t) => ({ id: t.id, state: t.state, currency: t.currency, totalMinor: t.total ?? 0 }));

  const audit = (
    actor: AuditActorKind,
    ts: string,
    type: string,
    subjectId: string,
    payload: unknown,
    transactionId: string | null = null,
  ) => {
    appendAuditEvent(db, {
      ts,
      actor,
      type,
      subjectType: "negotiation",
      subjectId,
      transactionId,
      payload,
    });
  };

  const getProposal = (id: string): ProposalRecord | undefined => {
    const r = one<ProposalRow>(db, "SELECT * FROM negotiation_proposals WHERE id = ?", [id]);
    return r && proposalFromRow(r);
  };

  const setProposalStatus: NegotiationOps["setProposalStatus"] = (a) => {
    const res = run(
      db,
      "UPDATE negotiation_proposals SET status = ?, status_reason = ?, decided_at = ? WHERE id = ? AND status = 'OPEN'",
      [a.to, a.reason, a.now, a.id],
    );
    if (res.changes !== 1) throw new ConflictError("That proposal is no longer open.");
    const p = getProposal(a.id);
    audit(a.actor, a.now, "PROPOSAL_STATUS_CHANGED", a.id, {
      negotiationId: p?.negotiationId,
      to: a.to,
      reason: a.reason,
      kind: p?.kind,
      version: p?.version,
    });
  };

  const ops: NegotiationOps = {
    getNegotiation(id) {
      const r = one<NegotiationRow>(db, "SELECT * FROM negotiations WHERE id = ?", [id]);
      return r && negotiationFromRow(r);
    },
    listNegotiations() {
      return all<NegotiationRow>(db, "SELECT * FROM negotiations ORDER BY created_at DESC, id").map(
        negotiationFromRow,
      );
    },
    listProposals(negotiationId) {
      return all<ProposalRow>(
        db,
        "SELECT * FROM negotiation_proposals WHERE negotiation_id = ? ORDER BY seq",
        [negotiationId],
      ).map(proposalFromRow);
    },
    getProposal,
    listAgreements(negotiationId) {
      return all<LinkRow>(
        db,
        "SELECT * FROM negotiation_agreements WHERE negotiation_id = ? ORDER BY version",
        [negotiationId],
      ).map(linkFromRow);
    },
    listPolicyChecks(negotiationId) {
      return all<CheckRow>(
        db,
        "SELECT * FROM negotiation_policy_checks WHERE negotiation_id = ? ORDER BY decided_at, rowid",
        [negotiationId],
      ).map(checkFromRow);
    },
    listSellers() {
      return all<{ id: string; display_name: string; payee_ref: string }>(
        db,
        "SELECT id, display_name, payee_ref FROM sellers ORDER BY id",
      ).map((r) => ({ id: r.id, displayName: r.display_name, payeeRef: r.payee_ref }));
    },
    getSeller,
    catalogFor,
    latestMandate,
    listMandates: () => mandates.listLatestMandates(),
    committedMinor(mandateId, ignore) {
      let sum = 0;
      for (const t of othersFor(mandateId, ignore))
        if (exposureCounts(t.state)) sum += t.totalMinor;
      return sum;
    },
    getTransaction(id): TransactionInfo | undefined {
      const t = getTransaction(db, id);
      return (
        t && {
          id: t.id,
          state: t.state,
          version: t.version,
          mandateId: t.mandateId,
          mandateVersion: t.mandateVersion,
          agreementId: t.agreementId,
        }
      );
    },
    approvalFor(transactionId): ApprovalInfo | undefined {
      const r = one<{
        decision: "APPROVED" | "REJECTED";
        decided_at: string;
        reason: string | null;
      }>(
        db,
        "SELECT decision, decided_at, reason FROM transaction_approvals WHERE transaction_id = ?",
        [transactionId],
      );
      return r && { decision: r.decision, decidedAt: r.decided_at, reason: r.reason };
    },

    insertNegotiation(n, actor) {
      run(
        db,
        `INSERT INTO negotiations (id, owner_id, mandate_id, status, currency, category, quantity, summary, max_total_minor,
           needed_within_days, required_deliverables, invited_seller_ids, expires_at, closed_reason, version, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          n.id,
          n.ownerId,
          n.mandateId,
          n.status,
          n.currency,
          n.request.category,
          n.request.quantity,
          n.request.summary,
          n.request.maxTotalMinor,
          n.request.neededWithinDays,
          JSON.stringify(n.request.requiredDeliverables),
          JSON.stringify(n.invitedSellerIds),
          n.expiresAt,
          n.closedReason,
          n.version,
          n.createdAt,
          n.updatedAt,
        ],
      );
      audit(actor, n.createdAt, "NEGOTIATION_OPENED", n.id, {
        mandateId: n.mandateId,
        category: n.request.category,
        sellers: n.invitedSellerIds,
        expiresAt: n.expiresAt,
      });
    },
    setNegotiationStatus(a) {
      const res = run(
        db,
        "UPDATE negotiations SET status = ?, closed_reason = ?, version = version + 1, updated_at = ? WHERE id = ? AND version = ?",
        [a.to, a.closedReason, a.now, a.id, a.expectedVersion],
      );
      if (res.changes !== 1)
        throw new ConflictError(
          "The negotiation changed while you were working. Reload and try again.",
        );
      audit(a.actor, a.now, "NEGOTIATION_STATUS_CHANGED", a.id, {
        to: a.to,
        reason: a.closedReason,
      });
      return ops.getNegotiation(a.id) as NegotiationRecord;
    },
    insertProposal(p) {
      const t = p.terms;
      run(
        db,
        `INSERT INTO negotiation_proposals (id, negotiation_id, seq, seller_id, kind, version, supersedes_id, responds_to_id, status,
           status_reason, decided_at, currency, category, lines, shipping_minor, fees_minor, claimed_total_minor, total_minor,
           deliverables, delivery_days, deliver_by, terms_text, payee_ref, valid_until, terms_hash, changes, actor, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          p.id,
          p.negotiationId,
          p.seq,
          t.sellerId,
          p.kind,
          p.version,
          p.supersedesId,
          p.respondsToId,
          p.status,
          p.statusReason,
          p.decidedAt,
          t.currency,
          t.category,
          t.lines === null ? null : JSON.stringify(t.lines),
          t.shippingMinor,
          t.feesMinor,
          p.claimedTotalMinor,
          t.totalMinor,
          JSON.stringify(t.deliverables),
          t.deliveryDays,
          p.deliverBy,
          t.termsText,
          t.payeeRef,
          p.validUntil,
          p.termsHash,
          JSON.stringify(p.changes),
          p.actor,
          p.createdAt,
        ],
      );
      audit(
        p.actor,
        p.createdAt,
        p.kind === "SELLER_OFFER" ? "OFFER_RECORDED" : "COUNTER_RECORDED",
        p.id,
        {
          negotiationId: p.negotiationId,
          sellerId: t.sellerId,
          version: p.version,
          totalMinor: t.totalMinor,
          currency: t.currency,
          changes: p.changes,
          termsHash: p.termsHash,
        },
      );
    },
    setProposalStatus,
    recordPolicyCheck(c) {
      run(
        db,
        `INSERT INTO negotiation_policy_checks (id, negotiation_id, proposal_id, agreement_link_id, subject, verdict, reason_codes,
           explanation, policy_version, inputs_hash, mandate_id, mandate_version, actor, decided_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          c.id,
          c.negotiationId,
          c.proposalId,
          c.agreementLinkId,
          c.subject,
          c.verdict,
          JSON.stringify(c.reasonCodes),
          c.explanation,
          c.policyVersion,
          c.inputsHash,
          c.mandateId,
          c.mandateVersion,
          c.actor,
          c.decidedAt,
        ],
      );
      audit(
        c.actor,
        c.decidedAt,
        c.verdict === "ALLOW" ? "POLICY_ALLOWED" : "POLICY_DENIED",
        c.id,
        {
          negotiationId: c.negotiationId,
          subject: c.subject,
          reasonCodes: c.reasonCodes,
          policyVersion: c.policyVersion,
          inputsHash: c.inputsHash,
        },
      );
    },

    policyInputForAcceptance({
      proposal,
      negotiation,
      transactionId,
      offerId,
      ignoreTransactionIds,
      now,
      actor,
    }) {
      const mandate = latestMandate(negotiation.mandateId);
      if (!mandate) throw new NotFoundError(`mandate ${negotiation.mandateId}`);
      const t = proposal.terms;
      const catalog = new Map(catalogFor(t.sellerId).map((c) => [c.sku, c]));
      const lines = (t.lines ?? []).map((l) => ({
        sku: l.sku,
        qty: l.qty,
        unitPriceMinor: l.unitPriceMinor,
        catalogUnitPriceMinor: catalog.get(l.sku)?.unitPriceMinor ?? null,
        category: catalog.get(l.sku)?.category ?? null,
      }));
      const seller = getSeller(t.sellerId);
      return {
        subject: "ACCEPT_OFFER",
        now,
        actor,
        transaction: {
          id: transactionId,
          state: "NEGOTIATING",
          mandateId: mandate.id,
          mandateVersion: mandate.version,
          agreementId: null,
          honorExpiresAt: null,
        },
        mandate: mandateFacts(mandate),
        latestMandate: { id: mandate.id, version: mandate.version, status: mandate.status },
        offer: {
          id: offerId,
          transactionId,
          sellerId: t.sellerId,
          // the catalog's payee RIGHT NOW; the proposal's snapshot is compared against it as a claim below
          catalogPayeeRef: seller?.payeeRef ?? "unknown_seller",
          currency: t.currency,
          status: "OPEN",
          validUntil: proposal.validUntil,
          shippingMinor: t.shippingMinor,
          feesMinor: t.feesMinor,
          claimedTotalMinor: proposal.claimedTotalMinor ?? 0,
          storedServerTotalMinor: sumOfferMinor(t.shippingMinor, t.feesMinor, t.lines ?? []) ?? 0,
          storedTermsHash: termsHashOf({
            sellerId: t.sellerId,
            currency: t.currency,
            shippingMinor: t.shippingMinor,
            feesMinor: t.feesMinor,
            lines: t.lines ?? [],
          }),
          lines,
        },
        agreement: null,
        others: othersFor(mandate.id, ignoreTransactionIds),
        approval: null,
        attempts: { liveForSubject: false, captureSucceeded: false },
        observed: null,
        claims: {
          transactionId,
          offerId,
          sellerId: t.sellerId,
          payeeRef: t.payeeRef,
          currency: t.currency,
          amountMinor: t.totalMinor,
        },
      };
    },

    policyInputForEligibility({ transactionId, now, actor }) {
      const tx = getTransaction(db, transactionId);
      if (!tx) throw new NotFoundError(`transaction ${transactionId}`);
      const pinned = mandates.getMandate(tx.mandateId, tx.mandateVersion);
      const latest = latestMandate(tx.mandateId);
      if (!pinned || !latest) throw new NotFoundError(`mandate ${tx.mandateId}`);
      const agreement = tx.agreementId
        ? one<{
            id: string;
            offer_id: string;
            terms_hash: string;
            mandate_id: string;
            mandate_version: number;
            payee_ref: string;
            total_minor: number;
            currency: string;
          }>(db, "SELECT * FROM agreements WHERE id = ?", [tx.agreementId])
        : undefined;
      const offer = agreement
        ? one<{
            id: string;
            transaction_id: string;
            seller_id: string;
            currency: string;
            status: "OPEN" | "SUPERSEDED" | "EXPIRED" | "ACCEPTED" | "REJECTED";
            valid_until: string;
            shipping_minor: number;
            fees_minor: number;
            claimed_total_minor: number;
            server_total_minor: number;
            terms_hash: string;
          }>(db, "SELECT * FROM offers WHERE id = ?", [agreement.offer_id])
        : undefined;
      const lines = offer
        ? all<{
            sku: string;
            qty: number;
            unit_price_minor: number;
            category: string | null;
            cat_price: number | null;
          }>(
            db,
            `SELECT l.sku, l.qty, l.unit_price_minor, l.category, c.unit_price_minor AS cat_price
               FROM offer_lines l LEFT JOIN seller_catalog_items c ON c.seller_id = ? AND c.sku = l.sku
              WHERE l.offer_id = ? ORDER BY l.line_no`,
            [offer.seller_id, offer.id],
          )
        : [];
      const seller = offer ? getSeller(offer.seller_id) : undefined;
      const approval = one<{
        agreement_id: string;
        decision: "APPROVED" | "REJECTED";
        decided_by: string;
      }>(
        db,
        "SELECT agreement_id, decision, decided_by FROM transaction_approvals WHERE transaction_id = ?",
        [transactionId],
      );
      const live = one<{ n: number }>(
        db,
        "SELECT COUNT(*) AS n FROM payment_attempts WHERE transaction_id = ? AND action = 'CREATE_ORDER' AND status <> 'FAILED_DEFINITE'",
        [transactionId],
      );
      const captured = one<{ n: number }>(
        db,
        "SELECT COUNT(*) AS n FROM payment_attempts WHERE transaction_id = ? AND action = 'CAPTURE' AND status = 'SUCCEEDED'",
        [transactionId],
      );
      return {
        subject: "CREATE_ORDER",
        now,
        actor,
        transaction: {
          id: tx.id,
          state: tx.state,
          mandateId: tx.mandateId,
          mandateVersion: tx.mandateVersion,
          agreementId: tx.agreementId,
          honorExpiresAt: tx.honorExpiresAt,
        },
        mandate: mandateFacts(pinned),
        latestMandate: { id: latest.id, version: latest.version, status: latest.status },
        offer:
          offer && seller
            ? {
                id: offer.id,
                transactionId: offer.transaction_id,
                sellerId: offer.seller_id,
                catalogPayeeRef: seller.payeeRef,
                currency: offer.currency,
                status: offer.status,
                validUntil: offer.valid_until,
                shippingMinor: offer.shipping_minor,
                feesMinor: offer.fees_minor,
                claimedTotalMinor: offer.claimed_total_minor,
                storedServerTotalMinor: offer.server_total_minor,
                storedTermsHash: offer.terms_hash,
                lines: lines.map((l) => ({
                  sku: l.sku,
                  qty: l.qty,
                  unitPriceMinor: l.unit_price_minor,
                  catalogUnitPriceMinor: l.cat_price,
                  category: l.category,
                })),
              }
            : null,
        agreement: agreement
          ? {
              id: agreement.id,
              offerId: agreement.offer_id,
              termsHash: agreement.terms_hash,
              mandateId: agreement.mandate_id,
              mandateVersion: agreement.mandate_version,
              payeeRef: agreement.payee_ref,
              currency: agreement.currency,
              totalMinor: agreement.total_minor,
            }
          : null,
        others: othersFor(tx.mandateId, [tx.id]),
        approval: approval
          ? {
              agreementId: approval.agreement_id,
              decision: approval.decision,
              decidedBy: approval.decided_by,
            }
          : null,
        attempts: { liveForSubject: (live?.n ?? 0) > 0, captureSucceeded: (captured?.n ?? 0) > 0 },
        observed: null,
        claims: {},
      };
    },

    commitAgreement({ negotiation, proposal, ids, decision, now, actor }) {
      const t = proposal.terms;
      const tx = createTransaction(db, {
        id: ids.transaction,
        mandateId: negotiation.mandateId,
        now,
      });
      insertOffer(db, {
        id: ids.offer,
        transactionId: tx.id,
        sellerId: t.sellerId,
        currency: t.currency,
        shippingMinor: t.shippingMinor,
        feesMinor: t.feesMinor,
        claimedTotalMinor: proposal.claimedTotalMinor ?? t.totalMinor,
        termsText: t.termsText,
        validUntil: proposal.validUntil,
        lines: (t.lines ?? []).map((l) => ({
          sku: l.sku,
          description: l.sku,
          qty: l.qty,
          unitPriceMinor: l.unitPriceMinor,
        })),
        now,
      });
      recordPolicyDecision(db, {
        id: ids.decision,
        subject: "ACCEPT_OFFER",
        transactionId: tx.id,
        verdict: "ALLOW",
        reasonCodes: [],
        inputsHash: decision.inputsHash,
        mandateId: tx.mandateId,
        mandateVersion: tx.mandateVersion,
        decidedAt: now,
      });
      acceptOffer(db, {
        agreementId: ids.agreement,
        offerId: ids.offer,
        policyDecisionId: ids.decision,
        expectedVersion: tx.version,
        now,
        actor,
      });
      setProposalStatus({
        id: proposal.id,
        to: "ACCEPTED",
        reason: "Passed the policy check and was accepted.",
        now,
        actor,
      });
      const version =
        (one<{ v: number | null }>(
          db,
          "SELECT MAX(version) AS v FROM negotiation_agreements WHERE negotiation_id = ?",
          [negotiation.id],
        )?.v ?? 0) + 1;
      run(
        db,
        `INSERT INTO negotiation_agreements (id, negotiation_id, version, proposal_id, proposal_hash, transaction_id, agreement_id,
           policy_decision_id, status, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'ACTIVE', ?)`,
        [
          ids.link,
          negotiation.id,
          version,
          proposal.id,
          proposal.termsHash,
          tx.id,
          ids.agreement,
          ids.decision,
          now,
        ],
      );
      audit(
        actor,
        now,
        "AGREEMENT_CREATED",
        ids.link,
        {
          negotiationId: negotiation.id,
          version,
          proposalId: proposal.id,
          transactionId: tx.id,
          totalMinor: t.totalMinor,
          currency: t.currency,
        },
        tx.id,
      );
      return linkFromRow(
        one<LinkRow>(db, "SELECT * FROM negotiation_agreements WHERE id = ?", [
          ids.link,
        ]) as LinkRow,
      );
    },

    retireAgreement({ link, to, reason, byProposalId, now, actor }) {
      const tx = getTransaction(db, link.transactionId);
      if (!tx) throw new NotFoundError(`transaction ${link.transactionId}`);
      if (tx.state !== "AGREED") {
        throw new ConflictError(
          `Payment steps have already started for this agreement (${tx.state}); its terms can no longer be changed. Void or cancel the payment first.`,
        );
      }
      const approval = ops.approvalFor(tx.id);
      transitionTransaction(db, {
        id: tx.id,
        expectedVersion: tx.version,
        to: "CANCELLED",
        now,
        actor,
        details: { reason: "agreement version retired", negotiationAgreementId: link.id },
      });
      const res = run(
        db,
        `UPDATE negotiation_agreements SET status = ?, invalidated_reason = ?, invalidated_by_proposal_id = ?,
           approval_was_valid = ?, invalidated_at = ? WHERE id = ? AND status = 'ACTIVE'`,
        [to, reason, byProposalId, approval?.decision === "APPROVED" ? 1 : 0, now, link.id],
      );
      if (res.changes !== 1) throw new ConflictError("That agreement version was already retired.");
      audit(
        actor,
        now,
        "AGREEMENT_RETIRED",
        link.id,
        {
          negotiationId: link.negotiationId,
          version: link.version,
          to,
          reason,
          approvalInvalidated: approval?.decision === "APPROVED",
          byProposalId,
        },
        tx.id,
      );
      return linkFromRow(
        one<LinkRow>(db, "SELECT * FROM negotiation_agreements WHERE id = ?", [link.id]) as LinkRow,
      );
    },

    recordApproval({ id, transactionId, decision, reason, now }) {
      recordTransactionApproval(db, {
        id,
        transactionId,
        decision,
        ...(reason === null ? {} : { reason }),
        now,
      });
    },
  };

  return { transaction: (fn) => inTransaction(db, () => fn(ops)) };
}
