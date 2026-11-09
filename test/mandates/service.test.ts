import { describe, expect, it } from "vitest";

import { createSqliteMandateStore } from "@/adapters/sqlite/mandate-store";
import { verifyChain } from "@/adapters/sqlite/audit";
import { getMandate, createTransaction, getLatestMandate } from "@/adapters/sqlite/store";
import { createMandateService, type Actor, type OperatorActor } from "@/application/mandates";
import { ConflictError, ForbiddenError, NotFoundError } from "@/domain/errors";

import { T0, cell, count, expectRejected, worldDb } from "../persistence/helpers";

const OPERATOR: OperatorActor = { kind: "OPERATOR", id: "demo_operator" };
const AGENT: Actor = { kind: "AGENT", id: "buyer-agent-1" };
const ANON: Actor = { kind: "ANONYMOUS" };

const fields = (over: Record<string, unknown> = {}) => ({
  currency: "USD",
  totalBudget: "300.00",
  maxTransactionAmount: "120.00",
  approvalThreshold: "100.00",
  allowedCategories: ["COMPUTE", "STORAGE"],
  allowedSellerIds: ["seller_acme"],
  requireReviewBeforeExecution: false,
  validDays: 30,
  ...over,
});

function setup() {
  const db = worldDb(); // seeds M1 v1 ($150 / $100 / threshold $100, COMPUTE only) and two sellers
  const store = createSqliteMandateStore(db);
  let clock = Date.parse("2026-02-01T00:00:00.000Z");
  let n = 0;
  const service = createMandateService({
    store,
    now: () => new Date((clock += 1_000)),
    newId: (prefix) => `${prefix}_${String(++n).padStart(4, "0")}`,
  });
  const snapshot = () => ({
    mandates: count(db, "mandates"),
    drafts: count(db, "mandate_drafts"),
    audit: count(db, "audit_events"),
    m1: JSON.stringify(getMandate(db, "M1", 1)),
  });
  const ok = <T>(r: { ok: true; value: T } | { ok: false; errors: unknown }): T => {
    if (!r.ok) throw new Error(`expected ok, got ${JSON.stringify(r.errors)}`);
    return r.value;
  };
  return { db, store, service, snapshot, ok };
}

describe("authority: only the human operator can touch a mandate", () => {
  const FORGED: [string, unknown][] = [
    ["an AI agent", AGENT],
    ["an anonymous caller", ANON],
    ["an operator with no id", { kind: "OPERATOR" }],
    ["an operator with an empty id", { kind: "OPERATOR", id: "" }],
    ["an operator with a non-string id", { kind: "OPERATOR", id: 7 }],
    ["a lower-case 'operator'", { kind: "operator", id: "demo_operator" }],
    ["a bare string", "OPERATOR"],
    ["null", null],
    ["undefined", undefined],
    [
      "an object claiming isOperator",
      { kind: "AGENT", id: "x", isOperator: true, role: "OPERATOR" },
    ],
  ];

  const calls: [string, (s: ReturnType<typeof setup>["service"], actor: Actor) => unknown][] = [
    ["overview", (s, a) => s.overview(a)],
    ["createDraft", (s, a) => s.createDraft(a, { fields: fields() })],
    [
      "updateDraft",
      (s, a) => s.updateDraft(a, { draftId: "drf_0001", revision: 1, fields: fields() }),
    ],
    ["discardDraft", (s, a) => s.discardDraft(a, { draftId: "drf_0001", revision: 1 })],
    ["approveDraft", (s, a) => s.approveDraft(a, { draftId: "drf_0001", revision: 1 })],
    ["revoke", (s, a) => s.revoke(a, { mandateId: "M1", expectedVersion: 1 })],
  ];

  it.each(calls)("%s refuses non-operators and changes nothing", (_name, call) => {
    const { service, snapshot, ok } = setup();
    ok(service.createDraft(OPERATOR, { fields: fields() })); // a real draft exists, so an agent could in principle target it
    const before = snapshot();
    for (const [who, actor] of FORGED) {
      expectRejected(() => call(service, actor as Actor), /only the human operator may/);
      expect(snapshot(), who).toEqual(before);
    }
  });

  it("refuses an agent BEFORE validating, so it learns nothing from error messages", () => {
    const { service } = setup();
    let error: unknown;
    try {
      service.createDraft(AGENT, {
        fields: { totalBudget: "-1", currency: "XXX", status: "ACTIVE" },
      });
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(ForbiddenError);
    expect(String((error as Error).message)).not.toMatch(/budget|currency|status|recognised/i);
  });

  it("an agent cannot approve a draft the operator created, nor edit, discard or revoke", () => {
    const { service, snapshot, ok, db } = setup();
    const draft = ok(
      service.createDraft(OPERATOR, { basedOn: { mandateId: "M1", version: 1 }, fields: fields() }),
    );
    const before = snapshot();
    expectRejected(
      () => service.approveDraft(AGENT, { draftId: draft.id, revision: draft.revision }),
      /only the human operator/,
    );
    expectRejected(
      () =>
        service.updateDraft(AGENT, {
          draftId: draft.id,
          revision: draft.revision,
          fields: fields({ totalBudget: "9999.00" }),
        }),
      /only the human operator/,
    );
    expectRejected(
      () => service.discardDraft(AGENT, { draftId: draft.id, revision: draft.revision }),
      /only the human operator/,
    );
    expectRejected(
      () => service.revoke(AGENT, { mandateId: "M1", expectedVersion: 1 }),
      /only the human operator/,
    );
    expect(snapshot()).toEqual(before);
    expect(getLatestMandate(db, "M1")?.version).toBe(1);
  });
});

describe("validation feedback (server-side, field by field)", () => {
  const errorsOf = (r: ReturnType<ReturnType<typeof setup>["service"]["createDraft"]>) => {
    if (r.ok) throw new Error("expected failure");
    return r.errors;
  };

  it.each([
    ["negative budget", { totalBudget: "-5.00" }, "totalBudget", /must not be negative/],
    [
      "negative maximum",
      { maxTransactionAmount: "-0.01" },
      "maxTransactionAmount",
      /must not be negative/,
    ],
    [
      "negative threshold",
      { approvalThreshold: "-1" },
      "approvalThreshold",
      /must not be negative/,
    ],
    ["invalid currency", { currency: "BTC" }, "currency", /not supported/],
    ["lower-case currency", { currency: "usd" }, "currency", /not supported/],
    [
      "unsupported category",
      { allowedCategories: ["COMPUTE", "WEAPONS"] },
      "allowedCategories",
      /unsupported categories: "WEAPONS"/,
    ],
    ["no categories", { allowedCategories: [] }, "allowedCategories", /at least one/],
    [
      "maximum above budget",
      { maxTransactionAmount: "300.01" },
      "maxTransactionAmount",
      /must not exceed the total budget/,
    ],
    [
      "threshold above maximum",
      { approvalThreshold: "120.01" },
      "approvalThreshold",
      /must not exceed the maximum/,
    ],
    ["too many decimals", { totalBudget: "300.001" }, "totalBudget", /at most 2 decimal places/],
    ["a JSON number for money", { totalBudget: 300 }, "totalBudget", /decimal string/],
    [
      "unknown seller",
      { allowedSellerIds: ["seller_ghost"] },
      "allowedSellerIds",
      /unknown sellers/,
    ],
  ])("%s", (_name, over, field, pattern) => {
    const { service, snapshot } = setup();
    const before = snapshot();
    const errors = errorsOf(service.createDraft(OPERATOR, { fields: fields(over) }));
    expect(errors.find((e) => e.field === field)?.message).toMatch(pattern);
    expect(snapshot()).toEqual(before); // nothing was written
  });

  it("reports every missing field when given an empty object", () => {
    const { service } = setup();
    const names = errorsOf(service.createDraft(OPERATOR, { fields: {} }))
      .map((e) => e.field)
      .sort();
    expect(names).toEqual([
      "allowedCategories",
      "allowedSellerIds",
      "approvalThreshold",
      "currency",
      "maxTransactionAmount",
      "requireReviewBeforeExecution",
      "totalBudget",
      "validDays",
    ]);
  });

  it("accepts the exact boundaries: max == budget, threshold == max, threshold 0, one-cent budget", () => {
    const { service, ok } = setup();
    ok(
      service.createDraft(OPERATOR, {
        fields: fields({
          totalBudget: "120.00",
          maxTransactionAmount: "120.00",
          approvalThreshold: "120.00",
        }),
      }),
    );
    const { service: s2, ok: ok2 } = setup();
    ok2(
      s2.createDraft(OPERATOR, {
        fields: fields({
          totalBudget: "0.01",
          maxTransactionAmount: "0.01",
          approvalThreshold: "0",
        }),
      }),
    );
  });

  it("rejects request-level forged fields and malformed requests", () => {
    const { service, snapshot } = setup();
    const before = snapshot();
    const forged = errorsOf(
      service.createDraft(OPERATOR, {
        approved: true,
        status: "ACTIVE",
        createdBy: "AGENT",
        fields: fields(),
      }),
    );
    expect(forged.map((e) => e.field).sort()).toEqual(["approved", "createdBy", "status"]);

    const bad = service.updateDraft(OPERATOR, {
      draftId: "../etc",
      revision: 0,
      fields: fields(),
      extra: 1,
    });
    expect(bad.ok).toBe(false);
    if (!bad.ok)
      expect(bad.errors.map((e) => e.field).sort()).toEqual(["draftId", "extra", "revision"]);
    expect(service.approveDraft(OPERATOR, { draftId: "drf_1" }).ok).toBe(false);
    expect(service.revoke(OPERATOR, { mandateId: "M1", expectedVersion: 1.5 }).ok).toBe(false);
    expect(snapshot()).toEqual(before);
  });

  it("rejects fields that try to set approval state, version, authorship or id", () => {
    const { service, snapshot } = setup();
    const before = snapshot();
    for (const forgedKey of [
      "status",
      "version",
      "createdBy",
      "approved",
      "id",
      "mandateId",
      "contentHash",
      "actor",
    ]) {
      const r = service.createDraft(OPERATOR, {
        fields: fields({ [forgedKey]: forgedKey === "approved" ? true : "ACTIVE" }),
      });
      expect(r.ok, forgedKey).toBe(false);
    }
    expect(snapshot()).toEqual(before);
  });
});

describe("drafts versus approved mandates", () => {
  it("creating and editing a draft never changes an approved mandate", () => {
    const { service, snapshot, ok, db } = setup();
    const m1Before = snapshot().m1;
    const draft = ok(
      service.createDraft(OPERATOR, { basedOn: { mandateId: "M1", version: 1 }, fields: fields() }),
    );
    expect(draft).toMatchObject({ mandateId: "M1", baseVersion: 1, revision: 1, status: "DRAFT" });

    let current = draft;
    for (const budget of ["400.00", "500.00", "999.99"]) {
      current = ok(
        service.updateDraft(OPERATOR, {
          draftId: current.id,
          revision: current.revision,
          fields: fields({ totalBudget: budget }),
        }),
      );
    }
    expect(current.revision).toBe(4);
    expect(current.fields.totalBudget).toBe("999.99");
    expect(getLatestMandate(db, "M1")?.version).toBe(1);
    expect(snapshot().m1).toBe(m1Before);
    expect(count(db, "mandates")).toBe(1);
  });

  it("approving creates the NEXT immutable version; the old version is untouched and traceable to the draft", () => {
    const { service, ok, db } = setup();
    const v1 = getMandate(db, "M1", 1);
    const draft = ok(
      service.createDraft(OPERATOR, { basedOn: { mandateId: "M1", version: 1 }, fields: fields() }),
    );
    const v2 = ok(service.approveDraft(OPERATOR, { draftId: draft.id, revision: draft.revision }));

    expect(v2).toMatchObject({ id: "M1", version: 2, status: "ACTIVE", sourceDraftId: draft.id });
    expect(v2.fields).toMatchObject({
      totalBudget: "300.00",
      maxTransactionAmount: "120.00",
      approvalThreshold: "100.00",
    });
    expect(v2.rules.join(" ")).toMatch(/Total spending budget: 300\.00 USD/);
    // expiry = approval time + validDays exactly
    expect(Date.parse(v2.expiresAt) - Date.parse(v2.createdAt)).toBe(30 * 24 * 3600 * 1000);

    expect(getMandate(db, "M1", 1)).toEqual(v1); // byte-for-byte the same
    expect(cell(db, "SELECT status FROM mandate_drafts WHERE id = ?", [draft.id])).toBe("APPROVED");
    expect(cell(db, "SELECT approved_version FROM mandate_drafts WHERE id = ?", [draft.id])).toBe(
      2,
    );
    expect(cell(db, "SELECT COUNT(*) FROM audit_events WHERE type = 'MANDATE_APPROVED'")).toBe(1);
    expect(verifyChain(db).status).toBe("VERIFIED");
  });

  it("a new mandate (no base) becomes version 1 of a freshly generated id", () => {
    const { service, ok } = setup();
    const draft = ok(service.createDraft(OPERATOR, { fields: fields() }));
    expect(draft.baseVersion).toBeNull();
    expect(draft.mandateId).toMatch(/^mdt_/);
    const v1 = ok(service.approveDraft(OPERATOR, { draftId: draft.id, revision: draft.revision }));
    expect(v1).toMatchObject({ id: draft.mandateId, version: 1 });
  });

  it("transactions keep the exact version they started under, whatever is approved afterwards", () => {
    const { service, ok, db } = setup();
    const old = createTransaction(db, { id: "tx-old", mandateId: "M1", now: T0 });
    expect(old.mandateVersion).toBe(1);

    const draft = ok(
      service.createDraft(OPERATOR, {
        basedOn: { mandateId: "M1", version: 1 },
        fields: fields({
          totalBudget: "10000.00",
          maxTransactionAmount: "5000.00",
          approvalThreshold: "5000.00",
        }),
      }),
    );
    ok(service.approveDraft(OPERATOR, { draftId: draft.id, revision: draft.revision }));

    // the existing transaction still points at v1, whose rules are unchanged...
    expect(cell(db, "SELECT mandate_version FROM transactions WHERE id = 'tx-old'")).toBe(1);
    expect(getMandate(db, "M1", 1)).toMatchObject({
      perTxCapMinor: 10_000,
      totalBudgetMinor: 15_000,
    });
    // ...and a transaction started now is pinned to v2
    const fresh = createTransaction(db, { id: "tx-new", mandateId: "M1", now: T0 });
    expect(fresh.mandateVersion).toBe(2);
  });

  it("stale or conflicting edits are refused with a clear conflict", () => {
    const { service, ok } = setup();
    const draft = ok(
      service.createDraft(OPERATOR, { basedOn: { mandateId: "M1", version: 1 }, fields: fields() }),
    );
    ok(
      service.updateDraft(OPERATOR, {
        draftId: draft.id,
        revision: 1,
        fields: fields({ totalBudget: "310.00" }),
      }),
    );
    // someone else (another tab) is still holding revision 1
    expectRejected(
      () => service.updateDraft(OPERATOR, { draftId: draft.id, revision: 1, fields: fields() }),
      /changed elsewhere/,
    );
    expectRejected(
      () => service.approveDraft(OPERATOR, { draftId: draft.id, revision: 1 }),
      /changed elsewhere/,
    );
    // a second open draft for the same mandate
    expect(() =>
      service.createDraft(OPERATOR, { basedOn: { mandateId: "M1", version: 1 }, fields: fields() }),
    ).toThrow(ConflictError);
  });

  it("an approved or discarded draft is final", () => {
    const { service, ok } = setup();
    const a = ok(service.createDraft(OPERATOR, { fields: fields() }));
    const approved = ok(service.approveDraft(OPERATOR, { draftId: a.id, revision: a.revision }));
    expect(approved.version).toBe(1);
    // revision moved on to 2 when approved; even with the right revision it cannot change
    expectRejected(
      () => service.updateDraft(OPERATOR, { draftId: a.id, revision: 2, fields: fields() }),
      /already approved/,
    );
    expectRejected(
      () => service.approveDraft(OPERATOR, { draftId: a.id, revision: 2 }),
      /already approved/,
    );

    const b = ok(service.createDraft(OPERATOR, { fields: fields() }));
    ok(service.discardDraft(OPERATOR, { draftId: b.id, revision: b.revision }));
    expectRejected(
      () => service.updateDraft(OPERATOR, { draftId: b.id, revision: 2, fields: fields() }),
      /already discarded/,
    );
    expectRejected(
      () => service.approveDraft(OPERATOR, { draftId: b.id, revision: 2 }),
      /already discarded/,
    );
  });

  it("a draft that is no longer based on the latest version cannot be approved (create a new draft instead)", () => {
    const { service, ok } = setup();
    const draft = ok(
      service.createDraft(OPERATOR, { basedOn: { mandateId: "M1", version: 1 }, fields: fields() }),
    );
    ok(service.revoke(OPERATOR, { mandateId: "M1", expectedVersion: 1 })); // M1 moves to v2 (revoked)
    expectRejected(
      () => service.approveDraft(OPERATOR, { draftId: draft.id, revision: draft.revision }),
      /mandate changed since this draft was started/,
    );

    // and a new draft cannot be based on the superseded version either
    expectRejected(
      () =>
        service.createDraft(OPERATOR, {
          basedOn: { mandateId: "M1", version: 1 },
          fields: fields(),
        }),
      /changed since this draft was started|latest/,
    );
  });

  it("unknown drafts and mandates are reported as not found", () => {
    const { service } = setup();
    expect(() =>
      service.updateDraft(OPERATOR, { draftId: "drf_missing", revision: 1, fields: fields() }),
    ).toThrow(NotFoundError);
    expect(() => service.approveDraft(OPERATOR, { draftId: "drf_missing", revision: 1 })).toThrow(
      NotFoundError,
    );
    expect(() => service.revoke(OPERATOR, { mandateId: "nope", expectedVersion: 1 })).toThrow(
      NotFoundError,
    );
    expect(() =>
      service.createDraft(OPERATOR, { basedOn: { mandateId: "M1", version: 9 }, fields: fields() }),
    ).toThrow(NotFoundError);
  });
});

describe("revocation", () => {
  it("adds a final REVOKED version, blocks new transactions, and cannot be repeated or raced", () => {
    const { service, ok, db } = setup();
    expectRejected(
      () => service.revoke(OPERATOR, { mandateId: "M1", expectedVersion: 5 }),
      /now at version 1/,
    );
    const revoked = ok(service.revoke(OPERATOR, { mandateId: "M1", expectedVersion: 1 }));
    expect(revoked).toMatchObject({ version: 2, status: "REVOKED" });
    expect(getMandate(db, "M1", 1)?.status).toBe("ACTIVE"); // history is never rewritten
    expectRejected(() => createTransaction(db, { id: "t", mandateId: "M1", now: T0 }), /ACTIVE/);
    expectRejected(
      () => service.revoke(OPERATOR, { mandateId: "M1", expectedVersion: 2 }),
      /already revoked/,
    );
    expect(cell(db, "SELECT COUNT(*) FROM audit_events WHERE type = 'MANDATE_REVOKED'")).toBe(1);
  });
});

describe("overview", () => {
  it("lists mandates with their versions, open drafts, sellers and the closed option lists", () => {
    const { service, ok } = setup();
    const draft = ok(
      service.createDraft(OPERATOR, { basedOn: { mandateId: "M1", version: 1 }, fields: fields() }),
    );
    const fresh = ok(service.createDraft(OPERATOR, { fields: fields() }));
    const o = service.overview(OPERATOR);
    expect(o.mandates).toHaveLength(1);
    expect(o.mandates[0]).toMatchObject({
      id: "M1",
      latest: { version: 1, status: "ACTIVE" },
      openDraft: { id: draft.id },
    });
    expect(o.drafts.map((d) => d.id)).toEqual([fresh.id]); // only drafts of not-yet-approved mandates
    expect(o.sellers.map((s) => s.id)).toEqual(["seller_acme", "seller_other"]);
    expect(o.currencies.map((c) => c.code)).toEqual(["USD", "EUR", "GBP", "JPY"]);
    expect(o.currencies.find((c) => c.code === "JPY")?.exponent).toBe(0);
    expect(o.categories.map((c) => c.code)).toContain("COMPUTE");
    expect(o.mandates[0]?.latest.fields).toMatchObject({
      totalBudget: "150.00",
      maxTransactionAmount: "100.00",
      approvalThreshold: "100.00",
    });
  });
});
