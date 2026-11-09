import { describe, expect, it } from "vitest";

import { createSqliteMandateStore } from "@/adapters/sqlite/mandate-store";
import { all, one, type Db } from "@/adapters/sqlite/database";
import {
  computeServerTotal,
  getTransaction,
  insertMandateVersion,
  recordPolicyDecision,
} from "@/adapters/sqlite/store";
import { sumOfferMinor, termsHashOf } from "@/domain/offer";
import { evaluatePolicy, type PolicyInput, type PolicySubject } from "@/domain/policy";

import { POLICY, T0, addOffer, agreed, newTx, tick, worldDb } from "../persistence/helpers";
import { must } from "./fixtures";

/**
 * Test-only loader: builds the engine's input from real database rows. It is a preview of what the
 * application layer will do, and it proves the engine's input type fits the actual schema.
 */
function load(
  db: Db,
  txId: string,
  subject: PolicySubject,
  over: Partial<PolicyInput> = {},
): PolicyInput {
  const tx = getTransaction(db, txId);
  if (!tx) throw new Error("no such transaction");
  const store = createSqliteMandateStore(db);
  const pinned = store.getMandate(tx.mandateId, tx.mandateVersion);
  const latest = store.listVersions(tx.mandateId)[0];
  if (!pinned || !latest) throw new Error("no mandate");

  const agreementRow = tx.agreementId
    ? one<{
        id: string;
        offer_id: string;
        terms_hash: string;
        mandate_id: string;
        mandate_version: number;
        payee_ref: string;
        total_minor: number;
        currency: string;
      }>(db, "SELECT * FROM agreements WHERE id = ?", [tx.agreementId])
    : undefined;
  const offerRow = agreementRow
    ? one<OfferRow>(db, "SELECT * FROM offers WHERE id = ?", [agreementRow.offer_id])
    : one<OfferRow>(
        db,
        "SELECT * FROM offers WHERE transaction_id = ? ORDER BY revision DESC LIMIT 1",
        [txId],
      );
  const lines = offerRow
    ? all<{
        sku: string;
        qty: number;
        unit_price_minor: number;
        category: string | null;
        cat_price: number | null;
      }>(
        db,
        `SELECT l.sku, l.qty, l.unit_price_minor, l.category, c.unit_price_minor AS cat_price
           FROM offer_lines l LEFT JOIN seller_catalog_items c ON c.seller_id = ? AND c.sku = l.sku
          WHERE l.offer_id = ? ORDER BY l.line_no`,
        [offerRow.seller_id, offerRow.id],
      )
    : [];
  const payee = offerRow
    ? one<{ payee_ref: string }>(db, "SELECT payee_ref FROM sellers WHERE id = ?", [
        offerRow.seller_id,
      ])
    : undefined;
  const others = all<{
    id: string;
    state: PolicyInput["transaction"]["state"];
    currency: string;
    total: number | null;
  }>(
    db,
    `SELECT t.id, t.state, t.currency, a.total_minor AS total FROM transactions t
       LEFT JOIN agreements a ON a.id = t.agreement_id WHERE t.mandate_id = ? AND t.id <> ?`,
    [tx.mandateId, txId],
  );
  const approval = one<{
    agreement_id: string;
    decision: "APPROVED" | "REJECTED";
    decided_by: string;
  }>(
    db,
    "SELECT agreement_id, decision, decided_by FROM transaction_approvals WHERE transaction_id = ?",
    [txId],
  );

  return {
    subject,
    now: T0.replace("2026-01-01", "2026-02-01"),
    actor: "SYSTEM",
    transaction: {
      id: tx.id,
      state: tx.state,
      mandateId: tx.mandateId,
      mandateVersion: tx.mandateVersion,
      agreementId: tx.agreementId,
      honorExpiresAt: tx.honorExpiresAt,
    },
    mandate: {
      id: pinned.id,
      version: pinned.version,
      ownerId: pinned.ownerId,
      status: pinned.status,
      expiresAt: pinned.expiresAt,
      contentHash: pinned.contentHash,
      terms: pinned.terms,
    },
    latestMandate: { id: latest.id, version: latest.version, status: latest.status },
    offer:
      offerRow && payee
        ? {
            id: offerRow.id,
            transactionId: offerRow.transaction_id,
            sellerId: offerRow.seller_id,
            catalogPayeeRef: payee.payee_ref,
            currency: offerRow.currency,
            status: offerRow.status,
            validUntil: offerRow.valid_until,
            shippingMinor: offerRow.shipping_minor,
            feesMinor: offerRow.fees_minor,
            claimedTotalMinor: offerRow.claimed_total_minor,
            storedServerTotalMinor: offerRow.server_total_minor,
            storedTermsHash: offerRow.terms_hash,
            lines: lines.map((l) => ({
              sku: l.sku,
              qty: l.qty,
              unitPriceMinor: l.unit_price_minor,
              catalogUnitPriceMinor: l.cat_price,
              category: l.category,
            })),
          }
        : null,
    agreement: agreementRow
      ? {
          id: agreementRow.id,
          offerId: agreementRow.offer_id,
          termsHash: agreementRow.terms_hash,
          mandateId: agreementRow.mandate_id,
          mandateVersion: agreementRow.mandate_version,
          payeeRef: agreementRow.payee_ref,
          currency: agreementRow.currency,
          totalMinor: agreementRow.total_minor,
        }
      : null,
    others: others.map((o) => ({
      id: o.id,
      state: o.state,
      currency: o.currency,
      totalMinor: o.total ?? 0,
    })),
    approval: approval
      ? {
          agreementId: approval.agreement_id,
          decision: approval.decision,
          decidedBy: approval.decided_by,
        }
      : null,
    attempts: { liveForSubject: false, captureSucceeded: false },
    observed: null,
    claims: {},
    ...over,
  };
}

type OfferRow = {
  id: string;
  transaction_id: string;
  seller_id: string;
  currency: string;
  status: NonNullable<PolicyInput["offer"]>["status"];
  valid_until: string;
  shipping_minor: number;
  fees_minor: number;
  claimed_total_minor: number;
  server_total_minor: number;
  terms_hash: string;
};

describe("the engine against real database rows", () => {
  it("accepts an open offer for a fresh negotiation", () => {
    const db = worldDb();
    newTx(db);
    addOffer(db, "tx1", { id: "o1", validUntil: "2026-06-01T00:00:00.000Z" });
    const d = evaluatePolicy(load(db, "tx1", "ACCEPT_OFFER", { actor: "AGENT" }));
    expect(d.reasonCodes).toEqual([]);
    expect(d.mandateRef).toEqual({ id: "M1", version: 1 });
  });

  it("allows order creation for a genuinely agreed transaction (hash, total, payee and category all verified against stored rows)", () => {
    const db = worldDb();
    agreed(db);
    const d = evaluatePolicy(load(db, "tx1", "CREATE_ORDER"));
    expect(d.reasonCodes).toEqual([]);
    expect(d.verdict).toBe("ALLOW");
  });

  it("the stored mandate content hash is exactly what the engine recomputes", () => {
    const db = worldDb();
    agreed(db);
    const input = load(db, "tx1", "CREATE_ORDER");
    expect(evaluatePolicy(input).reasonCodes).not.toContain("MANDATE_INTEGRITY");
    expect(
      evaluatePolicy({
        ...input,
        mandate: {
          ...input.mandate,
          terms: { ...input.mandate.terms, maxTransactionMinor: 99_999 },
        },
      }).reasonCodes,
    ).toEqual(["MANDATE_INTEGRITY"]);
  });

  it("a newer mandate version makes the pinned transaction stale; a revocation blocks it", () => {
    const db = worldDb();
    agreed(db);
    const v2 = {
      ...POLICY,
      id: "M1",
      ownerId: "demo_operator",
      perTxCapMinor: 10_000,
      totalBudgetMinor: 15_000,
      currency: "USD",
      allowedSellerIds: ["seller_acme"],
      expiresAt: "2027-01-01T00:00:00.000Z",
      now: tick(),
    };
    insertMandateVersion(db, { ...v2, status: "ACTIVE" });
    expect(evaluatePolicy(load(db, "tx1", "CREATE_ORDER")).reasonCodes).toEqual(["MANDATE_STALE"]);
    insertMandateVersion(db, { ...v2, status: "REVOKED", now: tick() });
    expect(evaluatePolicy(load(db, "tx1", "CREATE_ORDER")).reasonCodes).toEqual([
      "MANDATE_REVOKED",
      "MANDATE_STALE",
    ]);
  });

  it("closes the gap the database leaves open: cumulative budget across transactions", () => {
    const db = worldDb(); // budget 150.00, each agreement 80.00
    agreed(db, "tx1");
    agreed(db, "tx2"); // the schema allows this: it does not sum across transactions
    expect(getTransaction(db, "tx2")?.state).toBe("AGREED");
    expect(evaluatePolicy(load(db, "tx2", "CREATE_ORDER")).reasonCodes).toEqual([
      "OVER_TOTAL_BUDGET",
    ]);
    expect(evaluatePolicy(load(db, "tx1", "CREATE_ORDER")).reasonCodes).toEqual([
      "OVER_TOTAL_BUDGET",
    ]);
  });

  it("an offer in the database priced above the catalog (or with an unknown sku) is refused at acceptance", () => {
    const db = worldDb();
    newTx(db);
    addOffer(db, "tx1", {
      id: "o1",
      validUntil: "2026-06-01T00:00:00.000Z",
      claimedTotalMinor: 9000,
      lines: [{ sku: "GPU-PACK", description: "marked up", qty: 1, unitPriceMinor: 9000 }],
    });
    expect(evaluatePolicy(load(db, "tx1", "ACCEPT_OFFER")).reasonCodes).toEqual([
      "PRICE_NOT_IN_CATALOG",
    ]);
    newTx(db, "tx2");
    addOffer(db, "tx2", {
      id: "o2",
      validUntil: "2026-06-01T00:00:00.000Z",
      claimedTotalMinor: 100,
      lines: [{ sku: "UNKNOWN", description: "?", qty: 1, unitPriceMinor: 100 }],
    });
    expect(evaluatePolicy(load(db, "tx2", "ACCEPT_OFFER")).reasonCodes).toEqual([
      "CATEGORY_UNKNOWN",
      "PRICE_NOT_IN_CATALOG",
    ]);
  });

  it("a negotiated price below the catalog price is accepted (the catalog price is a ceiling)", () => {
    const db = worldDb();
    newTx(db);
    addOffer(db, "tx1", {
      id: "o1",
      validUntil: "2026-06-01T00:00:00.000Z",
      claimedTotalMinor: 7000,
      lines: [{ sku: "GPU-PACK", description: "negotiated", qty: 1, unitPriceMinor: 7000 }],
    });
    expect(evaluatePolicy(load(db, "tx1", "ACCEPT_OFFER")).reasonCodes).toEqual([]);
  });

  it("a seller who states a wrong total is refused (the server total is what counts)", () => {
    const db = worldDb();
    newTx(db);
    addOffer(db, "tx1", {
      id: "o1",
      validUntil: "2026-06-01T00:00:00.000Z",
      claimedTotalMinor: 1_000,
    });
    expect(evaluatePolicy(load(db, "tx1", "ACCEPT_OFFER")).reasonCodes).toEqual(["TOTAL_MISMATCH"]);
  });
});

describe("decisions fit the policy_decisions table unchanged", () => {
  it("both an ALLOW and a DENY produced by the engine can be recorded and read back", () => {
    const db = worldDb();
    agreed(db);
    const input = load(db, "tx1", "CREATE_ORDER");
    const results = [
      ["d-allow", evaluatePolicy(input)],
      ["d-deny", evaluatePolicy({ ...input, actor: "AGENT" })],
    ] as const;
    for (const [id, d] of results) {
      recordPolicyDecision(db, {
        id,
        subject: "CREATE_ORDER",
        transactionId: "tx1",
        verdict: d.verdict,
        reasonCodes: [...d.reasonCodes],
        inputsHash: d.inputsHash,
        mandateId: must(d.mandateRef).id,
        mandateVersion: must(d.mandateRef).version,
        decidedAt: tick(),
      });
    }
    const rows = all<{ id: string; verdict: string; reason_codes: string }>(
      db,
      "SELECT id, verdict, reason_codes FROM policy_decisions WHERE id IN ('d-allow', 'd-deny') ORDER BY id",
    );
    expect(rows.map((r) => [r.id, r.verdict, JSON.parse(r.reason_codes) as unknown])).toEqual([
      ["d-allow", "ALLOW", []],
      ["d-deny", "DENY", ["ACTOR_NOT_PERMITTED"]],
    ]);
  });

  it("input the engine could not understand has no mandate reference, so it cannot be stored there (audit it instead)", () => {
    expect(evaluatePolicy({ subject: "CAPTURE" }).mandateRef).toBeNull();
  });
});

describe("one definition of the arithmetic and the hash", () => {
  it("the engine's total and terms hash equal what persistence stores", () => {
    const db = worldDb();
    newTx(db);
    const lines = [
      { sku: "GPU-PACK", description: "a", qty: 3, unitPriceMinor: 8_000 },
      { sku: "GPU-PACK-XL", description: "b", qty: 1, unitPriceMinor: 45_000 },
    ];
    const stored = addOffer(db, "tx1", {
      id: "o1",
      shippingMinor: 123,
      feesMinor: 45,
      lines,
      claimedTotalMinor: 1,
    });
    const priced = lines.map((l) => ({ sku: l.sku, qty: l.qty, unitPriceMinor: l.unitPriceMinor }));
    expect(sumOfferMinor(123, 45, priced)).toBe(stored.serverTotalMinor);
    expect(
      termsHashOf({
        sellerId: "seller_acme",
        currency: "USD",
        shippingMinor: 123,
        feesMinor: 45,
        lines: priced,
      }),
    ).toBe(stored.termsHash);
  });

  it("sumOfferMinor matches computeServerTotal on 5,000 random offers, including every overflow", () => {
    let state = 12345;
    const rnd = (n: number) => {
      state = (Math.imul(state, 1103515245) + 12345) >>> 0;
      return state % n;
    };
    const pick = [0, 1, 2, 99, 10_000, 2 ** 31, 2 ** 40, 2 ** 52, Number.MAX_SAFE_INTEGER];
    for (let n = 0; n < 5000; n++) {
      const lines = Array.from({ length: 1 + rnd(3) }, () => ({
        qty: 1 + rnd(4),
        unitPriceMinor: pick[rnd(pick.length)] as number,
      }));
      const ship = pick[rnd(pick.length)] as number;
      const fees = pick[rnd(pick.length)] as number;
      let expected: number | null;
      try {
        expected = computeServerTotal(
          lines.map((l) => ({ ...l, sku: "x", description: "" })),
          ship,
          fees,
        );
      } catch {
        expected = null;
      }
      expect(sumOfferMinor(ship, fees, lines)).toBe(expected);
    }
  });

  it("sumOfferMinor refuses what is not a non-negative safe integer (never a wrong number)", () => {
    const line = { qty: 1, unitPriceMinor: 1 };
    for (const bad of [-1, 0.5, NaN, Infinity, 2 ** 53]) {
      expect(sumOfferMinor(bad, 0, [line])).toBeNull();
      expect(sumOfferMinor(0, bad, [line])).toBeNull();
      expect(sumOfferMinor(0, 0, [{ qty: 1, unitPriceMinor: bad }])).toBeNull();
    }
    expect(sumOfferMinor(0, 0, [{ qty: 0, unitPriceMinor: 1 }])).toBeNull();
    expect(sumOfferMinor(0, 0, [{ qty: 1.5, unitPriceMinor: 1 }])).toBeNull();
    expect(sumOfferMinor(0, 0, [])).toBe(0);
  });
});
