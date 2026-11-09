import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  AUDIT_HASH_VERSION,
  GENESIS_HASH,
  LEGACY_HASH_VERSION,
  computeEventHash,
  verifyAuditEvents,
  type ChainEvent,
} from "./audit.ts";
import { canonicalJson } from "./canonical.ts";

const sha = (s: string) => createHash("sha256").update(s, "utf8").digest("hex");

type Overrides = Partial<Omit<ChainEvent, "hash">>;

/** A version-2 event with its hash filled in. */
function v2(over: Overrides = {}): ChainEvent {
  const e: Omit<ChainEvent, "hash"> = {
    hashVersion: AUDIT_HASH_VERSION,
    seq: 1,
    eventId: "evt_00000001",
    ts: "2026-01-01T00:00:00.000Z",
    actor: "SYSTEM",
    type: "NOTE",
    subjectType: "note",
    subjectId: "n1",
    transactionId: null,
    mandateId: null,
    mandateVersion: null,
    agreementId: null,
    agreementVersion: null,
    provenance: "LOCAL_DECISION",
    payload: "{}",
    prevHash: GENESIS_HASH,
    ...over,
  };
  return { ...e, hash: computeEventHash(e) };
}

/** A version-1 (legacy) event, hashed exactly the way the original implementation did. */
function v1(over: Overrides = {}): ChainEvent {
  const e: Omit<ChainEvent, "hash"> = {
    ...v2(),
    hashVersion: LEGACY_HASH_VERSION,
    eventId: null,
    provenance: null,
    ...over,
  };
  return { ...e, hash: computeEventHash(e) };
}

/** Builds a linked chain of n version-2 events, seq 1..n. */
function chain(n: number, over: (i: number) => Overrides = () => ({})): ChainEvent[] {
  const out: ChainEvent[] = [];
  let prev = GENESIS_HASH;
  for (let i = 1; i <= n; i++) {
    const e = v2({
      seq: i,
      eventId: `evt_${String(i).padStart(8, "0")}`,
      payload: canonicalJson({ n: i }),
      prevHash: prev,
      ...over(i),
    });
    out.push(e);
    prev = e.hash;
  }
  return out;
}

/** Re-hashes events from `from` on, as an attacker who could write the whole log would. */
function rehash(events: ChainEvent[], from = 0): ChainEvent[] {
  const out = events.slice();
  for (let i = from; i < out.length; i++) {
    const prevHash = i === 0 ? GENESIS_HASH : (out[i - 1] as ChainEvent).hash;
    const { hash: _old, ...rest } = out[i] as ChainEvent;
    void _old;
    const e = { ...rest, prevHash };
    out[i] = { ...e, hash: computeEventHash(e) };
  }
  return out;
}

describe("computeEventHash", () => {
  it("version 2 is SHA-256 over the documented domain prefix and canonical JSON of every field but the hash", () => {
    const e = v2({ transactionId: "tx1", mandateId: "M1", mandateVersion: 3, payload: '{"a":1}' });
    const { hash, ...rest } = e;
    const expected = sha(`pactpay.audit.v2\n${canonicalJson(rest)}`);
    expect(hash).toBe(expected);
    expect(Object.keys(rest).sort()).toEqual(
      [
        "agreementId",
        "agreementVersion",
        "actor",
        "eventId",
        "hashVersion",
        "mandateId",
        "mandateVersion",
        "payload",
        "prevHash",
        "provenance",
        "seq",
        "subjectId",
        "subjectType",
        "transactionId",
        "ts",
        "type",
      ].sort(),
    );
  });

  it("version 1 is the original nine-field form, unchanged", () => {
    const e = v1({ seq: 1, payload: '{"x":1}', transactionId: null });
    const original = sha(
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
    expect(e.hash).toBe(original);
  });

  it("known answer: a fixed event always hashes to this digest (a format change must be a new version)", () => {
    // The canonical text below is written out by hand (sorted keys, no whitespace), not produced by canonicalJson.
    const text =
      '{"actor":"SYSTEM","agreementId":null,"agreementVersion":null,"eventId":"evt_00000001","hashVersion":2,' +
      '"mandateId":null,"mandateVersion":null,"payload":"{}","prevHash":"' +
      GENESIS_HASH +
      '","provenance":"LOCAL_DECISION","seq":1,"subjectId":"n1","subjectType":"note","transactionId":null,' +
      '"ts":"2026-01-01T00:00:00.000Z","type":"NOTE"}';
    expect(sha(`pactpay.audit.v2\n${text}`)).toBe(
      "187b18d49e6d86ef14b88e6fe81c2c6a39f9279ca8ed9761bf8f150df6106521",
    );
    expect(v2().hash).toBe("187b18d49e6d86ef14b88e6fe81c2c6a39f9279ca8ed9761bf8f150df6106521");
  });

  it("is deterministic and does not depend on key order of the object it hashes", () => {
    const a = v2({ payload: canonicalJson({ b: 1, a: { d: 2, c: 3 } }) });
    const b = v2({ payload: canonicalJson({ a: { c: 3, d: 2 }, b: 1 }) });
    expect(a.hash).toBe(b.hash);
  });

  it("changes when any single covered field changes", () => {
    const base = v2({
      transactionId: "tx1",
      mandateId: "M1",
      mandateVersion: 1,
      agreementId: "agr1",
      agreementVersion: 1,
      actor: "PAYPAL_API",
    });
    const { hash: _h, ...rest } = base;
    void _h;
    const variants: Overrides[] = [
      { seq: 2 },
      { eventId: "evt_other" },
      { ts: "2026-01-01T00:00:01.000Z" },
      { actor: "SYSTEM" },
      { type: "OTHER" },
      { subjectType: "other" },
      { subjectId: "other" },
      { transactionId: "tx2" },
      { transactionId: null },
      { mandateId: "M2" },
      { mandateVersion: 2 },
      { agreementId: "agr2" },
      { agreementVersion: 2 },
      { provenance: "OBSERVED_EXTERNAL" },
      { payload: '{"a":1}' },
      { prevHash: "f".repeat(64) },
    ];
    for (const v of variants) {
      expect(computeEventHash({ ...rest, ...v }), JSON.stringify(v)).not.toBe(base.hash);
    }
  });

  it("refuses an unknown hash version instead of guessing", () => {
    expect(() => computeEventHash({ ...v2(), hashVersion: 3 })).toThrow(
      /unknown audit hash version/,
    );
  });

  it("distinguishes a version-2 digest from a version-1 digest of the same fields", () => {
    expect(v2().hash).not.toBe(v1().hash);
  });
});

describe("verifyAuditEvents", () => {
  it("verifies an empty log, a single event and a long chain", () => {
    expect(verifyAuditEvents([])).toEqual({
      status: "VERIFIED",
      count: 0,
      headHash: GENESIS_HASH,
      legacyCount: 0,
    });
    const one = chain(1);
    expect(verifyAuditEvents(one)).toMatchObject({ status: "VERIFIED", count: 1 });
    const many = chain(200);
    expect(verifyAuditEvents(many)).toEqual({
      status: "VERIFIED",
      count: 200,
      headHash: (many.at(-1) as ChainEvent).hash,
      legacyCount: 0,
    });
  });

  it("verifies a log that begins with legacy events and continues with version 2", () => {
    const a = v1({ seq: 1 });
    const b = v1({ seq: 2, prevHash: a.hash });
    const c = v2({ seq: 3, prevHash: b.hash, eventId: "evt_00000003" });
    expect(verifyAuditEvents([a, b, c])).toMatchObject({
      status: "VERIFIED",
      count: 3,
      legacyCount: 2,
      headHash: c.hash,
    });
  });

  it("reports a modified payload at that event, with its id, and nothing before it", () => {
    const events = chain(5);
    const tampered = events.map((e) => (e.seq === 3 ? { ...e, payload: '{"n":999}' } : e));
    expect(verifyAuditEvents(tampered)).toMatchObject({
      status: "FAILED",
      firstBadSeq: 3,
      firstBadEventId: "evt_00000003",
      code: "HASH_MISMATCH",
      reason: "hash does not match event contents",
    });
  });

  it("reports the FIRST invalid event when several are damaged", () => {
    const events = chain(6);
    const tampered = events.map((e) =>
      e.seq === 5 ? { ...e, type: "X" } : e.seq === 2 ? { ...e, subjectId: "x" } : e,
    );
    expect(verifyAuditEvents(tampered)).toMatchObject({ firstBadSeq: 2, code: "HASH_MISMATCH" });
  });

  it("detects a deleted event in the middle, the start, and as a sequence hole", () => {
    const events = chain(5);
    expect(verifyAuditEvents(events.filter((e) => e.seq !== 3))).toMatchObject({
      status: "FAILED",
      firstBadSeq: 4,
      code: "SEQUENCE_GAP_OR_REORDER",
    });
    expect(verifyAuditEvents(events.filter((e) => e.seq !== 1))).toMatchObject({
      status: "FAILED",
      firstBadSeq: 2,
      code: "SEQUENCE_GAP_OR_REORDER",
    });
  });

  it("detects reordered events", () => {
    const events = chain(4);
    const swapped = [events[0], events[2], events[1], events[3]] as ChainEvent[];
    expect(verifyAuditEvents(swapped)).toMatchObject({
      status: "FAILED",
      firstBadSeq: 3,
      code: "SEQUENCE_GAP_OR_REORDER",
    });
    // reordered AND renumbered: the previous-hash links now point the wrong way
    const renumbered = swapped.map((e, i) => ({ ...e, seq: i + 1 }));
    expect(verifyAuditEvents(renumbered)).toMatchObject({
      status: "FAILED",
      firstBadSeq: 2,
      code: "PREV_HASH_MISMATCH",
    });
  });

  it("detects a broken previous hash, including a first event that does not start at genesis", () => {
    const events = chain(4);
    const broken = events.map((e) => (e.seq === 3 ? { ...e, prevHash: "e".repeat(64) } : e));
    expect(verifyAuditEvents(broken)).toMatchObject({
      status: "FAILED",
      firstBadSeq: 3,
      code: "PREV_HASH_MISMATCH",
    });
    const noGenesis = events.map((e) => (e.seq === 1 ? { ...e, prevHash: "e".repeat(64) } : e));
    expect(verifyAuditEvents(noGenesis)).toMatchObject({
      firstBadSeq: 1,
      code: "PREV_HASH_MISMATCH",
    });
  });

  it("detects a swapped-in event from another chain even though it is self-consistent", () => {
    const events = chain(4);
    const foreign = v2({
      seq: 3,
      eventId: "evt_00000003",
      prevHash: (events[1] as ChainEvent).hash,
      payload: '{"n":42}',
    });
    const spliced = [events[0], events[1], foreign, events[3]] as ChainEvent[];
    // the spliced event is valid in itself and in its link; the NEXT event no longer links to it
    expect(verifyAuditEvents(spliced)).toMatchObject({
      status: "FAILED",
      firstBadSeq: 4,
      code: "PREV_HASH_MISMATCH",
    });
  });

  it("rejects each field of a version-2 event being changed without re-hashing", () => {
    const events = chain(3, (i) =>
      i === 2
        ? {
            actor: "PAYPAL_API",
            transactionId: "tx1",
            mandateId: "M1",
            mandateVersion: 1,
            agreementId: "agr1",
            agreementVersion: 1,
            provenance: "OBSERVED_EXTERNAL" as const,
          }
        : {},
    );
    const changes: Overrides[] = [
      { eventId: "evt_changed" },
      { ts: "2027-01-01T00:00:00.000Z" },
      { actor: "SYSTEM", provenance: "LOCAL_DECISION" },
      { type: "ELSE" },
      { subjectType: "else" },
      { subjectId: "else" },
      { transactionId: "tx2" },
      { transactionId: null },
      { mandateId: "M9" },
      { mandateVersion: 9 },
      { agreementId: "agr9" },
      { agreementVersion: 9 },
      { provenance: "LOCAL_DECISION" },
    ];
    for (const c of changes) {
      const tampered = events.map((e) => (e.seq === 2 ? { ...e, ...c } : e));
      expect(verifyAuditEvents(tampered), JSON.stringify(c)).toMatchObject({
        status: "FAILED",
        firstBadSeq: 2,
        firstBadEventId: c.eventId ?? "evt_00000002",
      });
    }
  });

  it("flags a version-1 event carrying fields its hash does not cover", () => {
    const a = v1({ seq: 1 });
    const sneaky = { ...a, mandateVersion: 7, mandateId: "M1" };
    expect(verifyAuditEvents([sneaky])).toMatchObject({ firstBadSeq: 1, code: "MALFORMED_EVENT" });
    const withId = { ...a, eventId: "evt_x" };
    expect(verifyAuditEvents([withId])).toMatchObject({ firstBadSeq: 1, code: "MALFORMED_EVENT" });
  });

  it("flags a downgrade: a version-1 event after a version-2 event", () => {
    const a = v2({ seq: 1 });
    const b = v1({ seq: 2, prevHash: a.hash });
    expect(verifyAuditEvents([a, b])).toMatchObject({
      firstBadSeq: 2,
      code: "HASH_VERSION_DOWNGRADE",
    });
  });

  it("flags an unknown hash version as malformed rather than throwing", () => {
    const a = { ...v2(), hashVersion: 9 };
    expect(verifyAuditEvents([a])).toMatchObject({ firstBadSeq: 1, code: "MALFORMED_EVENT" });
  });

  it("flags a duplicate event id", () => {
    const a = v2({ seq: 1, eventId: "evt_same" });
    const b = v2({ seq: 2, eventId: "evt_same", prevHash: a.hash });
    expect(verifyAuditEvents([a, b])).toMatchObject({
      firstBadSeq: 2,
      firstBadEventId: "evt_same",
      code: "DUPLICATE_EVENT_ID",
    });
  });

  it("flags a missing provenance and a local actor claiming an observed external fact", () => {
    expect(verifyAuditEvents([v2({ provenance: null })])).toMatchObject({
      code: "MALFORMED_EVENT",
    });
    expect(
      verifyAuditEvents([v2({ actor: "OPERATOR", provenance: "OBSERVED_EXTERNAL" })]),
    ).toMatchObject({ code: "MALFORMED_EVENT" });
    expect(
      verifyAuditEvents([v2({ actor: "PAYPAL_WEBHOOK", provenance: "OBSERVED_EXTERNAL" })]),
    ).toMatchObject({
      status: "VERIFIED",
    });
  });

  it("flags a version number without its id, and a non-canonical payload", () => {
    expect(verifyAuditEvents([v2({ mandateVersion: 2 })])).toMatchObject({
      code: "MALFORMED_EVENT",
    });
    expect(verifyAuditEvents([v2({ agreementVersion: 2 })])).toMatchObject({
      code: "MALFORMED_EVENT",
    });
    // hashed consistently, but the stored text is not the canonical form of its own content
    expect(verifyAuditEvents([v2({ payload: '{ "a": 1 }' })])).toMatchObject({
      firstBadSeq: 1,
      code: "MALFORMED_EVENT",
      reason: "payload is not in canonical form",
    });
    expect(verifyAuditEvents([v2({ payload: "{not json" })])).toMatchObject({
      code: "MALFORMED_EVENT",
    });
  });

  it("never puts payload text in a failure result", () => {
    const secretish = "PAYLOAD-MARKER-4f1c";
    const events = chain(3, (i) =>
      i === 2 ? { payload: canonicalJson({ note: secretish }) } : {},
    );
    const tampered = events.map((e) =>
      e.seq === 2 ? { ...e, ts: "2027-01-01T00:00:00.000Z" } : e,
    );
    const result = verifyAuditEvents(tampered);
    expect(result.status).toBe("FAILED");
    expect(JSON.stringify(result)).not.toContain(secretish);
  });

  describe("with an anchor (a count and head hash remembered outside the database)", () => {
    it("is satisfied by the same chain and by a chain that has only grown", () => {
      const events = chain(5);
      const anchor = { count: 3, headHash: (events[2] as ChainEvent).hash };
      expect(verifyAuditEvents(events, anchor).status).toBe("VERIFIED");
      expect(verifyAuditEvents(events.slice(0, 3), anchor).status).toBe("VERIFIED");
    });

    it("detects removal of the newest events, which the chain alone cannot show", () => {
      const events = chain(5);
      const anchor = { count: 5, headHash: (events[4] as ChainEvent).hash };
      expect(verifyAuditEvents(events.slice(0, 4)).status).toBe("VERIFIED"); // the limitation
      expect(verifyAuditEvents(events.slice(0, 4), anchor)).toMatchObject({
        status: "FAILED",
        firstBadSeq: 5,
        firstBadEventId: null,
        code: "TRUNCATED",
      });
    });

    it("detects a whole chain rewritten after the anchor was taken", () => {
      const events = chain(5);
      const anchor = { count: 5, headHash: (events[4] as ChainEvent).hash };
      const rewritten = rehash(events.map((e) => (e.seq === 2 ? { ...e, payload: '{"n":0}' } : e)));
      expect(verifyAuditEvents(rewritten).status).toBe("VERIFIED"); // the limitation
      expect(verifyAuditEvents(rewritten, anchor)).toMatchObject({
        status: "FAILED",
        firstBadSeq: 5,
        code: "ANCHOR_MISMATCH",
      });
    });
  });

  it("documented limitation: a writer who re-hashes every later event passes verification", () => {
    const events = chain(4);
    const rewritten = rehash(events.map((e) => (e.seq === 1 ? { ...e, payload: '{"n":0}' } : e)));
    expect(verifyAuditEvents(rewritten)).toMatchObject({ status: "VERIFIED", count: 4 });
    expect((rewritten.at(-1) as ChainEvent).hash).not.toBe((events.at(-1) as ChainEvent).hash);
  });
});
