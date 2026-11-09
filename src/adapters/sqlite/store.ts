import { mandateContentHash } from "../../domain/mandate-hash.ts";
import { termsHashOf } from "../../domain/offer.ts";
import { NotFoundError } from "../../domain/errors.ts";
import type { ServiceCategory } from "../../domain/mandate.ts";
import { assertCurrency, assertMinor } from "../../domain/money.ts";
import type { InFlightState, TxState } from "../../domain/transaction-states.ts";
import { appendAuditEvent, type AuditActor } from "./audit.ts";
import { inTransaction, one, run, type Db } from "./database.ts";

export { NotFoundError };

/**
 * Typed write/read primitives over the schema. They validate inputs, derive anything the server
 * must own (totals, hashes, payee, mandate pin, request ids) and keep multi-row changes atomic.
 * The schema triggers re-check the same rules, so a bug here cannot persist an invalid state.
 * Policy decisions (should this be allowed?) are NOT made here.
 */

/** Optimistic-concurrency failure: the row changed since the caller read it. */
export class StaleVersionError extends Error {
  constructor(transactionId: string, expected: number) {
    super(`transaction ${transactionId} is no longer at version ${expected}`);
    this.name = "StaleVersionError";
  }
}

/* ------------------------------------------------------------------ sellers / mandates */

export function createSeller(
  db: Db,
  s: { id: string; displayName: string; payeeRef: string; now: string },
): void {
  run(db, "INSERT INTO sellers (id, display_name, payee_ref, created_at) VALUES (?, ?, ?, ?)", [
    s.id,
    s.displayName,
    s.payeeRef,
    s.now,
  ]);
}

export function upsertCatalogItem(
  db: Db,
  i: {
    sellerId: string;
    sku: string;
    unitPriceMinor: number;
    currency: string;
    category: ServiceCategory;
  },
): void {
  run(
    db,
    `INSERT INTO seller_catalog_items (seller_id, sku, unit_price_minor, currency, category) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT (seller_id, sku) DO UPDATE SET unit_price_minor = excluded.unit_price_minor,
       currency = excluded.currency, category = excluded.category`,
    [
      i.sellerId,
      i.sku,
      assertMinor(i.unitPriceMinor, "unitPriceMinor"),
      assertCurrency(i.currency),
      i.category,
    ],
  );
}

export type MandateInput = {
  id: string;
  ownerId: string;
  /** Maximum single transaction. */
  perTxCapMinor: number;
  totalBudgetMinor: number;
  /** A transaction ABOVE this needs human approval. */
  approvalThresholdMinor: number;
  /** When true every transaction needs human approval, whatever its amount. */
  requireReview: boolean;
  currency: string;
  allowedCategories: ServiceCategory[];
  allowedSellerIds: string[];
  expiresAt: string;
  status: "ACTIVE" | "REVOKED";
  /** Set only when the version is created by approving a draft. */
  sourceDraftId?: string;
  now: string;
};

export type MandateRecord = {
  id: string;
  version: number;
  ownerId: string;
  perTxCapMinor: number;
  totalBudgetMinor: number;
  approvalThresholdMinor: number;
  requireReview: boolean;
  currency: string;
  allowedCategories: ServiceCategory[];
  allowedSellerIds: string[];
  expiresAt: string;
  status: "ACTIVE" | "REVOKED";
  sourceDraftId: string | null;
  contentHash: string;
  createdAt: string;
};

type MandateRow = {
  id: string;
  version: number;
  owner_id: string;
  per_tx_cap_minor: number;
  total_budget_minor: number;
  approval_threshold_minor: number;
  require_review: number;
  currency: string;
  allowed_categories: string;
  allowed_seller_ids: string;
  expires_at: string;
  status: "ACTIVE" | "REVOKED";
  source_draft_id: string | null;
  content_hash: string;
  created_at: string;
};

export const mandateFromRow = (r: MandateRow): MandateRecord => ({
  id: r.id,
  version: r.version,
  ownerId: r.owner_id,
  perTxCapMinor: r.per_tx_cap_minor,
  totalBudgetMinor: r.total_budget_minor,
  approvalThresholdMinor: r.approval_threshold_minor,
  requireReview: r.require_review === 1,
  currency: r.currency,
  allowedCategories: JSON.parse(r.allowed_categories) as ServiceCategory[],
  allowedSellerIds: JSON.parse(r.allowed_seller_ids) as string[],
  expiresAt: r.expires_at,
  status: r.status,
  sourceDraftId: r.source_draft_id,
  contentHash: r.content_hash,
  createdAt: r.created_at,
});

/** Inserts the next version of a mandate (version 1 if new). A revocation is just another version. */
export function insertMandateVersion(db: Db, m: MandateInput): MandateRecord {
  assertMinor(m.perTxCapMinor, "perTxCapMinor");
  assertMinor(m.totalBudgetMinor, "totalBudgetMinor");
  assertMinor(m.approvalThresholdMinor, "approvalThresholdMinor");
  assertCurrency(m.currency);
  return inTransaction(db, () => {
    const prev = one<{ v: number | null }>(
      db,
      "SELECT MAX(version) AS v FROM mandates WHERE id = ?",
      [m.id],
    );
    const version = (prev?.v ?? 0) + 1;
    // Arrays are stored sorted so equal content always has equal text (drafts are compared to versions in SQL).
    const sellers = [...m.allowedSellerIds].sort();
    const categories = [...m.allowedCategories].sort();
    const contentHash = mandateContentHash({
      ...m,
      version,
      allowedCategories: categories,
      allowedSellerIds: sellers,
    });
    run(
      db,
      `INSERT INTO mandates (id, version, owner_id, per_tx_cap_minor, total_budget_minor, approval_threshold_minor,
                             require_review, currency, allowed_categories, allowed_seller_ids, expires_at, status,
                             source_draft_id, created_by, content_hash, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'OPERATOR', ?, ?)`,
      [
        m.id,
        version,
        m.ownerId,
        m.perTxCapMinor,
        m.totalBudgetMinor,
        m.approvalThresholdMinor,
        m.requireReview ? 1 : 0,
        m.currency,
        JSON.stringify(categories),
        JSON.stringify(sellers),
        m.expiresAt,
        m.status,
        m.sourceDraftId ?? null,
        contentHash,
        m.now,
      ],
    );
    return getMandate(db, m.id, version) as MandateRecord;
  });
}

export function getMandate(db: Db, id: string, version: number): MandateRecord | undefined {
  const r = one<MandateRow>(db, "SELECT * FROM mandates WHERE id = ? AND version = ?", [
    id,
    version,
  ]);
  return r && mandateFromRow(r);
}

export function getLatestMandate(db: Db, id: string): MandateRecord | undefined {
  const r = one<MandateRow>(
    db,
    "SELECT * FROM mandates WHERE id = ? ORDER BY version DESC LIMIT 1",
    [id],
  );
  return r && mandateFromRow(r);
}

/* ------------------------------------------------------------------ transactions */

export type TransactionRecord = {
  id: string;
  state: TxState;
  version: number;
  reconcilingFrom: InFlightState | null;
  mandateId: string;
  mandateVersion: number;
  agreementId: string | null;
  currency: string;
  paypalOrderId: string | null;
  paypalAuthorizationId: string | null;
  paypalCaptureId: string | null;
  authorizedMinor: number | null;
  capturedMinor: number | null;
  authorizedAt: string | null;
  honorExpiresAt: string | null;
  lastEventSeq: number | null;
  createdAt: string;
  updatedAt: string;
};

type TransactionRow = {
  id: string;
  state: TxState;
  version: number;
  reconciling_from: InFlightState | null;
  mandate_id: string;
  mandate_version: number;
  agreement_id: string | null;
  currency: string;
  paypal_order_id: string | null;
  paypal_authorization_id: string | null;
  paypal_capture_id: string | null;
  authorized_minor: number | null;
  captured_minor: number | null;
  authorized_at: string | null;
  honor_expires_at: string | null;
  last_event_seq: number | null;
  created_at: string;
  updated_at: string;
};

const txFromRow = (r: TransactionRow): TransactionRecord => ({
  id: r.id,
  state: r.state,
  version: r.version,
  reconcilingFrom: r.reconciling_from,
  mandateId: r.mandate_id,
  mandateVersion: r.mandate_version,
  agreementId: r.agreement_id,
  currency: r.currency,
  paypalOrderId: r.paypal_order_id,
  paypalAuthorizationId: r.paypal_authorization_id,
  paypalCaptureId: r.paypal_capture_id,
  authorizedMinor: r.authorized_minor,
  capturedMinor: r.captured_minor,
  authorizedAt: r.authorized_at,
  honorExpiresAt: r.honor_expires_at,
  lastEventSeq: r.last_event_seq,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});

export function getTransaction(db: Db, id: string): TransactionRecord | undefined {
  const r = one<TransactionRow>(db, "SELECT * FROM transactions WHERE id = ?", [id]);
  return r && txFromRow(r);
}

/** Starts a negotiation pinned to the LATEST version of the mandate (the schema rejects stale/revoked/expired). */
export function createTransaction(
  db: Db,
  t: { id: string; mandateId: string; now: string },
): TransactionRecord {
  return inTransaction(db, () => {
    const mandate = getLatestMandate(db, t.mandateId);
    if (!mandate) throw new NotFoundError(`mandate ${t.mandateId}`);
    run(
      db,
      `INSERT INTO transactions (id, state, version, mandate_id, mandate_version, currency, created_at, updated_at)
       VALUES (?, 'NEGOTIATING', 1, ?, ?, ?, ?, ?)`,
      [t.id, mandate.id, mandate.version, mandate.currency, t.now, t.now],
    );
    return getTransaction(db, t.id) as TransactionRecord;
  });
}

export type TransitionPatch = Partial<{
  agreementId: string;
  paypalOrderId: string;
  paypalAuthorizationId: string;
  paypalCaptureId: string;
  authorizedMinor: number;
  capturedMinor: number;
  authorizedAt: string;
  honorExpiresAt: string;
}>;

export type TransitionInput = {
  id: string;
  /** The version the caller read. A mismatch means someone else changed the row. */
  expectedVersion: number;
  to: TxState;
  now: string;
  actor: AuditActor;
  patch?: TransitionPatch;
  /** Extra audit detail (must not contain secrets). */
  details?: Record<string, unknown>;
};

/**
 * The only way to change a transaction's state: compare-and-swap on `version`, one audit event,
 * and the update, all in one DB transaction. Illegal transitions, missing audit references and
 * inconsistent amounts are rejected by the schema (and roll the whole thing back).
 */
export function transitionTransaction(db: Db, input: TransitionInput): TransactionRecord {
  const p = input.patch ?? {};
  if (p.authorizedMinor !== undefined) assertMinor(p.authorizedMinor, "authorizedMinor");
  if (p.capturedMinor !== undefined) assertMinor(p.capturedMinor, "capturedMinor");
  return inTransaction(db, () => {
    const cur = getTransaction(db, input.id);
    if (!cur) throw new NotFoundError(`transaction ${input.id}`);
    if (cur.version !== input.expectedVersion)
      throw new StaleVersionError(input.id, input.expectedVersion);

    const event = appendAuditEvent(db, {
      ts: input.now,
      actor: input.actor,
      type: "TX_STATE_CHANGED",
      subjectType: "transaction",
      subjectId: input.id,
      transactionId: input.id,
      payload: { ...input.details, from: cur.state, to: input.to, version: cur.version + 1 },
    });

    const res = run(
      db,
      `UPDATE transactions SET
         state = ?, version = ?, reconciling_from = ?, agreement_id = ?, paypal_order_id = ?,
         paypal_authorization_id = ?, paypal_capture_id = ?, authorized_minor = ?, captured_minor = ?,
         authorized_at = ?, honor_expires_at = ?, last_event_seq = ?, updated_at = ?
       WHERE id = ? AND version = ?`,
      [
        input.to,
        cur.version + 1,
        input.to === "NEEDS_RECONCILIATION" ? cur.state : null,
        p.agreementId ?? cur.agreementId,
        p.paypalOrderId ?? cur.paypalOrderId,
        p.paypalAuthorizationId ?? cur.paypalAuthorizationId,
        p.paypalCaptureId ?? cur.paypalCaptureId,
        p.authorizedMinor ?? cur.authorizedMinor,
        p.capturedMinor ?? cur.capturedMinor,
        p.authorizedAt ?? cur.authorizedAt,
        p.honorExpiresAt ?? cur.honorExpiresAt,
        event.seq,
        input.now,
        input.id,
        cur.version,
      ],
    );
    if (res.changes !== 1) throw new StaleVersionError(input.id, input.expectedVersion);
    return getTransaction(db, input.id) as TransactionRecord;
  });
}

/* ------------------------------------------------------------------ offers / decisions / agreements */

export type OfferInput = {
  id: string;
  transactionId: string;
  sellerId: string;
  currency: string;
  shippingMinor: number;
  feesMinor: number;
  /** What the seller says the total is. Stored for audit; never trusted. */
  claimedTotalMinor: number;
  termsText: string;
  validUntil: string;
  lines: { sku: string; description: string; qty: number; unitPriceMinor: number }[];
  now: string;
};

/** Sum with overflow protection; the server total is always computed here, never supplied. */
export function computeServerTotal(
  lines: OfferInput["lines"],
  shippingMinor: number,
  feesMinor: number,
): number {
  let total = assertMinor(shippingMinor, "shippingMinor") + assertMinor(feesMinor, "feesMinor");
  for (const l of lines) {
    if (!Number.isSafeInteger(l.qty) || l.qty < 1)
      throw new RangeError("line qty must be a positive integer");
    total += assertMinor(l.unitPriceMinor, "unitPriceMinor") * l.qty;
    if (!Number.isSafeInteger(total))
      throw new RangeError("offer total overflows safe integer range");
  }
  return total;
}

/** Inserts offer revision n+1 with its lines, supersedes the previous OPEN revision, all atomically. */
export function insertOffer(
  db: Db,
  o: OfferInput,
): { id: string; revision: number; serverTotalMinor: number; termsHash: string } {
  assertCurrency(o.currency);
  assertMinor(o.claimedTotalMinor, "claimedTotalMinor");
  if (o.lines.length === 0) throw new RangeError("an offer needs at least one line");
  const serverTotalMinor = computeServerTotal(o.lines, o.shippingMinor, o.feesMinor);
  const termsHash = termsHashOf(o);
  return inTransaction(db, () => {
    const prev = one<{ id: string; revision: number }>(
      db,
      "SELECT id, revision FROM offers WHERE transaction_id = ? ORDER BY revision DESC LIMIT 1",
      [o.transactionId],
    );
    const revision = (prev?.revision ?? 0) + 1;
    run(
      db,
      `INSERT INTO offers (id, transaction_id, seller_id, revision, supersedes_offer_id, currency, shipping_minor, fees_minor,
                           claimed_total_minor, server_total_minor, terms_text, terms_hash, valid_until, status, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'OPEN', ?)`,
      [
        o.id,
        o.transactionId,
        o.sellerId,
        revision,
        prev?.id ?? null,
        o.currency,
        o.shippingMinor,
        o.feesMinor,
        o.claimedTotalMinor,
        serverTotalMinor,
        o.termsText,
        termsHash,
        o.validUntil,
        o.now,
      ],
    );
    o.lines.forEach((l, i) => {
      // The category always comes from the seller catalog, never from the offer. Unknown sku -> NULL,
      // which can be stored (offers are untrusted input) but can never be agreed.
      const cat = one<{ category: string | null }>(
        db,
        "SELECT category FROM seller_catalog_items WHERE seller_id = ? AND sku = ?",
        [o.sellerId, l.sku],
      );
      run(
        db,
        `INSERT INTO offer_lines (offer_id, line_no, sku, description, qty, unit_price_minor, currency, category)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          o.id,
          i + 1,
          l.sku,
          l.description,
          l.qty,
          l.unitPriceMinor,
          o.currency,
          cat?.category ?? null,
        ],
      );
    });
    if (prev) run(db, "UPDATE offers SET status = 'SUPERSEDED' WHERE id = ?", [prev.id]);
    return { id: o.id, revision, serverTotalMinor, termsHash };
  });
}

export type PolicyDecisionInput = {
  id: string;
  subject: "ACCEPT_OFFER" | "CREATE_ORDER" | "AUTHORIZE" | "CAPTURE" | "VOID";
  transactionId: string;
  verdict: "ALLOW" | "DENY";
  reasonCodes: string[];
  inputsHash: string;
  mandateId: string;
  mandateVersion: number;
  decidedAt: string;
};

export function recordPolicyDecision(db: Db, d: PolicyDecisionInput): void {
  run(
    db,
    `INSERT INTO policy_decisions (id, subject, transaction_id, verdict, reason_codes, inputs_hash, mandate_id, mandate_version, decided_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      d.id,
      d.subject,
      d.transactionId,
      d.verdict,
      JSON.stringify(d.reasonCodes),
      d.inputsHash,
      d.mandateId,
      d.mandateVersion,
      d.decidedAt,
    ],
  );
}

/**
 * Freezes an agreement from an OPEN offer and an ALLOW decision, marks the offer ACCEPTED and moves the
 * transaction NEGOTIATING -> AGREED. Every agreement field is derived from stored rows, not from the caller.
 */
export function acceptOffer(
  db: Db,
  a: {
    agreementId: string;
    offerId: string;
    policyDecisionId: string;
    expectedVersion: number;
    now: string;
    actor: AuditActor;
  },
): TransactionRecord {
  return inTransaction(db, () => {
    const offer = one<{
      transaction_id: string;
      seller_id: string;
      currency: string;
      server_total_minor: number;
      terms_hash: string;
      payee_ref: string;
    }>(
      db,
      `SELECT o.transaction_id, o.seller_id, o.currency, o.server_total_minor, o.terms_hash, s.payee_ref
       FROM offers o JOIN sellers s ON s.id = o.seller_id WHERE o.id = ?`,
      [a.offerId],
    );
    if (!offer) throw new NotFoundError(`offer ${a.offerId}`);
    const tx = getTransaction(db, offer.transaction_id) as TransactionRecord;
    run(
      db,
      `INSERT INTO agreements (id, offer_id, terms_hash, mandate_id, mandate_version, payee_ref, total_minor, currency, policy_decision_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        a.agreementId,
        a.offerId,
        offer.terms_hash,
        tx.mandateId,
        tx.mandateVersion,
        offer.payee_ref,
        offer.server_total_minor,
        offer.currency,
        a.policyDecisionId,
        a.now,
      ],
    );
    run(db, "UPDATE offers SET status = 'ACCEPTED' WHERE id = ?", [a.offerId]);
    return transitionTransaction(db, {
      id: tx.id,
      expectedVersion: a.expectedVersion,
      to: "AGREED",
      now: a.now,
      actor: a.actor,
      patch: { agreementId: a.agreementId },
      details: { offerId: a.offerId, policyDecisionId: a.policyDecisionId },
    });
  });
}

/* ------------------------------------------------------------------ payment attempts */

export type AttemptAction = "CREATE_ORDER" | "AUTHORIZE" | "CAPTURE" | "VOID";
export type AttemptStatus = "IN_FLIGHT" | "SUCCEEDED" | "FAILED_DEFINITE" | "UNKNOWN";

/** Write-ahead record of an outbound call; call it in the same transaction that enters the in-flight state. */
export function startPaymentAttempt(
  db: Db,
  a: { id: string; transactionId: string; action: AttemptAction; requestHash: string; now: string },
): { id: string; seq: number; requestId: string } {
  return inTransaction(db, () => {
    const prev = one<{ s: number | null }>(
      db,
      "SELECT MAX(seq) AS s FROM payment_attempts WHERE transaction_id = ? AND action = ?",
      [a.transactionId, a.action],
    );
    const seq = (prev?.s ?? 0) + 1;
    const requestId = `pp:${a.transactionId}:${a.action}:${seq}`;
    run(
      db,
      `INSERT INTO payment_attempts (id, transaction_id, action, seq, request_id, request_hash, status, tries, started_at)
       VALUES (?, ?, ?, ?, ?, ?, 'IN_FLIGHT', 1, ?)`,
      [a.id, a.transactionId, a.action, seq, requestId, a.requestHash, a.now],
    );
    return { id: a.id, seq, requestId };
  });
}

export function finishPaymentAttempt(
  db: Db,
  f: {
    id: string;
    status: Exclude<AttemptStatus, "IN_FLIGHT">;
    httpStatus?: number;
    paypalDebugId?: string;
    now: string;
  },
): void {
  const r = run(
    db,
    "UPDATE payment_attempts SET status = ?, http_status = ?, paypal_debug_id = ?, finished_at = ? WHERE id = ?",
    [f.status, f.httpStatus ?? null, f.paypalDebugId ?? null, f.now, f.id],
  );
  if (r.changes !== 1) throw new NotFoundError(`payment attempt ${f.id}`);
}

/** Re-sends an UNKNOWN attempt with the same request id (only after a GET shows the action did not happen). */
export function retryPaymentAttempt(db: Db, id: string): void {
  const r = run(
    db,
    "UPDATE payment_attempts SET status = 'IN_FLIGHT', tries = tries + 1, finished_at = NULL, http_status = NULL WHERE id = ?",
    [id],
  );
  if (r.changes !== 1) throw new NotFoundError(`payment attempt ${id}`);
}

/* ------------------------------------------------------------------ attack runs / recommendations */

export function recordRecommendation(
  db: Db,
  r: {
    id: string;
    transactionId?: string;
    attackRunId?: string;
    agent: "UNSAFE_BASELINE" | "PROTECTED_BUYER" | "SELLER";
    kind: "ACCEPT_OFFER" | "COUNTER" | "REJECT" | "REQUEST_RELEASE" | "REQUEST_VOID" | "NONE";
    offerId?: string;
    rationale: string;
    modelRef: string;
    fixtureStep?: string;
    now: string;
  },
): void {
  run(
    db,
    `INSERT INTO agent_recommendations (id, transaction_id, attack_run_id, agent, kind, offer_id, rationale, model_ref, fixture_step, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      r.id,
      r.transactionId ?? null,
      r.attackRunId ?? null,
      r.agent,
      r.kind,
      r.offerId ?? null,
      r.rationale,
      r.modelRef,
      r.fixtureStep ?? null,
      r.now,
    ],
  );
}

export function createAttackRun(
  db: Db,
  r: {
    id: string;
    scenarioId: string;
    fixtureVersion: string;
    seed: string;
    mode: "UNSAFE_BASELINE" | "PROTECTED";
    provider: "SIMULATED" | "PAYPAL_SANDBOX";
    transactionId?: string;
    currency: string;
    mandateCapMinor: number;
    now: string;
  },
): void {
  run(
    db,
    `INSERT INTO attack_runs (id, scenario_id, fixture_version, seed, mode, provider, transaction_id, currency, mandate_cap_minor, started_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      r.id,
      r.scenarioId,
      r.fixtureVersion,
      r.seed,
      r.mode,
      r.provider,
      r.transactionId ?? null,
      assertCurrency(r.currency),
      assertMinor(r.mandateCapMinor, "mandateCapMinor"),
      r.now,
    ],
  );
}

export function addAttackStep(
  db: Db,
  s: {
    runId: string;
    sellerMessageRef: string;
    recommendationId?: string;
    policyDecisionId?: string;
    outcome: "EXECUTED" | "BLOCKED" | "NO_ACTION";
  },
): number {
  return inTransaction(db, () => {
    const prev = one<{ n: number | null }>(
      db,
      "SELECT MAX(n) AS n FROM attack_run_steps WHERE run_id = ?",
      [s.runId],
    );
    const n = (prev?.n ?? 0) + 1;
    run(
      db,
      `INSERT INTO attack_run_steps (run_id, n, seller_message_ref, recommendation_id, policy_decision_id, outcome) VALUES (?, ?, ?, ?, ?, ?)`,
      [
        s.runId,
        n,
        s.sellerMessageRef,
        s.recommendationId ?? null,
        s.policyDecisionId ?? null,
        s.outcome,
      ],
    );
    return n;
  });
}

export function finishAttackRun(
  db: Db,
  f: {
    id: string;
    moneyMovedMinor: number;
    invariantsViolated: string[];
    auditFromSeq?: number;
    auditToSeq?: number;
    now: string;
  },
): void {
  const r = run(
    db,
    `UPDATE attack_runs SET money_moved_minor = ?, invariants_violated = ?, audit_from_seq = ?, audit_to_seq = ?, finished_at = ? WHERE id = ?`,
    [
      assertMinor(f.moneyMovedMinor, "moneyMovedMinor"),
      JSON.stringify(f.invariantsViolated),
      f.auditFromSeq ?? null,
      f.auditToSeq ?? null,
      f.now,
      f.id,
    ],
  );
  if (r.changes !== 1) throw new NotFoundError(`attack run ${f.id}`);
}

/* ------------------------------------------------------------------ inbound idempotency */

export type IdempotencyClaim =
  | { outcome: "NEW" }
  | { outcome: "REPLAY"; responseStatus: number | null; responseBody: string | null }
  | { outcome: "CONFLICT" };

/** NEW: first time. REPLAY: same key and same request. CONFLICT: same key, different request. */
export function claimIdempotencyKey(
  db: Db,
  c: { key: string; scope: string; requestHash: string; now: string },
): IdempotencyClaim {
  return inTransaction(db, () => {
    const row = one<{
      scope: string;
      request_hash: string;
      response_status: number | null;
      response_body: string | null;
    }>(
      db,
      "SELECT scope, request_hash, response_status, response_body FROM idempotency_keys WHERE idem_key = ?",
      [c.key],
    );
    if (!row) {
      run(
        db,
        "INSERT INTO idempotency_keys (idem_key, scope, request_hash, created_at) VALUES (?, ?, ?, ?)",
        [c.key, c.scope, c.requestHash, c.now],
      );
      return { outcome: "NEW" };
    }
    if (row.scope === c.scope && row.request_hash === c.requestHash) {
      return {
        outcome: "REPLAY",
        responseStatus: row.response_status,
        responseBody: row.response_body,
      };
    }
    return { outcome: "CONFLICT" };
  });
}

export function storeIdempotentResponse(db: Db, key: string, status: number, body: string): void {
  const r = run(
    db,
    "UPDATE idempotency_keys SET response_status = ?, response_body = ? WHERE idem_key = ?",
    [status, body, key],
  );
  if (r.changes !== 1) throw new NotFoundError(`idempotency key ${key}`);
}

/* ------------------------------------------------------------------ human approval before execution */

/**
 * Records the operator's decision on an AGREED transaction. Whether an approval is *required* is decided by
 * the mandate (approvalRequirement in the domain); the schema refuses to start execution without an APPROVED
 * decision when it is. Callers must have verified the actor is the human operator.
 */
export function recordTransactionApproval(
  db: Db,
  a: {
    id: string;
    transactionId: string;
    decision: "APPROVED" | "REJECTED";
    reason?: string;
    now: string;
  },
): void {
  inTransaction(db, () => {
    const tx = getTransaction(db, a.transactionId);
    if (!tx) throw new NotFoundError(`transaction ${a.transactionId}`);
    run(
      db,
      `INSERT INTO transaction_approvals (id, transaction_id, agreement_id, decision, decided_by, reason, decided_at)
       VALUES (?, ?, ?, ?, 'OPERATOR', ?, ?)`,
      [a.id, a.transactionId, tx.agreementId, a.decision, a.reason ?? null, a.now],
    );
    appendAuditEvent(db, {
      ts: a.now,
      actor: "OPERATOR",
      type: "TX_APPROVAL_RECORDED",
      subjectType: "transaction",
      subjectId: a.transactionId,
      transactionId: a.transactionId,
      payload: { decision: a.decision, approvalId: a.id },
    });
  });
}
