import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  GENESIS_HASH,
  appendAuditEvent,
  assertNoSecretKeys,
  readAuditEvents,
  verifyChain,
  type AuditEventInput,
} from "@/adapters/sqlite/audit";
import { all, openDatabase, run, type Db } from "@/adapters/sqlite/database";
import { createSqliteMandateStore } from "@/adapters/sqlite/mandate-store";
import { createMandateService } from "@/application/mandates";
import { loadMigrations, migrate } from "@/adapters/sqlite/migrate";
import { canonicalJson } from "@/domain/canonical";
import { computeEventHash } from "@/domain/audit";

import { setup } from "../payments/harness";
import { HASH, T0, count, expectRejected, freshDb, newTx, tick, worldDb } from "./helpers";

const ev = (db: Db, over: Partial<AuditEventInput> = {}) =>
  appendAuditEvent(db, {
    ts: tick(),
    actor: "SYSTEM",
    type: "NOTE",
    subjectType: "note",
    subjectId: "n1",
    payload: {},
    ...over,
  });

/** What a privileged writer (or a bug) could do: remove the guards and edit rows directly. */
const unlock = (db: Db) => {
  db.exec("DROP TRIGGER audit_events_no_update");
  db.exec("DROP TRIGGER audit_events_no_delete");
};

function chainOf(n: number): Db {
  const db = freshDb();
  for (let i = 1; i <= n; i++) ev(db, { type: `EVT_${i}`, payload: { i } });
  return db;
}

describe("event identity and context", () => {
  it("gives every event a stable, unique id, its transaction id, type, timestamp and canonical payload", () => {
    const db = worldDb();
    newTx(db, "tx1");
    const a = ev(db, { transactionId: "tx1", type: "ONE", payload: { b: 2, a: 1 } });
    const b = ev(db, { type: "TWO" });
    expect(a.eventId).toBe("evt_00000001");
    expect(b.eventId).toBe("evt_00000002");
    expect(a).toMatchObject({
      transactionId: "tx1",
      type: "ONE",
      payload: '{"a":1,"b":2}',
      hashVersion: 2,
    });
    expect(a.ts).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(b.transactionId).toBeNull();
    // what is stored is what was returned
    expect(readAuditEvents(db)).toEqual([a, b]);
  });

  it("is deterministic: the same inputs on a fresh database produce identical hashes", () => {
    const fixed = (db: Db) => {
      for (let i = 1; i <= 3; i++)
        appendAuditEvent(db, {
          ts: T0,
          actor: "SYSTEM",
          type: "N",
          subjectType: "n",
          subjectId: "x",
          payload: { i },
        });
      return readAuditEvents(db).map((e) => e.hash);
    };
    expect(fixed(freshDb())).toEqual(fixed(freshDb()));
  });

  it("the database refuses a reused event id and a missing id or provenance", () => {
    const db = freshDb();
    ev(db, { eventId: "evt_mine" });
    expectRejected(
      () => ev(db, { eventId: "evt_mine" }),
      /UNIQUE constraint failed: audit_events\.event_id/,
    );
    expectRejected(
      () =>
        run(
          db,
          `INSERT INTO audit_events (seq, hash_version, ts, actor, type, subject_type, subject_id, payload, prev_hash, hash, provenance)
           VALUES (2, 2, ?, 'SYSTEM', 'N', 'n', 'x', '{}', ?, ?, 'LOCAL_DECISION')`,
          [tick(), readAuditEvents(db)[0]?.hash ?? "", "9".repeat(64)],
        ),
      /event id and a provenance/,
    );
    expect(count(db, "audit_events")).toBe(1);
  });

  it("new events must be hash version 2 (a legacy-form event cannot be added after the migration)", () => {
    const db = freshDb();
    const first = ev(db);
    expectRejected(
      () =>
        run(
          db,
          `INSERT INTO audit_events (seq, ts, actor, type, subject_type, subject_id, payload, prev_hash, hash)
           VALUES (2, ?, 'SYSTEM', 'N', 'n', 'x', '{}', ?, ?)`,
          [tick(), first.hash, "9".repeat(64)],
        ),
      /hash version 2/,
    );
  });

  it("records the mandate and agreement versions in force for an event about a transaction", () => {
    const db = worldDb();
    newTx(db, "tx1");
    const e = ev(db, { transactionId: "tx1" });
    expect(e).toMatchObject({
      mandateId: "M1",
      mandateVersion: 1,
      agreementId: null,
      agreementVersion: null,
    });
    // an event with no transaction records no context unless the caller supplies it
    expect(ev(db)).toMatchObject({ mandateId: null, mandateVersion: null });
    expect(
      ev(db, { mandate: { id: "M7", version: 4 }, agreement: { id: "agr9", version: 3 } }),
    ).toMatchObject({
      mandateId: "M7",
      mandateVersion: 4,
      agreementId: "agr9",
      agreementVersion: 3,
    });
    // a mandate with no version yet (a brand-new draft)
    expect(ev(db, { mandate: { id: "M8", version: null } })).toMatchObject({
      mandateId: "M8",
      mandateVersion: null,
    });
  });

  it("separates observed external facts from local decisions, and only a PayPal actor may claim an observation", () => {
    const db = freshDb();
    expect(ev(db).provenance).toBe("LOCAL_DECISION");
    expect(ev(db, { actor: "OPERATOR" }).provenance).toBe("LOCAL_DECISION");
    // a PayPal actor is still a local decision unless the caller says the payload is something PayPal reported
    expect(ev(db, { actor: "PAYPAL_API" }).provenance).toBe("LOCAL_DECISION");
    expect(ev(db, { actor: "PAYPAL_API", provenance: "OBSERVED_EXTERNAL" }).provenance).toBe(
      "OBSERVED_EXTERNAL",
    );
    expect(ev(db, { actor: "PAYPAL_WEBHOOK", provenance: "OBSERVED_EXTERNAL" }).provenance).toBe(
      "OBSERVED_EXTERNAL",
    );
    for (const actor of ["SYSTEM", "OPERATOR", "AGENT"] as const) {
      expectRejected(
        () => ev(db, { actor, provenance: "OBSERVED_EXTERNAL" }),
        /only a PayPal actor can record an observed external fact/,
      );
    }
    expect(verifyChain(db).status).toBe("VERIFIED");
  });

  it("the payment flow records PayPal's reported state as OBSERVED_EXTERNAL and its own decisions as LOCAL_DECISION, with versions", async () => {
    const h = setup();
    await h.start();
    const started = readAuditEvents(h.w.db).filter((e) => e.transactionId === h.tx);
    const refreshed = await h.refresh();
    expect(refreshed).toBeDefined();
    const events = readAuditEvents(h.w.db).filter((e) => e.transactionId === h.tx);
    expect(events.length).toBeGreaterThan(started.length);

    const observed = events.filter((e) => e.provenance === "OBSERVED_EXTERNAL");
    expect(observed.length).toBeGreaterThan(0);
    for (const e of observed) {
      expect(e.type).toBe("PAYPAL_ORDER_OBSERVED");
      expect(e.actor).toBe("PAYPAL_API");
    }
    // state changes are this system's decisions, never an "observation"
    const changes = events.filter((e) => e.type === "TX_STATE_CHANGED");
    expect(changes.length).toBeGreaterThan(0);
    for (const e of changes) expect(e.provenance).toBe("LOCAL_DECISION");

    // every event of an agreed transaction names the mandate, and the later ones the agreement version
    const m = h.w.cell<string>("SELECT mandate_id FROM transactions WHERE id = ?", h.tx);
    for (const e of events) {
      expect(e.mandateId).toBe(m);
      expect(e.mandateVersion).toBe(1);
    }
    const last = events.at(-1);
    expect(last?.agreementVersion).toBe(1);
    expect(last?.agreementId).toBeTruthy();
    expect(verifyChain(h.w.db).status).toBe("VERIFIED");
  });

  it("mandate events carry the mandate version they created", () => {
    const db = worldDb();
    let n = 0;
    let t = Date.parse("2026-02-01T00:00:00.000Z");
    const service = createMandateService({
      store: createSqliteMandateStore(db),
      now: () => new Date((t += 1_000)),
      newId: (prefix) => `${prefix}_${++n}`,
    });
    const op = { kind: "OPERATOR", id: "demo_operator" } as const;
    const fields = {
      currency: "USD",
      totalBudget: "300.00",
      maxTransactionAmount: "120.00",
      approvalThreshold: "100.00",
      allowedCategories: ["COMPUTE"],
      allowedSellerIds: ["seller_acme"],
      requireReviewBeforeExecution: false,
      validDays: 30,
    };
    const made = service.createDraft(op, { fields });
    if (!made.ok) throw new Error(`setup ${JSON.stringify(made.errors)}`);
    const approved = service.approveDraft(op, {
      draftId: made.value.id,
      revision: made.value.revision,
    });
    expect(approved.ok).toBe(true);
    const events = readAuditEvents(db);
    expect(events.map((e) => [e.type, e.mandateVersion, e.provenance])).toEqual([
      ["MANDATE_DRAFT_CREATED", null, "LOCAL_DECISION"],
      ["MANDATE_APPROVED", 1, "LOCAL_DECISION"],
    ]);
    expect(events[1]?.mandateId).toBe(events[0]?.mandateId);
    expect(events[1]?.mandateId).toBeTruthy();
    expect(verifyChain(db).status).toBe("VERIFIED");
  });
});

describe("the hash covers every field", () => {
  const COLS: [string, string | number | null][] = [
    ["ts", "2030-01-01T00:00:00.000Z"],
    ["type", "OTHER"],
    ["subject_type", "other"],
    ["subject_id", "other"],
    ["event_id", "evt_changed"],
    ["mandate_id", "M-changed"],
    ["mandate_version", 9],
    ["agreement_id", "agr-changed"],
    ["agreement_version", 9],
    ["payload", '{"changed":true}'],
  ];

  for (const [col, value] of COLS) {
    it(`editing ${col} of an event is reported at that event`, () => {
      const db = worldDb();
      newTx(db, "tx1");
      ev(db, { transactionId: "tx1" });
      ev(db, {
        transactionId: "tx1",
        mandate: { id: "M1", version: 1 },
        agreement: { id: "a", version: 1 },
      });
      ev(db, { transactionId: "tx1" });
      unlock(db);
      run(db, `UPDATE audit_events SET ${col} = ? WHERE seq = 2`, [value]);
      expect(verifyChain(db)).toMatchObject({
        status: "FAILED",
        firstBadSeq: 2,
        code: expect.stringMatching(/HASH_MISMATCH|DUPLICATE|MALFORMED/) as string,
      });
    });
  }

  it("editing the provenance or actor is reported at that event", () => {
    const db = freshDb();
    ev(db, { actor: "PAYPAL_API", provenance: "OBSERVED_EXTERNAL" });
    ev(db, { actor: "PAYPAL_API", provenance: "OBSERVED_EXTERNAL" });
    unlock(db);
    run(db, "UPDATE audit_events SET provenance = 'LOCAL_DECISION' WHERE seq = 2");
    expect(verifyChain(db)).toMatchObject({ firstBadSeq: 2, code: "HASH_MISMATCH" });
    run(
      db,
      "UPDATE audit_events SET provenance = 'OBSERVED_EXTERNAL', actor = 'SYSTEM' WHERE seq = 2",
    );
    expect(verifyChain(db)).toMatchObject({ firstBadSeq: 2 });
  });

  it("editing the transaction id is reported at that event", () => {
    const db = worldDb();
    newTx(db, "tx1");
    newTx(db, "tx2");
    ev(db, { transactionId: "tx1" });
    unlock(db);
    run(db, "UPDATE audit_events SET transaction_id = 'tx2' WHERE seq = 1");
    expect(verifyChain(db)).toMatchObject({ firstBadSeq: 1, code: "HASH_MISMATCH" });
  });

  it("downgrading an event to hash version 1 does not hide its extra fields", () => {
    const db = freshDb();
    ev(db);
    ev(db);
    unlock(db);
    run(db, "UPDATE audit_events SET hash_version = 1 WHERE seq = 2");
    expect(verifyChain(db)).toMatchObject({ firstBadSeq: 2, code: "HASH_VERSION_DOWNGRADE" });
    run(db, "UPDATE audit_events SET hash_version = 1 WHERE seq = 1");
    expect(verifyChain(db)).toMatchObject({ firstBadSeq: 1, code: "MALFORMED_EVENT" });
  });

  it("agrees with an independent SHA-256 computed over the documented form", () => {
    const db = worldDb();
    newTx(db, "tx1");
    const e = ev(db, { transactionId: "tx1", payload: { z: 1, a: [2, { y: 1, x: 2 }] } });
    const text = canonicalJson({
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
    });
    expect(createHash("sha256").update(`pactpay.audit.v2\n${text}`, "utf8").digest("hex")).toBe(
      e.hash,
    );
    expect(e.payload).toBe('{"a":[2,{"x":2,"y":1}],"z":1}');
  });
});

describe("verification of the whole chain", () => {
  it("accepts valid chains of several shapes", () => {
    expect(verifyChain(freshDb())).toMatchObject({ status: "VERIFIED", count: 0 });
    expect(verifyChain(chainOf(1))).toMatchObject({ status: "VERIFIED", count: 1 });
    const many = chainOf(150);
    const v = verifyChain(many);
    expect(v).toMatchObject({ status: "VERIFIED", count: 150, legacyCount: 0 });
    expect(v.status === "VERIFIED" && v.headHash).toBe(readAuditEvents(many).at(-1)?.hash);
    expect(readAuditEvents(many)[0]?.prevHash).toBe(GENESIS_HASH);
  });

  it("detects a modified payload at the first, a middle and the last event, and names the event", () => {
    for (const target of [1, 3, 5]) {
      const db = chainOf(5);
      unlock(db);
      run(db, "UPDATE audit_events SET payload = '{\"i\":999}' WHERE seq = ?", [target]);
      expect(verifyChain(db), `seq ${target}`).toMatchObject({
        status: "FAILED",
        firstBadSeq: target,
        firstBadEventId: `evt_${String(target).padStart(8, "0")}`,
        code: "HASH_MISMATCH",
        reason: "hash does not match event contents",
      });
    }
  });

  it("detects a payload edit that is re-hashed for that one event only (the next link no longer matches)", () => {
    const db = chainOf(5);
    unlock(db);
    const e = readAuditEvents(db)[2];
    if (!e) throw new Error("setup");
    const edited = { ...e, payload: '{"i":999}' };
    const { hash: _h, ...rest } = edited;
    void _h;
    run(db, "UPDATE audit_events SET payload = ?, hash = ? WHERE seq = 3", [
      edited.payload,
      computeEventHash(rest),
    ]);
    expect(verifyChain(db)).toMatchObject({ firstBadSeq: 4, code: "PREV_HASH_MISMATCH" });
  });

  it("detects deleted events at the start, in the middle and in a run, at the first event after the hole", () => {
    const cases: [number[], number][] = [
      [[1], 2],
      [[3], 4],
      [[2, 3, 4], 5],
    ];
    for (const [deleted, firstBad] of cases) {
      const db = chainOf(6);
      unlock(db);
      for (const s of deleted) run(db, "DELETE FROM audit_events WHERE seq = ?", [s]);
      expect(verifyChain(db), `deleted ${deleted.join(",")}`).toMatchObject({
        status: "FAILED",
        firstBadSeq: firstBad,
        code: "SEQUENCE_GAP_OR_REORDER",
      });
    }
  });

  it("cannot see removal of the NEWEST events by itself, but can against an anchor", () => {
    const db = chainOf(5);
    const before = verifyChain(db);
    if (before.status !== "VERIFIED") throw new Error("setup");
    unlock(db);
    run(db, "DELETE FROM audit_events WHERE seq IN (4, 5)");
    expect(verifyChain(db)).toMatchObject({ status: "VERIFIED", count: 3 }); // the limitation
    expect(verifyChain(db, { count: before.count, headHash: before.headHash })).toMatchObject({
      status: "FAILED",
      code: "TRUNCATED",
      firstBadSeq: 4,
    });
  });

  it("accepts a log that has only grown since the anchor was taken", () => {
    const db = chainOf(3);
    const a = verifyChain(db);
    if (a.status !== "VERIFIED") throw new Error("setup");
    ev(db);
    ev(db);
    expect(verifyChain(db, { count: a.count, headHash: a.headHash })).toMatchObject({
      status: "VERIFIED",
      count: 5,
    });
  });

  it("detects reordered events", () => {
    const db = chainOf(5);
    unlock(db);
    // swap the rows at seq 2 and 3 by renumbering them
    run(db, "UPDATE audit_events SET seq = 99 WHERE seq = 2");
    run(db, "UPDATE audit_events SET seq = 2 WHERE seq = 3");
    run(db, "UPDATE audit_events SET seq = 3 WHERE seq = 99");
    expect(verifyChain(db)).toMatchObject({
      status: "FAILED",
      firstBadSeq: 2,
      code: "PREV_HASH_MISMATCH",
    });
  });

  it("detects events moved to the end", () => {
    const db = chainOf(4);
    unlock(db);
    run(db, "UPDATE audit_events SET seq = 99 WHERE seq = 1");
    run(db, "UPDATE audit_events SET seq = seq - 1 WHERE seq BETWEEN 2 AND 4");
    run(db, "UPDATE audit_events SET seq = 4 WHERE seq = 99");
    expect(verifyChain(db)).toMatchObject({ status: "FAILED", firstBadSeq: 1 });
  });

  it("detects broken previous hashes: a wrong value, the genesis value, and a first event not at genesis", () => {
    for (const [seq, prev] of [
      [2, HASH],
      [3, GENESIS_HASH],
      [1, HASH],
    ] as const) {
      const db = chainOf(4);
      unlock(db);
      run(db, "UPDATE audit_events SET prev_hash = ? WHERE seq = ?", [prev, seq]);
      expect(verifyChain(db), `seq ${seq}`).toMatchObject({
        status: "FAILED",
        firstBadSeq: seq,
        code: "PREV_HASH_MISMATCH",
        reason: "prev_hash does not match the previous event",
      });
    }
  });

  it("reports the first invalid event when several are damaged, whatever order they were damaged in", () => {
    const db = chainOf(8);
    unlock(db);
    run(db, "UPDATE audit_events SET payload = '{}' WHERE seq = 6");
    run(db, "UPDATE audit_events SET prev_hash = ? WHERE seq = 4", [HASH]);
    run(db, "UPDATE audit_events SET type = 'X' WHERE seq = 7");
    expect(verifyChain(db)).toMatchObject({ firstBadSeq: 4, code: "PREV_HASH_MISMATCH" });
  });

  it("a fabricated row that satisfies the database's linkage rules still fails verification", () => {
    const db = chainOf(2);
    const head = readAuditEvents(db).at(-1)?.hash ?? "";
    run(
      db,
      `INSERT INTO audit_events (seq, hash_version, event_id, ts, actor, type, subject_type, subject_id, payload, prev_hash, hash, provenance)
       VALUES (3, 2, 'evt_forged', ?, 'SYSTEM', 'FORGED', 'n', 'x', '{}', ?, ?, 'LOCAL_DECISION')`,
      [tick(), head, "9".repeat(64)],
    );
    expect(verifyChain(db)).toMatchObject({
      firstBadSeq: 3,
      firstBadEventId: "evt_forged",
      code: "HASH_MISMATCH",
    });
  });

  it("holds across the real payment flow, and fails if that flow's history is edited", async () => {
    const h = setup();
    await h.start();
    await h.refresh();
    expect(h.chainOk()).toBe(true);
    unlock(h.w.db);
    const target = readAuditEvents(h.w.db).find((e) => e.type === "PAYPAL_ORDER_OBSERVED");
    if (!target) throw new Error("setup");
    run(h.w.db, "UPDATE audit_events SET provenance = 'LOCAL_DECISION' WHERE seq = ?", [
      target.seq,
    ]);
    expect(verifyChain(h.w.db)).toMatchObject({
      firstBadSeq: target.seq,
      firstBadEventId: target.eventId,
      code: "HASH_MISMATCH",
    });
  });
});

describe("events written before hash version 2", () => {
  /** Database as it was after migration 0007: legacy-form rows only. */
  function legacyDb(n: number): Db {
    const db = freshDbAt7();
    let prev = GENESIS_HASH;
    for (let seq = 1; seq <= n; seq++) {
      const base = {
        hashVersion: 1,
        seq,
        eventId: null,
        ts: tick(),
        actor: "SYSTEM",
        type: "LEGACY",
        subjectType: "note",
        subjectId: "n1",
        transactionId: null,
        mandateId: null,
        mandateVersion: null,
        agreementId: null,
        agreementVersion: null,
        provenance: null,
        payload: canonicalJson({ seq }),
        prevHash: prev,
      } as const;
      const hash = computeEventHash(base);
      run(
        db,
        `INSERT INTO audit_events (seq, ts, actor, type, subject_type, subject_id, transaction_id, payload, prev_hash, hash)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          seq,
          base.ts,
          base.actor,
          base.type,
          base.subjectType,
          base.subjectId,
          null,
          base.payload,
          prev,
          hash,
        ],
      );
      prev = hash;
    }
    return db;
  }

  function freshDbAt7(): Db {
    const db = freshDbEmpty();
    migrate(db, { now: T0, migrations: loadMigrations().filter((m) => m.id <= 7) });
    return db;
  }

  it("migrating does not rewrite them, and they still verify under their original form", () => {
    const db = legacyDb(3);
    const before = all(db, "SELECT * FROM audit_events ORDER BY seq");
    migrate(db, { now: T0 });
    const after = readAuditEvents(db);
    expect(after.map((e) => [e.hashVersion, e.eventId, e.provenance, e.mandateId])).toEqual([
      [1, null, null, null],
      [1, null, null, null],
      [1, null, null, null],
    ]);
    expect(after.map((e) => e.hash)).toEqual((before as { hash: string }[]).map((r) => r.hash));
    expect(verifyChain(db)).toMatchObject({ status: "VERIFIED", count: 3, legacyCount: 3 });
  });

  it("new events continue the same chain from the legacy head", () => {
    const db = legacyDb(2);
    migrate(db, { now: T0 });
    const head = readAuditEvents(db).at(-1);
    const next = ev(db, { type: "AFTER_MIGRATION" });
    expect(next).toMatchObject({ seq: 3, prevHash: head?.hash, hashVersion: 2 });
    expect(verifyChain(db)).toMatchObject({ status: "VERIFIED", count: 3, legacyCount: 2 });
  });

  it("a tampered legacy event is still caught, at its own position", () => {
    const db = legacyDb(3);
    migrate(db, { now: T0 });
    ev(db);
    unlock(db);
    run(db, "UPDATE audit_events SET payload = '{\"seq\":0}' WHERE seq = 2");
    expect(verifyChain(db)).toMatchObject({ firstBadSeq: 2, code: "HASH_MISMATCH" });
  });

  it("new columns on a legacy event are not covered by its hash, so they are refused", () => {
    const db = legacyDb(2);
    migrate(db, { now: T0 });
    unlock(db);
    run(db, "UPDATE audit_events SET mandate_id = 'M1', mandate_version = 5 WHERE seq = 1");
    expect(verifyChain(db)).toMatchObject({ firstBadSeq: 1, code: "MALFORMED_EVENT" });
  });
});

describe("secrets are not recorded", () => {
  it("refuses credential-looking keys and bearer-token values anywhere in a payload", () => {
    const db = freshDb();
    for (const payload of [
      { access_token: "t" },
      { deep: { list: [{ client_secret: "s" }] } },
      { header: "Bearer abcdefgh12345678" },
      { nested: ["  bearer eyJhbGciOi.AbCd_123-xyz"] },
    ]) {
      expectRejected(() => ev(db, { payload }), /refusing to store/);
    }
    expect(count(db, "audit_events")).toBe(0);
    // ordinary text that merely mentions the words is fine
    expect(() =>
      assertNoSecretKeys({ note: "the bearer of this offer", title: "Basic design" }),
    ).not.toThrow();
  });

  it("verification results contain event identifiers and a reason, never payload text", () => {
    const marker = "PAYLOAD-MARKER-9a7c";
    const db = freshDb();
    ev(db, { payload: { note: marker } });
    ev(db, { payload: { note: marker } });
    unlock(db);
    run(db, "UPDATE audit_events SET payload = ? WHERE seq = 2", [
      JSON.stringify({ note: `${marker}!` }),
    ]);
    const result = verifyChain(db);
    expect(result.status).toBe("FAILED");
    expect(JSON.stringify(result)).not.toContain(marker);
  });
});

function freshDbEmpty(): Db {
  // an unmigrated in-memory database
  return openDatabase(":memory:");
}
