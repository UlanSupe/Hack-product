import { describe, expect, it } from "vitest";

import { appendAuditEvent } from "@/adapters/sqlite/audit";
import { run, type SqlParam } from "@/adapters/sqlite/database";
import {
  addAttackStep,
  createAttackRun,
  finishAttackRun,
  recordPolicyDecision,
  recordRecommendation,
} from "@/adapters/sqlite/store";

import {
  HASH,
  addOffer,
  cell,
  count,
  expectRejected,
  newTx,
  rawInsert,
  tick,
  worldDb,
} from "./helpers";

const run1 = (
  db: ReturnType<typeof worldDb>,
  over: Partial<Parameters<typeof createAttackRun>[1]> = {},
) =>
  createAttackRun(db, {
    id: "run1",
    scenarioId: "S1",
    fixtureVersion: "v0",
    seed: "seed-1",
    mode: "PROTECTED",
    provider: "SIMULATED",
    currency: "USD",
    mandateCapMinor: 10_000,
    now: tick(),
    ...over,
  });

describe("attack runs", () => {
  it("records protected runs on either provider, with a transaction when real", () => {
    const db = worldDb();
    newTx(db);
    run1(db, { id: "r-sim" });
    run1(db, { id: "r-pp", provider: "PAYPAL_SANDBOX", transactionId: "tx1" });
    expect(count(db, "attack_runs")).toBe(2);
  });

  it("contains the unsafe baseline: it can only be SIMULATED and can never reference a transaction", () => {
    const db = worldDb();
    newTx(db);
    run1(db, { id: "base", mode: "UNSAFE_BASELINE" });
    expectRejected(
      () => run1(db, { id: "b2", mode: "UNSAFE_BASELINE", provider: "PAYPAL_SANDBOX" }),
      /CHECK constraint failed/,
    );
    expectRejected(
      () => run1(db, { id: "b3", mode: "UNSAFE_BASELINE", transactionId: "tx1" }),
      /CHECK constraint failed/,
    );
    expect(count(db, "attack_runs")).toBe(1);
  });

  it("derives cap_exceeded from the numbers and does not let callers write it", () => {
    const db = worldDb();
    run1(db, { id: "over", mode: "UNSAFE_BASELINE" });
    run1(db, { id: "ok" });
    finishAttackRun(db, {
      id: "over",
      moneyMovedMinor: 45_000,
      invariantsViolated: ["OVER_PER_TX_CAP"],
      now: tick(),
    });
    finishAttackRun(db, { id: "ok", moneyMovedMinor: 0, invariantsViolated: [], now: tick() });
    expect(cell(db, "SELECT cap_exceeded FROM attack_runs WHERE id = 'over'")).toBe(1);
    expect(cell(db, "SELECT cap_exceeded FROM attack_runs WHERE id = 'ok'")).toBe(0);
    expectRejected(
      () => run(db, "UPDATE attack_runs SET cap_exceeded = 0 WHERE id = 'over'"),
      /generated column|immutable|final/,
    );
  });

  it("freezes finished runs and protects identity columns", () => {
    const db = worldDb();
    run1(db);
    expectRejected(
      () => run(db, "UPDATE attack_runs SET mode = 'UNSAFE_BASELINE' WHERE id = 'run1'"),
      /immutable/,
    );
    expectRejected(
      () => run(db, "UPDATE attack_runs SET mandate_cap_minor = 999999 WHERE id = 'run1'"),
      /immutable/,
    );
    finishAttackRun(db, { id: "run1", moneyMovedMinor: 0, invariantsViolated: [], now: tick() });
    expectRejected(
      () =>
        finishAttackRun(db, {
          id: "run1",
          moneyMovedMinor: 1,
          invariantsViolated: [],
          now: tick(),
        }),
      /final/,
    );
    expectRejected(() => run(db, "DELETE FROM attack_runs WHERE id = 'run1'"), /cannot be deleted/);
    expectRejected(
      () =>
        finishAttackRun(db, {
          id: "ghost",
          moneyMovedMinor: 0,
          invariantsViolated: [],
          now: tick(),
        }),
      /attack run ghost not found/,
    );
  });

  it("validates audit ranges, timestamps, enums, json and money", () => {
    const db = worldDb();
    const e1 = appendAuditEvent(db, {
      ts: tick(),
      actor: "SYSTEM",
      type: "A",
      subjectType: "x",
      subjectId: "1",
      payload: {},
    });
    const e2 = appendAuditEvent(db, {
      ts: tick(),
      actor: "SYSTEM",
      type: "B",
      subjectType: "x",
      subjectId: "1",
      payload: {},
    });
    run1(db);
    expectRejected(
      () =>
        finishAttackRun(db, {
          id: "run1",
          moneyMovedMinor: 0,
          invariantsViolated: [],
          auditFromSeq: e2.seq,
          auditToSeq: e1.seq,
          now: tick(),
        }),
      /CHECK constraint failed/,
    );
    expectRejected(
      () =>
        finishAttackRun(db, {
          id: "run1",
          moneyMovedMinor: 0,
          invariantsViolated: [],
          auditFromSeq: 1,
          auditToSeq: 999,
          now: tick(),
        }),
      /FOREIGN KEY/,
    );
    expectRejected(
      () =>
        finishAttackRun(db, {
          id: "run1",
          moneyMovedMinor: 0,
          invariantsViolated: [],
          auditFromSeq: 1,
          now: tick(),
        }),
      /CHECK constraint failed/,
    );
    expectRejected(
      () =>
        finishAttackRun(db, {
          id: "run1",
          moneyMovedMinor: 1.5,
          invariantsViolated: [],
          now: tick(),
        }),
      /non-negative safe integer/,
    );
    expectRejected(
      () => run1(db, { id: "m", mode: "CHAOS" as "PROTECTED" }),
      /CHECK constraint failed/,
    );
    expectRejected(() => run1(db, { id: "c", currency: "usd" }), /3-letter uppercase/);
    expectRejected(() => run1(db, { id: "z", mandateCapMinor: 0 }), /CHECK constraint failed/);
    expectRejected(
      () => run(db, "UPDATE attack_runs SET invariants_violated = '{}' WHERE id = 'run1'"),
      /CHECK constraint failed/,
    );
    expectRejected(
      () =>
        run(
          db,
          "UPDATE attack_runs SET finished_at = '2000-01-01T00:00:00.000Z' WHERE id = 'run1'",
        ),
      /CHECK constraint failed/,
    );
    finishAttackRun(db, {
      id: "run1",
      moneyMovedMinor: 0,
      invariantsViolated: [],
      auditFromSeq: e1.seq,
      auditToSeq: e2.seq,
      now: tick(),
    });
  });

  it("rejects duplicate ids and a transaction that does not exist", () => {
    const db = worldDb();
    run1(db);
    expectRejected(() => run1(db), /UNIQUE constraint failed: attack_runs\.id/);
    expectRejected(
      () => run1(db, { id: "r2", provider: "PAYPAL_SANDBOX", transactionId: "ghost" }),
      /FOREIGN KEY/,
    );
  });
});

describe("attack run steps and recommendations", () => {
  const deny = (db: ReturnType<typeof worldDb>, id = "deny1") =>
    recordPolicyDecision(db, {
      id,
      subject: "ACCEPT_OFFER",
      transactionId: "tx1",
      verdict: "DENY",
      reasonCodes: ["OVER_PER_TX_CAP"],
      inputsHash: HASH,
      mandateId: "M1",
      mandateVersion: 1,
      decidedAt: tick(),
    });

  it("numbers steps automatically and refuses duplicates or gaps", () => {
    const db = worldDb();
    run1(db);
    expect(addAttackStep(db, { runId: "run1", sellerMessageRef: "m1", outcome: "NO_ACTION" })).toBe(
      1,
    );
    expect(addAttackStep(db, { runId: "run1", sellerMessageRef: "m2", outcome: "EXECUTED" })).toBe(
      2,
    );
    const raw = (n: number): Record<string, SqlParam> => ({
      run_id: "run1",
      n,
      seller_message_ref: "m",
      outcome: "NO_ACTION",
    });
    expectRejected(() => rawInsert(db, "attack_run_steps", raw(2)), /previous step \+ 1/);
    expectRejected(() => rawInsert(db, "attack_run_steps", raw(9)), /previous step \+ 1/);
    expectRejected(
      () => addAttackStep(db, { runId: "ghost", sellerMessageRef: "m", outcome: "NO_ACTION" }),
      /FOREIGN KEY/,
    );
  });

  it("a BLOCKED step must cite a DENY decision", () => {
    const db = worldDb();
    newTx(db);
    run1(db);
    deny(db);
    expectRejected(
      () => addAttackStep(db, { runId: "run1", sellerMessageRef: "m", outcome: "BLOCKED" }),
      /DENY policy decision/,
    );
    expectRejected(
      () =>
        addAttackStep(db, {
          runId: "run1",
          sellerMessageRef: "m",
          outcome: "BLOCKED",
          policyDecisionId: "ghost",
        }),
      /DENY policy decision|FOREIGN KEY/,
    );
    expect(
      addAttackStep(db, {
        runId: "run1",
        sellerMessageRef: "m",
        outcome: "BLOCKED",
        policyDecisionId: "deny1",
      }),
    ).toBe(1);

    recordPolicyDecision(db, {
      id: "allow1",
      subject: "ACCEPT_OFFER",
      transactionId: "tx1",
      verdict: "ALLOW",
      reasonCodes: [],
      inputsHash: HASH,
      mandateId: "M1",
      mandateVersion: 1,
      decidedAt: tick(),
    });
    expectRejected(
      () =>
        addAttackStep(db, {
          runId: "run1",
          sellerMessageRef: "m",
          outcome: "BLOCKED",
          policyDecisionId: "allow1",
        }),
      /DENY policy decision/,
    );
  });

  it("steps are immutable", () => {
    const db = worldDb();
    run1(db);
    addAttackStep(db, { runId: "run1", sellerMessageRef: "m", outcome: "NO_ACTION" });
    expectRejected(
      () => run(db, "UPDATE attack_run_steps SET outcome = 'EXECUTED' WHERE n = 1"),
      /immutable/,
    );
    expectRejected(() => run(db, "DELETE FROM attack_run_steps WHERE n = 1"), /immutable/);
  });

  it("records advisory recommendations tied to a run or a transaction, and only offers of that transaction", () => {
    const db = worldDb();
    newTx(db, "tx1");
    newTx(db, "tx2");
    const o1 = addOffer(db, "tx1", { id: "o1" });
    run1(db);
    const rec = (over: Partial<Parameters<typeof recordRecommendation>[1]>) =>
      recordRecommendation(db, {
        id: "rec1",
        agent: "PROTECTED_BUYER",
        kind: "ACCEPT_OFFER",
        rationale: "looks fine",
        modelRef: "scripted:v1",
        now: tick(),
        ...over,
      });

    rec({ attackRunId: "run1" });
    rec({ id: "rec2", transactionId: "tx1", offerId: o1.id });
    expectRejected(() => rec({ id: "rec3" }), /CHECK constraint failed/); // anchored to nothing
    expectRejected(
      () => rec({ id: "rec4", transactionId: "tx2", offerId: o1.id }),
      /same transaction/,
    );
    expectRejected(() => rec({ id: "rec5", attackRunId: "ghost" }), /FOREIGN KEY/);
    expectRejected(
      () => rec({ id: "rec6", attackRunId: "run1", agent: "ROBOT" as "SELLER" }),
      /CHECK constraint failed/,
    );
    expectRejected(
      () => rec({ id: "rec7", attackRunId: "run1", kind: "PAY_NOW" as "NONE" }),
      /CHECK constraint failed/,
    );
    expectRejected(
      () => rec({ id: "rec8", attackRunId: "run1", rationale: "x".repeat(2_001) }),
      /CHECK constraint failed/,
    );
    expectRejected(
      () => rec({ attackRunId: "run1" }),
      /UNIQUE constraint failed: agent_recommendations\.id/,
    );
    expectRejected(
      () => run(db, "UPDATE agent_recommendations SET kind = 'REJECT' WHERE id = 'rec1'"),
      /immutable/,
    );
    expectRejected(
      () => run(db, "DELETE FROM agent_recommendations WHERE id = 'rec1'"),
      /immutable/,
    );
    expect(cell(db, "SELECT COUNT(*) FROM agent_recommendations")).toBe(2);
  });

  it("a recommendation carries no amount or payee column (advisory only)", () => {
    const db = worldDb();
    const cols = (
      db.prepare("PRAGMA table_info(agent_recommendations)").all() as { name: string }[]
    ).map((c) => c.name);
    expect(cols.filter((c) => /minor|amount|payee|currency/.test(c))).toEqual([]);
  });
});
