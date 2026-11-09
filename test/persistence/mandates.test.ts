import { describe, expect, it } from "vitest";

import { run, type SqlParam } from "@/adapters/sqlite/database";
import {
  getLatestMandate,
  getMandate,
  insertMandateVersion,
  upsertCatalogItem,
  createSeller,
} from "@/adapters/sqlite/store";

import { POLICY, T0, count, expectRejected, rawInsert, worldDb } from "./helpers";

const baseRow = (over: Record<string, SqlParam> = {}): Record<string, SqlParam> => ({
  id: "M9",
  version: 1,
  owner_id: "demo_operator",
  per_tx_cap_minor: 10_000,
  total_budget_minor: 15_000,
  currency: "USD",
  allowed_seller_ids: '["seller_acme"]',
  allowed_categories: '["COMPUTE"]',
  approval_threshold_minor: 9_000,
  require_review: 0,
  expires_at: "2027-01-01T00:00:00.000Z",
  status: "ACTIVE",
  created_by: "OPERATOR",
  content_hash: "c".repeat(64),
  created_at: T0,
  ...over,
});

const input = (over = {}) => ({
  ...POLICY,
  id: "M1",
  ownerId: "demo_operator",
  perTxCapMinor: 20_000,
  totalBudgetMinor: 30_000,
  currency: "USD",
  allowedSellerIds: ["seller_acme"],
  expiresAt: "2027-06-01T00:00:00.000Z",
  status: "ACTIVE" as const,
  now: T0,
  ...over,
});

describe("mandate versioning", () => {
  it("starts at version 1 and every change is a new immutable row (old versions are kept)", () => {
    const db = worldDb();
    const v2 = insertMandateVersion(db, input());
    expect(v2.version).toBe(2);
    expect(v2.contentHash).toMatch(/^[0-9a-f]{64}$/);

    const v1 = getMandate(db, "M1", 1);
    expect(v1).toMatchObject({ perTxCapMinor: 10_000, totalBudgetMinor: 15_000 });
    expect(getLatestMandate(db, "M1")).toMatchObject({ version: 2, perTxCapMinor: 20_000 });
    expect(v1?.contentHash).not.toBe(v2.contentHash);
  });

  it("hashes content deterministically regardless of allow-list order", () => {
    const a = worldDb();
    const b = worldDb();
    for (const db of [a, b])
      createSeller(db, { id: "seller_z", displayName: "Z", payeeRef: "payee_z", now: T0 });
    const x = insertMandateVersion(a, input({ allowedSellerIds: ["seller_acme", "seller_z"] }));
    const y = insertMandateVersion(b, input({ allowedSellerIds: ["seller_z", "seller_acme"] }));
    expect(x.contentHash).toBe(y.contentHash);
  });

  it("rejects skipped and duplicate versions", () => {
    const db = worldDb();
    expectRejected(
      () => rawInsert(db, "mandates", baseRow({ id: "M1", version: 3 })),
      /previous version \+ 1/,
    );
    expectRejected(
      () => rawInsert(db, "mandates", baseRow({ id: "M1", version: 1 })),
      /previous version \+ 1/,
    );
    expect(count(db, "mandates")).toBe(1);
  });

  it("is immutable: no updates, no deletes", () => {
    const db = worldDb();
    expectRejected(
      () => run(db, "UPDATE mandates SET per_tx_cap_minor = 999999 WHERE id = 'M1'"),
      /immutable/,
    );
    expectRejected(
      () => run(db, "UPDATE mandates SET status = 'REVOKED' WHERE id = 'M1'"),
      /immutable/,
    );
    expectRejected(() => run(db, "DELETE FROM mandates WHERE id = 'M1'"), /cannot be deleted/);
    expect(getMandate(db, "M1", 1)?.perTxCapMinor).toBe(10_000);
  });

  it("treats revocation as a new version and makes a revoked mandate final", () => {
    const db = worldDb();
    const revoked = insertMandateVersion(db, input({ status: "REVOKED" }));
    expect(revoked).toMatchObject({ version: 2, status: "REVOKED" });
    expectRejected(() => insertMandateVersion(db, input()), /revoked mandates are final/);
  });
});

describe("mandate validation", () => {
  const cases: [string, Record<string, SqlParam>, RegExp][] = [
    [
      "cap above budget",
      { per_tx_cap_minor: 20_000, total_budget_minor: 15_000 },
      /CHECK constraint failed/,
    ],
    [
      "zero cap",
      { per_tx_cap_minor: 0 },
      /CHECK constraint failed|must not exceed the per-transaction cap/,
    ],
    [
      "negative cap",
      { per_tx_cap_minor: -5 },
      /CHECK constraint failed|must not exceed the per-transaction cap/,
    ],
    ["fractional cap", { per_tx_cap_minor: 99.5 }, /cannot store REAL value/],
    ["text cap", { per_tx_cap_minor: "lots" }, /cannot store TEXT value/],
    [
      "cap beyond 2^53-1",
      { per_tx_cap_minor: 2 ** 53, total_budget_minor: 2 ** 53 },
      /CHECK constraint failed/,
    ],
    ["lowercase currency", { currency: "usd" }, /CHECK constraint failed/],
    ["two-letter currency", { currency: "US" }, /CHECK constraint failed/],
    ["four-letter currency", { currency: "USDX" }, /CHECK constraint failed/],
    ["authored by an agent", { created_by: "AGENT" }, /CHECK constraint failed/],
    ["unknown status", { status: "PAUSED" }, /CHECK constraint failed/],
    ["empty allow-list", { allowed_seller_ids: "[]" }, /CHECK constraint failed/],
    [
      "allow-list not an array",
      { allowed_seller_ids: '{"a":1}' },
      /existing sellers|CHECK constraint failed/,
    ],
    [
      "allow-list not JSON",
      { allowed_seller_ids: "seller_acme" },
      /malformed JSON|CHECK constraint failed/,
    ],
    ["allow-list with a number", { allowed_seller_ids: "[1]" }, /existing sellers/],
    [
      "allow-list with an unknown seller",
      { allowed_seller_ids: '["seller_ghost"]' },
      /existing sellers/,
    ],
    ["malformed expiry", { expires_at: "tomorrow" }, /CHECK constraint failed/],
    ["malformed created_at", { created_at: "2026-01-01" }, /CHECK constraint failed/],
    ["content hash not hex", { content_hash: "Z".repeat(64) }, /CHECK constraint failed/],
    ["content hash wrong length", { content_hash: "abc" }, /CHECK constraint failed/],
    ["empty id", { id: "", version: 1 }, /CHECK constraint failed/],
    ["null owner", { owner_id: null }, /NOT NULL constraint failed/],
  ];
  it.each(cases)("rejects: %s", (_name, over, pattern) => {
    const db = worldDb();
    expectRejected(() => rawInsert(db, "mandates", baseRow(over)), pattern);
  });

  it("accepts the baseline row used by the cases above (so each rejection is caused by its own field)", () => {
    const db = worldDb();
    rawInsert(db, "mandates", baseRow());
    expect(getMandate(db, "M9", 1)?.allowedSellerIds).toEqual(["seller_acme"]);
  });

  it("validates store inputs before they reach SQL", () => {
    const db = worldDb();
    expectRejected(
      () => insertMandateVersion(db, input({ perTxCapMinor: 1.5 })),
      /non-negative safe integer/,
    );
    expectRejected(
      () => insertMandateVersion(db, input({ totalBudgetMinor: -1 })),
      /non-negative safe integer/,
    );
    expectRejected(
      () => insertMandateVersion(db, input({ currency: "dollars" })),
      /3-letter uppercase/,
    );
  });
});

describe("sellers and catalog", () => {
  it("rejects duplicate seller ids and payee refs", () => {
    const db = worldDb();
    expectRejected(
      () =>
        createSeller(db, { id: "seller_acme", displayName: "Dup", payeeRef: "payee_new", now: T0 }),
      /UNIQUE/,
    );
    expectRejected(
      () =>
        createSeller(db, { id: "seller_new", displayName: "Dup", payeeRef: "payee_acme", now: T0 }),
      /UNIQUE/,
    );
  });

  it("rejects a catalog item for a missing seller or with a bad price", () => {
    const db = worldDb();
    expectRejected(
      () =>
        upsertCatalogItem(db, {
          category: "COMPUTE",
          sellerId: "ghost",
          sku: "X",
          unitPriceMinor: 1,
          currency: "USD",
        }),
      /FOREIGN KEY/,
    );
    expectRejected(
      () =>
        upsertCatalogItem(db, {
          category: "COMPUTE",
          sellerId: "seller_acme",
          sku: "X",
          unitPriceMinor: 0.5,
          currency: "USD",
        }),
      /non-negative safe integer/,
    );
    expectRejected(
      () =>
        upsertCatalogItem(db, {
          category: "COMPUTE",
          sellerId: "seller_acme",
          sku: "X",
          unitPriceMinor: 1,
          currency: "usd",
        }),
      /3-letter uppercase/,
    );
  });

  it("upserts a price for an existing sku", () => {
    const db = worldDb();
    upsertCatalogItem(db, {
      category: "COMPUTE",
      sellerId: "seller_acme",
      sku: "GPU-PACK",
      unitPriceMinor: 8_500,
      currency: "USD",
    });
    expect(count(db, "seller_catalog_items")).toBe(2); // GPU-PACK (updated, not duplicated) and GPU-PACK-XL
  });

  it("cannot delete a seller that a mandate or offer depends on", () => {
    const db = worldDb();
    expectRejected(() => run(db, "DELETE FROM sellers WHERE id = 'seller_acme'"), /FOREIGN KEY/);
  });
});
