import { appendAuditEvent } from "./audit.ts";
import { inTransaction, one, type Db } from "./database.ts";
import { createSeller, insertMandateVersion, upsertCatalogItem } from "./store.ts";

/**
 * Development seed data. Everything is synthetic: made-up ids, no emails, no PayPal identifiers,
 * no credentials. Matches the fixture used by the Arena UI (seller_acme, mandate M1: $100 cap, $150 budget).
 * Idempotent: does nothing if the seed was already applied.
 */
export function seedDevelopment(db: Db, now: string): { seeded: boolean } {
  if (one(db, "SELECT 1 AS x FROM sellers WHERE id = 'seller_acme'")) return { seeded: false };
  return inTransaction(db, () => {
    createSeller(db, {
      id: "seller_acme",
      displayName: "Acme Compute (synthetic)",
      payeeRef: "payee_acme",
      now,
    });
    createSeller(db, {
      id: "seller_backup_demo",
      displayName: "Backup Reseller (synthetic, not allowed)",
      payeeRef: "payee_backup_demo",
      now,
    });

    for (const [sku, unitPriceMinor] of [
      ["GPU-PACK", 8_000],
      ["GPU-PACK-S", 6_000],
      ["GPU-PACK-XL", 45_000],
    ] as const) {
      upsertCatalogItem(db, {
        sellerId: "seller_acme",
        sku,
        unitPriceMinor,
        currency: "USD",
        category: "COMPUTE",
      });
    }

    const expiresAt = new Date(new Date(now).getTime() + 365 * 24 * 3600 * 1000).toISOString();
    insertMandateVersion(db, {
      id: "M1",
      ownerId: "demo_operator",
      perTxCapMinor: 10_000,
      totalBudgetMinor: 15_000,
      approvalThresholdMinor: 9_000,
      requireReview: false,
      currency: "USD",
      allowedCategories: ["COMPUTE"],
      allowedSellerIds: ["seller_acme"],
      expiresAt,
      status: "ACTIVE",
      now,
    });

    appendAuditEvent(db, {
      ts: now,
      actor: "SYSTEM",
      type: "SEED_APPLIED",
      subjectType: "seed",
      subjectId: "development",
      payload: { sellers: ["seller_acme", "seller_backup_demo"], mandate: "M1" },
    });
    return { seeded: true };
  });
}
