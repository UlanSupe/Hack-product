import { describe, expect, it } from "vitest";

import { inTransaction, run, type SqlParam } from "@/adapters/sqlite/database";
import {
  acceptOffer,
  computeServerTotal,
  createSeller,
  getTransaction,
  insertMandateVersion,
  recordPolicyDecision,
  upsertCatalogItem,
} from "@/adapters/sqlite/store";

import {
  POLICY,
  HASH,
  T0,
  addOffer,
  agreed,
  allowDecision,
  cell,
  count,
  expectRejected,
  newTx,
  rawInsert,
  step,
  tick,
  worldDb,
} from "./helpers";

const offerRow = (over: Record<string, SqlParam> = {}): Record<string, SqlParam> => ({
  id: "o-raw",
  transaction_id: "tx1",
  seller_id: "seller_acme",
  revision: 1,
  supersedes_offer_id: null,
  currency: "USD",
  shipping_minor: 0,
  fees_minor: 0,
  claimed_total_minor: 8_000,
  server_total_minor: 8_000,
  terms_text: "terms",
  terms_hash: HASH,
  valid_until: "2026-06-01T00:00:00.000Z",
  status: "OPEN",
  created_at: T0,
  ...over,
});

describe("offers", () => {
  it("numbers revisions, supersedes the previous one, and keeps every revision", () => {
    const db = worldDb();
    newTx(db);
    const a = addOffer(db, "tx1", { id: "o1" });
    const b = addOffer(db, "tx1", { id: "o2", claimedTotalMinor: 9_000 });
    expect([a.revision, b.revision]).toEqual([1, 2]);
    expect(cell(db, "SELECT status FROM offers WHERE id = 'o1'")).toBe("SUPERSEDED");
    expect(cell(db, "SELECT supersedes_offer_id FROM offers WHERE id = 'o2'")).toBe("o1");
    expect(count(db, "offers")).toBe(2);
  });

  it("computes the server total itself and stores the seller's claim only for audit", () => {
    const db = worldDb();
    newTx(db);
    const o = addOffer(db, "tx1", {
      id: "o1",
      shippingMinor: 500,
      feesMinor: 250,
      claimedTotalMinor: 100, // a lie
      lines: [
        { sku: "A", description: "a", qty: 2, unitPriceMinor: 1_000 },
        { sku: "B", description: "b", qty: 1, unitPriceMinor: 300 },
      ],
    });
    expect(o.serverTotalMinor).toBe(2 * 1_000 + 300 + 500 + 250);
    expect(cell(db, "SELECT claimed_total_minor FROM offers WHERE id = 'o1'")).toBe(100);
    expect(cell(db, "SELECT server_total_minor FROM offers WHERE id = 'o1'")).toBe(3_050);
  });

  it("hashes terms deterministically and changes the hash when any term changes", () => {
    const db = worldDb();
    newTx(db, "a");
    newTx(db, "b");
    const same1 = addOffer(db, "a");
    const same2 = addOffer(db, "b");
    expect(same1.termsHash).toBe(same2.termsHash);
    const cheaper = addOffer(db, "b", {
      lines: [{ sku: "GPU-PACK", description: "x", qty: 1, unitPriceMinor: 7_999 }],
    });
    const dearer = addOffer(db, "b", { feesMinor: 1 });
    expect(new Set([same1.termsHash, cheaper.termsHash, dearer.termsHash]).size).toBe(3);
  });

  it("validates totals and quantities before touching SQL (overflow, fractions, empties)", () => {
    const db = worldDb();
    newTx(db);
    const big = Number.MAX_SAFE_INTEGER;
    expectRejected(
      () => computeServerTotal([{ sku: "A", description: "", qty: 2, unitPriceMinor: big }], 0, 0),
      /overflows/,
    );
    expectRejected(
      () => computeServerTotal([{ sku: "A", description: "", qty: 1, unitPriceMinor: big }], 1, 0),
      /overflows/,
    );
    expectRejected(
      () => computeServerTotal([{ sku: "A", description: "", qty: 0, unitPriceMinor: 1 }], 0, 0),
      /qty/,
    );
    expectRejected(
      () => computeServerTotal([{ sku: "A", description: "", qty: 1.5, unitPriceMinor: 1 }], 0, 0),
      /qty/,
    );
    expectRejected(
      () => computeServerTotal([{ sku: "A", description: "", qty: 1, unitPriceMinor: -1 }], 0, 0),
      /non-negative/,
    );
    expectRejected(() => addOffer(db, "tx1", { lines: [] }), /at least one line/);
    expectRejected(
      () => addOffer(db, "tx1", { claimedTotalMinor: 80.5 }),
      /non-negative safe integer/,
    );
    expectRejected(() => addOffer(db, "tx1", { currency: "usd" }), /3-letter uppercase/);
    expect(count(db, "offers")).toBe(0);
  });

  it("rejects raw rows that skip revisions, reuse ids, or break field rules", () => {
    const db = worldDb();
    newTx(db);
    addOffer(db, "tx1", { id: "o1" });
    expectRejected(
      () => rawInsert(db, "offers", offerRow({ id: "o3", revision: 3, supersedes_offer_id: "o1" })),
      /previous revision \+ 1/,
    );
    expectRejected(
      () => rawInsert(db, "offers", offerRow({ id: "o1", revision: 2, supersedes_offer_id: "o1" })),
      /UNIQUE|CHECK/,
    );
    expectRejected(
      () => rawInsert(db, "offers", offerRow({ id: "o2", revision: 2, supersedes_offer_id: null })),
      /CHECK constraint failed/,
    );
    expectRejected(
      () =>
        rawInsert(
          db,
          "offers",
          offerRow({ id: "o2", revision: 2, supersedes_offer_id: "o-ghost" }),
        ),
      /supersedes_offer_id|FOREIGN KEY/,
    );
    expectRejected(
      () =>
        rawInsert(
          db,
          "offers",
          offerRow({ id: "o2", revision: 2, supersedes_offer_id: "o1", seller_id: "seller_ghost" }),
        ),
      /FOREIGN KEY/,
    );
    expectRejected(
      () =>
        rawInsert(
          db,
          "offers",
          offerRow({
            id: "o2",
            revision: 2,
            supersedes_offer_id: "o1",
            transaction_id: "tx-ghost",
          }),
        ),
      /NEGOTIATING/,
    );
    expectRejected(
      () =>
        rawInsert(
          db,
          "offers",
          offerRow({ id: "o2", revision: 2, supersedes_offer_id: "o1", status: "ACCEPTED" }),
        ),
      /must be OPEN/,
    );
    expectRejected(
      () =>
        rawInsert(
          db,
          "offers",
          offerRow({ id: "o2", revision: 2, supersedes_offer_id: "o1", terms_hash: "xyz" }),
        ),
      /CHECK constraint failed/,
    );
    expectRejected(
      () =>
        rawInsert(
          db,
          "offers",
          offerRow({ id: "o2", revision: 2, supersedes_offer_id: "o1", currency: "usd" }),
        ),
      /CHECK constraint failed/,
    );
    expectRejected(
      () =>
        rawInsert(
          db,
          "offers",
          offerRow({
            id: "o2",
            revision: 2,
            supersedes_offer_id: "o1",
            terms_text: "x".repeat(4_001),
          }),
        ),
      /CHECK constraint failed/,
    );
    expectRejected(
      () =>
        rawInsert(
          db,
          "offers",
          offerRow({ id: "o2", revision: 2, supersedes_offer_id: "o1", server_total_minor: 1.25 }),
        ),
      /cannot store REAL/,
    );
    expect(count(db, "offers")).toBe(1);
  });

  it("refuses new offers once the transaction left NEGOTIATING (a revision after agreement cannot be stored)", () => {
    const db = worldDb();
    agreed(db);
    expectRejected(
      () => addOffer(db, "tx1", { claimedTotalMinor: 11_000, feesMinor: 3_000 }),
      /only be added while the transaction is NEGOTIATING/,
    );
  });

  it("freezes terms: only status may change, once, and never back to OPEN", () => {
    const db = worldDb();
    newTx(db);
    addOffer(db, "tx1", { id: "o1" });
    for (const col of [
      "server_total_minor = 1",
      "claimed_total_minor = 1",
      "terms_text = 'new'",
      "terms_hash = '" + "b".repeat(64) + "'",
      "fees_minor = 1",
      "seller_id = 'seller_other'",
      "currency = 'EUR'",
      "revision = 7",
    ]) {
      expectRejected(() => run(db, `UPDATE offers SET ${col} WHERE id = 'o1'`), /immutable/);
    }
    expectRejected(
      () => run(db, "UPDATE offers SET status = 'ACCEPTED' WHERE id = 'o1'"),
      /agreement exists/,
    );
    run(db, "UPDATE offers SET status = 'EXPIRED' WHERE id = 'o1'");
    expectRejected(
      () => run(db, "UPDATE offers SET status = 'OPEN' WHERE id = 'o1'"),
      /only move from OPEN/,
    );
    expectRejected(
      () => run(db, "UPDATE offers SET status = 'REJECTED' WHERE id = 'o1'"),
      /only move from OPEN/,
    );
    expectRejected(() => run(db, "DELETE FROM offers WHERE id = 'o1'"), /cannot be deleted/);
  });
});

describe("offer lines", () => {
  it("are immutable and only added to OPEN offers", () => {
    const db = worldDb();
    newTx(db);
    addOffer(db, "tx1", { id: "o1" });
    expectRejected(
      () => run(db, "UPDATE offer_lines SET unit_price_minor = 1 WHERE offer_id = 'o1'"),
      /immutable/,
    );
    expectRejected(() => run(db, "DELETE FROM offer_lines WHERE offer_id = 'o1'"), /immutable/);
    expectRejected(
      () =>
        rawInsert(db, "offer_lines", {
          offer_id: "o1",
          line_no: 1,
          sku: "X",
          description: "",
          qty: 1,
          unit_price_minor: 1,
          currency: "USD",
        }),
      /UNIQUE|PRIMARY/,
    );
    run(db, "UPDATE offers SET status = 'EXPIRED' WHERE id = 'o1'");
    expectRejected(
      () =>
        rawInsert(db, "offer_lines", {
          offer_id: "o1",
          line_no: 2,
          sku: "X",
          description: "",
          qty: 1,
          unit_price_minor: 1,
          currency: "USD",
        }),
      /OPEN offer/,
    );
  });

  it("reject bad quantities/prices and missing offers", () => {
    const db = worldDb();
    newTx(db);
    addOffer(db, "tx1", { id: "o1" });
    const line = (over: Record<string, SqlParam>) =>
      rawInsert(db, "offer_lines", {
        offer_id: "o1",
        line_no: 2,
        sku: "X",
        description: "",
        qty: 1,
        unit_price_minor: 1,
        currency: "USD",
        ...over,
      });
    expectRejected(() => line({ qty: 0 }), /CHECK constraint failed/);
    expectRejected(() => line({ qty: 1_000_001 }), /CHECK constraint failed/);
    expectRejected(() => line({ unit_price_minor: -1 }), /CHECK constraint failed/);
    expectRejected(() => line({ unit_price_minor: 0.5 }), /cannot store REAL/);
    expectRejected(() => line({ line_no: 0 }), /CHECK constraint failed/);
    expectRejected(() => line({ offer_id: "o-ghost" }), /OPEN offer/);
    expectRejected(() => line({ currency: "EUR" }), /line currency must equal the offer currency/);
    expectRejected(
      () => line({ currency: "eur" }),
      /CHECK constraint failed|line currency must equal/,
    );
    expect(() => line({})).not.toThrow(); // control: the same row with correct values is accepted
  });
});

describe("policy decisions", () => {
  const dec = (db: ReturnType<typeof worldDb>, over: Record<string, unknown> = {}) =>
    recordPolicyDecision(db, {
      id: "d1",
      subject: "ACCEPT_OFFER",
      transactionId: "tx1",
      verdict: "DENY",
      reasonCodes: ["OVER_PER_TX_CAP"],
      inputsHash: HASH,
      mandateId: "M1",
      mandateVersion: 1,
      decidedAt: tick(),
      ...over,
    });

  it("records DENY with reasons and ALLOW without, and nothing else", () => {
    const db = worldDb();
    newTx(db);
    dec(db);
    allowDecision(db, "tx1", "d2");
    expect(cell(db, "SELECT reason_codes FROM policy_decisions WHERE id = 'd1'")).toBe(
      '["OVER_PER_TX_CAP"]',
    );
    expectRejected(
      () => dec(db, { id: "d3", verdict: "DENY", reasonCodes: [] }),
      /CHECK constraint failed/,
    );
    expectRejected(
      () => dec(db, { id: "d4", verdict: "ALLOW", reasonCodes: ["X"] }),
      /CHECK constraint failed/,
    );
    expectRejected(() => dec(db, { id: "d5", subject: "TELEPORT" }), /CHECK constraint failed/);
    expectRejected(() => dec(db, { id: "d6", inputsHash: "nope" }), /CHECK constraint failed/);
  });

  it("rejects duplicate ids and missing references", () => {
    const db = worldDb();
    newTx(db);
    dec(db);
    expectRejected(() => dec(db), /UNIQUE constraint failed: policy_decisions\.id/);
    expectRejected(() => dec(db, { id: "d7", transactionId: "tx-ghost" }), /FOREIGN KEY/);
    expectRejected(() => dec(db, { id: "d8", mandateVersion: 99 }), /FOREIGN KEY/);
  });

  it("requires an ALLOW to cite the mandate version the transaction pinned", () => {
    const db = worldDb();
    newTx(db);
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
      () => dec(db, { id: "d9", verdict: "ALLOW", reasonCodes: [], mandateVersion: 2 }),
      /pinned by its transaction/,
    );
  });

  it("is immutable", () => {
    const db = worldDb();
    newTx(db);
    dec(db);
    expectRejected(
      () =>
        run(
          db,
          "UPDATE policy_decisions SET verdict = 'ALLOW', reason_codes = '[]' WHERE id = 'd1'",
        ),
      /immutable/,
    );
    expectRejected(() => run(db, "DELETE FROM policy_decisions WHERE id = 'd1'"), /immutable/);
  });
});

describe("agreements", () => {
  it("are derived from stored rows: total, payee, terms hash and the pinned mandate version", () => {
    const db = worldDb();
    const a = agreed(db);
    const row = db.prepare("SELECT * FROM agreements WHERE id = ?").get(a.agreementId) as Record<
      string,
      unknown
    >;
    expect(row).toMatchObject({
      offer_id: a.offerId,
      total_minor: 8_000,
      currency: "USD",
      payee_ref: "payee_acme",
      mandate_id: "M1",
      mandate_version: 1,
      policy_decision_id: a.decisionId,
    });
    expect(row.terms_hash).toBe(
      cell(db, "SELECT terms_hash FROM offers WHERE id = ?", [a.offerId]),
    );
    expect(cell(db, "SELECT status FROM offers WHERE id = ?", [a.offerId])).toBe("ACCEPTED");
    expect(getTransaction(db, "tx1")).toMatchObject({
      state: "AGREED",
      version: 2,
      agreementId: a.agreementId,
    });
  });

  it("cannot be created for an offer that is not OPEN, so one offer yields one agreement", () => {
    const db = worldDb();
    const a = agreed(db);
    expectRejected(
      () =>
        acceptOffer(db, {
          agreementId: "agr-2",
          offerId: a.offerId,
          policyDecisionId: a.decisionId,
          expectedVersion: 2,
          now: tick(),
          actor: "SYSTEM",
        }),
      /must be OPEN/,
    );
    expect(count(db, "agreements")).toBe(1);
  });

  it("refuses totals above the mandate cap even if a decision says ALLOW", () => {
    const db = worldDb();
    newTx(db);
    const o = addOffer(db, "tx1", {
      claimedTotalMinor: 45_000,
      lines: [{ sku: "GPU-PACK-XL", description: "xl", qty: 1, unitPriceMinor: 45_000 }],
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
      /exceeds the mandate per-transaction cap/,
    );
    expect(getTransaction(db, "tx1")?.state).toBe("NEGOTIATING");
    expect(count(db, "agreements")).toBe(0);
  });

  it("refuses a seller that is not on the mandate allow-list", () => {
    const db = worldDb();
    newTx(db);
    upsertCatalogItem(db, {
      sellerId: "seller_other",
      sku: "GPU-PACK",
      unitPriceMinor: 8_000,
      currency: "USD",
      category: "COMPUTE",
    });
    const o = addOffer(db, "tx1", { sellerId: "seller_other" });
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
      /allow the seller/,
    );
  });

  it("refuses an offer in another currency than the mandate", () => {
    const db = worldDb();
    newTx(db);
    const o = addOffer(db, "tx1", { currency: "EUR" });
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
      /same currency/,
    );
  });

  it("requires an ALLOW/ACCEPT_OFFER decision for the same transaction", () => {
    const db = worldDb();
    newTx(db, "tx1");
    newTx(db, "tx2");
    const o = addOffer(db, "tx1", { id: "o1" });
    recordPolicyDecision(db, {
      id: "deny",
      subject: "ACCEPT_OFFER",
      transactionId: "tx1",
      verdict: "DENY",
      reasonCodes: ["TOTAL_MISMATCH"],
      inputsHash: HASH,
      mandateId: "M1",
      mandateVersion: 1,
      decidedAt: tick(),
    });
    const foreign = allowDecision(db, "tx2");
    recordPolicyDecision(db, {
      id: "wrong-subject",
      subject: "CAPTURE",
      transactionId: "tx1",
      verdict: "ALLOW",
      reasonCodes: [],
      inputsHash: HASH,
      mandateId: "M1",
      mandateVersion: 1,
      decidedAt: tick(),
    });
    const attempt = (decision: string) => () =>
      acceptOffer(db, {
        agreementId: "agr",
        offerId: o.id,
        policyDecisionId: decision,
        expectedVersion: 1,
        now: tick(),
        actor: "SYSTEM",
      });
    expectRejected(attempt("deny"), /must be an ALLOW for ACCEPT_OFFER/);
    expectRejected(attempt(foreign), /must be an ALLOW for ACCEPT_OFFER/);
    expectRejected(attempt("wrong-subject"), /must be an ALLOW for ACCEPT_OFFER/);
    expectRejected(attempt("missing-decision"), /must be an ALLOW for ACCEPT_OFFER|FOREIGN KEY/);
    expect(count(db, "agreements")).toBe(0);
  });

  it("rejects unknown offers", () => {
    const db = worldDb();
    newTx(db);
    expectRejected(
      () =>
        acceptOffer(db, {
          agreementId: "agr",
          offerId: "ghost",
          policyDecisionId: "d",
          expectedVersion: 1,
          now: tick(),
          actor: "SYSTEM",
        }),
      /offer ghost not found/,
    );
  });

  it("blocks stale and revoked mandates: the transaction keeps its pin but cannot proceed on it", () => {
    const stale = worldDb();
    newTx(stale);
    const o1 = addOffer(stale, "tx1");
    const d1 = allowDecision(stale, "tx1");
    insertMandateVersion(stale, {
      ...POLICY,
      id: "M1",
      ownerId: "demo_operator",
      perTxCapMinor: 50_000,
      totalBudgetMinor: 60_000,
      currency: "USD",
      allowedSellerIds: ["seller_acme"],
      expiresAt: "2027-01-01T00:00:00.000Z",
      status: "ACTIVE",
      now: T0,
    });
    expectRejected(
      () =>
        acceptOffer(stale, {
          agreementId: "agr",
          offerId: o1.id,
          policyDecisionId: d1,
          expectedVersion: 1,
          now: tick(),
          actor: "SYSTEM",
        }),
      /latest ACTIVE version/,
    );
    expect(getTransaction(stale, "tx1")?.mandateVersion).toBe(1);

    const revoked = worldDb();
    newTx(revoked);
    const o2 = addOffer(revoked, "tx1");
    const d2 = allowDecision(revoked, "tx1");
    insertMandateVersion(revoked, {
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
      () =>
        acceptOffer(revoked, {
          agreementId: "agr",
          offerId: o2.id,
          policyDecisionId: d2,
          expectedVersion: 1,
          now: tick(),
          actor: "SYSTEM",
        }),
      /latest ACTIVE version/,
    );
  });

  it("refuses an expired mandate", () => {
    const db = worldDb();
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
          now: "2027-02-01T00:00:00.000Z",
          actor: "SYSTEM",
        }),
      /unexpired/,
    );
  });

  it("re-checks offer arithmetic: a hand-written offer whose total disagrees with its lines cannot be agreed", () => {
    const db = worldDb();
    newTx(db);
    rawInsert(
      db,
      "offers",
      offerRow({ id: "o-bad", server_total_minor: 5_000, claimed_total_minor: 5_000 }),
    );
    rawInsert(db, "offer_lines", {
      offer_id: "o-bad",
      line_no: 1,
      sku: "GPU-PACK",
      description: "",
      qty: 1,
      unit_price_minor: 8_000,
      currency: "USD",
      category: "COMPUTE",
    });
    const d = allowDecision(db, "tx1");
    expectRejected(
      () =>
        acceptOffer(db, {
          agreementId: "agr",
          offerId: "o-bad",
          policyDecisionId: d,
          expectedVersion: 1,
          now: tick(),
          actor: "SYSTEM",
        }),
      /must equal lines \+ shipping \+ fees/,
    );
  });

  it("refuses an offer with no lines", () => {
    const db = worldDb();
    newTx(db);
    rawInsert(db, "offers", offerRow({ id: "o-empty" }));
    const d = allowDecision(db, "tx1");
    expectRejected(
      () =>
        acceptOffer(db, {
          agreementId: "agr",
          offerId: "o-empty",
          policyDecisionId: d,
          expectedVersion: 1,
          now: tick(),
          actor: "SYSTEM",
        }),
      /must equal lines|have lines/,
    );
  });

  it("rejects hand-written agreements that disagree with the offer, catalog or hash", () => {
    const db = worldDb();
    newTx(db);
    const o = addOffer(db, "tx1");
    const d = allowDecision(db, "tx1");
    const base = (over: Record<string, SqlParam>): Record<string, SqlParam> => ({
      id: "agr-raw",
      offer_id: o.id,
      terms_hash: o.termsHash,
      mandate_id: "M1",
      mandate_version: 1,
      payee_ref: "payee_acme",
      total_minor: 8_000,
      currency: "USD",
      policy_decision_id: d,
      created_at: tick(),
      ...over,
    });
    expectRejected(
      () => rawInsert(db, "agreements", base({ terms_hash: "d".repeat(64) })),
      /terms_hash/,
    );
    expectRejected(
      () => rawInsert(db, "agreements", base({ total_minor: 100 })),
      /total and currency/,
    );
    expectRejected(
      () => rawInsert(db, "agreements", base({ currency: "EUR" })),
      /total and currency/,
    );
    expectRejected(
      () => rawInsert(db, "agreements", base({ payee_ref: "payee_evil" })),
      /payee_ref/,
    );
    expectRejected(() => rawInsert(db, "agreements", base({ offer_id: "ghost" })), /must be OPEN/);
    expectRejected(
      () => rawInsert(db, "agreements", base({ mandate_version: 9 })),
      /latest ACTIVE version|FOREIGN KEY|category the mandate allows/,
    );
    expectRejected(
      () => rawInsert(db, "agreements", base({ policy_decision_id: "ghost" })),
      /must be an ALLOW|FOREIGN KEY/,
    );
    expect(count(db, "agreements")).toBe(0);
    rawInsert(db, "agreements", base({})); // control: the same row with correct values is accepted
    expect(count(db, "agreements")).toBe(1);
  });

  it("are immutable once created", () => {
    const db = worldDb();
    const a = agreed(db);
    expectRejected(
      () => run(db, "UPDATE agreements SET total_minor = 1 WHERE id = ?", [a.agreementId]),
      /immutable/,
    );
    expectRejected(
      () => run(db, "DELETE FROM agreements WHERE id = ?", [a.agreementId]),
      /immutable/,
    );
  });

  it("cannot be attached to a transaction that the offer does not belong to", () => {
    const db = worldDb();
    const a = agreed(db, "tx1");
    newTx(db, "tx2");
    expectRejected(
      () => inTransaction(db, () => step(db, "tx2", "AGREED", { agreementId: a.agreementId })),
      /must belong to this transaction|UNIQUE/,
    );
    expect(getTransaction(db, "tx2")?.state).toBe("NEGOTIATING");
  });

  it("deleting a seller or offer that an agreement depends on is impossible", () => {
    const db = worldDb();
    createSeller(db, { id: "seller_tmp", displayName: "tmp", payeeRef: "payee_tmp", now: T0 });
    agreed(db);
    expectRejected(() => run(db, "DELETE FROM offers WHERE id = 'offer-tx1'"), /cannot be deleted/);
    expectRejected(() => run(db, "DELETE FROM sellers WHERE id = 'seller_acme'"), /FOREIGN KEY/);
  });
});
