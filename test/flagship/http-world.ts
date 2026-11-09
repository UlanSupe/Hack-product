/* eslint-disable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-argument -- reads untyped API JSON */
import { openDatabase } from "@/adapters/sqlite/database";
import { POST as approveAgreement } from "@/app/api/negotiations/[id]/approve/route";
import { POST as postOffer } from "@/app/api/negotiations/[id]/offers/route";
import { POST as acceptProposal } from "@/app/api/negotiations/[id]/proposals/[pid]/accept/route";
import { POST as openNegotiation } from "@/app/api/negotiations/route";
import {
  FLAGSHIP_MANDATE,
  FLAGSHIP_SELLER,
  FLAGSHIP_SKU,
  seedFlagshipWorld,
} from "@/server/flagship";

import { bodyOf, boot, CONFIGURED, idCtx, request, type Session } from "../payments/api-harness";

/** The seeded development database, plus the flagship seller, catalog and $30 design mandate. */
export function bootFlagship(env: Record<string, string> | null = CONFIGURED) {
  const b = boot(env);
  const db = openDatabase(b.path);
  try {
    seedFlagshipWorld(db, "2026-01-01T00:00:00.000Z");
  } finally {
    db.close();
  }
  return b;
}

export const offerBody = (
  unitPriceMinor: number,
  over: Record<string, unknown> = {},
  top: Record<string, unknown> = {},
) => ({
  sellerId: FLAGSHIP_SELLER.id,
  offer: {
    currency: "USD",
    lines: [{ sku: FLAGSHIP_SKU, qty: 1, unitPriceMinor }],
    shippingMinor: 0,
    feesMinor: 0,
    claimedTotalMinor: unitPriceMinor,
    category: "DESIGN",
    deliveryDays: 3,
    deliverables: ["Logo (SVG and PNG)", "One-page brand sheet"],
    termsText: "Fixed price.",
    validForMinutes: 60,
    ...over,
  },
  ...top,
});

export async function openFlagshipNegotiation(s: Session): Promise<string> {
  const res = await openNegotiation(
    request("POST", "/api/negotiations", {
      s,
      body: {
        mandateId: FLAGSHIP_MANDATE.id,
        category: "DESIGN",
        quantity: 1,
        summary: "A logo and a one-page brand sheet",
        maxTotal: null,
        neededWithinDays: 7,
        requiredDeliverables: [],
        invitedSellerIds: [FLAGSHIP_SELLER.id],
        timeoutMinutes: 240,
      },
    }),
  );
  return (await bodyOf(res)).negotiation.id as string;
}

export async function submit(s: Session, negotiationId: string, body: unknown) {
  const res = await postOffer(request("POST", "/x", { s, body }), idCtx(negotiationId));
  return { res, json: await bodyOf(res.clone()) };
}

export async function accept(
  s: Session,
  negotiationId: string,
  proposalId: string,
  body: unknown = {},
) {
  const res = await acceptProposal(request("POST", "/x", { s, body }), {
    params: Promise.resolve({ id: negotiationId, pid: proposalId }),
  });
  return { res, json: await bodyOf(res.clone()) };
}

export async function approve(s: Session, negotiationId: string, body: unknown = {}) {
  const res = await approveAgreement(request("POST", "/x", { s, body }), idCtx(negotiationId));
  return { res, json: await bodyOf(res.clone()) };
}

/** Open, receive the $24.00 offer and accept it: agreement v1. */
export async function agreeAt24(s: Session) {
  const id = await openFlagshipNegotiation(s);
  const offer = await submit(s, id, offerBody(2_400));
  const out = await accept(s, id, offer.json.proposal.id);
  if (!out.json.outcome.accepted) throw new Error("the $24.00 offer was not accepted");
  return { id, proposalId: offer.json.proposal.id as string };
}
