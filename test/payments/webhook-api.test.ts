/* eslint-disable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-return, @typescript-eslint/no-unsafe-call -- these tests inspect untyped API JSON structurally */
import { afterEach, describe, expect, it, vi } from "vitest";

import { POST as authorizePayment } from "@/app/api/negotiations/[id]/payment/authorize/route";
import { POST as capturePayment } from "@/app/api/negotiations/[id]/payment/capture/route";
import { GET as getPayment, POST as startPayment } from "@/app/api/negotiations/[id]/payment/route";
import { POST as refreshPayment } from "@/app/api/negotiations/[id]/payment/refresh/route";
import { POST as paypalWebhook } from "@/app/api/webhooks/paypal/route";
import { loginThrottle } from "@/server/operator-guard";

import {
  agree,
  bodyOf,
  boot,
  CONFIGURED,
  idCtx,
  request,
  signIn,
  type Session,
} from "./api-harness";
import {
  createHttpPayPal,
  TEST_CLIENT_SECRET,
  TEST_TOKEN,
  TEST_WEBHOOK_ID,
  TEST_WEBHOOK_SIG,
} from "./http-paypal";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  loginThrottle.reset();
});

const WITH_WEBHOOK = { ...CONFIGURED, PAYPAL_WEBHOOK_ID: TEST_WEBHOOK_ID };

const post = (route: typeof startPayment, s: Session, id: string) =>
  route(request("POST", "/x", { s, body: {} }), idCtx(id));

function hook(
  rawBody: string,
  over: Record<string, string | null> = {},
  extra: { contentLength?: number } = {},
): Request {
  const headers: Record<string, string> = {
    "content-type": "application/json",
    "paypal-transmission-id": `tr-${Math.random().toString(36).slice(2, 10)}`,
    "paypal-transmission-time": new Date().toISOString(),
    "paypal-cert-url": "https://api.sandbox.paypal.com/v1/notifications/certs/CERT-TEST",
    "paypal-transmission-sig": TEST_WEBHOOK_SIG,
    "paypal-auth-algo": "SHA256withRSA",
  };
  for (const [k, v] of Object.entries(over)) {
    if (v === null) delete headers[k];
    else headers[k] = v;
  }
  if (extra.contentLength !== undefined) headers["content-length"] = String(extra.contentLength);
  return new Request("http://localhost:3000/api/webhooks/paypal", {
    method: "POST",
    headers,
    body: rawBody,
  });
}
const approvedEvent = (id: string, orderId: string) =>
  JSON.stringify({
    id,
    event_type: "CHECKOUT.ORDER.APPROVED",
    resource_type: "checkout-order",
    resource: { id: orderId, status: "APPROVED" },
  });
const captureEvent = (
  id: string,
  orderId: string,
  capId: string,
  type = "PAYMENT.CAPTURE.COMPLETED",
) =>
  JSON.stringify({
    id,
    event_type: type,
    resource_type: "capture",
    resource: { id: capId, supplementary_data: { related_ids: { order_id: orderId } } },
  });
const verifyCalls = (http: ReturnType<typeof createHttpPayPal>) =>
  http.apiCalls().filter((r) => r.path === "/v1/notifications/verify-webhook-signature");
const readsOf = (http: ReturnType<typeof createHttpPayPal>) =>
  http.apiCalls().filter((r) => r.method === "GET" && r.path.startsWith("/v2/checkout/orders/"));

async function started() {
  const db = boot(WITH_WEBHOOK);
  const http = createHttpPayPal();
  vi.stubGlobal("fetch", http.fetch);
  const s = await signIn();
  const id = await agree(s);
  const j = await bodyOf(await post(startPayment, s, id));
  const orderId = j.payment.paypalOrderId as string;
  return { db, http, s, id, orderId };
}

describe("the webhook endpoint over HTTP, with PayPal's verification service as the only judge", () => {
  it("not configured: 503, and PayPal is not contacted at all", async () => {
    boot(CONFIGURED); // credentials but no webhook id
    const http = createHttpPayPal();
    vi.stubGlobal("fetch", http.fetch);
    const res = await paypalWebhook(hook(approvedEvent("evt_1", "ORDER1")));
    expect(res.status).toBe(503);
    expect(await bodyOf(res)).toEqual({
      status: "NOT_CONFIGURED",
      reason: "WEBHOOK_NOT_CONFIGURED",
    });
    expect(http.log).toHaveLength(0);
  });

  it("a verified approval is applied after the server reads the order; the raw event reaches PayPal untouched; no cookie is needed", async () => {
    const { db, http, id, orderId } = await started();
    http.approve(orderId);
    // key order, spacing and an escaped character the way a sender might produce them
    const raw = `{ "id":"evt_1",\n "event_type" : "CHECKOUT.ORDER.APPROVED","resource_type":"checkout-order","resource":{"id":"${orderId}","note":"caf\\u00e9"} }`;
    const res = await paypalWebhook(hook(raw));
    expect(res.status).toBe(200);
    expect(await bodyOf(res)).toEqual({ status: "PROCESSED", reason: "APPLIED" });
    expect(db.state(id)).toBe("ORDER_APPROVED");

    const v = verifyCalls(http);
    expect(v).toHaveLength(1);
    expect(v[0]?.rawBody).toContain(`"webhook_event":${raw}}`);
    expect(v[0]?.json).toMatchObject({
      webhook_id: TEST_WEBHOOK_ID,
      transmission_sig: TEST_WEBHOOK_SIG,
      auth_algo: "SHA256withRSA",
    });
    expect(v[0]?.headers.authorization).toBe(`Bearer ${TEST_TOKEN}`);
    // the order was read AFTER the signature was verified (the read the event triggered)
    const calls = http.apiCalls();
    const verifyAt = calls.findIndex(
      (r) => r.path === "/v1/notifications/verify-webhook-signature",
    );
    const lastRead = calls
      .map((r, i) => (r.method === "GET" && r.path.startsWith("/v2/checkout/orders/") ? i : -1))
      .reduce((m, i) => Math.max(m, i), -1);
    expect(lastRead).toBeGreaterThan(verifyAt);
  });

  it("an invalid signature is a 401: the order is never read and nothing changes", async () => {
    const { db, http, id, orderId } = await started();
    http.approve(orderId);
    const reads = readsOf(http).length;
    const res = await paypalWebhook(
      hook(approvedEvent("evt_1", orderId), { "paypal-transmission-sig": "FORGED-SIGNATURE" }),
    );
    expect(res.status).toBe(401);
    expect(await bodyOf(res)).toEqual({ status: "REJECTED", reason: "INVALID_SIGNATURE" });
    expect(readsOf(http)).toHaveLength(reads);
    expect(db.state(id)).toBe("ORDER_CREATED");
    expect(db.read<number>("SELECT COUNT(*) FROM webhook_events")).toBe(0);
  });

  it("a body that was altered after signing (verification answers FAILURE) is refused the same way", async () => {
    const { http, orderId } = await started();
    http.approve(orderId);
    // this fake only accepts a body whose event is an object and whose signature matches; a wrong webhook id also fails
    vi.stubEnv("PAYPAL_WEBHOOK_ID", "WH-SOMEONE-ELSE");
    const res = await paypalWebhook(hook(approvedEvent("evt_1", orderId)));
    expect(res.status).toBe(401);
  });

  it("PayPal's verification service failing is a 503 retry: nothing stored, nothing trusted", async () => {
    const { db, http, orderId } = await started();
    http.approve(orderId);
    http.behaviour.verifyHttpStatus = 500;
    const res = await paypalWebhook(hook(approvedEvent("evt_1", orderId)));
    expect(res.status).toBe(503);
    expect(await bodyOf(res)).toEqual({ status: "RETRY", reason: "VERIFICATION_UNAVAILABLE" });
    expect(db.read<number>("SELECT COUNT(*) FROM webhook_events")).toBe(0);
    http.behaviour.verifyHttpStatus = null;
    expect((await paypalWebhook(hook(approvedEvent("evt_1", orderId)))).status).toBe(200);
  });

  it("an oversized body is a 413 before it is read or verified", async () => {
    const { http } = await started();
    const calls = http.apiCalls().length;
    const res = await paypalWebhook(hook("{}", {}, { contentLength: 10 * 1024 * 1024 }));
    expect(res.status).toBe(413);
    expect(http.apiCalls()).toHaveLength(calls);
  });

  it("a duplicate delivery is a 200 no-op that does not read PayPal again", async () => {
    const { http, orderId, db } = await started();
    http.approve(orderId);
    await paypalWebhook(hook(approvedEvent("evt_1", orderId)));
    const reads = readsOf(http).length;
    const again = await paypalWebhook(hook(approvedEvent("evt_1", orderId)));
    expect(again.status).toBe(200);
    expect(await bodyOf(again)).toEqual({ status: "DUPLICATE", reason: "APPLIED" });
    expect(readsOf(http)).toHaveLength(reads);
    expect(db.read<number>("SELECT deliveries FROM webhook_events")).toBe(2);
  });

  it("retry after a processing failure: PayPal unreadable → 503; the redelivery succeeds", async () => {
    const { http, orderId, db, id } = await started();
    http.approve(orderId);
    // verification works, but the order read fails once: make only the order GET fail
    const realFetch = http.fetch;
    let failOnce = true;
    vi.stubGlobal("fetch", (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (failOnce && (init?.method ?? "GET") === "GET" && url.includes("/v2/checkout/orders/")) {
        failOnce = false;
        return Promise.reject(new Error("socket hang up"));
      }
      return realFetch(input, init);
    });
    const first = await paypalWebhook(hook(approvedEvent("evt_1", orderId)));
    expect(first.status).toBe(503);
    expect((await bodyOf(first)).reason).toBe("READ_FAILED");
    expect(db.state(id)).toBe("ORDER_CREATED");
    const second = await paypalWebhook(hook(approvedEvent("evt_1", orderId)));
    expect(second.status).toBe(200);
    expect(db.state(id)).toBe("ORDER_APPROVED");
    expect(db.read<number>("SELECT attempts FROM webhook_events")).toBe(2);
  });

  it("an unsigned success redirect is not payment confirmation; the signed webhook plus a read is", async () => {
    const { db, http, s, id, orderId } = await started();
    // the buyer's browser claims success; PayPal has not approved anything
    const forged = await paypalWebhook(
      hook(approvedEvent("evt_forged", orderId), { "paypal-transmission-sig": "NOT-SIGNED" }),
    );
    expect(forged.status).toBe(401);
    expect(db.state(id)).toBe("ORDER_CREATED");
    http.approve(orderId);
    await paypalWebhook(hook(approvedEvent("evt_1", orderId)));
    expect(db.state(id)).toBe("ORDER_APPROVED");
    const authorized = await bodyOf(await post(authorizePayment, s, id));
    expect(authorized.payment.state).toBe("AUTHORIZED");
  });

  it("the whole journey, with webhooks settling a lost capture response; no response ever carries a credential", async () => {
    const { db, http, s, id, orderId } = await started();
    const texts: string[] = [];
    const take = async (res: Response) => {
      const t = await res.clone().text();
      texts.push(t);
      return JSON.parse(t) as Record<string, any>;
    };
    http.approve(orderId);
    texts.push(await (await paypalWebhook(hook(approvedEvent("evt_1", orderId)))).text());
    await take(await post(authorizePayment, s, id));
    expect(db.state(id)).toBe("AUTHORIZED");

    // the capture reaches PayPal but the answer is lost
    const realFetch = http.fetch;
    vi.stubGlobal("fetch", async (input: string | URL | Request, init?: RequestInit) => {
      const res = await realFetch(input, init);
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (url.endsWith("/capture")) throw new Error("socket hang up");
      return res;
    });
    const lost = await take(await post(capturePayment, s, id));
    expect(lost.payment).toMatchObject({ state: "NEEDS_RECONCILIATION", moneyMoved: false });

    vi.stubGlobal("fetch", http.fetch);
    const capId = [...http.orders.values()][0]?.captures[0]?.id as string;
    const settled = await paypalWebhook(hook(captureEvent("evt_cap", orderId, capId)));
    texts.push(await settled.clone().text());
    expect(await bodyOf(settled)).toEqual({ status: "PROCESSED", reason: "APPLIED" });
    expect(db.state(id)).toBe("CAPTURED");
    expect(http.apiCalls().filter((r) => r.path.endsWith("/capture"))).toHaveLength(1);

    const view = await take(await getPayment(request("GET", "/x", { s }), idCtx(id)));
    expect(view.payment).toMatchObject({ state: "CAPTURED", moneyMoved: true });
    expect(view.payment.history.map((e: any) => e.title)).toContain("PayPal webhook processed");
    expect((await refreshPayment(request("POST", "/x", { s, body: {} }), idCtx(id))).status).toBe(
      200,
    );

    for (const t of texts) {
      expect(t).not.toContain(TEST_CLIENT_SECRET);
      expect(t).not.toContain(TEST_TOKEN);
      expect(t).not.toContain(TEST_WEBHOOK_SIG);
    }
  });
});
