import { describe, expect, it } from "vitest";

import { ConflictError, ForbiddenError, NotFoundError } from "@/domain/errors";

import { AGENT, ANON, OP, SYSTEM, makeWorld } from "./world";

describe("opening a negotiation: the buyer's request and constraints", () => {
  it("stores the request, the constraints and a deadline, and explains the status", () => {
    const w = makeWorld();
    const neg = w.open({
      quantity: 2,
      maxTotal: "70.00",
      neededWithinDays: 5,
      requiredDeliverables: ["Usage report"],
      timeoutMinutes: 90,
    });
    expect(neg.status).toBe("OPEN");
    expect(neg.statusText).toMatch(
      /^Open: offers can still be made and accepted until 2026-10-12T10:30:00.000Z/,
    );
    expect(neg.request).toMatchObject({
      categoryLabel: "Compute & GPU",
      quantity: 2,
      maxTotalText: "70.00 USD",
      neededWithinDays: 5,
      requiredDeliverables: ["Usage report"],
    });
    expect(neg.expiresAt).toBe("2026-10-12T10:30:00.000Z");
    expect(neg.sellers.map((s) => s.sellerId)).toEqual(["seller_acme", "seller_other"]);
    expect(w.cell("SELECT max_total_minor FROM negotiations")).toBe(7000);
  });

  it.each([
    ["a money value in scientific notation", { maxTotal: "7e1" }, "maxTotal"],
    ["a negative budget", { maxTotal: "-5" }, "maxTotal"],
    ["a zero budget", { maxTotal: "0" }, "maxTotal"],
    ["too many decimals", { maxTotal: "70.001" }, "maxTotal"],
    ["a JSON number for money", { maxTotal: 70 }, "maxTotal"],
    ["an unsupported category", { category: "WEAPONS" }, "category"],
    ["an unknown seller", { invitedSellerIds: ["seller_nobody"] }, "invitedSellerIds"],
    [
      "a duplicated seller",
      { invitedSellerIds: ["seller_acme", "seller_acme"] },
      "invitedSellerIds",
    ],
    ["no sellers", { invitedSellerIds: [] }, "invitedSellerIds"],
    ["a zero quantity", { quantity: 0 }, "quantity"],
    ["a timeout of zero", { timeoutMinutes: 0 }, "timeoutMinutes"],
    ["a timeout over a week", { timeoutMinutes: 10_081 }, "timeoutMinutes"],
    ["an extra field", { approved: true }, "approved"],
  ])("rejects %s", (_n, over, field) => {
    const w = makeWorld();
    const r = w.svc.open(OP, {
      mandateId: "M1",
      category: "COMPUTE",
      quantity: 1,
      summary: "x",
      maxTotal: null,
      neededWithinDays: null,
      requiredDeliverables: [],
      invitedSellerIds: ["seller_acme"],
      timeoutMinutes: 60,
      ...over,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.map((e) => e.field)).toContain(field);
    expect(w.count("negotiations")).toBe(0);
  });

  it("an unknown mandate is not found", () => {
    const w = makeWorld();
    expect(() =>
      w.svc.open(OP, {
        mandateId: "nope",
        category: "COMPUTE",
        quantity: 1,
        summary: "x",
        maxTotal: null,
        neededWithinDays: null,
        requiredDeliverables: [],
        invitedSellerIds: ["seller_acme"],
        timeoutMinutes: 60,
      }),
    ).toThrow(NotFoundError);
  });

  it("only the operator can open one", () => {
    const w = makeWorld();
    for (const who of [AGENT, SYSTEM, ANON]) {
      expect(() => w.svc.open(who, {})).toThrow(ForbiddenError);
    }
    expect(w.count("negotiations")).toBe(0);
  });
});

describe("seller offers are stored as immutable, numbered versions", () => {
  it("several sellers can offer; each has its own chain", () => {
    const w = makeWorld();
    const neg = w.open();
    const a = w.offer(neg.id, "seller_acme");
    const o = w.offer(neg.id, "seller_other", w.priced(7500));
    const d = w.detail(neg.id);
    expect(d.sellers.map((s) => [s.sellerId, s.offers.map((p) => p.version)])).toEqual([
      ["seller_acme", [1]],
      ["seller_other", [1]],
    ]);
    expect([a.terms.totalText, o.terms.totalText]).toEqual(["80.00 USD", "75.00 USD"]);
    expect(w.count("negotiation_proposals")).toBe(2);
  });

  it("a revised offer is a NEW version that supersedes the old one, with its changes spelled out", () => {
    const w = makeWorld();
    const neg = w.open();
    const v1 = w.offer(neg.id);
    const v2 = w.offer(neg.id, "seller_acme", w.priced(7000));
    expect([v1.version, v2.version]).toEqual([1, 2]);
    const d = w.detail(neg.id);
    const offers = d.sellers[0]?.offers ?? [];
    expect(offers.map((p) => [p.version, p.status])).toEqual([
      [1, "SUPERSEDED"],
      [2, "OPEN"],
    ]);
    expect(offers[1]?.changes).toEqual([
      { kind: "PRICE", text: "The total price changed from 80.00 USD to 70.00 USD." },
    ]);
    expect(offers[0]?.statusReason).toBe("Replaced by version 2.");
    expect(w.cell("SELECT supersedes_id FROM negotiation_proposals WHERE version = 2")).toBe(v1.id);
  });

  it.each([
    [
      "category",
      {
        category: "STORAGE",
        lines: [{ sku: "STORE-100", qty: 1, unitPriceMinor: 2000 }],
        claimedTotalMinor: 2000,
      },
      ["PRICE", "SCOPE", "CATEGORY"],
    ],
    ["currency", { currency: "EUR" }, ["CURRENCY"]],
    [
      "deliverables (the acceptance criteria)",
      { deliverables: ["80 GPU-hours"] },
      ["ACCEPTANCE_CRITERIA"],
    ],
    ["delivery deadline", { deliveryDays: 10 }, ["DEADLINE"]],
    [
      "quantity (scope and price)",
      { lines: [{ sku: "GPU-PACK", qty: 2, unitPriceMinor: 8000 }], claimedTotalMinor: 16_000 },
      ["PRICE", "SCOPE"],
    ],
    ["written terms", { termsText: "Fixed price, no refunds." }, ["SCOPE"]],
    ["shipping", { shippingMinor: 100, claimedTotalMinor: 8100 }, ["PRICE"]],
  ])("classifies a change of %s", (_n, change, kinds) => {
    const w = makeWorld();
    const neg = w.open();
    w.offer(neg.id);
    const v2 = w.offer(neg.id, "seller_acme", change);
    expect(v2.changes.map((c) => c.kind)).toEqual(kinds);
    expect(w.cell<string>("SELECT changes FROM negotiation_proposals WHERE version = 2")).toBe(
      JSON.stringify(kinds),
    );
  });

  it("a revision that changes only the validity is not a change to the deal", () => {
    const w = makeWorld();
    const neg = w.open();
    const v1 = w.offer(neg.id);
    const v2 = w.offer(neg.id, "seller_acme", { validForMinutes: 600 });
    expect(v2.changes).toEqual([]);
    expect(w.cell("SELECT COUNT(DISTINCT terms_hash) FROM negotiation_proposals")).toBe(1);
    expect(v2.id).not.toBe(v1.id);
  });

  it("the payee is always the catalog's, whatever a proposal says", () => {
    const w = makeWorld();
    const neg = w.open();
    w.offer(neg.id, "seller_other");
    expect(w.cell("SELECT payee_ref FROM negotiation_proposals")).toBe("payee_other");
  });

  it.each([
    ["payeeRef", { payeeRef: "payee_attacker" }],
    ["payee", { payee: "attacker@example.com" }],
    ["account", { account: "DE00 0000" }],
    ["paypalEmail", { paypalEmail: "attacker@example.com" }],
  ])("a proposal that names a payee (%s) is refused and stores nothing", (key, extra) => {
    const w = makeWorld();
    const neg = w.open();
    for (const where of ["top", "offer"] as const) {
      const input = w.offerInput(
        neg.id,
        "seller_acme",
        where === "offer" ? extra : {},
        where === "top" ? extra : {},
      );
      const r = w.svc.submitOffer(AGENT, input);
      expect(r.ok).toBe(false);
      if (!r.ok) {
        const e = r.errors.find((x) => x.field.endsWith(key));
        expect(e?.message).toMatch(/payee cannot be supplied.*seller catalog/);
      }
    }
    expect(w.count("negotiation_proposals")).toBe(0);
  });

  it("a payee also cannot be sneaked into a counter-offer", () => {
    const w = makeWorld();
    const neg = w.open();
    w.offer(neg.id);
    const r = w.svc.submitCounter(AGENT, {
      negotiationId: neg.id,
      sellerId: "seller_acme",
      currency: "USD",
      category: "COMPUTE",
      targetTotalMinor: 7000,
      deliverables: ["x"],
      deliveryDays: 3,
      note: "n",
      validForMinutes: 60,
      payeeRef: "payee_attacker",
    });
    expect(r.ok).toBe(false);
  });

  it("refuses unknown sellers, uninvited sellers, bad shapes and overflow, storing nothing", () => {
    const w = makeWorld();
    const neg = w.open({ invitedSellerIds: ["seller_acme"] });
    expect(() => w.svc.submitOffer(AGENT, w.offerInput(neg.id, "seller_ghost"))).toThrow(
      NotFoundError,
    );
    const uninvited = w.svc.submitOffer(AGENT, w.offerInput(neg.id, "seller_other"));
    expect(uninvited.ok === false && uninvited.errors[0]?.field).toBe("sellerId");
    for (const bad of [
      { lines: [] },
      { lines: [{ sku: "GPU-PACK", qty: 1, unitPriceMinor: -1 }] },
      { lines: [{ sku: "GPU-PACK", qty: 1, unitPriceMinor: 1.5 }] },
      { claimedTotalMinor: "8000" },
      { currency: "usd" },
      { category: "WEAPONS" },
      { deliverables: [] },
      { validForMinutes: 0 },
      { surprise: 1 },
    ]) {
      expect(
        w.svc.submitOffer(AGENT, w.offerInput(neg.id, "seller_acme", bad)).ok,
        JSON.stringify(bad),
      ).toBe(false);
    }
    const huge = w.svc.submitOffer(
      AGENT,
      w.offerInput(neg.id, "seller_acme", {
        lines: [{ sku: "GPU-PACK", qty: 2, unitPriceMinor: Number.MAX_SAFE_INTEGER }],
        claimedTotalMinor: 1,
      }),
    );
    expect(huge.ok === false && huge.errors[0]?.field).toBe("offer.lines");
    expect(w.count("negotiation_proposals")).toBe(0);
  });

  it("a stated total that disagrees with the lines is stored, flagged, and not trusted", () => {
    const w = makeWorld();
    const neg = w.open();
    const p = w.offer(neg.id, "seller_acme", { claimedTotalMinor: 5000 });
    expect(p.totalMatchesClaim).toBe(false);
    expect(p.claimedTotalText).toBe("50.00 USD");
    expect(p.terms.totalText).toBe("80.00 USD"); // our sum
    expect(w.cell("SELECT total_minor FROM negotiation_proposals")).toBe(8000);
  });

  it("agents, the system and the operator may record offers; anonymous callers may not", () => {
    const w = makeWorld();
    const neg = w.open();
    for (const who of [AGENT, SYSTEM, OP])
      expect(w.svc.submitOffer(who, w.offerInput(neg.id, "seller_acme")).ok).toBe(true);
    expect(() => w.svc.submitOffer(ANON, w.offerInput(neg.id, "seller_acme"))).toThrow(
      ForbiddenError,
    );
    expect(w.count("negotiation_proposals")).toBe(3);
  });
});

describe("structured counter-offers", () => {
  it("state price, currency, category, deliverables and a deadline explicitly, as versions", () => {
    const w = makeWorld();
    const neg = w.open();
    const offer = w.offer(neg.id);
    const c1 = w.counter(neg.id);
    const c2 = w.counter(neg.id, "seller_acme", { targetTotalMinor: 7500, deliveryDays: 2 });
    expect([c1.kind, c1.version, c2.version]).toEqual(["BUYER_COUNTER", 1, 2]);
    expect(c1.terms).toMatchObject({
      totalText: "70.00 USD",
      currency: "USD",
      category: "COMPUTE",
      deliverables: ["80 GPU-hours", "Usage report"],
      deliveryDays: 3,
      lines: null,
    });
    expect(c1.terms.deliverBy).toBe("2026-10-15T09:00:00.000Z");
    expect(c2.changes.map((c) => c.kind)).toEqual(["PRICE", "DEADLINE"]);
    const d = w.detail(neg.id);
    expect(d.sellers[0]?.counters.map((p) => [p.version, p.status])).toEqual([
      [1, "SUPERSEDED"],
      [2, "OPEN"],
    ]);
    expect(
      w.cell(
        "SELECT responds_to_id FROM negotiation_proposals WHERE kind = 'BUYER_COUNTER' AND version = 1",
      ),
    ).toBe(offer.id);
  });

  it("need an open offer from that seller to counter", () => {
    const w = makeWorld();
    const neg = w.open();
    expect(() => w.counter(neg.id)).toThrow(ConflictError);
  });

  it("a seller's new offer can answer a counter, which is then marked answered", () => {
    const w = makeWorld();
    const neg = w.open();
    w.offer(neg.id);
    const c = w.counter(neg.id);
    const v2 = w.offer(neg.id, "seller_acme", w.priced(7000), { respondsToId: c.id });
    expect(v2.version).toBe(2);
    const counter = w.detail(neg.id).sellers[0]?.counters[0];
    expect(counter?.status).toBe("SUPERSEDED");
    expect(counter?.statusReason).toBe("Answered by offer version 2.");
  });

  it("an offer cannot claim to answer a counter that is not addressed to its seller", () => {
    const w = makeWorld();
    const neg = w.open();
    w.offer(neg.id);
    const c = w.counter(neg.id);
    const r = w.svc.submitOffer(
      AGENT,
      w.offerInput(neg.id, "seller_other", {}, { respondsToId: c.id }),
    );
    expect(r.ok === false && r.errors[0]?.field).toBe("respondsToId");
  });

  it("a counter-offer is the buyer's own proposal and can never be 'accepted'", () => {
    const w = makeWorld();
    const neg = w.open();
    w.offer(neg.id);
    const c = w.counter(neg.id);
    expect(() => w.accept(neg.id, c.id)).toThrow(ConflictError);
    expect(w.count("negotiation_agreements")).toBe(0);
  });

  it("zero is not a price", () => {
    const w = makeWorld();
    const neg = w.open();
    w.offer(neg.id);
    const r = w.svc.submitCounter(AGENT, {
      negotiationId: neg.id,
      sellerId: "seller_acme",
      currency: "USD",
      category: "COMPUTE",
      targetTotalMinor: 0,
      deliverables: ["x"],
      deliveryDays: 1,
      note: "",
      validForMinutes: 5,
    });
    expect(r.ok === false && r.errors[0]?.field).toBe("targetTotalMinor");
  });

  it("the system and anonymous callers cannot make buyer counter-offers", () => {
    const w = makeWorld();
    const neg = w.open();
    w.offer(neg.id);
    const input = {
      negotiationId: neg.id,
      sellerId: "seller_acme",
      currency: "USD",
      category: "COMPUTE",
      targetTotalMinor: 7000,
      deliverables: ["x"],
      deliveryDays: 1,
      note: "",
      validForMinutes: 5,
    };
    expect(() => w.svc.submitCounter(SYSTEM, input)).toThrow(ForbiddenError);
    expect(() => w.svc.submitCounter(ANON, input)).toThrow(ForbiddenError);
  });
});
