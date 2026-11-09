import { describe, expect, it } from "vitest";

import {
  CHANGE_KINDS,
  NEGOTIATION_STATUSES,
  NEGOTIATION_TRANSITIONS,
  PROPOSAL_STATUSES,
  PROPOSAL_TRANSITIONS,
  SubmitCounterSchema,
  deliverBy,
  describeChanges,
  diffTerms,
  moneyText,
  parseStrict,
  proposalHash,
  type ProposalTerms,
} from "@/domain/negotiation";
import { GUIDANCE, explainCodes } from "@/domain/policy-explanations";
import { REASON_CODES } from "@/domain/policy";

const base: ProposalTerms = {
  sellerId: "seller_acme",
  payeeRef: "payee_acme",
  currency: "USD",
  category: "COMPUTE",
  lines: [{ sku: "GPU-PACK", qty: 1, unitPriceMinor: 8000 }],
  shippingMinor: 0,
  feesMinor: 0,
  totalMinor: 8000,
  deliverables: ["a", "b"],
  deliveryDays: 3,
  termsText: "Fixed.",
};

describe("diffTerms: what counts as a change", () => {
  it("the first version has no changes, and identical terms have none", () => {
    expect(diffTerms(null, base)).toEqual([]);
    expect(diffTerms(base, structuredClone(base))).toEqual([]);
  });

  it("the order of deliverables or lines does not matter", () => {
    expect(diffTerms(base, { ...base, deliverables: ["b", "a"] })).toEqual([]);
    const two = {
      ...base,
      lines: [
        { sku: "A", qty: 1, unitPriceMinor: 1 },
        { sku: "B", qty: 2, unitPriceMinor: 2 },
      ],
      totalMinor: 5,
    };
    expect(diffTerms(two, { ...two, lines: [...(two.lines ?? [])].reverse() })).toEqual([]);
  });

  it.each<[string, Partial<ProposalTerms>, string[]]>([
    ["total", { totalMinor: 7000 }, ["PRICE"]],
    [
      "unit price with the same total",
      { lines: [{ sku: "GPU-PACK", qty: 1, unitPriceMinor: 7900 }] },
      ["PRICE"],
    ],
    ["shipping", { shippingMinor: 1 }, ["PRICE"]],
    ["fees", { feesMinor: 1 }, ["PRICE"]],
    ["payee", { payeeRef: "payee_x" }, ["PAYEE"]],
    ["seller", { sellerId: "seller_other" }, ["PAYEE"]],
    ["quantity", { lines: [{ sku: "GPU-PACK", qty: 2, unitPriceMinor: 8000 }] }, ["SCOPE"]],
    ["sku", { lines: [{ sku: "OTHER", qty: 1, unitPriceMinor: 8000 }] }, ["SCOPE"]],
    ["written terms", { termsText: "Other." }, ["SCOPE"]],
    ["category", { category: "STORAGE" }, ["CATEGORY"]],
    ["currency", { currency: "EUR" }, ["CURRENCY"]],
    ["deliverables", { deliverables: ["a"] }, ["ACCEPTANCE_CRITERIA"]],
    ["deadline", { deliveryDays: 4 }, ["DEADLINE"]],
  ])("%s", (_n, change, kinds) => {
    expect(diffTerms(base, { ...base, ...change })).toEqual(kinds);
  });

  it("reports several changes in a fixed order, and every kind is describable in words", () => {
    const next: ProposalTerms = {
      ...base,
      totalMinor: 9000,
      payeeRef: "p2",
      category: "STORAGE",
      currency: "EUR",
      deliverables: ["z"],
      deliveryDays: 9,
      termsText: "n",
      lines: [{ sku: "S", qty: 2, unitPriceMinor: 4500 }],
    };
    expect(diffTerms(base, next)).toEqual([...CHANGE_KINDS]);
    const words = describeChanges(base, next);
    expect(words).toHaveLength(CHANGE_KINDS.length);
    expect(words[0]).toBe("The total price changed from 80.00 USD to 90.00 EUR.");
    for (const line of words) expect(line.length).toBeGreaterThan(20);
  });
});

describe("proposalHash identifies a version of the terms", () => {
  it("is stable, ignores deliverable order, and depends on kind and on every term", () => {
    const h = proposalHash("SELLER_OFFER", base);
    expect(h).toMatch(/^[0-9a-f]{64}$/);
    expect(proposalHash("SELLER_OFFER", structuredClone(base))).toBe(h);
    expect(proposalHash("SELLER_OFFER", { ...base, deliverables: ["b", "a"] })).toBe(h);
    expect(proposalHash("BUYER_COUNTER", base)).not.toBe(h);
    for (const change of [
      { totalMinor: 1 },
      { payeeRef: "x" },
      { sellerId: "x" },
      { currency: "EUR" },
      { category: "DESIGN" as const },
      { deliveryDays: 1 },
      { termsText: "x" },
      { deliverables: ["q"] },
    ]) {
      expect(proposalHash("SELLER_OFFER", { ...base, ...change }), JSON.stringify(change)).not.toBe(
        h,
      );
    }
  });
});

describe("small helpers", () => {
  it("deliverBy adds whole days in UTC", () => {
    expect(deliverBy("2026-10-12T09:00:00.000Z", 3)).toBe("2026-10-15T09:00:00.000Z");
    expect(deliverBy("2026-10-12T09:00:00.000Z", 0)).toBe("2026-10-12T09:00:00.000Z");
  });

  it("moneyText formats supported currencies exactly and shows unsupported ones as minor units, never as a guess", () => {
    expect(moneyText(12345, "USD")).toBe("123.45 USD");
    expect(moneyText(500, "JPY")).toBe("500 JPY");
    expect(moneyText(12345, "XBT")).toBe("12345 minor units of XBT");
  });

  it("status tables never allow leaving a final state", () => {
    for (const s of NEGOTIATION_STATUSES) expect(NEGOTIATION_TRANSITIONS[s]).toBeDefined();
    for (const s of PROPOSAL_STATUSES) expect(PROPOSAL_TRANSITIONS[s]).toBeDefined();
    for (const final of ["REJECTED", "TIMED_OUT", "CANCELLED"] as const)
      expect(NEGOTIATION_TRANSITIONS[final]).toEqual([]);
    for (const final of PROPOSAL_STATUSES.filter((s) => s !== "OPEN"))
      expect(PROPOSAL_TRANSITIONS[final]).toEqual([]);
  });

  it("parseStrict reports every problem and names payee-like keys explicitly", () => {
    const r = parseStrict(SubmitCounterSchema, { payeeRef: "x", currency: "usd" });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      const fields = r.errors.map((e) => e.field);
      expect(fields).toEqual(expect.arrayContaining(["payeeRef", "currency", "negotiationId"]));
      expect(r.errors.find((e) => e.field === "payeeRef")?.message).toMatch(/seller catalog/);
    }
  });
});

describe("plain-language explanations", () => {
  it("exist for every reason code the engine can give, and say what to do next", () => {
    expect(Object.keys(GUIDANCE).sort()).toEqual(Object.keys(REASON_CODES).sort());
    for (const [code, g] of Object.entries(GUIDANCE)) {
      expect(g.title.length, code).toBeGreaterThan(5);
      expect(g.detail.length, code).toBeGreaterThan(20);
      expect(g.next.length, code).toBeGreaterThan(8);
    }
  });

  it("builds a headline for one reason, several reasons, and an allow; unknown codes are shown, not hidden", () => {
    expect(explainCodes("ALLOW", [], "ACCEPT_OFFER").headline).toBe(
      "Policy check passed for accepting this offer.",
    );
    expect(explainCodes("DENY", ["CURRENCY_MISMATCH"], "ACCEPT_OFFER").headline).toBe(
      "Policy check refused accepting this offer: Wrong currency.",
    );
    expect(
      explainCodes("DENY", ["OVER_PER_TX_CAP", "OVER_TOTAL_BUDGET"], "CREATE_ORDER").headline,
    ).toBe("Policy check refused starting payment for 2 reasons.");
    const unknown = explainCodes("DENY", ["FUTURE_CODE"], "CREATE_ORDER");
    expect(unknown.items[0]).toMatchObject({ code: "FUTURE_CODE", title: "Refused" });
  });

  it("never contains markup or anything a seller could have written", () => {
    for (const g of Object.values(GUIDANCE))
      expect(`${g.title}${g.detail}${g.next}`).not.toMatch(/[<>]/);
  });
});
