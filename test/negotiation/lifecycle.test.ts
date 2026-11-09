import { describe, expect, it } from "vitest";

import { verifyChain } from "@/adapters/sqlite/audit";
import { ConflictError, ForbiddenError, NotFoundError } from "@/domain/errors";

import { AGENT, ANON, OP, SYSTEM, makeWorld } from "./world";

describe("rejection", () => {
  it("the operator rejects one offer; the negotiation carries on with the others", () => {
    const w = makeWorld();
    const neg = w.open();
    const a = w.offer(neg.id, "seller_acme");
    const b = w.offer(neg.id, "seller_other", w.priced(7500));
    const d = w.ok(
      w.svc.reject(OP, { negotiationId: neg.id, proposalId: a.id, reason: "Too slow" }),
    );
    const [acme, other] = d.sellers;
    expect(acme?.offers[0]).toMatchObject({ status: "REJECTED", statusReason: "Too slow" });
    expect(other?.offers[0]?.status).toBe("OPEN");
    expect(d.status).toBe("OPEN");
    expect(w.accept(neg.id, b.id).accepted).toBe(true);
  });

  it("a rejected offer can neither be accepted nor rejected again; the seller may offer again", () => {
    const w = makeWorld();
    const neg = w.open();
    const a = w.offer(neg.id);
    w.ok(w.svc.reject(OP, { negotiationId: neg.id, proposalId: a.id }));
    expect(() => w.accept(neg.id, a.id)).toThrow(/no longer open \(rejected/);
    expect(() => w.svc.reject(OP, { negotiationId: neg.id, proposalId: a.id })).toThrow(
      ConflictError,
    );
    const again = w.offer(neg.id);
    expect(again.version).toBe(2);
    expect(w.accept(neg.id, again.id).accepted).toBe(true);
  });

  it("a counter-offer can be rejected too (for example by the seller's side, via the operator)", () => {
    const w = makeWorld();
    const neg = w.open();
    w.offer(neg.id);
    const c = w.counter(neg.id);
    const d = w.ok(
      w.svc.reject(OP, { negotiationId: neg.id, proposalId: c.id, reason: "Seller declined" }),
    );
    expect(d.sellers[0]?.counters[0]).toMatchObject({
      status: "REJECTED",
      statusReason: "Seller declined",
    });
  });

  it("agents and anonymous callers cannot reject", () => {
    const w = makeWorld();
    const neg = w.open();
    const a = w.offer(neg.id);
    expect(() => w.svc.reject(AGENT, { negotiationId: neg.id, proposalId: a.id })).toThrow(
      ForbiddenError,
    );
    expect(() => w.svc.reject(ANON, { negotiationId: neg.id, proposalId: a.id })).toThrow(
      ForbiddenError,
    );
    expect(w.detail(neg.id).sellers[0]?.offers[0]?.status).toBe("OPEN");
  });

  it("rejecting every offer closes the negotiation; open proposals are rejected with it and nothing more is accepted", () => {
    const w = makeWorld();
    const neg = w.open();
    const a = w.offer(neg.id);
    w.counter(neg.id);
    const d = w.ok(w.svc.close(OP, { negotiationId: neg.id, reason: "None suit us" }, "REJECTED"));
    expect(d.status).toBe("REJECTED");
    expect(d.statusText).toBe("Rejected: no deal. None suit us");
    expect(d.sellers[0]?.offers[0]?.status).toBe("REJECTED");
    expect(d.sellers[0]?.counters[0]?.status).toBe("REJECTED");
    expect(() => w.offer(neg.id)).toThrow(/negotiation is closed/);
    expect(() => w.accept(neg.id, a.id)).toThrow(/negotiation is closed/);
    expect(() => w.svc.close(OP, { negotiationId: neg.id }, "CANCELLED")).toThrow(ConflictError);
  });

  it("cancelling an agreed negotiation cancels the agreement and its transaction", () => {
    const w = makeWorld();
    const { neg } = w.agreed();
    const d = w.ok(w.svc.close(OP, { negotiationId: neg.id }, "CANCELLED"));
    expect(d.status).toBe("CANCELLED");
    expect(d.agreements[0]).toMatchObject({ status: "CANCELLED", transactionState: "CANCELLED" });
    expect(d.active).toBeNull();
  });

  it("the operator can reject the CURRENT agreement: it is cancelled and the negotiation reopens for another offer", () => {
    const w = makeWorld();
    const { neg } = w.agreed();
    const d = w.ok(w.svc.disapprove(OP, { negotiationId: neg.id, reason: "Changed my mind" }));
    expect(d.status).toBe("OPEN");
    expect(d.agreements[0]).toMatchObject({ version: 1, status: "CANCELLED" });
    expect(d.agreements[0]?.retired?.reason).toBe("Changed my mind");
    expect(w.cell("SELECT decision FROM transaction_approvals")).toBe("REJECTED");
    const alt = w.offer(neg.id, "seller_other", w.priced(7500));
    const out = w.accept(neg.id, alt.id);
    expect(out.accepted).toBe(true);
    expect(out.negotiation.active).toMatchObject({ version: 2, sellerName: "Other Cloud" });
  });

  it("only the operator can reject an agreement or close a negotiation", () => {
    const w = makeWorld();
    const { neg } = w.agreed();
    for (const who of [AGENT, SYSTEM, ANON]) {
      expect(() => w.svc.disapprove(who, { negotiationId: neg.id })).toThrow(ForbiddenError);
      expect(() => w.svc.close(who, { negotiationId: neg.id }, "CANCELLED")).toThrow(
        ForbiddenError,
      );
    }
    expect(w.detail(neg.id).active?.status).toBe("ACTIVE");
  });
});

describe("negotiation timeout", () => {
  it("a negotiation past its deadline is timed out, its open proposals expire, and the reason is stated", () => {
    const w = makeWorld();
    const neg = w.open({ timeoutMinutes: 30 });
    w.offer(neg.id);
    w.counter(neg.id);
    w.clock.advance(31);
    const d = w.detail(neg.id);
    expect(d.status).toBe("TIMED_OUT");
    expect(d.statusText).toMatch(
      /^Timed out: no agreement was reached by 2026-10-12T09:30:00.000Z\.$/,
    );
    expect(d.sellers[0]?.offers[0]).toMatchObject({
      status: "EXPIRED",
      statusReason: "The negotiation timed out.",
    });
    expect(d.sellers[0]?.counters[0]?.status).toBe("EXPIRED");
  });

  it("nothing can be offered, countered, accepted or approved after a timeout", () => {
    const w = makeWorld();
    const neg = w.open({ timeoutMinutes: 30 });
    const o = w.offer(neg.id);
    w.clock.advance(30); // exactly at the deadline
    expect(() => w.offer(neg.id)).toThrow(/negotiation is closed.*Timed out/);
    expect(() => w.counter(neg.id)).toThrow(/negotiation is closed/);
    expect(() => w.accept(neg.id, o.id)).toThrow(/negotiation is closed/);
    expect(() => w.svc.approve(OP, { negotiationId: neg.id })).toThrow(/negotiation is closed/);
    expect(w.count("negotiation_agreements")).toBe(0);
  });

  it("one millisecond before the deadline it is still open", () => {
    const w = makeWorld();
    const neg = w.open({ timeoutMinutes: 30 });
    const o = w.offer(neg.id, "seller_acme", w.priced(4000, 1, "GPU-MINI"));
    w.clock.advanceMs(30 * 60_000 - 1);
    expect(w.accept(neg.id, o.id).accepted).toBe(true);
  });

  it("an agreed negotiation does not time out, but offers that were never accepted still expire", () => {
    const w = makeWorld();
    const neg = w.open({ timeoutMinutes: 30 });
    const a = w.offer(neg.id, "seller_acme", {
      ...w.priced(4000, 1, "GPU-MINI"),
      validForMinutes: 20,
    });
    const b = w.offer(neg.id, "seller_other", { ...w.priced(7500), validForMinutes: 25 });
    w.accept(neg.id, a.id);
    w.clock.advance(60);
    const d = w.detail(neg.id);
    expect(d.status).toBe("AGREED");
    expect(d.active?.status).toBe("ACTIVE");
    expect(d.sellers[1]?.offers.find((p) => p.id === b.id)?.status).toBe("EXPIRED");
  });

  it("the sweep applies deadlines to every negotiation at once and reports what it did", () => {
    const w = makeWorld();
    const n1 = w.open({ timeoutMinutes: 10 });
    const n2 = w.open({ timeoutMinutes: 500 });
    w.offer(n1.id);
    w.offer(n2.id, "seller_acme", { validForMinutes: 5 });
    w.clock.advance(20);
    expect(w.svc.sweep(SYSTEM)).toEqual({ timedOut: 1, expiredProposals: 2 });
    expect(w.svc.sweep(OP)).toEqual({ timedOut: 0, expiredProposals: 0 });
    expect(w.detail(n1.id).status).toBe("TIMED_OUT");
    expect(w.detail(n2.id).status).toBe("OPEN");
    expect(() => w.svc.sweep(AGENT)).toThrow(ForbiddenError);
  });

  it("the overview applies deadlines too", () => {
    const w = makeWorld();
    w.open({ timeoutMinutes: 5 });
    w.clock.advance(6);
    expect(w.svc.overview(OP).negotiations[0]?.status).toBe("TIMED_OUT");
  });
});

describe("authority", () => {
  it("only the operator can read negotiations or the overview", () => {
    const w = makeWorld();
    const neg = w.open();
    for (const who of [AGENT, SYSTEM, ANON]) {
      expect(() => w.svc.overview(who)).toThrow(ForbiddenError);
      expect(() => w.svc.detail(who, neg.id)).toThrow(ForbiddenError);
    }
  });

  it("an agent can never approve an agreement, whatever the amounts", () => {
    const w = makeWorld();
    const { neg } = w.agreed();
    expect(() => w.svc.approve(AGENT, { negotiationId: neg.id })).toThrow(ForbiddenError);
    expect(() => w.svc.approve(SYSTEM, { negotiationId: neg.id })).toThrow(ForbiddenError);
    expect(w.count("transaction_approvals")).toBe(0);
    expect(w.ok(w.svc.checkEligibility(AGENT, { negotiationId: neg.id })).state).toBe(
      "AWAITING_APPROVAL",
    );
  });

  it("a forged actor (wrong shape, empty id) is refused", () => {
    const w = makeWorld();
    const neg = w.open();
    expect(() => w.svc.open({ kind: "OPERATOR", id: "" }, {})).toThrow(ForbiddenError);
    expect(() => w.svc.open({ kind: "ROOT" } as never, {})).toThrow(ForbiddenError);
    expect(() => w.svc.open(null as never, {})).toThrow(ForbiddenError);
    expect(() =>
      w.svc.approve({ kind: "AGENT", id: "a", extra: "OPERATOR" } as never, {
        negotiationId: neg.id,
      }),
    ).toThrow(ForbiddenError);
  });

  it("requests must name existing things", () => {
    const w = makeWorld();
    expect(() => w.svc.detail(OP, "neg_missing")).toThrow(NotFoundError);
    const neg = w.open();
    expect(() => w.accept(neg.id, "ofr_missing")).toThrow(NotFoundError);
    expect(() => w.svc.approve(OP, { negotiationId: neg.id })).toThrow(/no active agreement/);
    expect(w.ok(w.svc.checkEligibility(OP, { negotiationId: neg.id })).state).toBe("NOT_AGREED");
  });

  it("unknown fields in a request are refused", () => {
    const w = makeWorld();
    const neg = w.open();
    const r = w.svc.accept(OP, { negotiationId: neg.id, proposalId: "x", force: true });
    expect(r.ok).toBe(false);
  });
});

describe("the audit trail", () => {
  it("records every step and the hash chain verifies", () => {
    const w = makeWorld();
    const { neg } = w.agreed();
    w.ok(w.svc.approve(OP, { negotiationId: neg.id }));
    const bad = w.offer(neg.id, "seller_acme", { currency: "EUR" });
    w.accept(neg.id, bad.id);
    const v2 = w.offer(neg.id, "seller_acme", w.priced(7000));
    w.accept(neg.id, v2.id);
    const types = (
      w.db.prepare("SELECT type FROM audit_events ORDER BY seq").all() as { type: string }[]
    ).map((r) => r.type);
    for (const t of [
      "NEGOTIATION_OPENED",
      "OFFER_RECORDED",
      "POLICY_ALLOWED",
      "POLICY_DENIED",
      "AGREEMENT_CREATED",
      "AGREEMENT_RETIRED",
      "PROPOSAL_STATUS_CHANGED",
      "NEGOTIATION_STATUS_CHANGED",
      "TX_APPROVAL_RECORDED",
    ]) {
      expect(types, t).toContain(t);
    }
    expect(verifyChain(w.db)).toMatchObject({ status: "VERIFIED" });
  });

  it("the retirement of an approved agreement says the approval was invalidated, and by which proposal", () => {
    const w = makeWorld();
    const { neg } = w.agreed();
    w.ok(w.svc.approve(OP, { negotiationId: neg.id }));
    const v2 = w.offer(neg.id, "seller_acme", w.priced(7000));
    w.accept(neg.id, v2.id);
    const payload = JSON.parse(
      w.cell<string>("SELECT payload FROM audit_events WHERE type = 'AGREEMENT_RETIRED'"),
    ) as Record<string, unknown>;
    expect(payload).toMatchObject({
      version: 1,
      to: "INVALIDATED",
      approvalInvalidated: true,
      byProposalId: v2.id,
    });
  });

  it("denials keep their evidence: reason codes, policy version and input hash", () => {
    const w = makeWorld();
    const neg = w.open();
    const o = w.offer(neg.id, "seller_acme", { currency: "EUR" });
    w.accept(neg.id, o.id);
    const payload = JSON.parse(
      w.cell<string>("SELECT payload FROM audit_events WHERE type = 'POLICY_DENIED'"),
    ) as Record<string, unknown>;
    expect(payload).toMatchObject({
      subject: "ACCEPT_OFFER",
      reasonCodes: ["CURRENCY_MISMATCH"],
      policyVersion: "pactpay-policy/1.1.0",
    });
    expect(String(payload.inputsHash)).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("offer validity is judged to the millisecond when a deadline is applied", () => {
  it("still open one millisecond before its validity ends, expired at the instant it ends", () => {
    const w = makeWorld();
    const neg = w.open({ timeoutMinutes: 600 });
    w.offer(neg.id, "seller_acme", { validForMinutes: 10 });
    w.clock.advanceMs(10 * 60_000 - 1);
    expect(w.detail(neg.id).sellers[0]?.offers[0]?.status).toBe("OPEN");
    w.clock.advanceMs(1);
    const offer = w.detail(neg.id).sellers[0]?.offers[0];
    expect(offer).toMatchObject({ status: "EXPIRED", expired: true });
    expect(offer?.statusReason).toBe("Its validity ended at 2026-10-12T09:10:00.000Z.");
  });
});
