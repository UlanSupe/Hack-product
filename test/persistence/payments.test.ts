import { describe, expect, it } from "vitest";

import { run, type SqlParam } from "@/adapters/sqlite/database";
import {
  claimIdempotencyKey,
  finishPaymentAttempt,
  retryPaymentAttempt,
  startPaymentAttempt,
  storeIdempotentResponse,
} from "@/adapters/sqlite/store";

import {
  HASH,
  T0,
  agreed,
  cell,
  count,
  expectRejected,
  rawInsert,
  step,
  tick,
  toAuthorized,
  worldDb,
} from "./helpers";

const start = (
  db: ReturnType<typeof worldDb>,
  id: string,
  action: "CREATE_ORDER" | "AUTHORIZE" | "CAPTURE" | "VOID",
  tx = "tx1",
) => startPaymentAttempt(db, { id, transactionId: tx, action, requestHash: HASH, now: tick() });

describe("payment attempts: write-ahead and idempotency", () => {
  it("derives the PayPal-Request-Id from the transaction, action and attempt number", () => {
    const db = worldDb();
    agreed(db);
    step(db, "tx1", "CREATING_ORDER");
    const a = start(db, "a1", "CREATE_ORDER");
    expect(a).toEqual({ id: "a1", seq: 1, requestId: "pp:tx1:CREATE_ORDER:1" });
    expect(cell(db, "SELECT status FROM payment_attempts WHERE id = 'a1'")).toBe("IN_FLIGHT");
  });

  it("only allows an attempt that matches the transaction's in-flight state", () => {
    const db = worldDb();
    toAuthorized(db);
    // AUTHORIZED is not CAPTURING: capture/void attempts are refused until the state machine moves
    expectRejected(() => start(db, "c1", "CAPTURE"), /does not match the transaction state/);
    expectRejected(() => start(db, "v1", "VOID"), /does not match the transaction state/);
    expectRejected(() => start(db, "x1", "AUTHORIZE"), /does not match the transaction state/);
    step(db, "tx1", "CAPTURING");
    expect(start(db, "c2", "CAPTURE").seq).toBe(1);
    expectRejected(() => start(db, "v2", "VOID"), /does not match the transaction state/);
  });

  it("refuses an attempt for an unknown transaction", () => {
    const db = worldDb();
    expectRejected(
      () => start(db, "g", "CAPTURE", "ghost"),
      /does not match the transaction state/,
    );
  });

  it("allows at most one live attempt per (transaction, action)", () => {
    const db = worldDb();
    toAuthorized(db);
    step(db, "tx1", "CAPTURING");
    start(db, "c1", "CAPTURE");
    expectRejected(() => start(db, "c2", "CAPTURE"), /UNIQUE constraint failed/);
    finishPaymentAttempt(db, { id: "c1", status: "UNKNOWN", now: tick() });
    expectRejected(() => start(db, "c3", "CAPTURE"), /UNIQUE constraint failed/); // UNKNOWN still counts as live
    expect(count(db, "payment_attempts")).toBe(3); // create_order, authorize, and capture c1 only
  });

  it("permits a new attempt only after a definite failure, numbered 2 and 3, never 4", () => {
    const db = worldDb();
    toAuthorized(db);
    for (const n of [1, 2, 3]) {
      step(db, "tx1", "CAPTURING");
      const a = start(db, `c${n}`, "CAPTURE");
      expect(a.seq).toBe(n);
      expect(a.requestId).toBe(`pp:tx1:CAPTURE:${n}`);
      finishPaymentAttempt(db, {
        id: `c${n}`,
        status: "FAILED_DEFINITE",
        httpStatus: 422,
        now: tick(),
      });
      step(db, "tx1", "AUTHORIZED"); // capture declined, hold still valid
    }
    step(db, "tx1", "CAPTURING");
    expectRejected(() => start(db, "c4", "CAPTURE"), /CHECK constraint failed/);
  });

  it("rejects hand-written rows with a wrong request id, wrong seq, bad hash or non-initial status", () => {
    const db = worldDb();
    agreed(db);
    step(db, "tx1", "CREATING_ORDER");
    const row = (over: Record<string, SqlParam> = {}): Record<string, SqlParam> => ({
      id: "r1",
      transaction_id: "tx1",
      action: "CREATE_ORDER",
      seq: 1,
      request_id: "pp:tx1:CREATE_ORDER:1",
      request_hash: HASH,
      status: "IN_FLIGHT",
      tries: 1,
      started_at: tick(),
      ...over,
    });
    expectRejected(
      () => rawInsert(db, "payment_attempts", row({ request_id: "pp:other:CREATE_ORDER:1" })),
      /CHECK constraint failed/,
    );
    expectRejected(
      () => rawInsert(db, "payment_attempts", row({ seq: 2, request_id: "pp:tx1:CREATE_ORDER:2" })),
      /previous seq \+ 1/,
    );
    expectRejected(
      () => rawInsert(db, "payment_attempts", row({ request_hash: "nothex" })),
      /CHECK constraint failed/,
    );
    expectRejected(
      () => rawInsert(db, "payment_attempts", row({ status: "SUCCEEDED", finished_at: tick() })),
      /IN_FLIGHT with tries = 1/,
    );
    expectRejected(
      () => rawInsert(db, "payment_attempts", row({ tries: 3 })),
      /IN_FLIGHT with tries = 1/,
    );
    expectRejected(
      () =>
        rawInsert(db, "payment_attempts", row({ action: "REFUND", request_id: "pp:tx1:REFUND:1" })),
      /CHECK constraint failed|does not match/,
    );
    rawInsert(db, "payment_attempts", row()); // control
    expectRejected(() => rawInsert(db, "payment_attempts", row()), /previous seq \+ 1|UNIQUE/); // duplicate id/request id
  });

  it("walks IN_FLIGHT -> UNKNOWN -> retried (same request id, tries + 1) -> SUCCEEDED, then freezes", () => {
    const db = worldDb();
    agreed(db);
    step(db, "tx1", "CREATING_ORDER");
    start(db, "a1", "CREATE_ORDER");
    finishPaymentAttempt(db, { id: "a1", status: "UNKNOWN", now: tick() });
    expect(cell(db, "SELECT finished_at IS NOT NULL FROM payment_attempts WHERE id = 'a1'")).toBe(
      1,
    );

    retryPaymentAttempt(db, "a1");
    expect(
      db
        .prepare(
          "SELECT status, tries, finished_at, request_id FROM payment_attempts WHERE id = 'a1'",
        )
        .get(),
    ).toMatchObject({
      status: "IN_FLIGHT",
      tries: 2,
      finished_at: null,
      request_id: "pp:tx1:CREATE_ORDER:1",
    });
    finishPaymentAttempt(db, {
      id: "a1",
      status: "SUCCEEDED",
      httpStatus: 201,
      paypalDebugId: "debug-123",
      now: tick(),
    });

    expectRejected(
      () => finishPaymentAttempt(db, { id: "a1", status: "FAILED_DEFINITE", now: tick() }),
      /final/,
    );
    expectRejected(() => retryPaymentAttempt(db, "a1"), /final/);
  });

  it("freezes FAILED_DEFINITE attempts and guards status, tries and timestamps", () => {
    const db = worldDb();
    agreed(db);
    step(db, "tx1", "CREATING_ORDER");
    start(db, "a1", "CREATE_ORDER");
    expectRejected(
      () => run(db, "UPDATE payment_attempts SET status = 'IN_FLIGHT' WHERE id = 'a1'"),
      /illegal payment attempt status change/,
    );
    expectRejected(
      () =>
        run(
          db,
          "UPDATE payment_attempts SET status = 'SUCCEEDED', tries = 5, finished_at = ? WHERE id = 'a1'",
          [tick()],
        ),
      /tries/,
    );
    expectRejected(
      () => run(db, "UPDATE payment_attempts SET status = 'SUCCEEDED' WHERE id = 'a1'"),
      /CHECK constraint failed/,
    ); // finished_at missing
    expectRejected(
      () =>
        run(
          db,
          "UPDATE payment_attempts SET status = 'SUCCEEDED', finished_at = ? WHERE id = 'a1'",
          [T0],
        ),
      /CHECK constraint failed/,
    ); // finished before started
    expectRejected(
      () =>
        run(
          db,
          "UPDATE payment_attempts SET status = 'SUCCEEDED', http_status = 99, finished_at = ? WHERE id = 'a1'",
          [tick()],
        ),
      /CHECK constraint failed/,
    );
    expectRejected(
      () =>
        run(db, "UPDATE payment_attempts SET request_hash = ? WHERE id = 'a1'", ["e".repeat(64)]),
      /immutable payment attempt column/,
    );
    expectRejected(
      () => run(db, "UPDATE payment_attempts SET request_id = 'pp:x' WHERE id = 'a1'"),
      /immutable payment attempt column/,
    );
    finishPaymentAttempt(db, { id: "a1", status: "FAILED_DEFINITE", httpStatus: 422, now: tick() });
    expectRejected(
      () => run(db, "UPDATE payment_attempts SET status = 'SUCCEEDED' WHERE id = 'a1'"),
      /final/,
    );
    expectRejected(
      () => run(db, "DELETE FROM payment_attempts WHERE id = 'a1'"),
      /cannot be deleted/,
    );
  });

  it("reports unknown attempts", () => {
    const db = worldDb();
    expectRejected(
      () => finishPaymentAttempt(db, { id: "ghost", status: "SUCCEEDED", now: tick() }),
      /payment attempt ghost not found/,
    );
    expectRejected(() => retryPaymentAttempt(db, "ghost"), /payment attempt ghost not found/);
  });

  it("never stores anything credential-like (only ids, hashes, statuses)", () => {
    const db = worldDb();
    toAuthorized(db);
    const row = db.prepare("SELECT * FROM payment_attempts LIMIT 1").get() as Record<
      string,
      unknown
    >;
    expect(Object.keys(row).sort()).toEqual(
      [
        "action",
        "finished_at",
        "http_status",
        "id",
        "paypal_debug_id",
        "request_hash",
        "request_id",
        "seq",
        "started_at",
        "status",
        "transaction_id",
        "tries",
      ].sort(),
    );
  });
});

describe("inbound idempotency keys", () => {
  const claim = (
    db: ReturnType<typeof worldDb>,
    over: Partial<Parameters<typeof claimIdempotencyKey>[1]> = {},
  ) =>
    claimIdempotencyKey(db, {
      key: "key-12345678",
      scope: "release",
      requestHash: HASH,
      now: tick(),
      ...over,
    });

  it("returns NEW, then REPLAY for the same request, CONFLICT for a different one", () => {
    const db = worldDb();
    expect(claim(db)).toEqual({ outcome: "NEW" });
    expect(claim(db)).toEqual({ outcome: "REPLAY", responseStatus: null, responseBody: null });
    expect(claim(db, { requestHash: "b".repeat(64) })).toEqual({ outcome: "CONFLICT" });
    expect(claim(db, { scope: "void" })).toEqual({ outcome: "CONFLICT" });
    expect(count(db, "idempotency_keys")).toBe(1);
  });

  it("replays the stored response, which can be recorded only once", () => {
    const db = worldDb();
    claim(db);
    storeIdempotentResponse(db, "key-12345678", 200, '{"ok":true}');
    expect(claim(db)).toEqual({
      outcome: "REPLAY",
      responseStatus: 200,
      responseBody: '{"ok":true}',
    });
    expectRejected(
      () => storeIdempotentResponse(db, "key-12345678", 500, "{}"),
      /only be recorded once/,
    );
    expectRejected(
      () => storeIdempotentResponse(db, "missing-key-1", 200, "{}"),
      /idempotency key missing-key-1 not found/,
    );
  });

  it("rejects duplicate raw keys, short keys and malformed rows", () => {
    const db = worldDb();
    claim(db);
    const row = (over: Record<string, SqlParam>) =>
      rawInsert(db, "idempotency_keys", {
        idem_key: "key-87654321",
        scope: "s",
        request_hash: HASH,
        created_at: tick(),
        ...over,
      });
    expectRejected(() => row({ idem_key: "key-12345678" }), /UNIQUE constraint failed/);
    expectRejected(() => row({ idem_key: "short" }), /CHECK constraint failed/);
    expectRejected(() => row({ request_hash: "zz" }), /CHECK constraint failed/);
    expectRejected(() => row({ response_status: 200 }), /CHECK constraint failed/); // status without body
    expectRejected(
      () =>
        run(db, "UPDATE idempotency_keys SET request_hash = ? WHERE idem_key = 'key-12345678'", [
          "c".repeat(64),
        ]),
      /identity is immutable/,
    );
  });
});
