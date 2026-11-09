import { describe, expect, it } from "vitest";

import { appendAuditEvent, verifyChain } from "@/adapters/sqlite/audit";
import { inTransaction, run } from "@/adapters/sqlite/database";
import {
  StaleVersionError,
  createTransaction,
  getTransaction,
  insertMandateVersion,
  transitionTransaction,
} from "@/adapters/sqlite/store";
import { TERMINAL_STATES, TRANSITIONS, TX_STATES, type TxState } from "@/domain/transaction-states";

import {
  POLICY,
  T0,
  agreed,
  attempt,
  cell,
  count,
  expectRejected,
  newTx,
  rawInsert,
  rawTransition,
  step,
  tick,
  toAuthorized,
  toCaptured,
  toOrderCreated,
  worldDb,
} from "./helpers";

describe("transaction creation", () => {
  it("pins the exact mandate version that was current and approved at the time", () => {
    const db = worldDb();
    const first = newTx(db, "tx-old");
    insertMandateVersion(db, {
      ...POLICY,
      id: "M1",
      ownerId: "demo_operator",
      perTxCapMinor: 20_000,
      totalBudgetMinor: 30_000,
      currency: "USD",
      allowedSellerIds: ["seller_acme"],
      expiresAt: "2027-06-01T00:00:00.000Z",
      status: "ACTIVE",
      now: T0,
    });
    const second = newTx(db, "tx-new");
    expect([first.mandateVersion, second.mandateVersion]).toEqual([1, 2]);
    expect(getTransaction(db, "tx-old")?.mandateVersion).toBe(1); // still retains the policy it started under
    expect(first).toMatchObject({
      state: "NEGOTIATING",
      version: 1,
      currency: "USD",
      agreementId: null,
    });
  });

  it("refuses a missing, revoked, stale or expired mandate", () => {
    const db = worldDb();
    expectRejected(
      () => createTransaction(db, { id: "t", mandateId: "NOPE", now: tick() }),
      /mandate NOPE not found/,
    );

    // stale: pointing at v1 after v2 exists
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
    });
    expectRejected(
      () =>
        rawInsert(db, "transactions", {
          id: "stale",
          state: "NEGOTIATING",
          version: 1,
          mandate_id: "M1",
          mandate_version: 1,
          currency: "USD",
          created_at: tick(),
          updated_at: tick(),
        }),
      /latest version/,
    );

    // expired: created after expires_at
    expectRejected(
      () => createTransaction(db, { id: "late", mandateId: "M1", now: "2027-01-02T00:00:00.000Z" }),
      /expired/,
    );

    // revoked
    insertMandateVersion(db, {
      ...POLICY,
      id: "M1",
      ownerId: "demo_operator",
      perTxCapMinor: 10_000,
      totalBudgetMinor: 15_000,
      currency: "USD",
      allowedSellerIds: ["seller_acme"],
      expiresAt: "2027-01-01T00:00:00.000Z",
      status: "REVOKED",
      now: T0,
    });
    expectRejected(
      () => createTransaction(db, { id: "rev", mandateId: "M1", now: tick() }),
      /ACTIVE/,
    );
    expect(count(db, "transactions")).toBe(0);
  });

  it("rejects a reference to a mandate version that does not exist", () => {
    const db = worldDb();
    expectRejected(() =>
      rawInsert(db, "transactions", {
        id: "ghost",
        state: "NEGOTIATING",
        version: 1,
        mandate_id: "M1",
        mandate_version: 42,
        currency: "USD",
        created_at: tick(),
        updated_at: tick(),
      }),
    );
  });

  it("rejects duplicate transaction ids", () => {
    const db = worldDb();
    newTx(db, "dup");
    expectRejected(() => newTx(db, "dup"), /UNIQUE constraint failed: transactions\.id/);
  });

  it("only allows a clean NEGOTIATING start", () => {
    const db = worldDb();
    const base = {
      id: "x",
      mandate_id: "M1",
      mandate_version: 1,
      currency: "USD",
      created_at: tick(),
      updated_at: tick(),
    };
    expectRejected(
      () => rawInsert(db, "transactions", { ...base, state: "CAPTURED", version: 1 }),
      /must start NEGOTIATING/,
    );
    expectRejected(
      () => rawInsert(db, "transactions", { ...base, state: "NEGOTIATING", version: 5 }),
      /must start NEGOTIATING/,
    );
    expectRejected(
      () =>
        rawInsert(db, "transactions", {
          ...base,
          state: "NEGOTIATING",
          version: 1,
          paypal_order_id: "ORD",
        }),
      /must start NEGOTIATING/,
    );
  });

  it("requires the transaction currency to match the mandate", () => {
    const db = worldDb();
    expectRejected(
      () =>
        rawInsert(db, "transactions", {
          id: "eur",
          state: "NEGOTIATING",
          version: 1,
          mandate_id: "M1",
          mandate_version: 1,
          currency: "EUR",
          created_at: tick(),
          updated_at: tick(),
        }),
      /currency must equal the mandate currency/,
    );
  });
});

describe("legal lifecycles", () => {
  it("walks the happy path to CAPTURED with a gap-free, verifiable audit trail", () => {
    const db = worldDb();
    toCaptured(db);
    const tx = getTransaction(db, "tx1");
    expect(tx).toMatchObject({
      state: "CAPTURED",
      capturedMinor: 8_000,
      authorizedMinor: 8_000,
      paypalCaptureId: "CAP-tx1",
    });
    // NEGOTIATING->AGREED->CREATING_ORDER->ORDER_CREATED->ORDER_APPROVED->AUTHORIZING->AUTHORIZED->CAPTURING->CAPTURED = 8 changes
    expect(tx?.version).toBe(9);
    expect(
      cell(
        db,
        "SELECT COUNT(*) FROM audit_events WHERE transaction_id = 'tx1' AND type = 'TX_STATE_CHANGED'",
      ),
    ).toBe(8);
    expect(tx?.lastEventSeq).toBe(cell(db, "SELECT MAX(seq) FROM audit_events"));
    expect(verifyChain(db)).toMatchObject({ status: "VERIFIED" });
  });

  it("supports authorize then void", () => {
    const db = worldDb();
    toAuthorized(db);
    step(db, "tx1", "VOIDING");
    attempt(db, "tx1", "VOID", "SUCCEEDED");
    expect(step(db, "tx1", "VOIDED").state).toBe("VOIDED");
  });

  it("supports a pending capture that later completes", () => {
    const db = worldDb();
    toAuthorized(db);
    step(db, "tx1", "CAPTURING");
    attempt(db, "tx1", "CAPTURE", "SUCCEEDED");
    step(db, "tx1", "CAPTURE_PENDING", { paypalCaptureId: "CAP-1", capturedMinor: 8_000 });
    expect(step(db, "tx1", "CAPTURED").state).toBe("CAPTURED");
  });

  it("supports the unknown-outcome path: in-flight -> NEEDS_RECONCILIATION -> resolved", () => {
    const db = worldDb();
    toOrderCreated(db);
    step(db, "tx1", "ORDER_APPROVED");
    step(db, "tx1", "AUTHORIZING");
    attempt(db, "tx1", "AUTHORIZE", "UNKNOWN");
    const stuck = step(db, "tx1", "NEEDS_RECONCILIATION");
    expect(stuck).toMatchObject({ state: "NEEDS_RECONCILIATION", reconcilingFrom: "AUTHORIZING" });
    const done = step(db, "tx1", "AUTHORIZED", {
      paypalAuthorizationId: "AUTH-1",
      authorizedMinor: 8_000,
      authorizedAt: tick(),
      honorExpiresAt: "2099-01-01T00:00:00.000Z",
    });
    expect(done).toMatchObject({ state: "AUTHORIZED", reconcilingFrom: null });
  });

  it("supports a policy rejection during negotiation (no agreement needed)", () => {
    const db = worldDb();
    newTx(db);
    expect(step(db, "tx1", "REJECTED")).toMatchObject({ state: "REJECTED", agreementId: null });
  });
});

describe("illegal transitions", () => {
  const legal = new Set(TRANSITIONS.map(([f, t]) => `${f}>${t}`));

  it("rejects the dangerous shortcuts and leaves state, version and audit log untouched", () => {
    const db = worldDb();
    toAuthorized(db, "auth");
    agreed(db, "agr");
    newTx(db, "neg");
    toCaptured(db, "cap");
    newTx(db, "rej");
    step(db, "rej", "REJECTED");

    const cases: [string, TxState][] = [
      ["agr", "CAPTURED"], // skipping order/authorization
      ["auth", "CAPTURED"], // must pass through CAPTURING
      ["neg", "AUTHORIZED"],
      ["cap", "AUTHORIZED"], // captured money cannot go back
      ["cap", "VOIDING"], // fully captured: cannot void
      ["rej", "AGREED"], // terminal stays terminal
    ];
    for (const [id, to] of cases) {
      const before = getTransaction(db, id)!;
      const events = count(db, "audit_events");
      expect(legal.has(`${before.state}>${to}`), `${before.state}>${to} must be illegal`).toBe(
        false,
      );
      expectRejected(() => step(db, id, to), /illegal state transition/);
      expect(getTransaction(db, id)).toEqual(before);
      expect(count(db, "audit_events")).toBe(events); // the failed attempt left no orphan audit event
    }
  });

  it("every terminal state is a dead end", () => {
    // sanity over the table the database uses (reference tables are checked against the domain in migrations.test.ts)
    for (const s of TERMINAL_STATES) {
      const db = worldDb();
      expect(TRANSITIONS.some(([f]) => f === s)).toBe(false);
      expect(cell(db, "SELECT COUNT(*) FROM tx_transitions WHERE from_state = ?", [s])).toBe(0);
    }
    expect(TX_STATES).toContain("VOIDED");
  });

  it("rejects an unknown state value", () => {
    const db = worldDb();
    agreed(db);
    expectRejected(() => inTransaction(db, () => rawTransition(db, "tx1", { state: "BOGUS" })));
  });

  it("restricts reconciliation to the in-flight state it came from", () => {
    const db = worldDb();
    toOrderCreated(db);
    step(db, "tx1", "ORDER_APPROVED");
    step(db, "tx1", "AUTHORIZING");
    attempt(db, "tx1", "AUTHORIZE", "UNKNOWN");
    step(db, "tx1", "NEEDS_RECONCILIATION");
    // a lost AUTHORIZE call can never resolve straight to CAPTURED
    expectRejected(
      () =>
        step(db, "tx1", "CAPTURED", {
          paypalCaptureId: "CAP",
          capturedMinor: 8_000,
          paypalAuthorizationId: "A",
          authorizedMinor: 8_000,
          authorizedAt: tick(),
          honorExpiresAt: "2099-01-01T00:00:00.000Z",
        }),
      /not allowed for the in-flight state/,
    );
    expect(step(db, "tx1", "ORDER_APPROVED").state).toBe("ORDER_APPROVED");
  });

  it("only enters NEEDS_RECONCILIATION from an in-flight state and records which", () => {
    const db = worldDb();
    toAuthorized(db);
    expectRejected(() => step(db, "tx1", "NEEDS_RECONCILIATION"), /illegal state transition/);

    const db2 = worldDb();
    toOrderCreated(db2);
    step(db2, "tx1", "ORDER_APPROVED");
    step(db2, "tx1", "AUTHORIZING");
    expectRejected(
      () =>
        inTransaction(db2, () =>
          rawTransition(db2, "tx1", {
            state: "NEEDS_RECONCILIATION",
            reconciling_from: "CAPTURING",
          }),
        ),
      /must come from an in-flight state and record it/,
    );
  });
});

describe("optimistic concurrency and audit linkage", () => {
  it("fails a stale writer with StaleVersionError and applies the first writer only", () => {
    const db = worldDb();
    agreed(db);
    const v = getTransaction(db, "tx1")!.version;
    transitionTransaction(db, {
      id: "tx1",
      expectedVersion: v,
      to: "CREATING_ORDER",
      now: tick(),
      actor: "SYSTEM",
    });
    let err: unknown;
    try {
      transitionTransaction(db, {
        id: "tx1",
        expectedVersion: v,
        to: "CANCELLED",
        now: tick(),
        actor: "OPERATOR",
      });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(StaleVersionError);
    expect(getTransaction(db, "tx1")?.state).toBe("CREATING_ORDER");
  });

  it("reports an unknown transaction", () => {
    const db = worldDb();
    expectRejected(() => step(db, "ghost", "AGREED"), /no transaction ghost/);
    expectRejected(
      () =>
        transitionTransaction(db, {
          id: "ghost",
          expectedVersion: 1,
          to: "REJECTED",
          now: tick(),
          actor: "SYSTEM",
        }),
      /transaction ghost not found/,
    );
  });

  it("requires version to increase by exactly one", () => {
    const db = worldDb();
    agreed(db);
    expectRejected(
      () => inTransaction(db, () => rawTransition(db, "tx1", { state: "CANCELLED", version: 99 })),
      /exactly 1/,
    );
    expectRejected(
      () => inTransaction(db, () => rawTransition(db, "tx1", { state: "CANCELLED", version: 2 })),
      /exactly 1/,
    );
  });

  it("requires every state change to cite a newer TX_STATE_CHANGED event for the same transaction", () => {
    const db = worldDb();
    agreed(db, "a");
    agreed(db, "b");
    const cur = getTransaction(db, "a")!;
    const update = (extra: Record<string, number | string | null>) => {
      const cols = { state: "CANCELLED", version: cur.version + 1, updated_at: tick(), ...extra };
      return run(
        db,
        `UPDATE transactions SET ${Object.keys(cols)
          .map((k) => `${k} = ?`)
          .join(", ")} WHERE id = 'a'`,
        Object.values(cols),
      );
    };
    const other = appendAuditEvent(db, {
      ts: tick(),
      actor: "SYSTEM",
      type: "TX_STATE_CHANGED",
      subjectType: "transaction",
      subjectId: "b",
      transactionId: "b",
      payload: {},
    });
    const wrongType = appendAuditEvent(db, {
      ts: tick(),
      actor: "SYSTEM",
      type: "NOTE",
      subjectType: "transaction",
      subjectId: "a",
      transactionId: "a",
      payload: {},
    });

    expectRejected(() => update({}), /audit event/); // no reference
    expectRejected(() => update({ last_event_seq: cur.lastEventSeq }), /audit event/); // reused old event
    expectRejected(() => update({ last_event_seq: other.seq }), /audit event/); // another transaction's event
    expectRejected(() => update({ last_event_seq: wrongType.seq }), /audit event/); // wrong event type
    expectRejected(() => update({ last_event_seq: 9_999 }), /audit event|FOREIGN KEY/); // does not exist
    expect(getTransaction(db, "a")?.state).toBe("AGREED");
  });

  it("does not let last_event_seq change without a state change", () => {
    const db = worldDb();
    agreed(db);
    const cur = getTransaction(db, "tx1")!;
    const ev = appendAuditEvent(db, {
      ts: tick(),
      actor: "SYSTEM",
      type: "TX_STATE_CHANGED",
      subjectType: "transaction",
      subjectId: "tx1",
      transactionId: "tx1",
      payload: {},
    });
    expectRejected(
      () =>
        run(
          db,
          "UPDATE transactions SET version = ?, last_event_seq = ?, updated_at = ? WHERE id = 'tx1'",
          [cur.version + 1, ev.seq, tick()],
        ),
      /only change together with a state change/,
    );
  });
});

describe("immutable columns and state/data consistency", () => {
  it("never lets identity, mandate pin, agreement or PayPal ids be rewritten", () => {
    const db = worldDb();
    toAuthorized(db, "a");
    toOrderCreated(db, "b");
    const set = (id: string, col: string, value: string | number) =>
      inTransaction(db, () => rawTransition(db, id, { [col]: value }));
    expectRejected(() => set("a", "mandate_version", 2), /immutable transaction column/);
    expectRejected(() => set("a", "mandate_id", "OTHER"), /immutable transaction column/);
    expectRejected(() => set("a", "currency", "EUR"), /immutable transaction column/);
    expectRejected(() => set("a", "created_at", T0), /immutable transaction column/);
    expectRejected(() => set("a", "agreement_id", "agr-b"), /immutable transaction column/);
    expectRejected(
      () => set("a", "paypal_order_id", "ORDER-HIJACK"),
      /immutable transaction column/,
    );
    expectRejected(
      () => set("a", "paypal_authorization_id", "AUTH-HIJACK"),
      /immutable transaction column/,
    );
    expectRejected(() => set("a", "authorized_minor", 1), /immutable transaction column/);
    expectRejected(() => set("a", "id", "renamed"), /immutable transaction column/);
  });

  it("cannot attach someone else's agreement", () => {
    const db = worldDb();
    agreed(db, "a");
    newTx(db, "c");
    expectRejected(
      () =>
        inTransaction(db, () => rawTransition(db, "c", { state: "AGREED", agreement_id: "agr-a" })),
      /must belong to this transaction|UNIQUE/,
    );
  });

  it("only attaches an agreement on NEGOTIATING -> AGREED", () => {
    const db = worldDb();
    newTx(db, "x");
    expectRejected(
      () =>
        inTransaction(db, () =>
          rawTransition(db, "x", { state: "REJECTED", agreement_id: "nope" }),
        ),
      /only be attached on NEGOTIATING -> AGREED|FOREIGN KEY/,
    );
  });

  it("keeps PayPal ids and amounts consistent with the state", () => {
    const db = worldDb();
    toOrderCreated(db, "o");
    step(db, "o", "ORDER_APPROVED");
    step(db, "o", "AUTHORIZING");
    // AUTHORIZED without an authorization id / amount
    expectRejected(
      () => inTransaction(db, () => rawTransition(db, "o", { state: "AUTHORIZED" })),
      /CHECK constraint failed/,
    );
    // authorization amount different from the agreement total
    const at = tick();
    const good = {
      paypal_authorization_id: "AUTH-o",
      authorized_at: at,
      honor_expires_at: "2099-01-01T00:00:00.000Z",
    };
    expectRejected(
      () =>
        inTransaction(db, () =>
          rawTransition(db, "o", { state: "AUTHORIZED", ...good, authorized_minor: 9_999 }),
        ),
      /authorized amount must equal the agreement total/,
    );
    expectRejected(
      () =>
        inTransaction(db, () =>
          rawTransition(db, "o", { state: "AUTHORIZED", ...good, authorized_minor: 7_999 }),
        ),
      /authorized amount must equal the agreement total/,
    );
    // honor period must end after it starts
    expectRejected(
      () =>
        inTransaction(db, () =>
          rawTransition(db, "o", {
            state: "AUTHORIZED",
            ...good,
            authorized_minor: 8_000,
            honor_expires_at: T0,
          }),
        ),
      /CHECK constraint failed/,
    );
    // id without amount
    expectRejected(
      () =>
        inTransaction(db, () =>
          rawTransition(db, "o", { state: "AUTHORIZED", paypal_authorization_id: "AUTH-o" }),
        ),
      /CHECK constraint failed/,
    );
  });

  it("allows only full capture equal to the agreement total, and never more than authorized", () => {
    const db = worldDb();
    toAuthorized(db);
    step(db, "tx1", "CAPTURING");
    expectRejected(
      () => step(db, "tx1", "CAPTURED", { paypalCaptureId: "CAP-1", capturedMinor: 4_000 }),
      /full capture only/,
    );
    expectRejected(
      () => step(db, "tx1", "CAPTURED", { paypalCaptureId: "CAP-1", capturedMinor: 8_001 }),
      /CHECK constraint failed|full capture only/,
    );
    expectRejected(() => step(db, "tx1", "CAPTURED"), /CHECK constraint failed/); // no capture id/amount
    expect(
      step(db, "tx1", "CAPTURED", { paypalCaptureId: "CAP-1", capturedMinor: 8_000 }).state,
    ).toBe("CAPTURED");
  });

  it("forbids PayPal ids before an order exists, and money in pre-order states", () => {
    const db = worldDb();
    agreed(db);
    expectRejected(
      () => step(db, "tx1", "CREATING_ORDER", { paypalOrderId: "ORD-early" }),
      /CHECK constraint failed/,
    );
  });

  it("keeps PayPal object ids unique across transactions", () => {
    const db = worldDb();
    toOrderCreated(db, "t1");
    agreed(db, "t2");
    step(db, "t2", "CREATING_ORDER");
    attempt(db, "t2", "CREATE_ORDER", "SUCCEEDED");
    expectRejected(
      () => step(db, "t2", "ORDER_CREATED", { paypalOrderId: "ORDER-t1" }),
      /UNIQUE constraint failed: transactions\.paypal_order_id/,
    );
  });

  it("cannot be deleted", () => {
    const db = worldDb();
    newTx(db);
    expectRejected(() => run(db, "DELETE FROM transactions WHERE id = 'tx1'"), /cannot be deleted/);
  });

  it("rejects malformed timestamps and ids", () => {
    const db = worldDb();
    expectRejected(
      () =>
        rawInsert(db, "transactions", {
          id: "t",
          state: "NEGOTIATING",
          version: 1,
          mandate_id: "M1",
          mandate_version: 1,
          currency: "USD",
          created_at: "yesterday",
          updated_at: tick(),
        }),
      /CHECK constraint failed|not be expired/,
    );
    expectRejected(
      () =>
        rawInsert(db, "transactions", {
          id: "",
          state: "NEGOTIATING",
          version: 1,
          mandate_id: "M1",
          mandate_version: 1,
          currency: "USD",
          created_at: tick(),
          updated_at: tick(),
        }),
      /CHECK constraint failed/,
    );
  });
});
