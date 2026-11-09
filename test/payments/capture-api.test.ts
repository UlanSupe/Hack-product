/* eslint-disable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-call -- these tests inspect untyped API JSON structurally */
import { afterEach, describe, expect, it, vi } from "vitest";

import { POST as authorizePayment } from "@/app/api/negotiations/[id]/payment/authorize/route";
import { POST as capturePayment } from "@/app/api/negotiations/[id]/payment/capture/route";
import { POST as startPayment } from "@/app/api/negotiations/[id]/payment/route";
import { POST as refreshPayment } from "@/app/api/negotiations/[id]/payment/refresh/route";
import { POST as voidPayment } from "@/app/api/negotiations/[id]/payment/void/route";
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
import { createHttpPayPal, TEST_CLIENT_SECRET, TEST_TOKEN } from "./http-paypal";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  loginThrottle.reset();
});

const post = (route: typeof capturePayment, s: Session, id: string, body: unknown = {}) =>
  route(request("POST", "/x", { s, body }), idCtx(id));

/** Real client, provider, service and routes against the HTTP-level fake PayPal, up to an authorized hold. */
async function toHold() {
  const db = boot(CONFIGURED);
  const http = createHttpPayPal();
  vi.stubGlobal("fetch", http.fetch);
  const s = await signIn();
  const id = await agree(s);
  const started = await bodyOf(await post(startPayment, s, id));
  http.approve(started.payment.paypalOrderId);
  await post(refreshPayment, s, id);
  const held = await bodyOf(await post(authorizePayment, s, id));
  expect(held.payment.state).toBe("AUTHORIZED");
  return { db, http, s, id };
}
const writes = (http: ReturnType<typeof createHttpPayPal>, suffix: string) =>
  http.apiCalls().filter((r) => r.method === "POST" && r.path.endsWith(suffix));

describe("access: only the signed-in human operator may capture or release", () => {
  it("anonymous requests are 401 and nothing reaches PayPal", async () => {
    boot(CONFIGURED);
    const http = createHttpPayPal();
    vi.stubGlobal("fetch", http.fetch);
    for (const route of [capturePayment, voidPayment]) {
      expect((await route(request("POST", "/x", { body: {} }), idCtx("n1"))).status).toBe(401);
    }
    expect(http.log).toHaveLength(0);
  });

  it("an agent, even with a valid operator cookie, is refused (403)", async () => {
    boot(CONFIGURED);
    const http = createHttpPayPal();
    vi.stubGlobal("fetch", http.fetch);
    const s = await signIn();
    for (const headers of [{ "x-agent-id": "buyer-1" }, { authorization: "Bearer agent-token" }]) {
      for (const route of [capturePayment, voidPayment]) {
        const res = await route(request("POST", "/x", { s, body: {}, headers }), idCtx("n1"));
        expect(res.status).toBe(403);
      }
    }
    expect(http.log).toHaveLength(0);
  });

  it("writes need the CSRF token and the same origin", async () => {
    boot(CONFIGURED);
    vi.stubGlobal("fetch", createHttpPayPal().fetch);
    const s = await signIn();
    for (const route of [capturePayment, voidPayment]) {
      expect(
        (await route(request("POST", "/x", { s, csrf: false, body: {} }), idCtx("n1"))).status,
      ).toBe(403);
      expect(
        (
          await route(
            request("POST", "/x", { s, body: {}, headers: { origin: "https://evil.example" } }),
            idCtx("n1"),
          )
        ).status,
      ).toBe(403);
    }
  });

  it("PayPal not configured: a 503 before any state changes", async () => {
    const db = boot(null);
    const http = createHttpPayPal();
    vi.stubGlobal("fetch", http.fetch);
    const s = await signIn();
    const id = await agree(s);
    for (const route of [capturePayment, voidPayment]) {
      const res = await post(route, s, id);
      expect(res.status).toBe(503);
      expect((await bodyOf(res)).error).toBe("PAYPAL_NOT_CONFIGURED");
    }
    expect(db.state(id)).toBe("AGREED");
    expect(http.log).toHaveLength(0);
  });
});

describe("a browser cannot supply an amount, authorization, payee or id", () => {
  it.each([
    [{ amount: "1.00" }],
    [{ amountMinor: 1 }],
    [{ amount: { currency_code: "USD", value: "0.01" } }],
    [{ authorizationId: "AUTHFORGED" }],
    [{ captureId: "CAPFORGED" }],
    [{ finalCapture: false }],
    [{ payee: "attacker@example.com" }],
    [{ transactionId: "tx_other" }],
    [[]],
    [null],
    ["80.00"],
  ])("a body of %j is refused with 400 and nothing is sent", async (bad) => {
    const { http, s, id, db } = await toHold();
    const before = http.apiCalls().length;
    for (const route of [capturePayment, voidPayment]) {
      const res = await post(route, s, id, bad);
      expect(res.status).toBe(400);
      expect((await bodyOf(res)).error).toBe("NO_PARAMETERS_ALLOWED");
    }
    expect(http.apiCalls()).toHaveLength(before);
    expect(db.state(id)).toBe("AUTHORIZED");
  });
});

describe("capture over HTTP, with the real client and provider against a fake PayPal", () => {
  it("captures exactly the agreed total from the stored authorization; a repeat sends nothing; the response carries no credential", async () => {
    const { http, s, id, db } = await toHold();
    const texts: string[] = [];

    const res = await post(capturePayment, s, id);
    expect(res.status).toBe(200);
    texts.push(await res.clone().text());
    const j = await bodyOf(res);
    expect(j.payment).toMatchObject({ state: "CAPTURED", moneyMoved: true });
    expect(j.payment.capture.amountText).toBe("80.00 USD");
    expect(j.result.performed).toBe(true);
    expect(db.state(id)).toBe("CAPTURED");

    const sent = writes(http, "/capture");
    expect(sent).toHaveLength(1);
    const authId = [...http.orders.values()][0]?.authorization?.id;
    expect(sent[0]?.path).toBe(`/v2/payments/authorizations/${authId}/capture`);
    expect(sent[0]?.json).toEqual({
      amount: { currency_code: "USD", value: "80.00" },
      final_capture: true,
    });
    expect(sent[0]?.headers["paypal-request-id"]).toMatch(/^pp:.+:CAPTURE:1$/);
    expect(sent[0]?.headers.authorization).toBe(`Bearer ${TEST_TOKEN}`);

    const again = await post(capturePayment, s, id);
    texts.push(await again.clone().text());
    expect((await bodyOf(again)).result.performed).toBe(false);
    expect(writes(http, "/capture")).toHaveLength(1);

    // a captured payment cannot be released
    const voided = await post(voidPayment, s, id);
    expect(voided.status).toBe(409);
    expect(writes(http, "/void")).toHaveLength(0);

    for (const t of texts) {
      expect(t).not.toContain(TEST_CLIENT_SECRET);
      expect(t).not.toContain(TEST_TOKEN);
    }
  });

  it("before the hold exists a capture is a 409 and PayPal is not asked to capture", async () => {
    const db = boot(CONFIGURED);
    const http = createHttpPayPal();
    vi.stubGlobal("fetch", http.fetch);
    const s = await signIn();
    const id = await agree(s);
    await post(startPayment, s, id);
    const res = await post(capturePayment, s, id);
    expect(res.status).toBe(409);
    expect(writes(http, "/capture")).toHaveLength(0);
    expect(db.state(id)).toBe("ORDER_CREATED");
  });

  it("an amount PayPal reports differently at capture time is never captured, and the response says so without PayPal text", async () => {
    const { http, s, id, db } = await toHold();
    http.behaviour.reportedValue = "79.99";
    const j = await bodyOf(await post(capturePayment, s, id));
    expect(j.result.performed).toBe(false);
    expect(j.payment).toMatchObject({ state: "AUTHORIZED", moneyMoved: false });
    expect(j.result.notes.join(" ")).toMatch(/does not match the agreement/);
    expect(writes(http, "/capture")).toHaveLength(0);
    expect(db.state(id)).toBe("AUTHORIZED");
  });

  it("PayPal unreachable for the pre-check is a 502 with a correlation id and changes nothing", async () => {
    const { http, s, id, db } = await toHold();
    http.behaviour.down = true;
    const res = await post(capturePayment, s, id);
    expect(res.status).toBe(502);
    const j = await bodyOf(res);
    expect(j.error).toBe("PAYPAL_UNAVAILABLE");
    expect(j.correlationId).toMatch(/^corr_/);
    expect(JSON.stringify(j)).not.toMatch(/socket|hang up|ECONN/);
    expect(db.state(id)).toBe("AUTHORIZED");
  });

  it("a read that has not caught up leaves the payment NEEDS_RECONCILIATION, never paid; the next check finds the capture", async () => {
    const { http, s, id } = await toHold();
    http.behaviour.staleReads = true;
    const j = await bodyOf(await post(capturePayment, s, id));
    expect(j.payment).toMatchObject({ state: "NEEDS_RECONCILIATION", moneyMoved: false });
    expect(j.payment.headline).not.toMatch(/Captured/);

    http.behaviour.staleReads = false;
    const fin = await bodyOf(await post(refreshPayment, s, id));
    expect(fin.payment).toMatchObject({ state: "CAPTURED", moneyMoved: true });
    expect(writes(http, "/capture")).toHaveLength(1);
  });

  it("a PENDING capture is not paid", async () => {
    const { http, s, id } = await toHold();
    http.behaviour.captureStatus = "PENDING";
    const j = await bodyOf(await post(capturePayment, s, id));
    expect(j.payment).toMatchObject({ state: "CAPTURE_PENDING", moneyMoved: false });
    expect(j.payment.headline).toMatch(/not paid yet/);
  });
});

describe("void over HTTP", () => {
  it("releases the hold: PayPal's 204 with no body is handled, the order is read back, and nothing is charged", async () => {
    const { http, s, id, db } = await toHold();
    const res = await post(voidPayment, s, id);
    expect(res.status).toBe(200);
    const j = await bodyOf(res);
    expect(j.payment).toMatchObject({ state: "VOIDED", moneyMoved: false });
    expect(db.state(id)).toBe("VOIDED");
    const sent = writes(http, "/void");
    expect(sent).toHaveLength(1);
    expect(sent[0]?.json).toEqual({});
    expect(sent[0]?.headers["paypal-request-id"]).toMatch(/^pp:.+:VOID:1$/);

    const again = await bodyOf(await post(voidPayment, s, id));
    expect(again.result.performed).toBe(false);
    expect(writes(http, "/void")).toHaveLength(1);

    const cap = await post(capturePayment, s, id);
    expect(cap.status).toBe(409);
    expect(writes(http, "/capture")).toHaveLength(0);
  });

  it("only an authorized hold can be released: before authorization it is a 409 with nothing sent", async () => {
    const db = boot(CONFIGURED);
    const http = createHttpPayPal();
    vi.stubGlobal("fetch", http.fetch);
    const s = await signIn();
    const id = await agree(s);
    expect((await post(voidPayment, s, id)).status).toBe(409);
    expect(writes(http, "/void")).toHaveLength(0);
    expect(db.state(id)).toBe("AGREED");
  });
});
