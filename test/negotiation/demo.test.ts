import { describe, expect, it } from "vitest";

import { createSeller } from "@/adapters/sqlite/store";
import { ConflictError, ForbiddenError } from "@/domain/errors";

import { AGENT, ANON, OP, makeWorld } from "./world";

const ALL = ["seller_acme", "seller_other", "seller_blocked"];

describe("the demo agents record their proposals like anyone else", () => {
  it("several sellers offer; the buyer agent recommends the best allowed one; the operator then accepts it through the policy engine", async () => {
    const w = makeWorld();
    const neg = w.open({ maxTotal: "70.00", invitedSellerIds: ALL });
    const out = await w.demo.run(OP, neg.id);

    expect(out.status).toBe("RECOMMENDED");
    expect(out.headline).toMatch(/recommends an offer/);
    expect(out.recorded).toEqual({ offers: 3, counters: 0 });
    expect(out.problems).toEqual([]);
    expect(w.cell("SELECT DISTINCT actor FROM negotiation_proposals")).toBe("AGENT");

    const d = w.detail(neg.id);
    expect(d.sellers.map((s) => [s.sellerId, s.offers.length])).toEqual([
      ["seller_acme", 1],
      ["seller_other", 1],
      ["seller_blocked", 1],
    ]);
    const recommended = d.sellers
      .flatMap((s) => s.offers)
      .find((p) => p.id === out.recommendedProposalId);
    expect(recommended).toMatchObject({ sellerId: "seller_acme", status: "OPEN" });

    // the blocked seller's offer is on the table, with the engine's live verdict explained
    const blocked = d.sellers[2]?.offers[0];
    expect(blocked?.policy).toMatchObject({
      verdict: "DENY",
      source: "PREVIEW",
      reasonCodes: ["PAYEE_NOT_ALLOWED"],
    });
    expect(blocked?.policy?.items[0]?.title).toBe("This seller is not on your allow-list");

    const accepted = w.accept(neg.id, out.recommendedProposalId as string);
    expect(accepted.accepted).toBe(true);
  });

  it("the demo itself never accepts, approves or pays anything", async () => {
    const w = makeWorld();
    const neg = w.open({ invitedSellerIds: ALL });
    await w.demo.run(OP, neg.id);
    expect(w.count("negotiation_agreements")).toBe(0);
    expect(w.count("transaction_approvals")).toBe(0);
    expect(w.count("transactions")).toBe(0);
    expect(w.count("payment_attempts")).toBe(0);
    expect(w.detail(neg.id).status).toBe("OPEN");
  });

  it("when the target is below what sellers will accept, it records counter-offers and seller revisions as versions, within the seller's floor", async () => {
    const w = makeWorld();
    const neg = w.open({ maxTotal: "30.00", invitedSellerIds: ["seller_acme"] });
    const out = await w.demo.run(OP, neg.id);
    expect(out.recorded.counters).toBeGreaterThanOrEqual(1);
    expect(out.recorded.offers).toBeGreaterThanOrEqual(2);
    expect(out.status).toBe("APPROVAL_REQUESTED"); // it could not reach the target, so a person decides

    const d = w.detail(neg.id);
    const thread = d.sellers[0];
    expect(thread?.counters[0]?.terms).toMatchObject({
      totalText: "30.00 USD",
      currency: "USD",
      category: "COMPUTE",
    });
    expect(thread?.counters.map((c) => c.version)).toEqual(thread?.counters.map((_c, i) => i + 1));
    expect(thread?.offers.map((o) => o.version)).toEqual(thread?.offers.map((_o, i) => i + 1));
    const last = thread?.offers[thread.offers.length - 1];
    expect(last?.terms.totalText).toBe("32.00 USD"); // GPU-MINI list 40.00, synthetic floor 80%
    expect(last?.changes.map((c) => c.kind)).toEqual([]); // a repeat of "best and final" is not a change
    expect(thread?.offers.slice(0, -1).every((o) => o.status === "SUPERSEDED")).toBe(true);
    const second = thread?.offers[1];
    expect(second?.changes).toEqual([
      { kind: "PRICE", text: "The total price changed from 40.00 USD to 32.00 USD." },
    ]);
  });

  it("only the operator can start it, and only on an open negotiation", async () => {
    const w = makeWorld();
    const neg = w.open();
    for (const who of [AGENT, ANON])
      await expect(w.demo.run(who, neg.id)).rejects.toThrow(ForbiddenError);
    w.ok(w.svc.close(OP, { negotiationId: neg.id }, "CANCELLED"));
    await expect(w.demo.run(OP, neg.id)).rejects.toThrow(ConflictError);
  });

  it("a seller with nothing in its catalog is simply skipped", async () => {
    const w = makeWorld();
    createSeller(w.db, {
      id: "seller_empty",
      displayName: "Empty",
      payeeRef: "payee_empty",
      now: "2026-01-01T00:00:00.000Z",
    });
    const neg = w.open({ invitedSellerIds: ["seller_empty", "seller_acme"] });
    const out = await w.demo.run(OP, neg.id);
    expect(out.recorded.offers).toBe(1);
    expect(out.problems).toEqual([]);
  });
});
