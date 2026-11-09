import type { MandateTerms } from "../domain/mandate.ts";

/**
 * Persistence port for mandates. Errors the application relies on: `NotFoundError`, `ConflictError`
 * (domain/errors). Implementations must make each method atomic and write an audit event for every change.
 */

export type SellerOption = { id: string; displayName: string };

/** An APPROVED, immutable mandate version (or its revocation). */
export type MandateVersion = {
  id: string;
  version: number;
  ownerId: string;
  status: "ACTIVE" | "REVOKED";
  terms: MandateTerms;
  expiresAt: string;
  contentHash: string;
  sourceDraftId: string | null;
  createdAt: string;
};

export type DraftStatus = "DRAFT" | "APPROVED" | "DISCARDED";

/** A mutable proposal. It has no effect on any transaction until it is approved into a new version. */
export type MandateDraft = {
  id: string;
  mandateId: string;
  /** The version this draft edits, or null for a brand new mandate. */
  baseVersion: number | null;
  ownerId: string;
  /** Optimistic-concurrency counter; every change must present the revision it read. */
  revision: number;
  status: DraftStatus;
  terms: MandateTerms;
  approvedVersion: number | null;
  createdAt: string;
  updatedAt: string;
};

export interface MandateStore {
  listSellers(): SellerOption[];
  /** The latest version of each mandate. */
  listLatestMandates(): MandateVersion[];
  /** Newest first. */
  listVersions(mandateId: string): MandateVersion[];
  getMandate(mandateId: string, version: number): MandateVersion | undefined;
  /** Open drafts only. */
  listDrafts(): MandateDraft[];
  getDraft(id: string): MandateDraft | undefined;

  createDraft(input: {
    id: string;
    mandateId: string;
    baseVersion: number | null;
    ownerId: string;
    terms: MandateTerms;
    actorId: string;
    now: string;
  }): MandateDraft;
  updateDraft(input: {
    id: string;
    expectedRevision: number;
    terms: MandateTerms;
    actorId: string;
    now: string;
  }): MandateDraft;
  discardDraft(input: {
    id: string;
    expectedRevision: number;
    actorId: string;
    now: string;
  }): MandateDraft;
  /** Atomically creates the next immutable version from the draft and closes the draft. */
  approveDraft(input: {
    id: string;
    expectedRevision: number;
    actorId: string;
    now: string;
  }): MandateVersion;
  /** Atomically adds a final REVOKED version. */
  revokeMandate(input: {
    mandateId: string;
    expectedVersion: number;
    actorId: string;
    now: string;
  }): MandateVersion;
}
