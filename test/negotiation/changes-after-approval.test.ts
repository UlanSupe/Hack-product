import { describe, expect, it } from "vitest";

import { getTransaction, transitionTransaction } from "@/adapters/sqlite/store";
import { ConflictError } from "@/domain/errors";

import { AGENT, OP, makeWorld } from "./world";

/** An approved v1 at 80.00 (above the 50.00 threshold, so it needed the operator's approval). */
function approvedDeal(opts: Parameters<typeof makeWorld>[0] = {}) {
  const w = makeWorld(opts);
  const deal = w.agreed();
  const approved = w.ok(w.svc.approve(OP, { negotiationId: deal.neg.id }));
  expect(approved.state).toBe("ELIGIBLE");
  return { w, ...deal };
}

describe("a price change after approval", () => {
  it("a cheaper version retires v1 and its approval; v2 needs its own approval", () => {
    const { w, neg } = approvedDeal();
    const v2 = w.offer(neg.id, "seller_acme", w.priced(7000));
    expect(v2.changes.map((c) => c.kind)).toEqual(["PRICE"]);

    const out = w.accept(neg.id, v2.id);
    expect(out.accepted).toBe(true);
    expect(out.retired).toMatchObject({
      version: 1,
      status: "INVALIDATED",
      transactionState: "CANCELLED",
    });
    expect(out.retired?.retired).toMatchObject({ approvalWasValid: true, byProposalId: v2.id });
    expect(out.retired?.retired?.reason).toMatch(/total price changed from 80.00 USD to 70.00 USD/);
    expect(out.retired?.retired?.reason).toMatch(/earlier approval no longer applies/);
    expect(out.retired?.approval).toMatchObject({ state: "INVALIDATED" });
    expect(out.retired?.approval.text).toMatch(/no longer counts/);

    // v2 does not inherit v1's approval
    expect(out.negotiation.active).toMatchObject({ version: 2, totalText: "70.00 USD" });
    expect(out.negotiation.active?.approval.state).toBe("REQUIRED");
    const e = w.ok(w.svc.checkEligibility(OP, { negotiationId: neg.id }));
    expect(e.state).toBe("AWAITING_APPROVAL");
    expect(e.policy?.reasonCodes).toEqual(["APPROVAL_REQUIRED"]);
    expect(w.count("transaction_approvals")).toBe(1); // v1's, still on the cancelled transaction

    expect(w.ok(w.svc.approve(OP, { negotiationId: neg.id })).state).toBe("ELIGIBLE");
    expect(w.count("transaction_approvals")).toBe(2);
    expect(
      w.cell(
        "SELECT state FROM transactions WHERE id = (SELECT transaction_id FROM negotiation_agreements WHERE version = 1)",
      ),
    ).toBe("CANCELLED");
  });

  it("a MORE expensive version (after the seller raised its catalog price) also retires the approval", () => {
    const { w, neg } = approvedDeal();
    w.db
      .prepare(
        "UPDATE seller_catalog_items SET unit_price_minor = 9000 WHERE seller_id = 'seller_acme' AND sku = 'GPU-PACK'",
      )
      .run();
    const v2 = w.offer(neg.id, "seller_acme", w.priced(9000));
    const out = w.accept(neg.id, v2.id);
    expect(out.accepted).toBe(true);
    expect(out.retired?.retired?.reason).toMatch(/from 80.00 USD to 90.00 USD/);
    expect(out.retired?.retired?.approvalWasValid).toBe(true);
    expect(out.negotiation.active?.approval.state).toBe("REQUIRED");
  });

  it("a mark-up above the catalog is refused, and v1 with its approval is untouched", () => {
    const { w, neg } = approvedDeal();
    const v2 = w.offer(neg.id, "seller_acme", w.priced(9000));
    const out = w.accept(neg.id, v2.id);
    expect(out.accepted).toBe(false);
    expect(out.policy.reasonCodes).toEqual(["PRICE_NOT_IN_CATALOG"]);
    const d = w.detail(neg.id);
    expect(d.active).toMatchObject({ version: 1, totalText: "80.00 USD" });
    expect(d.active?.approval.state).toBe("APPROVED");
    expect(d.active?.eligibility?.state).toBe("ELIGIBLE");
  });

  it("a proposed change that is not accepted changes nothing: payment still uses the agreed terms, and the UI says so", () => {
    const { w, neg } = approvedDeal();
    w.offer(neg.id, "seller_acme", w.priced(7000));
    const d = w.detail(neg.id);
    expect(d.active).toMatchObject({ version: 1, totalText: "80.00 USD" });
    expect(d.active?.approval.state).toBe("APPROVED");
    expect(d.active?.eligibility?.state).toBe("ELIGIBLE");
    expect(d.pendingRevisions).toHaveLength(1);
    expect(d.pendingRevisions[0]?.changes).toEqual([
      "The total price changed from 80.00 USD to 70.00 USD.",
    ]);
    expect(w.cell("SELECT total_minor FROM agreements")).toBe(8000);
    expect(w.cell("SELECT state FROM transactions")).toBe("AGREED");
  });

  it("replacing a version does not count the retiring deal against the budget twice", () => {
    const { w, neg } = approvedDeal({ budget: 12_000, threshold: 10_000 }); // 80.00 reserved of 120.00
    const v2 = w.offer(neg.id, "seller_acme", w.priced(7500)); // 80 + 75 would exceed 120; replacing must not
    expect(w.accept(neg.id, v2.id).accepted).toBe(true);
  });
});

describe("a category change after approval", () => {
  it("is classified as category, scope and price; accepting it retires the approval", () => {
    const { w, neg } = approvedDeal({ categories: ["COMPUTE", "STORAGE"] });
    const v2 = w.offer(neg.id, "seller_acme", {
      category: "STORAGE",
      ...w.priced(2000, 1, "STORE-100"),
    });
    expect(v2.changes.map((c) => c.kind)).toEqual(["PRICE", "SCOPE", "CATEGORY"]);
    const out = w.accept(neg.id, v2.id);
    expect(out.accepted).toBe(true);
    expect(out.retired?.retired?.reason).toMatch(
      /service category changed from COMPUTE to STORAGE/,
    );
    expect(out.negotiation.active).toMatchObject({ version: 2, totalText: "20.00 USD" });
    expect(out.negotiation.active?.approval.state).toBe("NOT_REQUIRED"); // 20.00 is under the threshold, but the old approval was NOT reused
  });

  it("is refused when the mandate does not allow the new category; v1 stays intact", () => {
    const { w, neg } = approvedDeal({ categories: ["COMPUTE"] });
    const v2 = w.offer(neg.id, "seller_acme", {
      category: "STORAGE",
      ...w.priced(2000, 1, "STORE-100"),
    });
    const out = w.accept(neg.id, v2.id);
    expect(out.accepted).toBe(false);
    expect(out.policy.reasonCodes).toEqual(["CATEGORY_NOT_ALLOWED"]);
    expect(w.detail(neg.id).active).toMatchObject({ version: 1, status: "ACTIVE" });
  });

  it("a seller cannot relabel an item: the catalog's category decides, not the claim", () => {
    const w = makeWorld({ categories: ["COMPUTE"] });
    const neg = w.open();
    // claims COMPUTE for a STORAGE item
    const o = w.offer(neg.id, "seller_acme", {
      category: "COMPUTE",
      ...w.priced(2000, 1, "STORE-100"),
    });
    const out = w.accept(neg.id, o.id);
    expect(out.accepted).toBe(false);
    expect(out.policy.reasonCodes).toEqual(["CATEGORY_NOT_ALLOWED"]);
  });
});

describe("other changes after approval", () => {
  it.each([
    [
      "deliverables (the acceptance criteria)",
      { deliverables: ["80 GPU-hours"] },
      "deliverables, which are the acceptance criteria, changed",
    ],
    ["the delivery deadline", { deliveryDays: 1 }, "delivery time changed from 3 to 1 day"],
    ["the written terms (scope)", { termsText: "No refunds." }, "What is being bought changed"],
  ])("a change of %s retires the approval", (_n, change, text) => {
    const { w, neg } = approvedDeal();
    const v2 = w.offer(neg.id, "seller_acme", change);
    const out = w.accept(neg.id, v2.id);
    expect(out.accepted).toBe(true);
    expect(out.retired?.retired?.reason).toContain(text);
    expect(out.retired?.retired?.approvalWasValid).toBe(true);
    expect(out.negotiation.active?.approval.state).toBe("REQUIRED");
  });

  it("a quantity change is a scope and price change", () => {
    const { w, neg } = approvedDeal({ budget: 20_000, cap: 20_000, threshold: 5000 });
    const v2 = w.offer(neg.id, "seller_acme", w.priced(8000, 2));
    expect(v2.changes.map((c) => c.kind)).toEqual(["PRICE", "SCOPE"]);
    expect(w.accept(neg.id, v2.id).retired?.retired?.reason).toMatch(
      /total price changed from 80.00 USD to 160.00 USD/,
    );
  });

  it("a currency change is refused (the mandate is in USD) and v1 is untouched", () => {
    const { w, neg } = approvedDeal();
    const v2 = w.offer(neg.id, "seller_acme", { currency: "EUR" });
    expect(v2.changes.map((c) => c.kind)).toEqual(["CURRENCY"]);
    const out = w.accept(neg.id, v2.id);
    expect(out.policy.reasonCodes).toEqual(["CURRENCY_MISMATCH"]);
    expect(w.detail(neg.id).active?.approval.state).toBe("APPROVED");
  });

  it("re-issuing identical terms (only the validity differs) keeps the agreement and its approval", () => {
    const { w, neg } = approvedDeal();
    const v2 = w.offer(neg.id, "seller_acme", { validForMinutes: 600 });
    expect(v2.changes).toEqual([]);
    expect(w.detail(neg.id).pendingRevisions).toEqual([]);
    expect(w.detail(neg.id).sellers[0]?.offers.find((p) => p.id === v2.id)?.actions).toMatchObject({
      canAccept: false,
      note: "Identical to the agreed terms: the existing agreement and its approval stay valid.",
    });
    expect(() => w.accept(neg.id, v2.id)).toThrow(/identical to the agreed version/);
    expect(w.detail(neg.id).active?.approval.state).toBe("APPROVED");
    expect(w.count("negotiation_agreements")).toBe(1);
  });

  it("each retirement is final: a retired version cannot be approved, and an approval is only given once", () => {
    const { w, neg } = approvedDeal();
    expect(() => w.svc.approve(OP, { negotiationId: neg.id })).toThrow(/already been recorded/);
    const v2 = w.offer(neg.id, "seller_acme", w.priced(7000));
    w.accept(neg.id, v2.id);
    expect(() =>
      w.db
        .prepare(
          "UPDATE negotiation_agreements SET status = 'ACTIVE', invalidated_at = NULL WHERE version = 1",
        )
        .run(),
    ).toThrow();
    w.ok(w.svc.approve(OP, { negotiationId: neg.id })); // approves v2, the active one
    expect(w.detail(neg.id).agreements.map((a) => [a.version, a.status, a.approval.state])).toEqual(
      [
        [1, "INVALIDATED", "INVALIDATED"],
        [2, "ACTIVE", "APPROVED"],
      ],
    );
  });
});

describe("once payment has started, the deal can no longer change", () => {
  function started() {
    const { w, neg } = approvedDeal();
    const pending = w.offer(neg.id, "seller_acme", w.priced(7000));
    const link = w.cell<string>(
      "SELECT transaction_id FROM negotiation_agreements WHERE status = 'ACTIVE'",
    );
    const tx = getTransaction(w.db, link);
    transitionTransaction(w.db, {
      id: link,
      expectedVersion: tx?.version ?? 0,
      to: "CREATING_ORDER",
      now: w.clock.iso(),
      actor: "SYSTEM",
    });
    return { w, neg, pending };
  }

  it("new offers, counters and acceptances are refused with an explanation", () => {
    const { w, neg, pending } = started();
    expect(() => w.offer(neg.id, "seller_acme", w.priced(6000))).toThrow(
      /Payment steps have already started/,
    );
    expect(() => w.counter(neg.id)).toThrow(/Payment steps have already started/);
    expect(() => w.accept(neg.id, pending.id)).toThrow(ConflictError);
    expect(() => w.accept(neg.id, pending.id, AGENT)).toThrow(/CREATING_ORDER/);
    expect(w.count("negotiation_agreements", "status = 'ACTIVE'")).toBe(1);
  });

  it("the operator cannot reject or close the agreement under a payment in progress", () => {
    const { w, neg } = started();
    expect(() => w.svc.disapprove(OP, { negotiationId: neg.id })).toThrow(
      /already been recorded|already started/,
    );
    expect(() => w.svc.close(OP, { negotiationId: neg.id }, "CANCELLED")).toThrow(
      /already started/,
    );
    expect(w.detail(neg.id).status).toBe("AGREED");
  });

  it("the engine itself says IN_PROGRESS rather than eligible", () => {
    const { w, neg } = started();
    const e = w.ok(w.svc.checkEligibility(OP, { negotiationId: neg.id }));
    expect(e.state).toBe("IN_PROGRESS");
    expect(e.policy?.reasonCodes).toContain("STATE_NOT_PERMITTED");
  });
});

describe("the retirement note matches what the mandate actually requires", () => {
  it("says the new version needs its own approval only when the mandate requires one", () => {
    const needs = approvedDeal();
    const n1 = needs.w.accept(
      needs.neg.id,
      needs.w.offer(needs.neg.id, "seller_acme", needs.w.priced(7000)).id,
    );
    expect(n1.retired?.retired?.reason).toMatch(
      /earlier approval no longer applies; the new version needs its own\.$/,
    );

    const optional = approvedDeal({ threshold: 10_000 }); // 70.00 is under the threshold: no approval required
    const n2 = optional.w.accept(
      optional.neg.id,
      optional.w.offer(optional.neg.id, "seller_acme", optional.w.priced(7000)).id,
    );
    expect(n2.retired?.retired?.reason).toMatch(/earlier approval no longer applies\.$/);
    expect(n2.retired?.retired?.reason).not.toMatch(/needs its own/);
  });
});
