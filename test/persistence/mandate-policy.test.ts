import { describe, expect, it } from "vitest";

import { inTransaction, openDatabase, run, type SqlParam } from "@/adapters/sqlite/database";
import { loadMigrations, migrate } from "@/adapters/sqlite/migrate";
import {
  acceptOffer,
  getMandate,
  insertMandateVersion,
  recordTransactionApproval,
  upsertCatalogItem,
} from "@/adapters/sqlite/store";
import { CATEGORY_CODES, SERVICE_CATEGORIES, type ServiceCategory } from "@/domain/mandate";

import {
  HASH,
  POLICY,
  T0,
  addOffer,
  agreed,
  allowDecision,
  cell,
  count,
  expectRejected,
  freshDb,
  newTx,
  rawInsert,
  step,
  tick,
  worldDb,
} from "./helpers";

const mandateOver = (over: Record<string, unknown> = {}) => ({
  ...POLICY,
  id: "M1",
  ownerId: "demo_operator",
  perTxCapMinor: 10_000,
  totalBudgetMinor: 15_000,
  currency: "USD",
  allowedSellerIds: ["seller_acme"],
  expiresAt: "2027-01-01T00:00:00.000Z",
  status: "ACTIVE" as const,
  now: T0,
  ...over,
});

describe("mandate policy columns", () => {
  it("stores categories sorted, the threshold, and the review flag; all of them affect the content hash", () => {
    const db = worldDb();
    const base = getMandate(db, "M1", 1);
    expect(base).toMatchObject({
      allowedCategories: ["COMPUTE"],
      approvalThresholdMinor: 10_000,
      requireReview: false,
    });

    const hashes = new Set([base?.contentHash]);
    for (const over of [
      { approvalThresholdMinor: 9_999 },
      { requireReview: true },
      { allowedCategories: ["COMPUTE", "STORAGE"] as ServiceCategory[] },
    ]) {
      const db2 = worldDb();
      hashes.add(insertMandateVersion(db2, mandateOver(over)).contentHash);
    }
    expect(hashes.size).toBe(4);

    const sorted = insertMandateVersion(
      worldDb(),
      mandateOver({ allowedCategories: ["STORAGE", "COMPUTE"] }),
    );
    expect(sorted.allowedCategories).toEqual(["COMPUTE", "STORAGE"]);
  });

  it("rejects empty or unsupported categories and a threshold above the cap", () => {
    const db = worldDb();
    expectRejected(
      () => insertMandateVersion(db, mandateOver({ allowedCategories: [] })),
      /non-empty list of supported categories/,
    );
    expectRejected(
      () => insertMandateVersion(db, mandateOver({ allowedCategories: ["GAMBLING"] })),
      /supported categories/,
    );
    expectRejected(
      () => insertMandateVersion(db, mandateOver({ approvalThresholdMinor: 10_001 })),
      /must not exceed the per-transaction cap/,
    );
    expectRejected(
      () => insertMandateVersion(db, mandateOver({ approvalThresholdMinor: 0.5 })),
      /non-negative safe integer/,
    );
    expect(count(db, "mandates")).toBe(1);
  });

  it("accepts the boundaries: threshold 0, threshold equal to the cap", () => {
    expect(
      insertMandateVersion(worldDb(), mandateOver({ approvalThresholdMinor: 0 }))
        .approvalThresholdMinor,
    ).toBe(0);
    expect(
      insertMandateVersion(worldDb(), mandateOver({ approvalThresholdMinor: 10_000 }))
        .approvalThresholdMinor,
    ).toBe(10_000);
  });

  it("keeps the policy fields immutable like the rest of the row", () => {
    const db = worldDb();
    for (const set of [
      "allowed_categories = '[\"STORAGE\"]'",
      "approval_threshold_minor = 1",
      "require_review = 1",
    ]) {
      expectRejected(() => run(db, `UPDATE mandates SET ${set} WHERE id = 'M1'`), /immutable/);
    }
  });

  it("gives legacy rows (created before this migration) the safest defaults and then fails closed", () => {
    const db = openDatabase(":memory:");
    migrate(db, { migrations: loadMigrations().slice(0, 4), now: T0 }); // the schema as it was before
    rawInsert(db, "sellers", {
      id: "seller_acme",
      display_name: "Acme",
      payee_ref: "payee_acme",
      created_at: T0,
    });
    rawInsert(db, "mandates", {
      id: "OLD",
      version: 1,
      owner_id: "demo_operator",
      per_tx_cap_minor: 10_000,
      total_budget_minor: 15_000,
      currency: "USD",
      allowed_seller_ids: '["seller_acme"]',
      expires_at: "2027-01-01T00:00:00.000Z",
      status: "ACTIVE",
      created_by: "OPERATOR",
      content_hash: HASH,
      created_at: T0,
    });
    migrate(db, { now: T0 }); // applies 0005
    expect(
      db
        .prepare(
          "SELECT allowed_categories, approval_threshold_minor, require_review FROM mandates",
        )
        .get(),
    ).toMatchObject({
      allowed_categories: "[]", // nothing is allowed
      approval_threshold_minor: 0, // everything is above the threshold
      require_review: 1, // and every transaction needs review
    });
  });
});

describe("categories are enforced on what is actually bought", () => {
  it("derives a line's category from the seller catalog, and refuses a spoofed one", () => {
    const db = worldDb();
    newTx(db);
    addOffer(db, "tx1", { id: "o1" });
    expect(cell(db, "SELECT category FROM offer_lines WHERE offer_id = 'o1'")).toBe("COMPUTE");
    expectRejected(
      () =>
        rawInsert(db, "offer_lines", {
          offer_id: "o1",
          line_no: 2,
          sku: "GPU-PACK",
          description: "",
          qty: 1,
          unit_price_minor: 1,
          currency: "USD",
          category: "STORAGE",
        }),
      /category must come from the seller catalog/,
    );
    expectRejected(
      () =>
        rawInsert(db, "offer_lines", {
          offer_id: "o1",
          line_no: 2,
          sku: "UNKNOWN-SKU",
          description: "",
          qty: 1,
          unit_price_minor: 1,
          currency: "USD",
          category: "COMPUTE",
        }),
      /category must come from the seller catalog/,
    );
  });

  it("stores an unknown sku (offers are untrusted input) with no category, and it can never be agreed", () => {
    const db = worldDb();
    newTx(db);
    const o = addOffer(db, "tx1", {
      lines: [{ sku: "NOT-IN-CATALOG", description: "x", qty: 1, unitPriceMinor: 1_000 }],
      claimedTotalMinor: 1_000,
    });
    expect(cell(db, "SELECT category FROM offer_lines WHERE offer_id = ?", [o.id])).toBeNull();
    const d = allowDecision(db, "tx1");
    expectRejected(
      () =>
        acceptOffer(db, {
          agreementId: "agr",
          offerId: o.id,
          policyDecisionId: d,
          expectedVersion: 1,
          now: tick(),
          actor: "SYSTEM",
        }),
      /category the mandate allows/,
    );
  });

  it("refuses to agree an offer whose category the mandate does not allow, and allows it once it does", () => {
    const db = worldDb({ allowedCategories: ["STORAGE"] }); // GPU packs are COMPUTE
    newTx(db);
    const o = addOffer(db, "tx1");
    const d = allowDecision(db, "tx1");
    expectRejected(
      () =>
        acceptOffer(db, {
          agreementId: "agr",
          offerId: o.id,
          policyDecisionId: d,
          expectedVersion: 1,
          now: tick(),
          actor: "SYSTEM",
        }),
      /category the mandate allows/,
    );
    expect(cell(db, "SELECT state FROM transactions WHERE id = 'tx1'")).toBe("NEGOTIATING");

    const db2 = worldDb({ allowedCategories: ["STORAGE", "COMPUTE"] });
    expect(agreed(db2).total).toBe(8_000);
  });

  it("requires every line to be allowed, not just one", () => {
    const db = worldDb({ allowedCategories: ["COMPUTE"] });
    upsertCatalogItem(db, {
      sellerId: "seller_acme",
      sku: "BACKUP-1",
      unitPriceMinor: 500,
      currency: "USD",
      category: "STORAGE",
    });
    newTx(db);
    const o = addOffer(db, "tx1", {
      lines: [
        { sku: "GPU-PACK", description: "", qty: 1, unitPriceMinor: 8_000 },
        { sku: "BACKUP-1", description: "", qty: 1, unitPriceMinor: 500 },
      ],
      claimedTotalMinor: 8_500,
    });
    const d = allowDecision(db, "tx1");
    expectRejected(
      () =>
        acceptOffer(db, {
          agreementId: "agr",
          offerId: o.id,
          policyDecisionId: d,
          expectedVersion: 1,
          now: tick(),
          actor: "SYSTEM",
        }),
      /category the mandate allows/,
    );
  });

  it("rejects an unsupported category on a catalog item", () => {
    const db = worldDb();
    expectRejected(
      () =>
        upsertCatalogItem(db, {
          sellerId: "seller_acme",
          sku: "X",
          unitPriceMinor: 1,
          currency: "USD",
          category: "GAMBLING" as ServiceCategory,
        }),
      /FOREIGN KEY/,
    );
  });

  it("keeps the category list read-only and identical to the domain list", () => {
    const db = freshDb();
    const rows = db.prepare("SELECT code, label FROM service_categories ORDER BY code").all() as {
      code: string;
      label: string;
    }[];
    expect(rows.map((r) => r.code)).toEqual([...CATEGORY_CODES].sort());
    for (const r of rows) expect(r.label).toBe(SERVICE_CATEGORIES[r.code as ServiceCategory]);
    expectRejected(
      () => run(db, "INSERT INTO service_categories (code, label) VALUES ('GAMBLING', 'x')"),
      /read-only/,
    );
    expectRejected(() => run(db, "DELETE FROM service_categories"), /read-only/);
    expectRejected(() => run(db, "UPDATE service_categories SET label = 'x'"), /read-only/);
  });
});

describe("mandate drafts (the only mutable place)", () => {
  const draft = (over: Record<string, SqlParam> = {}): Record<string, SqlParam> => ({
    id: "d1",
    mandate_id: "NEW1",
    base_version: null,
    owner_id: "demo_operator",
    revision: 1,
    status: "DRAFT",
    currency: "USD",
    total_budget_minor: 15_000,
    per_tx_cap_minor: 10_000,
    approval_threshold_minor: 9_000,
    require_review: 0,
    allowed_categories: '["COMPUTE"]',
    allowed_seller_ids: '["seller_acme"]',
    valid_days: 30,
    approved_version: null,
    created_at: T0,
    updated_at: T0,
    ...over,
  });

  const cases: [string, Record<string, SqlParam>, RegExp][] = [
    ["zero budget", { total_budget_minor: 0 }, /CHECK constraint failed/],
    ["negative budget", { total_budget_minor: -1 }, /CHECK constraint failed/],
    ["fractional budget", { total_budget_minor: 10.5 }, /cannot store REAL/],
    ["cap above budget", { per_tx_cap_minor: 15_001 }, /CHECK constraint failed/],
    ["threshold above cap", { approval_threshold_minor: 10_001 }, /CHECK constraint failed/],
    ["negative threshold", { approval_threshold_minor: -1 }, /CHECK constraint failed/],
    ["bad currency", { currency: "usd" }, /CHECK constraint failed/],
    ["review flag 2", { require_review: 2 }, /CHECK constraint failed/],
    ["zero days", { valid_days: 0 }, /CHECK constraint failed/],
    ["366 days", { valid_days: 366 }, /CHECK constraint failed/],
    ["no categories", { allowed_categories: "[]" }, /CHECK constraint failed/],
    [
      "seven categories",
      { allowed_categories: '["COMPUTE","STORAGE","DATA","SOFTWARE","DESIGN","CONSULTING","X"]' },
      /CHECK constraint failed|supported/,
    ],
    [
      "unsupported category",
      { allowed_categories: '["GAMBLING"]' },
      /categories must all be supported/,
    ],
    ["no sellers", { allowed_seller_ids: "[]" }, /CHECK constraint failed/],
    ["unknown seller", { allowed_seller_ids: '["ghost"]' }, /sellers must all exist/],
    [
      "created already APPROVED",
      { status: "APPROVED", approved_version: 1 },
      /must be DRAFT at revision 1/,
    ],
    ["created at revision 5", { revision: 5 }, /must be DRAFT at revision 1/],
    [
      "not-yet-approved but with an approved version",
      { approved_version: 2 },
      /must be DRAFT at revision 1|CHECK constraint failed/,
    ],
    [
      "new mandate reusing an existing id",
      { mandate_id: "M1" },
      /must not reuse an existing mandate id/,
    ],
    [
      "based on a version that does not exist",
      { mandate_id: "M1", base_version: 7 },
      /latest ACTIVE version|FOREIGN KEY/,
    ],
    ["empty id", { id: "" }, /CHECK constraint failed/],
  ];
  it.each(cases)("rejects: %s", (_name, over, pattern) => {
    const db = worldDb();
    expectRejected(() => rawInsert(db, "mandate_drafts", draft(over)), pattern);
    expect(count(db, "mandate_drafts")).toBe(0);
  });

  it("accepts the baseline row (so each rejection above is caused by its own field)", () => {
    const db = worldDb();
    rawInsert(db, "mandate_drafts", draft());
    rawInsert(db, "mandate_drafts", draft({ id: "d2", mandate_id: "M1", base_version: 1 }));
    expect(count(db, "mandate_drafts")).toBe(2);
  });

  it("allows only one open draft per mandate", () => {
    const db = worldDb();
    rawInsert(db, "mandate_drafts", draft({ mandate_id: "M1", base_version: 1 }));
    expectRejected(
      () => rawInsert(db, "mandate_drafts", draft({ id: "d2", mandate_id: "M1", base_version: 1 })),
      /UNIQUE constraint failed/,
    );
  });

  it("requires a draft to be based on the LATEST ACTIVE version", () => {
    const db = worldDb();
    insertMandateVersion(db, mandateOver({ perTxCapMinor: 20_000, totalBudgetMinor: 30_000 })); // v2
    expectRejected(
      () => rawInsert(db, "mandate_drafts", draft({ mandate_id: "M1", base_version: 1 })),
      /latest ACTIVE version/,
    );
    insertMandateVersion(db, mandateOver({ status: "REVOKED" })); // v3
    expectRejected(
      () => rawInsert(db, "mandate_drafts", draft({ mandate_id: "M1", base_version: 3 })),
      /latest ACTIVE version/,
    );
  });

  it("can be edited only while open, one revision at a time, and never deleted", () => {
    const db = worldDb();
    rawInsert(db, "mandate_drafts", draft());
    const upd = (set: string, params: SqlParam[] = []) =>
      run(db, `UPDATE mandate_drafts SET ${set} WHERE id = 'd1'`, params);
    expectRejected(() => upd("total_budget_minor = 16000"), /revision must increase by exactly 1/);
    expectRejected(
      () => upd("revision = 3, total_budget_minor = 16000"),
      /revision must increase by exactly 1/,
    );
    upd("revision = 2, total_budget_minor = 16000, updated_at = ?", [tick()]);
    expectRejected(() => upd("revision = 3, mandate_id = 'OTHER'"), /immutable draft column/);
    expectRejected(() => upd("revision = 3, owner_id = 'someone_else'"), /immutable draft column/);
    expectRejected(() => upd("revision = 3, base_version = 1"), /immutable draft column/);
    expectRejected(
      () => upd("revision = 3, allowed_categories = '[\"GAMBLING\"]'"),
      /categories must all be supported/,
    );
    expectRejected(
      () => upd("revision = 3, status = 'APPROVED', approved_version = 1"),
      /approved draft must match the mandate version/,
    );
    upd("revision = 3, status = 'DISCARDED', updated_at = ?", [tick()]);
    expectRejected(
      () => upd("revision = 4, status = 'DRAFT'"),
      /approved and discarded drafts are final/,
    );
    expectRejected(
      () => run(db, "DELETE FROM mandate_drafts WHERE id = 'd1'"),
      /cannot be deleted/,
    );
  });

  it("a version created from a draft must match it exactly, and the draft can only be approved into that version", () => {
    const db = worldDb();
    rawInsert(db, "mandate_drafts", draft({ id: "dx", mandate_id: "M1", base_version: 1 }));
    // differs from the draft (budget 15000 vs 20000)
    expectRejected(
      () =>
        insertMandateVersion(
          db,
          mandateOver({
            sourceDraftId: "dx",
            perTxCapMinor: 10_000,
            totalBudgetMinor: 20_000,
            approvalThresholdMinor: 9_000,
          }),
        ),
      /match that draft exactly/,
    );
    // the matching version is accepted
    const v2 = insertMandateVersion(
      db,
      mandateOver({ sourceDraftId: "dx", approvalThresholdMinor: 9_000 }),
    );
    expect(v2.sourceDraftId).toBe("dx");
    // approving a different draft id into it is refused, the right one works
    run(
      db,
      "UPDATE mandate_drafts SET status = 'APPROVED', approved_version = 2, revision = 2, updated_at = ? WHERE id = 'dx'",
      [tick()],
    );
    expect(cell(db, "SELECT status FROM mandate_drafts WHERE id = 'dx'")).toBe("APPROVED");
  });

  it("a draft-sourced version cannot be REVOKED, for another mandate id, or from a draft that is not open", () => {
    const db = worldDb();
    rawInsert(db, "mandate_drafts", draft({ id: "dz", mandate_id: "M1", base_version: 1 }));
    expectRejected(
      () =>
        insertMandateVersion(
          db,
          mandateOver({ sourceDraftId: "dz", approvalThresholdMinor: 9_000, status: "REVOKED" }),
        ),
      /match that draft exactly/,
    );
    expectRejected(
      () =>
        insertMandateVersion(
          db,
          mandateOver({ id: "M2", sourceDraftId: "dz", approvalThresholdMinor: 9_000 }),
        ),
      /match that draft exactly/,
    );
    expectRejected(
      () =>
        insertMandateVersion(
          db,
          mandateOver({ sourceDraftId: "ghost", approvalThresholdMinor: 9_000 }),
        ),
      /match that draft exactly/,
    );
  });
});

describe("human approval gate before execution", () => {
  const toCreatingOrder = (db: ReturnType<typeof worldDb>) => {
    agreed(db);
    return () => step(db, "tx1", "CREATING_ORDER");
  };
  const approve = (
    db: ReturnType<typeof worldDb>,
    decision: "APPROVED" | "REJECTED" = "APPROVED",
  ) =>
    recordTransactionApproval(db, {
      id: `ap-${decision}`,
      transactionId: "tx1",
      decision,
      now: tick(),
    });

  it("blocks execution of every transaction when the mandate requires review, until approved", () => {
    const db = worldDb({ requireReview: true, approvalThresholdMinor: 10_000 });
    const execute = toCreatingOrder(db);
    expectRejected(execute, /human approval is required/);
    approve(db);
    expect(execute().state).toBe("CREATING_ORDER");
  });

  it("a REJECTED decision never unlocks execution", () => {
    const db = worldDb({ requireReview: true });
    const execute = toCreatingOrder(db);
    approve(db, "REJECTED");
    expectRejected(execute, /human approval is required/);
  });

  it.each([
    ["threshold below the total", 7_999, true],
    ["threshold equal to the total (equal is NOT above)", 8_000, false],
    ["threshold above the total", 8_001, false],
    ["threshold of zero", 0, true],
  ])("threshold boundary: %s", (_name, threshold, needsApproval) => {
    const db = worldDb({ approvalThresholdMinor: threshold, requireReview: false }); // the $80.00 agreement
    const execute = toCreatingOrder(db);
    if (needsApproval) {
      expectRejected(execute, /human approval is required/);
      approve(db);
    }
    expect(execute().state).toBe("CREATING_ORDER");
  });

  it("does not gate other transitions (cancelling an unapproved transaction is always possible)", () => {
    const db = worldDb({ requireReview: true });
    agreed(db);
    expect(step(db, "tx1", "CANCELLED").state).toBe("CANCELLED");
  });

  it("the gate reads the PINNED mandate version: a later, laxer version does not unlock it", () => {
    const db = worldDb({ requireReview: true });
    agreed(db);
    insertMandateVersion(db, mandateOver({ requireReview: false, approvalThresholdMinor: 10_000 })); // v2 is lax
    expectRejected(() => step(db, "tx1", "CREATING_ORDER"), /human approval is required/);
  });

  it("approvals attach to the agreed transaction while it is AGREED, once, as the operator, and are immutable", () => {
    const db = worldDb({ requireReview: true });
    newTx(db, "early");
    expectRejected(
      () =>
        recordTransactionApproval(db, {
          id: "a0",
          transactionId: "early",
          decision: "APPROVED",
          now: tick(),
        }),
      /while it is AGREED/,
    );

    agreed(db);
    approve(db);
    expectRejected(
      () =>
        recordTransactionApproval(db, {
          id: "again",
          transactionId: "tx1",
          decision: "APPROVED",
          now: tick(),
        }),
      /UNIQUE constraint failed/,
    );
    expectRejected(
      () =>
        recordTransactionApproval(db, {
          id: "ghost",
          transactionId: "ghost",
          decision: "APPROVED",
          now: tick(),
        }),
      /transaction ghost not found/,
    );
    expectRejected(
      () => run(db, "UPDATE transaction_approvals SET decision = 'REJECTED'"),
      /immutable/,
    );
    expectRejected(() => run(db, "DELETE FROM transaction_approvals"), /immutable/);
    expect(cell(db, "SELECT COUNT(*) FROM audit_events WHERE type = 'TX_APPROVAL_RECORDED'")).toBe(
      1,
    );
  });

  it("rejects approvals not made by the operator, with a bad decision, or an over-long reason", () => {
    const db = worldDb({ requireReview: true });
    const { agreementId } = agreed(db);
    const row = (over: Record<string, SqlParam>): Record<string, SqlParam> => ({
      id: "x1",
      transaction_id: "tx1",
      agreement_id: agreementId,
      decision: "APPROVED",
      decided_by: "OPERATOR",
      reason: null,
      decided_at: tick(),
      ...over,
    });
    expectRejected(
      () => rawInsert(db, "transaction_approvals", row({ decided_by: "AGENT" })),
      /CHECK constraint failed/,
    );
    expectRejected(
      () => rawInsert(db, "transaction_approvals", row({ decided_by: "SYSTEM" })),
      /CHECK constraint failed/,
    );
    expectRejected(
      () => rawInsert(db, "transaction_approvals", row({ decision: "MAYBE" })),
      /CHECK constraint failed/,
    );
    expectRejected(
      () => rawInsert(db, "transaction_approvals", row({ reason: "x".repeat(501) })),
      /CHECK constraint failed/,
    );
    expectRejected(
      () => rawInsert(db, "transaction_approvals", row({ agreement_id: "other" })),
      /while it is AGREED/,
    );
    expect(() =>
      inTransaction(db, () => rawInsert(db, "transaction_approvals", row({}))),
    ).not.toThrow();
  });
});
