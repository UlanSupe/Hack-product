import { describe, expect, it } from "vitest";

import { insertMandateVersion } from "@/adapters/sqlite/store";
import { ConflictError, ForbiddenError } from "@/domain/errors";

import { AGENT, ANON, OP, SYSTEM, makeWorld } from "./world";

describe("an offer becomes an agreement only through the policy engine", () => {
  it("an in-policy offer is accepted: a recorded ALLOW, a versioned agreement, a core transaction", () => {
    const w = makeWorld();
    const neg = w.open();
    const o = w.offer(neg.id, "seller_acme", w.priced(4000, 1, "GPU-MINI"));
    const out = w.accept(neg.id, o.id);

    expect(out.accepted).toBe(true);
    expect(out.policy.verdict).toBe("ALLOW");
    expect(out.policy.headline).toBe("Policy check passed for accepting this offer.");
    expect(out.negotiation.status).toBe("AGREED");
    expect(out.negotiation.active).toMatchObject({
      version: 1,
      status: "ACTIVE",
      totalText: "40.00 USD",
      transactionState: "AGREED",
    });
    expect(out.negotiation.sellers[0]?.offers[0]?.status).toBe("ACCEPTED");

    // the core rows exist and agree
    expect(w.cell("SELECT total_minor FROM agreements")).toBe(4000);
    expect(w.cell("SELECT payee_ref FROM agreements")).toBe("payee_acme");
    expect(w.cell("SELECT verdict FROM policy_decisions WHERE subject = 'ACCEPT_OFFER'")).toBe(
      "ALLOW",
    );
    expect(
      w.cell("SELECT verdict FROM negotiation_policy_checks WHERE subject = 'ACCEPT_OFFER'"),
    ).toBe("ALLOW");
    expect(w.cell("SELECT state FROM transactions")).toBe("AGREED");
  });

  it("is eligible for payment only when the engine says so: a small amount needs no approval", () => {
    const w = makeWorld();
    const neg = w.open();
    w.accept(neg.id, w.offer(neg.id, "seller_acme", w.priced(4000, 1, "GPU-MINI")).id);
    const e = w.ok(w.svc.checkEligibility(OP, { negotiationId: neg.id }));
    expect(e.state).toBe("ELIGIBLE");
    expect(e.policy?.reasonCodes).toEqual([]);
    expect(e.negotiation.active?.approval.state).toBe("NOT_REQUIRED");
  });

  it("an amount above the threshold is NOT eligible until the operator approves; the reason is explained", () => {
    const w = makeWorld();
    const { neg } = w.agreed();
    const before = w.ok(w.svc.checkEligibility(OP, { negotiationId: neg.id }));
    expect(before.state).toBe("AWAITING_APPROVAL");
    expect(before.policy?.reasonCodes).toEqual(["APPROVAL_REQUIRED"]);
    expect(before.policy?.items[0]).toMatchObject({
      code: "APPROVAL_REQUIRED",
      title: "Waiting for your approval",
    });
    expect(before.negotiation.active?.approval.state).toBe("REQUIRED");

    const after = w.ok(w.svc.approve(OP, { negotiationId: neg.id, reason: "Looks right" }));
    expect(after.state).toBe("ELIGIBLE");
    expect(after.negotiation.active?.approval).toMatchObject({ state: "APPROVED" });
    expect(w.cell("SELECT decision FROM transaction_approvals")).toBe("APPROVED");
  });

  it("when the mandate forces review, even a tiny amount waits for approval", () => {
    const w = makeWorld({ review: true });
    const neg = w.open();
    w.accept(neg.id, w.offer(neg.id, "seller_acme", w.priced(4000, 1, "GPU-MINI")).id);
    const e = w.ok(w.svc.checkEligibility(OP, { negotiationId: neg.id }));
    expect(e.state).toBe("AWAITING_APPROVAL");
  });

  it("every check, allowed or refused, is recorded with its reasons, version and input hash", () => {
    const w = makeWorld();
    const { neg } = w.agreed();
    w.svc.checkEligibility(OP, { negotiationId: neg.id });
    const rows = w.db
      .prepare(
        "SELECT subject, verdict, reason_codes, policy_version, inputs_hash FROM negotiation_policy_checks ORDER BY rowid",
      )
      .all() as {
      subject: string;
      verdict: string;
      reason_codes: string;
      policy_version: string;
      inputs_hash: string;
    }[];
    expect(rows.map((r) => [r.subject, r.verdict, JSON.parse(r.reason_codes) as string[]])).toEqual(
      [
        ["ACCEPT_OFFER", "ALLOW", []],
        ["CREATE_ORDER", "DENY", ["APPROVAL_REQUIRED"]],
      ],
    );
    for (const r of rows) {
      expect(r.policy_version).toBe("pactpay-policy/1.1.0");
      expect(r.inputs_hash).toMatch(/^[0-9a-f]{64}$/);
    }
  });
});

describe("refusals: the engine's reasons, in words, with the evidence kept", () => {
  /** Offer, attempt to accept, and check that nothing became an agreement. */
  function refused(
    w: ReturnType<typeof makeWorld>,
    over: Record<string, unknown>,
    seller = "seller_acme",
    top: Record<string, unknown> = {},
  ) {
    const neg = w.open({
      invitedSellerIds: ["seller_acme", "seller_other", "seller_blocked"],
      ...top,
    });
    const o = w.offer(neg.id, seller, over);
    const out = w.accept(neg.id, o.id);
    expect(out.accepted).toBe(false);
    expect(out.negotiation.active).toBeNull();
    expect(out.negotiation.status).toBe("OPEN");
    expect(w.count("negotiation_agreements")).toBe(0);
    expect(w.count("transactions")).toBe(0); // a refused offer never even creates a transaction
    expect(
      w.cell("SELECT verdict FROM negotiation_policy_checks WHERE proposal_id = ?", o.id),
    ).toBe("DENY");
    return { out, codes: out.policy.reasonCodes, neg, o };
  }

  it("mismatched currency", () => {
    const w = makeWorld();
    const { out, codes } = refused(w, { currency: "EUR" });
    expect(codes).toEqual(["CURRENCY_MISMATCH"]);
    expect(out.policy.items[0]?.title).toBe("Wrong currency");
    expect(out.policy.headline).toBe("Policy check refused accepting this offer: Wrong currency.");
    expect(w.cell("SELECT status FROM negotiation_proposals")).toBe("REJECTED");
  });

  it("a category the mandate does not allow", () => {
    const w = makeWorld({ categories: ["COMPUTE"] });
    const { codes, out } = refused(w, { category: "STORAGE", ...w.priced(2000, 1, "STORE-100") });
    expect(codes).toEqual(["CATEGORY_NOT_ALLOWED"]);
    expect(out.policy.items[0]?.next).toMatch(/allow the category in a new mandate version/);
  });

  it("a seller who is not on the allow-list", () => {
    const w = makeWorld();
    const { codes } = refused(w, w.priced(5000), "seller_blocked");
    expect(codes).toEqual(["PAYEE_NOT_ALLOWED"]);
  });

  it("a total that does not add up uses OUR sum and says so", () => {
    const w = makeWorld();
    const { codes } = refused(w, { claimedTotalMinor: 1 });
    expect(codes).toEqual(["TOTAL_MISMATCH"]);
  });

  it("a price above the catalog", () => {
    const w = makeWorld();
    expect(refused(w, w.priced(8100)).codes).toEqual(["PRICE_NOT_IN_CATALOG"]);
  });

  it("a SKU the seller does not sell", () => {
    const w = makeWorld();
    expect(refused(w, w.priced(100, 1, "FREE-GPU")).codes).toEqual([
      "CATEGORY_UNKNOWN",
      "PRICE_NOT_IN_CATALOG",
    ]);
  });

  it("over the per-transaction limit, and over the total budget", () => {
    const w = makeWorld();
    expect(refused(w, w.priced(8000, 2)).codes).toEqual(["OVER_PER_TX_CAP", "OVER_TOTAL_BUDGET"]);
  });

  it("a revoked mandate", () => {
    const w = makeWorld();
    const neg = w.open();
    const o = w.offer(neg.id, "seller_acme", w.priced(4000, 1, "GPU-MINI"));
    insertMandateVersion(w.db, {
      id: "M1",
      ownerId: "op1",
      perTxCapMinor: 10_000,
      totalBudgetMinor: 15_000,
      approvalThresholdMinor: 5000,
      requireReview: false,
      currency: "USD",
      allowedCategories: ["COMPUTE"],
      allowedSellerIds: ["seller_acme"],
      expiresAt: "2027-06-01T00:00:00.000Z",
      status: "REVOKED",
      now: "2026-10-12T09:00:00.000Z",
    });
    const out = w.accept(neg.id, o.id);
    expect(out.accepted).toBe(false);
    expect(out.policy.reasonCodes).toEqual(["MANDATE_REVOKED"]);
    expect(out.policy.items[0]?.title).toBe("The mandate was revoked");
  });

  it("the cumulative budget: a second deal that would exceed it is refused while the first is reserved", () => {
    const w = makeWorld({ budget: 12_000, threshold: 10_000 });
    w.agreed(); // 80.00 of 120.00 is now reserved
    const neg2 = w.open();
    const out = w.accept(neg2.id, w.offer(neg2.id, "seller_acme", w.priced(5000)).id);
    expect(out.accepted).toBe(false);
    expect(out.policy.reasonCodes).toEqual(["OVER_TOTAL_BUDGET"]);
    expect(out.policy.items[0]?.title).toBe("Over your total budget");
  });

  it("a refusal never harms an agreement that already exists", () => {
    const w = makeWorld();
    const { neg } = w.agreed();
    const bad = w.offer(neg.id, "seller_acme", { currency: "EUR" });
    const out = w.accept(neg.id, bad.id);
    expect(out.accepted).toBe(false);
    expect(out.negotiation.active).toMatchObject({ version: 1, status: "ACTIVE" });
    expect(w.cell("SELECT state FROM transactions")).toBe("AGREED");
  });
});

describe("expired offers", () => {
  it("accepting one after its validity is refused by the engine and recorded as expired", () => {
    const w = makeWorld();
    const neg = w.open({ timeoutMinutes: 600 });
    const o = w.offer(neg.id, "seller_acme", { validForMinutes: 30 });
    w.clock.advance(31);
    const out = w.accept(neg.id, o.id);
    expect(out.accepted).toBe(false);
    expect(out.policy.reasonCodes).toEqual(["OFFER_EXPIRED"]);
    expect(out.policy.items[0]).toMatchObject({
      title: "The offer has expired",
      next: "Ask the seller for a fresh offer.",
    });
    expect(w.cell("SELECT status FROM negotiation_proposals")).toBe("EXPIRED");
    expect(w.count("negotiation_agreements")).toBe(0);
  });

  it("is judged to the millisecond: valid up to the last instant, expired at the deadline", () => {
    const w = makeWorld();
    const cheap = w.priced(4000, 1, "GPU-MINI");
    const first = w.open({ timeoutMinutes: 600 });
    const a = w.offer(first.id, "seller_acme", { ...cheap, validForMinutes: 30 });
    w.clock.advanceMs(30 * 60_000 - 1);
    expect(w.accept(first.id, a.id).accepted).toBe(true);

    const second = w.open({ timeoutMinutes: 600 });
    const b = w.offer(second.id, "seller_acme", { ...cheap, validForMinutes: 30 });
    w.clock.advanceMs(30 * 60_000);
    const out = w.accept(second.id, b.id);
    expect(out.accepted).toBe(false);
    expect(out.policy.reasonCodes).toEqual(["OFFER_EXPIRED"]);
  });

  it("once a read has noticed the expiry, accepting is a conflict that says why", () => {
    const w = makeWorld();
    const neg = w.open({ timeoutMinutes: 600 });
    const o = w.offer(neg.id, "seller_acme", { validForMinutes: 10 });
    w.clock.advance(11);
    const seen = w.detail(neg.id).sellers[0]?.offers[0];
    expect(seen).toMatchObject({ status: "EXPIRED", statusText: "Expired", expired: true });
    expect(seen?.statusReason).toMatch(/Its validity ended at 2026-10-12T09:10:00.000Z/);
    expect(() => w.accept(neg.id, o.id)).toThrow(/no longer open \(expired/);
  });

  it("a fresh version from the seller can be accepted after the old one expired", () => {
    const w = makeWorld();
    const neg = w.open({ timeoutMinutes: 600 });
    w.offer(neg.id, "seller_acme", { validForMinutes: 10 });
    w.clock.advance(20);
    w.detail(neg.id);
    const v2 = w.offer(neg.id, "seller_acme");
    expect(v2.version).toBe(2);
    expect(w.accept(neg.id, v2.id).accepted).toBe(true);
  });
});

describe("substituting a payee", () => {
  it("is refused when the catalog payee changed between the offer and its acceptance", () => {
    const w = makeWorld();
    const neg = w.open();
    const o = w.offer(neg.id, "seller_acme", w.priced(4000, 1, "GPU-MINI"));
    // someone repoints the seller's catalog payee after the offer was recorded
    w.db.prepare("UPDATE sellers SET payee_ref = 'payee_attacker' WHERE id = 'seller_acme'").run();
    const out = w.accept(neg.id, o.id);
    expect(out.accepted).toBe(false);
    expect(out.policy.reasonCodes).toEqual(["PAYEE_MISMATCH"]);
    expect(out.policy.items[0]?.detail).toMatch(/can only ever come from the catalog/);
    expect(w.count("agreements")).toBe(0);
  });

  it("cannot be done by writing a different payee into a proposal row", () => {
    const w = makeWorld();
    const neg = w.open();
    const o = w.offer(neg.id);
    expect(() =>
      w.db
        .prepare("UPDATE negotiation_proposals SET payee_ref = 'payee_attacker' WHERE id = ?")
        .run(o.id),
    ).toThrow(/immutable/);
    expect(() =>
      w.db
        .prepare(
          `INSERT INTO negotiation_proposals (id, negotiation_id, seq, seller_id, kind, version, supersedes_id, status, currency, category, lines,
           shipping_minor, fees_minor, claimed_total_minor, total_minor, deliverables, delivery_days, deliver_by, terms_text, payee_ref,
           valid_until, terms_hash, changes, actor, created_at)
         SELECT 'forged', negotiation_id, 2, seller_id, kind, 2, id, 'OPEN', currency, category, lines, shipping_minor, fees_minor,
                claimed_total_minor, total_minor, deliverables, delivery_days, deliver_by, terms_text, 'payee_attacker', valid_until,
                terms_hash, changes, actor, created_at FROM negotiation_proposals WHERE id = ?`,
        )
        .run(o.id),
    ).toThrow(/catalog payee/);
  });

  it("switching to another seller after approval is a PAYEE change: the approval is invalidated", () => {
    const w = makeWorld();
    const { neg } = w.agreed();
    w.ok(w.svc.approve(OP, { negotiationId: neg.id }));
    const other = w.offer(neg.id, "seller_other", w.priced(7500));
    const out = w.accept(neg.id, other.id);
    expect(out.accepted).toBe(true);
    expect(out.retired).toMatchObject({ version: 1, status: "INVALIDATED" });
    expect(out.retired?.retired?.reason).toMatch(/payee changed/);
    expect(out.retired?.retired?.approvalWasValid).toBe(true);
    expect(out.negotiation.active).toMatchObject({ version: 2, sellerName: "Other Cloud" });
    expect(out.negotiation.active?.approval.state).toBe("REQUIRED");
    expect(
      w.cell("SELECT payee_ref FROM agreements ORDER BY created_at DESC, rowid DESC LIMIT 1"),
    ).toBe("payee_other");
  });

  it("an offer in one seller's name cannot be appended to another seller's chain", () => {
    const w = makeWorld();
    const neg = w.open();
    const a = w.offer(neg.id, "seller_acme");
    expect(() =>
      w.db
        .prepare(
          `INSERT INTO negotiation_proposals (id, negotiation_id, seq, seller_id, kind, version, supersedes_id, status, currency, category, lines,
           shipping_minor, fees_minor, claimed_total_minor, total_minor, deliverables, delivery_days, deliver_by, terms_text, payee_ref,
           valid_until, terms_hash, changes, actor, created_at)
         SELECT 'hijack', negotiation_id, 2, 'seller_other', kind, 2, id, 'OPEN', currency, category, lines, shipping_minor, fees_minor,
                claimed_total_minor, total_minor, deliverables, delivery_days, deliver_by, terms_text, 'payee_other', valid_until,
                terms_hash, changes, actor, created_at FROM negotiation_proposals WHERE id = ?`,
        )
        .run(a.id),
    ).toThrow(/previous version of this chain|supersedes_id/);
  });
});

describe("who may accept", () => {
  it("an agent may ASK for an acceptance, but the engine still decides: an out-of-policy one is refused", () => {
    const w = makeWorld();
    const neg = w.open();
    const bad = w.offer(neg.id, "seller_acme", w.priced(8000, 2));
    const refused = w.accept(neg.id, bad.id, AGENT);
    expect(refused.accepted).toBe(false);
    const good = w.offer(neg.id, "seller_acme", w.priced(4000, 1, "GPU-MINI"));
    expect(w.accept(neg.id, good.id, AGENT).accepted).toBe(true);
    // ... and an agreement made that way is still not approved
    expect(w.detail(neg.id).active?.approval.state).toBe("NOT_REQUIRED");
  });

  it("anonymous callers cannot", () => {
    const w = makeWorld();
    const neg = w.open();
    const o = w.offer(neg.id);
    expect(() => w.svc.accept(ANON, { negotiationId: neg.id, proposalId: o.id })).toThrow(
      ForbiddenError,
    );
    expect(w.count("negotiation_policy_checks")).toBe(0);
  });

  it("an offer cannot be taken to a different negotiation by id", () => {
    const w = makeWorld();
    const a = w.open();
    const b = w.open();
    const o = w.offer(a.id);
    expect(() => w.accept(b.id, o.id)).toThrow(/not found/);
  });

  it("accepting twice is a conflict, not a second agreement", () => {
    const w = makeWorld();
    const { neg, o } = w.agreed();
    expect(() => w.accept(neg.id, o.id)).toThrow(ConflictError);
    expect(w.count("negotiation_agreements")).toBe(1);
  });

  it("the system may also request acceptance", () => {
    const w = makeWorld();
    const neg = w.open();
    const o = w.offer(neg.id, "seller_acme", w.priced(4000, 1, "GPU-MINI"));
    expect(w.accept(neg.id, o.id, SYSTEM).accepted).toBe(true);
  });
});
