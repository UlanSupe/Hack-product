import { canonicalJson, sha256Hex } from "./canonical.ts";

/**
 * The audit hash chain, as pure functions (no database). See docs/AUDIT_CHAIN.md.
 *
 * Each event is hashed with SHA-256 over a deterministic canonical serialization of every field it carries plus
 * the previous event's hash. That makes a partial edit, deletion or reordering detectable by recomputation. It is
 * NOT a signature: nothing here involves a secret key, so anyone who can write the whole log can write a chain
 * that verifies. See "Threat model" in docs/AUDIT_CHAIN.md.
 */

/** prev_hash of the first event. */
export const GENESIS_HASH = "0".repeat(64);

/** Events written before hash version 2 existed. They keep verifying under their original form. */
export const LEGACY_HASH_VERSION = 1;
export const AUDIT_HASH_VERSION = 2;

/**
 * What the payload of an event asserts.
 *  - OBSERVED_EXTERNAL: a fact PayPal reported (and only a PayPal actor may say so). Still just "PayPal told us",
 *    recorded by us; the hash chain does not prove PayPal said it.
 *  - LOCAL_DECISION: something this system (or its operator) decided, did, refused or noticed.
 */
export type AuditProvenance = "LOCAL_DECISION" | "OBSERVED_EXTERNAL";

export const PAYPAL_ACTORS: readonly string[] = ["PAYPAL_API", "PAYPAL_WEBHOOK"];

/** An event as stored. Version-1 events have null for every field their hash does not cover. */
export type ChainEvent = {
  hashVersion: number;
  seq: number;
  eventId: string | null;
  ts: string;
  actor: string;
  type: string;
  subjectType: string;
  subjectId: string;
  transactionId: string | null;
  /** The mandate (and version) in force for the event, when it concerns one. */
  mandateId: string | null;
  mandateVersion: number | null;
  /** The agreement (and negotiation agreement version) in force for the event, when it concerns one. */
  agreementId: string | null;
  agreementVersion: number | null;
  provenance: AuditProvenance | null;
  /** Canonical JSON text. This exact string is what the hash covers. */
  payload: string;
  prevHash: string;
  hash: string;
};

const V2_DOMAIN = "pactpay.audit.v2\n";

/**
 * Version 1: SHA-256(canonicalJson({seq, ts, actor, type, subjectType, subjectId, transactionId, payload, prevHash})).
 * Version 2: SHA-256("pactpay.audit.v2\n" + canonicalJson(every field of the event except `hash`)). The prefix stops
 * a version-2 digest from being reinterpreted as a version-1 one; the version number is itself hashed.
 * Any other version throws: an unknown format cannot be silently treated as valid.
 */
export function computeEventHash(e: Omit<ChainEvent, "hash">): string {
  if (e.hashVersion === LEGACY_HASH_VERSION) {
    return sha256Hex(
      canonicalJson({
        seq: e.seq,
        ts: e.ts,
        actor: e.actor,
        type: e.type,
        subjectType: e.subjectType,
        subjectId: e.subjectId,
        transactionId: e.transactionId,
        payload: e.payload,
        prevHash: e.prevHash,
      }),
    );
  }
  if (e.hashVersion === AUDIT_HASH_VERSION) {
    return sha256Hex(
      V2_DOMAIN +
        canonicalJson({
          hashVersion: e.hashVersion,
          seq: e.seq,
          eventId: e.eventId,
          ts: e.ts,
          actor: e.actor,
          type: e.type,
          subjectType: e.subjectType,
          subjectId: e.subjectId,
          transactionId: e.transactionId,
          mandateId: e.mandateId,
          mandateVersion: e.mandateVersion,
          agreementId: e.agreementId,
          agreementVersion: e.agreementVersion,
          provenance: e.provenance,
          payload: e.payload,
          prevHash: e.prevHash,
        }),
    );
  }
  throw new RangeError(`unknown audit hash version ${String(e.hashVersion)}`);
}

export type ChainFailureCode =
  | "SEQUENCE_GAP_OR_REORDER"
  | "PREV_HASH_MISMATCH"
  | "HASH_MISMATCH"
  | "MALFORMED_EVENT"
  | "HASH_VERSION_DOWNGRADE"
  | "DUPLICATE_EVENT_ID"
  | "TRUNCATED"
  | "ANCHOR_MISMATCH";

export type ChainVerification =
  | {
      status: "VERIFIED";
      count: number;
      headHash: string;
      /** How many leading events are version 1 (hashed over fewer fields). */
      legacyCount: number;
    }
  | {
      status: "FAILED";
      count: number;
      /** The first event (lowest position in the log) that does not check out. */
      firstBadSeq: number;
      firstBadEventId: string | null;
      code: ChainFailureCode;
      /** Never contains payload text. */
      reason: string;
    };

/**
 * A (count, head hash) pair remembered somewhere an attacker of the database cannot write. With it, removal of
 * the newest events, which no chain can show by itself, becomes detectable.
 */
export type ChainAnchor = { count: number; headHash: string };

const HEX64 = /^[0-9a-f]{64}$/;
const isInt = (n: unknown): n is number => typeof n === "number" && Number.isInteger(n);

/** Structural problems that would leave a field outside the hash's protection, or are contradictory. */
function malformed(e: ChainEvent): string | undefined {
  if (!HEX64.test(e.prevHash) || !HEX64.test(e.hash))
    return "prev_hash or hash is not a SHA-256 hex digest";
  if (e.hashVersion === LEGACY_HASH_VERSION) {
    const extra =
      e.eventId !== null ||
      e.mandateId !== null ||
      e.mandateVersion !== null ||
      e.agreementId !== null ||
      e.agreementVersion !== null ||
      e.provenance !== null;
    return extra ? "a version-1 event carries fields its hash does not cover" : undefined;
  }
  if (e.hashVersion !== AUDIT_HASH_VERSION) return "unknown hash version";
  if (e.eventId === null || e.eventId.length === 0) return "event id is missing";
  if (e.provenance !== "LOCAL_DECISION" && e.provenance !== "OBSERVED_EXTERNAL")
    return "provenance is missing or unknown";
  if (e.provenance === "OBSERVED_EXTERNAL" && !PAYPAL_ACTORS.includes(e.actor))
    return "only a PayPal actor can record an observed external fact";
  if (
    (e.mandateVersion !== null && e.mandateId === null) ||
    (e.mandateVersion !== null && !isInt(e.mandateVersion))
  )
    return "mandate version without a valid mandate id";
  if (
    (e.agreementVersion !== null && e.agreementId === null) ||
    (e.agreementVersion !== null && !isInt(e.agreementVersion))
  )
    return "agreement version without a valid agreement id";
  return undefined;
}

function payloadIsCanonical(payload: string): boolean {
  try {
    return canonicalJson(JSON.parse(payload) as unknown) === payload;
  } catch {
    return false;
  }
}

/**
 * Checks the whole log, oldest first, and reports the FIRST event that does not verify.
 * VERIFIED means "internally consistent" (and consistent with the anchor, if one was given). It does not mean the
 * events are true, nor that the log was not rewritten end to end by someone who could write all of it.
 */
export function verifyAuditEvents(
  events: readonly ChainEvent[],
  anchor?: ChainAnchor,
): ChainVerification {
  let prev = GENESIS_HASH;
  let sawV2 = false;
  let legacyCount = 0;
  const ids = new Set<string>();
  const count = events.length;

  for (const [i, e] of events.entries()) {
    const fail = (code: ChainFailureCode, reason: string): ChainVerification => ({
      status: "FAILED",
      count,
      firstBadSeq: e.seq,
      firstBadEventId: e.eventId,
      code,
      reason,
    });
    if (e.seq !== i + 1) return fail("SEQUENCE_GAP_OR_REORDER", "sequence gap or reorder");
    if (e.prevHash !== prev)
      return fail("PREV_HASH_MISMATCH", "prev_hash does not match the previous event");
    if (e.hashVersion === LEGACY_HASH_VERSION && sawV2)
      return fail("HASH_VERSION_DOWNGRADE", "a version-1 event follows a version-2 event");
    const problem = malformed(e);
    if (problem) return fail("MALFORMED_EVENT", problem);
    const { hash, ...unsigned } = e;
    if (computeEventHash(unsigned) !== hash)
      return fail("HASH_MISMATCH", "hash does not match event contents");
    if (e.hashVersion === AUDIT_HASH_VERSION) {
      sawV2 = true;
      if (!payloadIsCanonical(e.payload))
        return fail("MALFORMED_EVENT", "payload is not in canonical form");
      if (e.eventId !== null) {
        if (ids.has(e.eventId)) return fail("DUPLICATE_EVENT_ID", "event id was already used");
        ids.add(e.eventId);
      }
    } else {
      legacyCount += 1;
    }
    prev = hash;
  }

  if (anchor && anchor.count > 0) {
    if (count < anchor.count) {
      return {
        status: "FAILED",
        count,
        firstBadSeq: count + 1,
        firstBadEventId: null,
        code: "TRUNCATED",
        reason: `the log has ${count} events but the anchor records ${anchor.count}`,
      };
    }
    const at = events[anchor.count - 1];
    if (at && at.hash !== anchor.headHash) {
      return {
        status: "FAILED",
        count,
        firstBadSeq: at.seq,
        firstBadEventId: at.eventId,
        code: "ANCHOR_MISMATCH",
        reason: "the event at the anchored position has a different hash than the anchor",
      };
    }
  }
  return { status: "VERIFIED", count, headHash: prev, legacyCount };
}
