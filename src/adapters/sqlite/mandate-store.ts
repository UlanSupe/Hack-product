import { ConflictError, NotFoundError } from "../../domain/errors.ts";
import type { MandateTerms, ServiceCategory, SupportedCurrency } from "../../domain/mandate.ts";
import type {
  MandateDraft,
  MandateStore,
  MandateVersion,
  SellerOption,
} from "../../ports/mandate-store.ts";
import { appendAuditEvent } from "./audit.ts";
import { all, inTransaction, one, run, type Db, type SqlParam } from "./database.ts";
import {
  getLatestMandate,
  getMandate,
  insertMandateVersion,
  mandateFromRow,
  type MandateRecord,
} from "./store.ts";

const DAY_MS = 24 * 60 * 60 * 1000;

type DraftRow = {
  id: string;
  mandate_id: string;
  base_version: number | null;
  owner_id: string;
  revision: number;
  status: "DRAFT" | "APPROVED" | "DISCARDED";
  currency: SupportedCurrency;
  total_budget_minor: number;
  per_tx_cap_minor: number;
  approval_threshold_minor: number;
  require_review: number;
  allowed_categories: string;
  allowed_seller_ids: string;
  valid_days: number;
  approved_version: number | null;
  created_at: string;
  updated_at: string;
};

const draftFromRow = (r: DraftRow): MandateDraft => ({
  id: r.id,
  mandateId: r.mandate_id,
  baseVersion: r.base_version,
  ownerId: r.owner_id,
  revision: r.revision,
  status: r.status,
  terms: {
    currency: r.currency,
    totalBudgetMinor: r.total_budget_minor,
    maxTransactionMinor: r.per_tx_cap_minor,
    approvalThresholdMinor: r.approval_threshold_minor,
    allowedCategories: JSON.parse(r.allowed_categories) as ServiceCategory[],
    allowedSellerIds: JSON.parse(r.allowed_seller_ids) as string[],
    requireReviewBeforeExecution: r.require_review === 1,
    validDays: r.valid_days,
  },
  approvedVersion: r.approved_version,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});

const versionFromRecord = (m: MandateRecord): MandateVersion => ({
  id: m.id,
  version: m.version,
  ownerId: m.ownerId,
  status: m.status,
  terms: {
    currency: m.currency as SupportedCurrency,
    totalBudgetMinor: m.totalBudgetMinor,
    maxTransactionMinor: m.perTxCapMinor,
    approvalThresholdMinor: m.approvalThresholdMinor,
    allowedCategories: m.allowedCategories,
    allowedSellerIds: m.allowedSellerIds,
    requireReviewBeforeExecution: m.requireReview,
    // Versions store the absolute expiry; this is the validity the approver chose (used to prefill a new draft).
    validDays: Math.min(
      365,
      Math.max(1, Math.round((Date.parse(m.expiresAt) - Date.parse(m.createdAt)) / DAY_MS)),
    ),
  },
  expiresAt: m.expiresAt,
  contentHash: m.contentHash,
  sourceDraftId: m.sourceDraftId,
  createdAt: m.createdAt,
});

/** Turns the schema's refusals into the domain errors the application understands. */
function mapDbError(err: unknown): never {
  const msg = err instanceof Error ? err.message : "";
  if (
    /UNIQUE constraint failed: mandate_drafts\./.test(msg) ||
    /must not reuse an existing mandate id|based on the latest ACTIVE version|only an open DRAFT can change|revoked mandates are final/.test(
      msg,
    )
  ) {
    throw new ConflictError(
      /UNIQUE/.test(msg)
        ? "this mandate already has an open draft"
        : "the mandate changed since this draft was started; create a new draft",
    );
  }
  throw err;
}

export function createSqliteMandateStore(db: Db): MandateStore {
  const getDraft = (id: string): MandateDraft | undefined => {
    const r = one<DraftRow>(db, "SELECT * FROM mandate_drafts WHERE id = ?", [id]);
    return r && draftFromRow(r);
  };

  /** Loads an OPEN draft and checks the caller's revision. */
  const openDraft = (id: string, expectedRevision: number): MandateDraft => {
    const d = getDraft(id);
    if (!d) throw new NotFoundError(`draft ${id}`);
    if (d.status !== "DRAFT")
      throw new ConflictError(
        `this draft is already ${d.status.toLowerCase()} and can no longer change`,
      );
    if (d.revision !== expectedRevision)
      throw new ConflictError(
        `the draft was changed elsewhere (it is now at revision ${d.revision}); reload it`,
      );
    return d;
  };

  const termsParams = (t: MandateTerms): SqlParam[] => [
    t.currency,
    t.totalBudgetMinor,
    t.maxTransactionMinor,
    t.approvalThresholdMinor,
    t.requireReviewBeforeExecution ? 1 : 0,
    JSON.stringify([...t.allowedCategories].sort()),
    JSON.stringify([...t.allowedSellerIds].sort()),
    t.validDays,
  ];

  return {
    listSellers(): SellerOption[] {
      return all<{ id: string; display_name: string }>(
        db,
        "SELECT id, display_name FROM sellers ORDER BY id",
      ).map((s) => ({
        id: s.id,
        displayName: s.display_name,
      }));
    },

    listLatestMandates() {
      return all<Parameters<typeof mandateFromRow>[0]>(
        db,
        `SELECT * FROM mandates m WHERE version = (SELECT MAX(version) FROM mandates WHERE id = m.id) ORDER BY created_at DESC, id`,
      )
        .map(mandateFromRow)
        .map(versionFromRecord);
    },

    listVersions(mandateId) {
      return all<Parameters<typeof mandateFromRow>[0]>(
        db,
        "SELECT * FROM mandates WHERE id = ? ORDER BY version DESC",
        [mandateId],
      )
        .map(mandateFromRow)
        .map(versionFromRecord);
    },

    getMandate(mandateId, version) {
      const m = getMandate(db, mandateId, version);
      return m && versionFromRecord(m);
    },

    listDrafts() {
      return all<DraftRow>(
        db,
        "SELECT * FROM mandate_drafts WHERE status = 'DRAFT' ORDER BY updated_at DESC, id",
      ).map(draftFromRow);
    },

    getDraft,

    createDraft(i) {
      try {
        return inTransaction(db, () => {
          run(
            db,
            `INSERT INTO mandate_drafts (id, mandate_id, base_version, owner_id, revision, status, currency, total_budget_minor,
               per_tx_cap_minor, approval_threshold_minor, require_review, allowed_categories, allowed_seller_ids, valid_days,
               created_at, updated_at)
             VALUES (?, ?, ?, ?, 1, 'DRAFT', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [i.id, i.mandateId, i.baseVersion, i.ownerId, ...termsParams(i.terms), i.now, i.now],
          );
          appendAuditEvent(db, {
            ts: i.now,
            actor: "OPERATOR",
            type: "MANDATE_DRAFT_CREATED",
            subjectType: "mandate_draft",
            subjectId: i.id,
            mandate: { id: i.mandateId, version: i.baseVersion },
            payload: { mandateId: i.mandateId, baseVersion: i.baseVersion, actorId: i.actorId },
          });
          return getDraft(i.id) as MandateDraft;
        });
      } catch (err) {
        return mapDbError(err);
      }
    },

    updateDraft(i) {
      try {
        return inTransaction(db, () => {
          const d = openDraft(i.id, i.expectedRevision);
          run(
            db,
            `UPDATE mandate_drafts SET revision = ?, currency = ?, total_budget_minor = ?, per_tx_cap_minor = ?,
               approval_threshold_minor = ?, require_review = ?, allowed_categories = ?, allowed_seller_ids = ?,
               valid_days = ?, updated_at = ? WHERE id = ? AND revision = ?`,
            [d.revision + 1, ...termsParams(i.terms), i.now, i.id, d.revision],
          );
          appendAuditEvent(db, {
            ts: i.now,
            actor: "OPERATOR",
            type: "MANDATE_DRAFT_UPDATED",
            subjectType: "mandate_draft",
            subjectId: i.id,
            mandate: { id: d.mandateId, version: d.baseVersion },
            payload: { mandateId: d.mandateId, revision: d.revision + 1, actorId: i.actorId },
          });
          return getDraft(i.id) as MandateDraft;
        });
      } catch (err) {
        return mapDbError(err);
      }
    },

    discardDraft(i) {
      try {
        return inTransaction(db, () => {
          const d = openDraft(i.id, i.expectedRevision);
          run(
            db,
            "UPDATE mandate_drafts SET status = 'DISCARDED', revision = ?, updated_at = ? WHERE id = ? AND revision = ?",
            [d.revision + 1, i.now, i.id, d.revision],
          );
          appendAuditEvent(db, {
            ts: i.now,
            actor: "OPERATOR",
            type: "MANDATE_DRAFT_DISCARDED",
            subjectType: "mandate_draft",
            subjectId: i.id,
            mandate: { id: d.mandateId, version: d.baseVersion },
            payload: { mandateId: d.mandateId, actorId: i.actorId },
          });
          return getDraft(i.id) as MandateDraft;
        });
      } catch (err) {
        return mapDbError(err);
      }
    },

    approveDraft(i) {
      try {
        return inTransaction(db, () => {
          const d = openDraft(i.id, i.expectedRevision);
          const latest = getLatestMandate(db, d.mandateId);
          if (
            d.baseVersion === null
              ? latest !== undefined
              : latest?.version !== d.baseVersion || latest.status !== "ACTIVE"
          ) {
            throw new ConflictError(
              "the mandate changed since this draft was started; create a new draft",
            );
          }
          const t = d.terms;
          const created = insertMandateVersion(db, {
            id: d.mandateId,
            ownerId: d.ownerId,
            perTxCapMinor: t.maxTransactionMinor,
            totalBudgetMinor: t.totalBudgetMinor,
            approvalThresholdMinor: t.approvalThresholdMinor,
            requireReview: t.requireReviewBeforeExecution,
            currency: t.currency,
            allowedCategories: t.allowedCategories,
            allowedSellerIds: t.allowedSellerIds,
            expiresAt: new Date(Date.parse(i.now) + t.validDays * DAY_MS).toISOString(),
            status: "ACTIVE",
            sourceDraftId: d.id,
            now: i.now,
          });
          run(
            db,
            "UPDATE mandate_drafts SET status = 'APPROVED', approved_version = ?, revision = ?, updated_at = ? WHERE id = ? AND revision = ?",
            [created.version, d.revision + 1, i.now, i.id, d.revision],
          );
          appendAuditEvent(db, {
            ts: i.now,
            actor: "OPERATOR",
            type: "MANDATE_APPROVED",
            subjectType: "mandate",
            subjectId: d.mandateId,
            mandate: { id: d.mandateId, version: created.version },
            payload: {
              version: created.version,
              draftId: d.id,
              contentHash: created.contentHash,
              actorId: i.actorId,
            },
          });
          return versionFromRecord(created);
        });
      } catch (err) {
        return mapDbError(err);
      }
    },

    revokeMandate(i) {
      try {
        return inTransaction(db, () => {
          const latest = getLatestMandate(db, i.mandateId);
          if (!latest) throw new NotFoundError(`mandate ${i.mandateId}`);
          if (latest.version !== i.expectedVersion) {
            throw new ConflictError(
              `the mandate is now at version ${latest.version}, not ${i.expectedVersion}; reload it`,
            );
          }
          if (latest.status === "REVOKED")
            throw new ConflictError("this mandate is already revoked");
          const created = insertMandateVersion(db, {
            id: latest.id,
            ownerId: latest.ownerId,
            perTxCapMinor: latest.perTxCapMinor,
            totalBudgetMinor: latest.totalBudgetMinor,
            approvalThresholdMinor: latest.approvalThresholdMinor,
            requireReview: latest.requireReview,
            currency: latest.currency,
            allowedCategories: latest.allowedCategories,
            allowedSellerIds: latest.allowedSellerIds,
            expiresAt: latest.expiresAt,
            status: "REVOKED",
            now: i.now,
          });
          appendAuditEvent(db, {
            ts: i.now,
            actor: "OPERATOR",
            type: "MANDATE_REVOKED",
            subjectType: "mandate",
            subjectId: latest.id,
            mandate: { id: latest.id, version: created.version },
            payload: {
              version: created.version,
              revokedVersion: latest.version,
              actorId: i.actorId,
            },
          });
          return versionFromRecord(created);
        });
      } catch (err) {
        return mapDbError(err);
      }
    },
  };
}
