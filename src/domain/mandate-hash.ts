import { canonicalJson, sha256Hex } from "./canonical.ts";

/**
 * The content hash stored with every approved mandate version. Kept apart from mandate.ts, which is
 * also bundled for the browser, because hashing uses node:crypto. Persistence stores it; the policy
 * engine recomputes it, so terms that are not exactly the approved row's terms (a draft, a stale
 * copy, a forged row) cannot be used to authorize spending.
 *
 * Field names follow the stored row (perTxCapMinor, requireReview). Changing this changes every hash.
 */
export type MandateHashFields = {
  id: string;
  version: number;
  ownerId: string;
  perTxCapMinor: number;
  totalBudgetMinor: number;
  approvalThresholdMinor: number;
  requireReview: boolean;
  currency: string;
  allowedCategories: readonly string[];
  allowedSellerIds: readonly string[];
  expiresAt: string;
  status: string;
};

export function mandateContentHash(m: MandateHashFields): string {
  return sha256Hex(
    canonicalJson({
      id: m.id,
      version: m.version,
      ownerId: m.ownerId,
      perTxCapMinor: m.perTxCapMinor,
      totalBudgetMinor: m.totalBudgetMinor,
      approvalThresholdMinor: m.approvalThresholdMinor,
      requireReview: m.requireReview,
      currency: m.currency,
      allowedCategories: [...m.allowedCategories].sort(),
      allowedSellerIds: [...m.allowedSellerIds].sort(),
      expiresAt: m.expiresAt,
      status: m.status,
    }),
  );
}
