import { expect } from "vitest";

import { appendAuditEvent } from "@/adapters/sqlite/audit";
import { openDatabase, run, type Db, type SqlParam } from "@/adapters/sqlite/database";
import { migrate } from "@/adapters/sqlite/migrate";
import {
  acceptOffer,
  createSeller,
  createTransaction,
  finishPaymentAttempt,
  getTransaction,
  insertMandateVersion,
  insertOffer,
  recordPolicyDecision,
  startPaymentAttempt,
  transitionTransaction,
  upsertCatalogItem,
  type AttemptAction,
  type OfferInput,
  type TransitionPatch,
} from "@/adapters/sqlite/store";
import type { ServiceCategory } from "@/domain/mandate";
import type { TxState } from "@/domain/transaction-states";

export const T0 = "2026-01-01T00:00:00.000Z";
export const HASH = "a".repeat(64);

/** Policy fields every test mandate needs. The threshold equals the cap, so no approval is needed unless a test asks. */
export const POLICY = {
  approvalThresholdMinor: 10_000,
  requireReview: false,
  allowedCategories: ["COMPUTE"] as ServiceCategory[],
};

export const ts = (minutes: number) => new Date(Date.parse(T0) + minutes * 60_000).toISOString();
let clock = 100;
/** Strictly increasing timestamps so ordering checks are meaningful. */
export const tick = () => ts(clock++);

export function freshDb(): Db {
  const db = openDatabase(":memory:");
  migrate(db, { now: T0 });
  return db;
}

/** Asserts the database (or store) refused the operation, optionally with a matching message. */
export function expectRejected(fn: () => unknown, pattern?: RegExp): void {
  let error: unknown;
  try {
    fn();
  } catch (e) {
    error = e;
  }
  expect(error, "expected the operation to be rejected").toBeInstanceOf(Error);
  if (pattern) expect((error as Error).message).toMatch(pattern);
}

export function count(db: Db, table: string): number {
  return (db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
}

export function cell<T = unknown>(db: Db, sql: string, params: SqlParam[] = []): T {
  const row = db.prepare(sql).get(...params) as Record<string, T> | undefined;
  return Object.values(row ?? {})[0] as T;
}

export function rawInsert(db: Db, table: string, row: Record<string, SqlParam>): void {
  const cols = Object.keys(row);
  run(
    db,
    `INSERT INTO ${table} (${cols.join(", ")}) VALUES (${cols.map(() => "?").join(", ")})`,
    Object.values(row),
  );
}

/** Synthetic world: two sellers, a catalog, mandate M1 v1 ($100 cap, $150 budget, only seller_acme). */
export function seedWorld(
  db: Db,
  mandate: Partial<Parameters<typeof insertMandateVersion>[1]> = {},
): void {
  createSeller(db, {
    id: "seller_acme",
    displayName: "Acme (test)",
    payeeRef: "payee_acme",
    now: T0,
  });
  createSeller(db, {
    id: "seller_other",
    displayName: "Other (test)",
    payeeRef: "payee_other",
    now: T0,
  });
  upsertCatalogItem(db, {
    category: "COMPUTE",
    sellerId: "seller_acme",
    sku: "GPU-PACK",
    unitPriceMinor: 8_000,
    currency: "USD",
  });
  upsertCatalogItem(db, {
    category: "COMPUTE",
    sellerId: "seller_acme",
    sku: "GPU-PACK-XL",
    unitPriceMinor: 45_000,
    currency: "USD",
  });
  insertMandateVersion(db, {
    ...POLICY,
    id: "M1",
    ownerId: "demo_operator",
    perTxCapMinor: 10_000,
    totalBudgetMinor: 15_000,
    currency: "USD",
    allowedSellerIds: ["seller_acme"],
    expiresAt: "2027-01-01T00:00:00.000Z",
    status: "ACTIVE",
    now: T0,
    ...mandate,
  });
}

export function worldDb(mandate: Partial<Parameters<typeof insertMandateVersion>[1]> = {}): Db {
  const db = freshDb();
  seedWorld(db, mandate);
  return db;
}

export const newTx = (db: Db, id = "tx1") =>
  createTransaction(db, { id, mandateId: "M1", now: tick() });

export function addOffer(db: Db, txId: string, over: Partial<OfferInput> = {}) {
  return insertOffer(db, {
    id: `offer-${txId}-${Math.random().toString(36).slice(2, 8)}`,
    transactionId: txId,
    sellerId: "seller_acme",
    currency: "USD",
    shippingMinor: 0,
    feesMinor: 0,
    claimedTotalMinor: 8_000,
    termsText: "One GPU pack, all-in.",
    validUntil: "2026-06-01T00:00:00.000Z",
    lines: [{ sku: "GPU-PACK", description: "GPU pack", qty: 1, unitPriceMinor: 8_000 }],
    now: tick(),
    ...over,
  });
}

export function allowDecision(db: Db, txId: string, id = `dec-${txId}`): string {
  recordPolicyDecision(db, {
    id,
    subject: "ACCEPT_OFFER",
    transactionId: txId,
    verdict: "ALLOW",
    reasonCodes: [],
    inputsHash: HASH,
    mandateId: "M1",
    mandateVersion: 1,
    decidedAt: tick(),
  });
  return id;
}

/** A transaction in AGREED with an $80.00 agreement from seller_acme. */
export function agreed(db: Db, id = "tx1") {
  newTx(db, id);
  const offer = addOffer(db, id, { id: `offer-${id}` });
  const decisionId = allowDecision(db, id);
  acceptOffer(db, {
    agreementId: `agr-${id}`,
    offerId: offer.id,
    policyDecisionId: decisionId,
    expectedVersion: 1,
    now: tick(),
    actor: "SYSTEM",
  });
  return { txId: id, offerId: offer.id, agreementId: `agr-${id}`, decisionId, total: 8_000 };
}

/** One CAS transition using the current version. */
export function step(db: Db, id: string, to: TxState, patch: TransitionPatch = {}) {
  const cur = getTransaction(db, id);
  if (!cur) throw new Error(`no transaction ${id}`);
  return transitionTransaction(db, {
    id,
    expectedVersion: cur.version,
    to,
    now: tick(),
    actor: "SYSTEM",
    patch,
  });
}

let attemptSeq = 0;
export function attempt(
  db: Db,
  txId: string,
  action: AttemptAction,
  finish?: "SUCCEEDED" | "FAILED_DEFINITE" | "UNKNOWN",
) {
  const id = `att-${++attemptSeq}`;
  const a = startPaymentAttempt(db, {
    id,
    transactionId: txId,
    action,
    requestHash: HASH,
    now: tick(),
  });
  if (finish)
    finishPaymentAttempt(db, {
      id,
      status: finish,
      httpStatus: finish === "SUCCEEDED" ? 201 : 500,
      now: tick(),
    });
  return a;
}

export function toOrderCreated(db: Db, id = "tx1") {
  const a = agreed(db, id);
  step(db, id, "CREATING_ORDER");
  attempt(db, id, "CREATE_ORDER", "SUCCEEDED");
  step(db, id, "ORDER_CREATED", { paypalOrderId: `ORDER-${id}` });
  return a;
}

export function toAuthorized(db: Db, id = "tx1") {
  const a = toOrderCreated(db, id);
  step(db, id, "ORDER_APPROVED");
  step(db, id, "AUTHORIZING");
  attempt(db, id, "AUTHORIZE", "SUCCEEDED");
  const at = tick();
  step(db, id, "AUTHORIZED", {
    paypalAuthorizationId: `AUTH-${id}`,
    authorizedMinor: a.total,
    authorizedAt: at,
    honorExpiresAt: new Date(Date.parse(at) + 3 * 24 * 3600_000).toISOString(),
  });
  return a;
}

export function toCaptured(db: Db, id = "tx1") {
  const a = toAuthorized(db, id);
  step(db, id, "CAPTURING");
  attempt(db, id, "CAPTURE", "SUCCEEDED");
  step(db, id, "CAPTURED", { paypalCaptureId: `CAP-${id}`, capturedMinor: a.total });
  return a;
}

/**
 * Bypasses the store to poke the triggers directly: appends a TX_STATE_CHANGED event, then updates.
 * Wrap in inTransaction when the update is expected to fail so the event rolls back too.
 */
export function rawTransition(db: Db, txId: string, set: Record<string, SqlParam>): void {
  const cur = getTransaction(db, txId);
  if (!cur) throw new Error(`no transaction ${txId}`);
  const ev = appendAuditEvent(db, {
    ts: tick(),
    actor: "SYSTEM",
    type: "TX_STATE_CHANGED",
    subjectType: "transaction",
    subjectId: txId,
    transactionId: txId,
    payload: { raw: true },
  });
  const cols: Record<string, SqlParam> = {
    version: cur.version + 1,
    last_event_seq: ev.seq,
    updated_at: tick(),
    ...set,
  };
  run(
    db,
    `UPDATE transactions SET ${Object.keys(cols)
      .map((k) => `${k} = ?`)
      .join(", ")} WHERE id = ?`,
    [...Object.values(cols), txId],
  );
}
