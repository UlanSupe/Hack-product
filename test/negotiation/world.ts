import { expect } from "vitest";

import type { Db } from "@/adapters/sqlite/database";
import { createSqliteNegotiationStore } from "@/adapters/sqlite/negotiation-store";
import {
  createSeller,
  insertMandateVersion,
  upsertCatalogItem,
  type MandateInput,
} from "@/adapters/sqlite/store";
import { createNegotiationDemo } from "@/application/negotiation-demo";
import { createNegotiationService, type NegotiationService } from "@/application/negotiations";
import type { NegotiationDetail, ProposalView } from "@/application/negotiation-views";
import type { NegotiationActor } from "@/domain/negotiation";
import type { ServiceCategory } from "@/domain/mandate";

import { freshDb } from "../persistence/helpers";

export const BASE = "2026-10-12T09:00:00.000Z";

export const OP: NegotiationActor = { kind: "OPERATOR", id: "op1" };
export const AGENT: NegotiationActor = { kind: "AGENT", id: "agent1" };
export const SYSTEM: NegotiationActor = { kind: "SYSTEM", id: "sys1" };
export const ANON: NegotiationActor = { kind: "ANONYMOUS" };

export type World = ReturnType<typeof makeWorld>;

/**
 * A synthetic world: three sellers, a small catalog, mandate M1 (cap 100.00, budget 150.00, approval above 50.00,
 * allowed sellers acme + other), a controllable clock and sequential ids.
 */
export function makeWorld(
  opts: {
    categories?: ServiceCategory[];
    threshold?: number;
    review?: boolean;
    budget?: number;
    cap?: number;
  } = {},
) {
  const db: Db = freshDb();
  let t = Date.parse(BASE);
  let n = 0;
  const clock = {
    now: () => new Date(t),
    iso: () => new Date(t).toISOString(),
    advance: (minutes: number) => {
      t += Math.round(minutes * 60_000);
    },
    advanceMs: (ms: number) => {
      t += ms;
    },
    set: (iso: string) => {
      t = Date.parse(iso);
    },
  };

  const seed = "2026-01-01T00:00:00.000Z";
  createSeller(db, {
    id: "seller_acme",
    displayName: "Acme Compute",
    payeeRef: "payee_acme",
    now: seed,
  });
  createSeller(db, {
    id: "seller_other",
    displayName: "Other Cloud",
    payeeRef: "payee_other",
    now: seed,
  });
  createSeller(db, {
    id: "seller_blocked",
    displayName: "Blocked Reseller",
    payeeRef: "payee_blocked",
    now: seed,
  });
  for (const [seller, sku, price, category] of [
    ["seller_acme", "GPU-PACK", 8000, "COMPUTE"],
    ["seller_acme", "GPU-MINI", 4000, "COMPUTE"],
    ["seller_acme", "GPU-PACK-S", 6000, "COMPUTE"],
    ["seller_acme", "STORE-100", 2000, "STORAGE"],
    ["seller_other", "GPU-PACK", 7500, "COMPUTE"],
    ["seller_blocked", "GPU-PACK", 5000, "COMPUTE"],
  ] as const) {
    upsertCatalogItem(db, {
      sellerId: seller,
      sku,
      unitPriceMinor: price,
      currency: "USD",
      category,
    });
  }
  const mandate: MandateInput = {
    id: "M1",
    ownerId: "op1",
    perTxCapMinor: opts.cap ?? 10_000,
    totalBudgetMinor: opts.budget ?? 15_000,
    approvalThresholdMinor: opts.threshold ?? 5000,
    requireReview: opts.review ?? false,
    currency: "USD",
    allowedCategories: opts.categories ?? ["COMPUTE"],
    allowedSellerIds: ["seller_acme", "seller_other"],
    expiresAt: "2027-06-01T00:00:00.000Z",
    status: "ACTIVE",
    now: seed,
  };
  insertMandateVersion(db, mandate);

  const store = createSqliteNegotiationStore(db);
  const svc: NegotiationService = createNegotiationService({
    store,
    now: clock.now,
    newId: (prefix) => `${prefix}_${++n}`,
  });

  const demo = createNegotiationDemo({ service: svc, store });

  const cell = <T = unknown>(sql: string, ...params: (string | number | null)[]): T => {
    const row = db.prepare(sql).get(...params) as Record<string, T> | undefined;
    return row ? (Object.values(row)[0] as T) : (undefined as T);
  };
  const count = (table: string, where = "1=1") =>
    cell<number>(`SELECT COUNT(*) FROM ${table} WHERE ${where}`);

  const ok = <T>(
    r: { ok: true; value: T } | { ok: false; errors: { field: string; message: string }[] },
  ): T => {
    if (!r.ok) throw new Error(`expected ok, got ${JSON.stringify(r.errors)}`);
    return r.value;
  };

  /** Opens a negotiation with sensible defaults. */
  const open = (over: Record<string, unknown> = {}): NegotiationDetail =>
    ok(
      svc.open(OP, {
        mandateId: "M1",
        category: "COMPUTE",
        quantity: 1,
        summary: "One GPU pack for model training",
        maxTotal: null,
        neededWithinDays: null,
        requiredDeliverables: [],
        invitedSellerIds: ["seller_acme", "seller_other"],
        timeoutMinutes: 120,
        ...over,
      }),
    );

  /** Raw offer input for a seller; override any part of the `offer` object with `over`. */
  const offerInput = (
    negotiationId: string,
    sellerId: string,
    over: Record<string, unknown> = {},
    top: Record<string, unknown> = {},
  ) => ({
    negotiationId,
    sellerId,
    offer: {
      currency: "USD",
      lines: [{ sku: "GPU-PACK", qty: 1, unitPriceMinor: 8000 }],
      shippingMinor: 0,
      feesMinor: 0,
      claimedTotalMinor: 8000,
      category: "COMPUTE",
      deliveryDays: 3,
      deliverables: ["80 GPU-hours", "Usage report"],
      termsText: "Fixed price.",
      validForMinutes: 60,
      ...over,
    },
    ...top,
  });
  const offer = (
    negotiationId: string,
    sellerId = "seller_acme",
    over: Record<string, unknown> = {},
    top: Record<string, unknown> = {},
  ): ProposalView => ok(svc.submitOffer(AGENT, offerInput(negotiationId, sellerId, over, top)));

  /** An offer for a different price, with lines and claimed total kept consistent. */
  const priced = (unit: number, qty = 1, sku = "GPU-PACK") => ({
    lines: [{ sku, qty, unitPriceMinor: unit }],
    claimedTotalMinor: unit * qty,
  });

  const counter = (
    negotiationId: string,
    sellerId = "seller_acme",
    over: Record<string, unknown> = {},
  ) =>
    ok(
      svc.submitCounter(AGENT, {
        negotiationId,
        sellerId,
        currency: "USD",
        category: "COMPUTE",
        targetTotalMinor: 7000,
        deliverables: ["80 GPU-hours", "Usage report"],
        deliveryDays: 3,
        note: "Can you do this price?",
        validForMinutes: 60,
        ...over,
      }),
    );

  const accept = (negotiationId: string, proposalId: string, actor: NegotiationActor = OP) =>
    ok(svc.accept(actor, { negotiationId, proposalId }));
  const detail = (id: string) => svc.detail(OP, id);

  /** Open → offer → accept, returning the pieces. */
  const agreed = (over: { unit?: number; seller?: string; sku?: string } = {}) => {
    const neg = open();
    const o = offer(
      neg.id,
      over.seller ?? "seller_acme",
      priced(over.unit ?? 8000, 1, over.sku ?? "GPU-PACK"),
    );
    const outcome = accept(neg.id, o.id);
    expect(outcome.accepted, JSON.stringify(outcome.policy.reasonCodes)).toBe(true);
    return { neg, o, outcome };
  };

  return {
    db,
    svc,
    demo,
    store,
    clock,
    cell,
    count,
    ok,
    open,
    offer,
    offerInput,
    priced,
    counter,
    accept,
    detail,
    agreed,
  };
}
