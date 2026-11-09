/* eslint-disable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-explicit-any -- the journey inspects untyped API JSON */
import { writeFileSync } from "node:fs";

import { afterEach, describe, expect, it, vi } from "vitest";

import { verifyChain } from "@/adapters/sqlite/audit";
import { openDatabase } from "@/adapters/sqlite/database";
import { POST as eligibility } from "@/app/api/negotiations/[id]/eligibility/route";
import { POST as postOffer } from "@/app/api/negotiations/[id]/offers/route";
import { POST as authorizePayment } from "@/app/api/negotiations/[id]/payment/authorize/route";
import { POST as capturePayment } from "@/app/api/negotiations/[id]/payment/capture/route";
import { GET as getPayment, POST as startPayment } from "@/app/api/negotiations/[id]/payment/route";
import { POST as acceptProposal } from "@/app/api/negotiations/[id]/proposals/[pid]/accept/route";
import { POST as openNegotiation } from "@/app/api/negotiations/route";
import { GET as paypalReturn } from "@/app/api/paypal/return/route";
import { POST as paypalWebhook } from "@/app/api/webhooks/paypal/route";
import { loginThrottle } from "@/server/operator-guard";

import { bodyOf, boot, CONFIGURED, idCtx, request, signIn } from "../payments/api-harness";
import { createHttpPayPal, TEST_WEBHOOK_ID, TEST_WEBHOOK_SIG } from "../payments/http-paypal";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  loginThrottle.reset();
});

/**
 * The first end-to-end transaction, as far as it can be run without PayPal: the real routes, services, policy engine,
 * SQLite database, PayPal client and webhook verifier run together against an in-process FAKE PayPal. Nothing here talks
 * to the real PayPal sandbox. docs/END_TO_END_TEST.md records this sequence and its actual outcome, and separately what
 * a live sandbox run still has to confirm. Set E2E_TRANSCRIPT=<file> to write the transcript of a run.
 */

const offerBody = (unit: number) => ({
  sellerId: "seller_acme",
  offer: {
    currency: "USD",
    lines: [{ sku: "GPU-PACK", qty: 1, unitPriceMinor: unit }],
    shippingMinor: 0,
    feesMinor: 0,
    claimedTotalMinor: unit,
    category: "COMPUTE",
    deliveryDays: 3,
    deliverables: ["80 GPU-hours"],
    termsText: "Fixed price.",
    validForMinutes: 30,
  },
});

function hookRequest(raw: string, sig: string = TEST_WEBHOOK_SIG): Request {
  return new Request("http://localhost:3000/api/webhooks/paypal", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "paypal-transmission-id": `tr-${Math.random().toString(36).slice(2, 10)}`,
      "paypal-transmission-time": new Date().toISOString(),
      "paypal-cert-url": "https://api.sandbox.paypal.com/v1/notifications/certs/CERT-TEST",
      "paypal-transmission-sig": sig,
      "paypal-auth-algo": "SHA256withRSA",
    },
    body: raw,
  });
}

const pidCtx = (id: string, pid: string) => ({ params: Promise.resolve({ id, pid }) });

describe("first end-to-end transaction (fake PayPal)", () => {
  it("offer → policy → order → approval → hold → capture, with webhooks, duplicates and history", async () => {
    const db = boot({ ...CONFIGURED, PAYPAL_WEBHOOK_ID: TEST_WEBHOOK_ID });
    const http = createHttpPayPal();
    vi.stubGlobal("fetch", http.fetch);
    const steps: string[] = [];
    const log = (line: string) => steps.push(line);
    const s = await signIn();
    log("operator signs in (session cookie + CSRF token)");

    // 1. negotiation and offers: policy evaluation
    const neg = (
      await bodyOf(
        await openNegotiation(
          request("POST", "/api/negotiations", {
            s,
            body: {
              mandateId: "M1",
              category: "COMPUTE",
              quantity: 1,
              summary: "One GPU pack",
              maxTotal: null,
              neededWithinDays: null,
              requiredDeliverables: [],
              invitedSellerIds: ["seller_acme"],
              timeoutMinutes: 60,
            },
          }),
        ),
      )
    ).negotiation;
    log(`negotiation opened: ${neg.id}`);

    const expensive = (
      await bodyOf(
        await postOffer(request("POST", "/x", { s, body: offerBody(12_000) }), idCtx(neg.id)),
      )
    ).proposal;
    const refused = await bodyOf(
      await acceptProposal(request("POST", "/x", { s, body: {} }), pidCtx(neg.id, expensive.id)),
    );
    expect(refused.outcome.accepted).toBe(false);
    log(
      `offer 120.00 USD refused by the policy engine: ${refused.outcome.policy.reasonCodes.join(", ")}`,
    );

    const fair = (
      await bodyOf(
        await postOffer(request("POST", "/x", { s, body: offerBody(8_000) }), idCtx(neg.id)),
      )
    ).proposal;
    const accepted = await bodyOf(
      await acceptProposal(request("POST", "/x", { s, body: {} }), pidCtx(neg.id, fair.id)),
    );
    expect(accepted.outcome.accepted).toBe(true);
    log(`offer 80.00 USD accepted: policy ${accepted.outcome.policy.verdict}`);

    const elig = await eligibility(request("POST", "/x", { s, body: {} }), idCtx(neg.id));
    expect(elig.status).toBe(200);
    log("eligibility check for payment: HTTP 200");

    // 2. order
    const started = await bodyOf(
      await startPayment(request("POST", "/x", { s, body: {} }), idCtx(neg.id)),
    );
    expect(started.payment.state).toBe("ORDER_CREATED");
    const orderId = started.payment.paypalOrderId as string;
    log(
      `PayPal order created and read back: ${orderId}, state ORDER_CREATED, amount ${started.payment.amountText}`,
    );

    // 3. the browser comes back claiming success: not evidence
    await paypalReturn(
      request("GET", `/api/paypal/return?token=${orderId}&success=true&status=APPROVED`, { s }),
    );
    expect(db.state(neg.id)).toBe("ORDER_CREATED");
    log("browser redirect claiming success: the server asked PayPal; state stays ORDER_CREATED");

    // 4. the buyer approves at PayPal; a forged webhook is refused; the genuine one is applied after a read
    http.approve(orderId);
    const approvedRaw = JSON.stringify({
      id: "WH-EVT-1",
      event_type: "CHECKOUT.ORDER.APPROVED",
      resource_type: "checkout-order",
      resource: { id: orderId },
    });
    const forged = await paypalWebhook(hookRequest(approvedRaw, "FORGED"));
    expect(forged.status).toBe(401);
    expect(db.state(neg.id)).toBe("ORDER_CREATED");
    log("webhook with an invalid signature: HTTP 401, state unchanged");
    const genuine = await paypalWebhook(hookRequest(approvedRaw));
    expect(await bodyOf(genuine)).toEqual({ status: "PROCESSED", reason: "APPLIED" });
    expect(db.state(neg.id)).toBe("ORDER_APPROVED");
    log(
      "verified CHECKOUT.ORDER.APPROVED webhook: PROCESSED/APPLIED, state ORDER_APPROVED (the server read the order first)",
    );

    // 5. hold
    const held = await bodyOf(
      await authorizePayment(request("POST", "/x", { s, body: {} }), idCtx(neg.id)),
    );
    expect(held.payment).toMatchObject({ state: "AUTHORIZED", moneyMoved: false });
    log("authorized: funds on hold, moneyMoved=false");
    const authId = [...http.orders.values()][0]?.authorization?.id as string;
    const authRaw = JSON.stringify({
      id: "WH-EVT-2",
      event_type: "PAYMENT.AUTHORIZATION.CREATED",
      resource: { id: authId, supplementary_data: { related_ids: { order_id: orderId } } },
    });
    expect(await bodyOf(await paypalWebhook(hookRequest(authRaw)))).toEqual({
      status: "PROCESSED",
      reason: "CONSISTENT",
    });
    log("verified PAYMENT.AUTHORIZATION.CREATED webhook: PROCESSED/CONSISTENT");

    // 6. capture
    const captured = await bodyOf(
      await capturePayment(request("POST", "/x", { s, body: {} }), idCtx(neg.id)),
    );
    expect(captured.payment).toMatchObject({ state: "CAPTURED", moneyMoved: true });
    log(`captured: ${captured.payment.capture.amountText}, moneyMoved=true`);
    const capId = [...http.orders.values()][0]?.captures[0]?.id as string;
    const capRaw = JSON.stringify({
      id: "WH-EVT-3",
      event_type: "PAYMENT.CAPTURE.COMPLETED",
      resource: { id: capId, supplementary_data: { related_ids: { order_id: orderId } } },
    });
    expect(await bodyOf(await paypalWebhook(hookRequest(capRaw)))).toEqual({
      status: "PROCESSED",
      reason: "CONSISTENT",
    });
    expect(await bodyOf(await paypalWebhook(hookRequest(capRaw)))).toEqual({
      status: "DUPLICATE",
      reason: "CONSISTENT",
    });
    log(
      "verified PAYMENT.CAPTURE.COMPLETED webhook: PROCESSED/CONSISTENT; the same delivery again: DUPLICATE (no second read)",
    );
    expect(http.apiCalls().filter((r) => r.path.endsWith("/capture"))).toHaveLength(1);

    // 7. history and integrity
    const view = (await bodyOf(await getPayment(request("GET", "/x", { s }), idCtx(neg.id))))
      .payment;
    expect(view.state).toBe("CAPTURED");
    log("transaction history (from the audit trail):");
    for (const e of view.history)
      log(`  #${e.seq} ${e.actor} · ${e.title}${e.detail ? ` (${e.detail})` : ""}`);
    const d = openDatabase(db.path, { readOnly: true });
    try {
      expect(verifyChain(d).status).toBe("VERIFIED");
      const row = d
        .prepare(
          "SELECT authorized_minor, captured_minor FROM transactions WHERE state = 'CAPTURED'",
        )
        .get() as any;
      expect(row).toMatchObject({ authorized_minor: 8000, captured_minor: 8000 });
      const hooks = d
        .prepare(
          "SELECT paypal_event_id AS id, event_type AS type, status, reason, deliveries FROM webhook_events ORDER BY received_at, rowid",
        )
        .all();
      log(`webhook_events rows: ${JSON.stringify(hooks)}`);
    } finally {
      d.close();
    }
    log(
      "audit hash chain: VERIFIED (local tamper evidence only, not proof of PayPal's authenticity)",
    );

    if (process.env.E2E_TRANSCRIPT)
      writeFileSync(process.env.E2E_TRANSCRIPT, steps.join("\n") + "\n", "utf8");
  });
});
