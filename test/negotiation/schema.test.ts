import { describe, expect, it } from "vitest";

import { makeWorld } from "./world";

/** Direct SQL: what the schema refuses even if application code were bypassed or buggy. */
function raw(w: ReturnType<typeof makeWorld>, sql: string, ...params: (string | number | null)[]) {
  return () => w.db.prepare(sql).run(...params);
}

describe("negotiations", () => {
  it("the request and its constraints are immutable; only the status moves", () => {
    const w = makeWorld();
    const n = w.open({ maxTotal: "70.00" });
    for (const [column, value] of [
      ["max_total_minor", 999_999],
      ["category", "STORAGE"],
      ["quantity", 50],
      ["summary", "changed"],
      ["currency", "EUR"],
      ["mandate_id", "M2"],
      ["expires_at", "2099-01-01T00:00:00.000Z"],
      ["invited_seller_ids", '["seller_other"]'],
      ["required_deliverables", "[]"],
    ] as const) {
      expect(
        raw(w, `UPDATE negotiations SET ${column} = ? WHERE id = ?`, value, n.id),
        column,
      ).toThrow(/immutable|illegal|version/);
    }
  });

  it("status moves follow the table; closed negotiations never reopen; a closure needs a reason", () => {
    const w = makeWorld();
    const n = w.open();
    const move = (to: string, version: number, reason: string | null = null) =>
      raw(
        w,
        "UPDATE negotiations SET status = ?, closed_reason = ?, version = ? WHERE id = ?",
        to,
        reason,
        version,
        n.id,
      );
    expect(move("OPEN", 2)).toThrow(/illegal/);
    expect(move("TIMED_OUT", 2)).toThrow(/needs a reason/);
    expect(move("TIMED_OUT", 5, "x")).toThrow(/version must grow by exactly 1/);
    expect(move("TIMED_OUT", 2, "deadline")).not.toThrow();
    expect(move("OPEN", 3)).toThrow(/illegal/);
    expect(move("AGREED", 3)).toThrow(/illegal/);
  });

  it("cannot be deleted, must start OPEN at version 1, and must reference real mandates and sellers", () => {
    const w = makeWorld();
    const n = w.open();
    expect(raw(w, "DELETE FROM negotiations WHERE id = ?", n.id)).toThrow(/cannot be deleted/);
    const insert = (over: Record<string, string | number | null>) => {
      const row = {
        id: "x",
        owner_id: "o",
        mandate_id: "M1",
        status: "OPEN",
        currency: "USD",
        category: "COMPUTE",
        quantity: 1,
        summary: "s",
        max_total_minor: null,
        needed_within_days: null,
        required_deliverables: "[]",
        invited_seller_ids: '["seller_acme"]',
        expires_at: "2026-10-13T00:00:00.000Z",
        closed_reason: null,
        version: 1,
        created_at: "2026-10-12T00:00:00.000Z",
        updated_at: "2026-10-12T00:00:00.000Z",
        ...over,
      };
      return raw(
        w,
        `INSERT INTO negotiations (${Object.keys(row).join(",")}) VALUES (${Object.keys(row)
          .map(() => "?")
          .join(",")})`,
        ...Object.values(row),
      );
    };
    expect(insert({})).not.toThrow();
    expect(insert({ id: "y", status: "AGREED" })).toThrow(/starts OPEN/);
    expect(insert({ id: "y", version: 2 })).toThrow(/starts OPEN/);
    expect(insert({ id: "y", mandate_id: "nope" })).toThrow(/mandate does not exist/);
    expect(insert({ id: "y", invited_seller_ids: '["seller_ghost"]' })).toThrow(
      /seller must exist/,
    );
    expect(insert({ id: "y", invited_seller_ids: "[]" })).toThrow();
    expect(insert({ id: "y", max_total_minor: 1.5 })).toThrow();
    expect(insert({ id: "y", currency: "usd" })).toThrow();
    expect(insert({ id: "y", expires_at: "2026-10-11T00:00:00.000Z" })).toThrow();
  });
});

describe("proposals", () => {
  const clone = (w: ReturnType<typeof makeWorld>, id: string, set: string) =>
    raw(
      w,
      `INSERT INTO negotiation_proposals (id, negotiation_id, seq, seller_id, kind, version, supersedes_id, responds_to_id, status, currency, category,
         lines, shipping_minor, fees_minor, claimed_total_minor, total_minor, deliverables, delivery_days, deliver_by, terms_text, payee_ref,
         valid_until, terms_hash, changes, actor, created_at)
       SELECT 'copy', negotiation_id, ${set} FROM (
         SELECT negotiation_id, seq + 1 AS seq, seller_id, kind, version + 1 AS version, id AS supersedes_id, responds_to_id, 'OPEN' AS status, currency, category,
                lines, shipping_minor, fees_minor, claimed_total_minor, total_minor, deliverables, delivery_days, deliver_by, terms_text, payee_ref,
                valid_until, terms_hash, changes, actor, created_at FROM negotiation_proposals WHERE id = ?)`,
      id,
    );
  const columns =
    "seq, seller_id, kind, version, supersedes_id, responds_to_id, status, currency, category, lines, shipping_minor, fees_minor, claimed_total_minor, total_minor, deliverables, delivery_days, deliver_by, terms_text, payee_ref, valid_until, terms_hash, changes, actor, created_at";

  it("a well-formed next version can be inserted (the control for the refusals below)", () => {
    const w = makeWorld();
    const n = w.open();
    const p = w.offer(n.id);
    expect(clone(w, p.id, columns)).not.toThrow();
    expect(w.count("negotiation_proposals")).toBe(2);
  });

  it("terms can never be edited, and a proposal can never be deleted", () => {
    const w = makeWorld();
    const n = w.open();
    const p = w.offer(n.id);
    for (const [column, value] of [
      ["total_minor", 1],
      ["currency", "EUR"],
      ["category", "STORAGE"],
      ["deliverables", '["x"]'],
      ["delivery_days", 1],
      ["payee_ref", "payee_attacker"],
      ["terms_hash", "0".repeat(64)],
      ["lines", "[]"],
      ["valid_until", "2099-01-01T00:00:00.000Z"],
      ["version", 7],
      ["seq", 9],
      ["changes", '["PRICE"]'],
      ["actor", "OPERATOR"],
    ] as const) {
      expect(
        raw(w, `UPDATE negotiation_proposals SET ${column} = ? WHERE id = ?`, value, p.id),
        column,
      ).toThrow(/immutable/);
    }
    expect(raw(w, "DELETE FROM negotiation_proposals WHERE id = ?", p.id)).toThrow(
      /cannot be deleted/,
    );
  });

  it("a status can leave OPEN exactly once, and only with a decision time", () => {
    const w = makeWorld();
    const n = w.open();
    const p = w.offer(n.id);
    expect(
      raw(w, "UPDATE negotiation_proposals SET status = 'REJECTED' WHERE id = ?", p.id),
    ).toThrow(); // no decided_at
    expect(
      raw(
        w,
        "UPDATE negotiation_proposals SET status = 'REJECTED', decided_at = '2026-10-12T09:01:00.000Z' WHERE id = ?",
        p.id,
      ),
    ).not.toThrow();
    expect(
      raw(
        w,
        "UPDATE negotiation_proposals SET status = 'OPEN', decided_at = NULL WHERE id = ?",
        p.id,
      ),
    ).toThrow(/OPEN to a final status/);
    expect(
      raw(
        w,
        "UPDATE negotiation_proposals SET status = 'ACCEPTED', decided_at = '2026-10-12T09:02:00.000Z' WHERE id = ?",
        p.id,
      ),
    ).toThrow(/OPEN to a final status/);
  });

  it("refuses skipped versions, skipped sequence numbers, wrong predecessors and foreign payees", () => {
    const w = makeWorld();
    const n = w.open();
    const p = w.offer(n.id);
    const bad = (col: string, value: string) => clone(w, p.id, columns.replace(col, `'${value}'`));
    expect(clone(w, p.id, columns.replace("version", "version + 1"))).toThrow(
      /version must be the previous version/,
    );
    expect(clone(w, p.id, columns.replace("seq", "seq + 5"))).toThrow(
      /seq must be the previous seq/,
    );
    expect(bad("supersedes_id", p.id + "x")).toThrow();
    expect(bad("payee_ref", "payee_attacker")).toThrow(/catalog payee/);
    expect(bad("seller_id", "seller_other")).toThrow(
      /previous version of this chain|supersedes_id/,
    );
  });

  it("an offer needs lines and a claimed total; a counter must have neither", () => {
    const w = makeWorld();
    const n = w.open();
    w.offer(n.id);
    const c = w.counter(n.id);
    expect(
      raw(w, "UPDATE negotiation_proposals SET lines = NULL WHERE kind = 'SELLER_OFFER'"),
    ).toThrow();
    expect(w.cell("SELECT lines FROM negotiation_proposals WHERE id = ?", c.id)).toBeNull();
    expect(
      w.cell("SELECT claimed_total_minor FROM negotiation_proposals WHERE id = ?", c.id),
    ).toBeNull();
    expect(
      w.cell("SELECT shipping_minor + fees_minor FROM negotiation_proposals WHERE id = ?", c.id),
    ).toBe(0);
  });

  it("only invited sellers can have proposals, and only while the negotiation is OPEN or AGREED", () => {
    const w = makeWorld();
    const n = w.open({ invitedSellerIds: ["seller_acme"] });
    const p = w.offer(n.id);
    expect(
      raw(
        w,
        "UPDATE negotiation_proposals SET status = 'WITHDRAWN', decided_at = '2026-10-12T09:03:00.000Z' WHERE id = ?",
        p.id,
      ),
    ).not.toThrow();
    w.svc.close({ kind: "OPERATOR", id: "op1" }, { negotiationId: n.id }, "CANCELLED");
    expect(clone(w, p.id, columns)).toThrow(/OPEN or AGREED/);
  });

  it("a counter-offer cannot be ACCEPTED", () => {
    const w = makeWorld();
    const n = w.open();
    w.offer(n.id);
    const c = w.counter(n.id);
    expect(
      raw(
        w,
        "UPDATE negotiation_proposals SET status = 'ACCEPTED', decided_at = '2026-10-12T09:03:00.000Z' WHERE id = ?",
        c.id,
      ),
    ).toThrow();
  });
});

describe("agreement versions", () => {
  it("at most one version is ACTIVE; a retired one can never come back", () => {
    const w = makeWorld();
    const { neg } = w.agreed();
    const link = w.cell<string>("SELECT id FROM negotiation_agreements");
    expect(
      raw(w, "UPDATE negotiation_agreements SET invalidated_reason = 'x' WHERE id = ?", link),
    ).toThrow(/immutable/);
    expect(raw(w, "DELETE FROM negotiation_agreements WHERE id = ?", link)).toThrow(
      /cannot be deleted/,
    );
    expect(
      raw(w, "UPDATE negotiation_agreements SET status = 'INVALIDATED' WHERE id = ?", link),
    ).toThrow(); // needs reason + time
    w.ok(w.svc.disapprove({ kind: "OPERATOR", id: "op1" }, { negotiationId: neg.id }));
    expect(
      raw(
        w,
        "UPDATE negotiation_agreements SET status = 'ACTIVE', invalidated_at = NULL WHERE id = ?",
        link,
      ),
    ).toThrow(/immutable/);
  });

  it("cannot be created from a proposal that was not accepted, or with a mismatched hash or transaction", () => {
    const w = makeWorld();
    const { neg, o } = w.agreed();
    const second = w.offer(neg.id, "seller_other", w.priced(7500));
    const insert = (proposal: string, hash: string, tx: string, ag: string, version: number) =>
      raw(
        w,
        `INSERT INTO negotiation_agreements (id, negotiation_id, version, proposal_id, proposal_hash, transaction_id, agreement_id, policy_decision_id, status, created_at)
         VALUES ('forged', ?, ?, ?, ?, ?, ?, (SELECT policy_decision_id FROM negotiation_agreements LIMIT 1), 'ACTIVE', '2026-10-12T09:05:00.000Z')`,
        neg.id,
        version,
        proposal,
        hash,
        tx,
        ag,
      );
    const tx = w.cell<string>("SELECT transaction_id FROM negotiation_agreements");
    const ag = w.cell<string>("SELECT agreement_id FROM negotiation_agreements");
    expect(insert(second.id, "0".repeat(64), tx, ag, 2)).toThrow(
      /ACCEPTED seller offer|UNIQUE|ACTIVE/,
    );
    expect(insert(o.id, "0".repeat(64), tx, ag, 3)).toThrow(
      /version must be the previous version \+ 1/,
    );
  });
});

describe("policy checks", () => {
  it("are append-only, and a verdict must agree with its reason codes", () => {
    const w = makeWorld();
    const { neg } = w.agreed();
    const id = w.cell<string>("SELECT id FROM negotiation_policy_checks");
    expect(
      raw(w, "UPDATE negotiation_policy_checks SET verdict = 'DENY' WHERE id = ?", id),
    ).toThrow(/immutable/);
    expect(raw(w, "DELETE FROM negotiation_policy_checks WHERE id = ?", id)).toThrow(/immutable/);
    const insert = (verdict: string, codes: string) =>
      raw(
        w,
        `INSERT INTO negotiation_policy_checks (id, negotiation_id, proposal_id, subject, verdict, reason_codes, explanation, policy_version, inputs_hash, actor, decided_at)
         VALUES ('c' || abs(random()), ?, (SELECT id FROM negotiation_proposals LIMIT 1), 'ACCEPT_OFFER', ?, ?, 'x', 'v', ?, 'SYSTEM', '2026-10-12T09:05:00.000Z')`,
        neg.id,
        verdict,
        codes,
        "a".repeat(64),
      );
    expect(insert("ALLOW", '["OVER_PER_TX_CAP"]')).toThrow();
    expect(insert("DENY", "[]")).toThrow();
    expect(insert("DENY", '["OVER_PER_TX_CAP"]')).not.toThrow();
  });
});
