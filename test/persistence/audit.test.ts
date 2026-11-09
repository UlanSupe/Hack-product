import { describe, expect, it } from "vitest";

import {
  GENESIS_HASH,
  appendAuditEvent,
  computeEventHash,
  readAuditEvents,
  verifyChain,
} from "@/adapters/sqlite/audit";
import { inTransaction, run, type SqlParam } from "@/adapters/sqlite/database";

import { HASH, count, expectRejected, freshDb, rawInsert, tick, worldDb } from "./helpers";

const ev = (db: ReturnType<typeof freshDb>, type = "NOTE", payload: unknown = {}) =>
  appendAuditEvent(db, {
    ts: tick(),
    actor: "SYSTEM",
    type,
    subjectType: "note",
    subjectId: "n1",
    payload,
  });

describe("audit chain", () => {
  it("starts at the genesis hash, links each event to the previous one and numbers them gap-free", () => {
    const db = freshDb();
    const a = ev(db);
    const b = ev(db);
    const c = ev(db);
    expect([a.seq, b.seq, c.seq]).toEqual([1, 2, 3]);
    expect(a.prevHash).toBe(GENESIS_HASH);
    expect(b.prevHash).toBe(a.hash);
    expect(c.prevHash).toBe(b.hash);
    expect(new Set([a.hash, b.hash, c.hash]).size).toBe(3);
    expect(verifyChain(db)).toEqual({
      status: "VERIFIED",
      count: 3,
      headHash: c.hash,
      legacyCount: 0,
    });
  });

  it("verifies an empty log", () => {
    expect(verifyChain(freshDb())).toEqual({
      status: "VERIFIED",
      count: 0,
      headHash: GENESIS_HASH,
      legacyCount: 0,
    });
  });

  it("stores canonical JSON so key order cannot change the recorded payload", () => {
    const db = freshDb();
    const a = ev(db, "X", { b: 1, a: { d: 2, c: 3 } });
    expect(a.payload).toBe('{"a":{"c":3,"d":2},"b":1}');
    const { hash, ...unsigned } = a;
    expect(computeEventHash(unsigned)).toBe(hash);
    expect(a.hashVersion).toBe(2);
    // the hash covers the canonical payload: a different key order cannot produce a different event
    const b = ev(db, "X", { a: { c: 3, d: 2 }, b: 1 });
    expect(b.payload).toBe(a.payload);
  });

  it("is rolled back with the surrounding transaction (no orphan events)", () => {
    const db = freshDb();
    ev(db);
    expectRejected(() =>
      inTransaction(db, () => {
        ev(db);
        throw new Error("boom");
      }),
    );
    expect(count(db, "audit_events")).toBe(1);
    expect(verifyChain(db).status).toBe("VERIFIED");
  });
});

describe("audit constraints enforced by the database", () => {
  let n = 0;
  const row = (over: Record<string, SqlParam> = {}): Record<string, SqlParam> => ({
    seq: 2,
    hash_version: 2,
    event_id: `evt_raw_${++n}`,
    provenance: "LOCAL_DECISION",
    ts: tick(),
    actor: "SYSTEM",
    type: "NOTE",
    subject_type: "note",
    subject_id: "n1",
    transaction_id: null,
    payload: "{}",
    prev_hash: "",
    hash: "9".repeat(64),
    ...over,
  });

  it("refuses forks, gaps and bad linkage", () => {
    const db = freshDb();
    const first = ev(db);
    expectRejected(
      () => rawInsert(db, "audit_events", row({ prev_hash: HASH })),
      /prev_hash must equal/,
    );
    expectRejected(
      () => rawInsert(db, "audit_events", row({ prev_hash: GENESIS_HASH })),
      /prev_hash must equal/,
    ); // a fork off genesis
    expectRejected(
      () => rawInsert(db, "audit_events", row({ seq: 5, prev_hash: first.hash })),
      /previous seq \+ 1/,
    );
    expectRejected(
      () => rawInsert(db, "audit_events", row({ seq: 1, prev_hash: first.hash })),
      /previous seq \+ 1/,
    );
    expect(count(db, "audit_events")).toBe(1);
    rawInsert(db, "audit_events", row({ prev_hash: first.hash })); // control: a correctly linked row is accepted by the DB
    expect(verifyChain(db)).toMatchObject({ status: "FAILED", firstBadSeq: 2 }); // ...but its fake hash fails verification
  });

  it("is append-only", () => {
    const db = freshDb();
    ev(db);
    expectRejected(
      () => run(db, "UPDATE audit_events SET payload = '{}' WHERE seq = 1"),
      /append-only/,
    );
    expectRejected(() => run(db, "DELETE FROM audit_events WHERE seq = 1"), /append-only/);
  });

  it("validates actor, timestamps, payload shape/size, hashes and the transaction reference", () => {
    const db = freshDb();
    const first = ev(db);
    const base = (over: Record<string, SqlParam>) => row({ prev_hash: first.hash, ...over });
    expectRejected(
      () => rawInsert(db, "audit_events", base({ actor: "WIZARD" })),
      /CHECK constraint failed/,
    );
    expectRejected(
      () => rawInsert(db, "audit_events", base({ ts: "now" })),
      /CHECK constraint failed/,
    );
    expectRejected(
      () => rawInsert(db, "audit_events", base({ payload: "{not json" })),
      /CHECK constraint failed/,
    );
    expectRejected(
      () => rawInsert(db, "audit_events", base({ payload: `"${"x".repeat(16_400)}"` })),
      /CHECK constraint failed/,
    );
    expectRejected(
      () => rawInsert(db, "audit_events", base({ hash: "short" })),
      /CHECK constraint failed/,
    );
    expectRejected(
      () => rawInsert(db, "audit_events", base({ hash: first.hash })),
      /UNIQUE constraint failed: audit_events\.hash/,
    );
    expectRejected(
      () => rawInsert(db, "audit_events", base({ type: "" })),
      /CHECK constraint failed/,
    );
    expectRejected(
      () => rawInsert(db, "audit_events", base({ transaction_id: "no-such-transaction" })),
      /FOREIGN KEY/,
    );
  });

  it("refuses to store secret-looking keys (never log credentials)", () => {
    const db = freshDb();
    for (const payload of [
      { client_secret: "x" },
      { nested: { access_token: "t" } },
      { list: [{ password: "p" }] },
      { authorization: "Bearer abc" },
      { apiKey: "k" },
      { card_number: "4111" },
    ]) {
      expectRejected(() => ev(db, "LEAK", payload), /secret-looking key/);
    }
    expect(count(db, "audit_events")).toBe(0);
    // PayPal object ids are fine: "authorization_id" is not a secret
    expect(() => ev(db, "OK", { authorization_id: "AUTH-1", order_id: "ORD-1" })).not.toThrow();
  });
});

describe("tamper evidence (local only)", () => {
  it("detects an edited payload by a privileged writer who drops the trigger", () => {
    const db = freshDb();
    ev(db);
    ev(db, "X", { amount: 100 });
    ev(db);
    db.exec("DROP TRIGGER audit_events_no_update");
    run(db, "UPDATE audit_events SET payload = '{\"amount\":1}' WHERE seq = 2");
    expect(verifyChain(db)).toMatchObject({
      status: "FAILED",
      firstBadSeq: 2,
      reason: "hash does not match event contents",
    });
  });

  it("detects a deleted event", () => {
    const db = freshDb();
    ev(db);
    ev(db);
    ev(db);
    db.exec("DROP TRIGGER audit_events_no_delete");
    run(db, "DELETE FROM audit_events WHERE seq = 2");
    expect(verifyChain(db)).toMatchObject({
      status: "FAILED",
      firstBadSeq: 3,
      reason: "sequence gap or reorder",
    });
  });

  it("detects a re-linked chain whose hashes were not recomputed", () => {
    const db = freshDb();
    ev(db);
    const second = ev(db);
    db.exec("DROP TRIGGER audit_events_no_update");
    run(db, "UPDATE audit_events SET prev_hash = ? WHERE seq = 2", [HASH]);
    expect(second.seq).toBe(2);
    expect(verifyChain(db)).toMatchObject({
      status: "FAILED",
      firstBadSeq: 2,
      reason: "prev_hash does not match the previous event",
    });
  });

  it("cannot prove external authenticity: a writer who recomputes every later hash passes verification", () => {
    // Documented limitation (docs/AUDIT_CHAIN.md): the chain is local tamper-EVIDENCE for partial edits only.
    const db = worldDb();
    ev(db, "X", { amount: 100 });
    ev(db, "Y", { amount: 200 });
    ev(db, "Z", { amount: 300 });
    const before = verifyChain(db);
    db.exec("DROP TRIGGER audit_events_no_update");

    // rewrite event 1's payload, then re-hash and re-link every event from 1 onward
    run(db, "UPDATE audit_events SET payload = '{\"amount\":1}' WHERE seq = 1");
    let prev = GENESIS_HASH;
    for (const e of readAuditEvents(db)) {
      const { hash: _old, ...rest } = e;
      void _old;
      const unsigned = { ...rest, prevHash: prev };
      prev = computeEventHash(unsigned);
      run(db, "UPDATE audit_events SET prev_hash = ?, hash = ? WHERE seq = ?", [
        unsigned.prevHash,
        prev,
        unsigned.seq,
      ]);
    }
    expect(verifyChain(db)).toMatchObject({ status: "VERIFIED", count: 3, headHash: prev });
    // ...which is exactly what an anchor held elsewhere would catch
    if (before.status !== "VERIFIED") throw new Error("setup");
    expect(verifyChain(db, { count: 3, headHash: before.headHash })).toMatchObject({
      status: "FAILED",
      code: "ANCHOR_MISMATCH",
    });
  });
});
