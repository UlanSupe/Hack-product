import { canonicalJson } from "../../domain/canonical.ts";
import {
  AUDIT_HASH_VERSION,
  GENESIS_HASH,
  computeEventHash,
  verifyAuditEvents,
  type AuditProvenance,
  type ChainAnchor,
  type ChainEvent,
  type ChainVerification,
} from "../../domain/audit.ts";
import { all, inTransaction, one, type Db } from "./database.ts";

export { GENESIS_HASH, computeEventHash };
export type { AuditProvenance, ChainAnchor, ChainVerification };

export type AuditActor = "OPERATOR" | "AGENT" | "SYSTEM" | "PAYPAL_API" | "PAYPAL_WEBHOOK";

export type AuditEventInput = {
  ts: string;
  actor: AuditActor;
  type: string;
  subjectType: string;
  subjectId: string;
  transactionId?: string | null;
  payload: unknown;
  /**
   * What the payload asserts. Defaults to LOCAL_DECISION: an event is only recorded as an observed external fact
   * when the caller says so, and the database refuses that for a non-PayPal actor.
   */
  provenance?: AuditProvenance;
  /**
   * The mandate / agreement in force. For an event about a transaction they default to the transaction's own
   * mandate and its negotiation agreement at the moment of the append; pass them to say otherwise.
   */
  mandate?: { id: string; version: number | null };
  agreement?: { id: string; version: number | null };
  /** Defaults to `evt_` + the zero-padded sequence number: deterministic, so replays hash identically. */
  eventId?: string;
};

export type AuditEvent = ChainEvent & { actor: AuditActor };

type AuditRow = {
  seq: number;
  hash_version: number;
  event_id: string | null;
  ts: string;
  actor: AuditActor;
  type: string;
  subject_type: string;
  subject_id: string;
  transaction_id: string | null;
  mandate_id: string | null;
  mandate_version: number | null;
  agreement_id: string | null;
  agreement_version: number | null;
  provenance: AuditProvenance | null;
  payload: string;
  prev_hash: string;
  hash: string;
};

const fromRow = (r: AuditRow): AuditEvent => ({
  hashVersion: r.hash_version,
  seq: r.seq,
  eventId: r.event_id,
  ts: r.ts,
  actor: r.actor,
  type: r.type,
  subjectType: r.subject_type,
  subjectId: r.subject_id,
  transactionId: r.transaction_id,
  mandateId: r.mandate_id,
  mandateVersion: r.mandate_version,
  agreementId: r.agreement_id,
  agreementVersion: r.agreement_version,
  provenance: r.provenance,
  payload: r.payload,
  prevHash: r.prev_hash,
  hash: r.hash,
});

// Keys that must never appear in stored payloads: defence in depth for "never store secrets".
const SECRET_KEY =
  /secret|password|passcode|credential|cvv|card[_-]?number|api[_-]?key|private[_-]?key|access[_-]?token|refresh[_-]?token|bearer|^authorization$|^cookie$/i;
// ...and values that are plainly an HTTP credential, whatever their key is called.
const SECRET_VALUE = /^\s*bearer\s+[\w.~+/=-]{8,}/i;

export function assertNoSecretKeys(value: unknown, path = "payload"): void {
  if (typeof value === "string") {
    if (SECRET_VALUE.test(value))
      throw new TypeError(`refusing to store a credential-looking value at ${path}`);
  } else if (Array.isArray(value)) value.forEach((v, i) => assertNoSecretKeys(v, `${path}[${i}]`));
  else if (value !== null && typeof value === "object") {
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (SECRET_KEY.test(k))
        throw new TypeError(`refusing to store secret-looking key at ${path}.${k}`);
      assertNoSecretKeys(v, `${path}.${k}`);
    }
  }
}

/** The mandate and agreement a transaction is bound to right now (null parts when it has none yet). */
function transactionContext(db: Db, transactionId: string) {
  return one<{
    mandate_id: string;
    mandate_version: number;
    agreement_id: string | null;
    agreement_version: number | null;
  }>(
    db,
    `SELECT t.mandate_id, t.mandate_version, l.agreement_id, l.version AS agreement_version
       FROM transactions t LEFT JOIN negotiation_agreements l ON l.transaction_id = t.id
      WHERE t.id = ?`,
    [transactionId],
  );
}

/**
 * Appends one event, linking it to the previous event's hash. Safe to call inside a larger
 * transaction (it nests as a savepoint). The database independently enforces gap-free seq
 * and prev_hash linkage, so a racing writer cannot fork the chain.
 */
export function appendAuditEvent(db: Db, input: AuditEventInput): AuditEvent {
  assertNoSecretKeys(input.payload);
  return inTransaction(db, () => {
    const last = one<{ seq: number; hash: string }>(
      db,
      "SELECT seq, hash FROM audit_events ORDER BY seq DESC LIMIT 1",
    );
    const transactionId = input.transactionId ?? null;
    const ctx = transactionId ? transactionContext(db, transactionId) : undefined;
    const seq = (last?.seq ?? 0) + 1;
    const unsigned: Omit<AuditEvent, "hash"> = {
      hashVersion: AUDIT_HASH_VERSION,
      seq,
      eventId: input.eventId ?? `evt_${String(seq).padStart(8, "0")}`,
      ts: input.ts,
      actor: input.actor,
      type: input.type,
      subjectType: input.subjectType,
      subjectId: input.subjectId,
      transactionId,
      mandateId: input.mandate?.id ?? ctx?.mandate_id ?? null,
      mandateVersion: input.mandate ? input.mandate.version : (ctx?.mandate_version ?? null),
      agreementId: input.agreement?.id ?? ctx?.agreement_id ?? null,
      agreementVersion: input.agreement
        ? input.agreement.version
        : (ctx?.agreement_version ?? null),
      provenance: input.provenance ?? "LOCAL_DECISION",
      payload: canonicalJson(input.payload),
      prevHash: last?.hash ?? GENESIS_HASH,
    };
    const event: AuditEvent = { ...unsigned, hash: computeEventHash(unsigned) };
    db.prepare(
      `INSERT INTO audit_events (seq, hash_version, event_id, ts, actor, type, subject_type, subject_id, transaction_id,
                                 mandate_id, mandate_version, agreement_id, agreement_version, provenance,
                                 payload, prev_hash, hash)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      event.seq,
      event.hashVersion,
      event.eventId,
      event.ts,
      event.actor,
      event.type,
      event.subjectType,
      event.subjectId,
      event.transactionId,
      event.mandateId,
      event.mandateVersion,
      event.agreementId,
      event.agreementVersion,
      event.provenance,
      event.payload,
      event.prevHash,
      event.hash,
    );
    return event;
  });
}

/** The whole log, oldest first. */
export function readAuditEvents(db: Db): AuditEvent[] {
  // ponytail: loads every event; stream with .iterate() if the log ever gets large.
  return all<AuditRow>(db, "SELECT * FROM audit_events ORDER BY seq").map(fromRow);
}

/**
 * Recomputes the whole chain and reports the first invalid event (its seq and event id). VERIFIED means internally
 * consistent, not authentic: whoever can write every row can write a chain that verifies. Pass an `anchor`
 * (count + head hash kept outside this database) to also detect removal of the newest events.
 */
export function verifyChain(db: Db, anchor?: ChainAnchor): ChainVerification {
  return verifyAuditEvents(readAuditEvents(db), anchor);
}
