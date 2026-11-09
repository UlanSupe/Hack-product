/* eslint-disable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-assignment -- these tests inspect untyped API JSON structurally */
import { afterEach, describe, expect, it, vi } from "vitest";

import { POST as authorizePayment } from "@/app/api/negotiations/[id]/payment/authorize/route";
import { GET as getPayment, POST as startPayment } from "@/app/api/negotiations/[id]/payment/route";
import { POST as refreshPayment } from "@/app/api/negotiations/[id]/payment/refresh/route";
import { GET as paypalReturn } from "@/app/api/paypal/return/route";
import { loginThrottle } from "@/server/operator-guard";

import { agree, bodyOf, boot, CONFIGURED, idCtx, request, signIn } from "./api-harness";
import { createHttpPayPal, TEST_CLIENT_ID, TEST_CLIENT_SECRET, TEST_TOKEN } from "./http-paypal";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  loginThrottle.reset();
});

describe("access: only the signed-in human operator", () => {
  it("anonymous requests are 401 on every payment route and nothing reaches PayPal", async () => {
    boot(CONFIGURED);
    const http = createHttpPayPal();
    vi.stubGlobal("fetch", http.fetch);
    const ctx = idCtx("n1");
    for (const res of [
      await getPayment(request("GET", "/x"), ctx),
      await startPayment(request("POST", "/x", { body: {} }), ctx),
      await refreshPayment(request("POST", "/x", { body: {} }), ctx),
      await authorizePayment(request("POST", "/x", { body: {} }), ctx),
    ]) {
      expect(res.status).toBe(401);
    }
    // The buyer's browser return is a page navigation, not an API call: with no session it is sent to the console to sign in.
    const back = await paypalReturn(request("GET", "/api/paypal/return?token=ABC123"));
    expect(back.status).toBe(303);
    expect(back.headers.get("location")).toBe("http://localhost:3000/negotiations?payment=signin");
    expect(http.log).toHaveLength(0);
  });

  it("an agent (even with a valid operator cookie) is refused", async () => {
    boot(CONFIGURED);
    const http = createHttpPayPal();
    vi.stubGlobal("fetch", http.fetch);
    const s = await signIn();
    for (const headers of [{ "x-agent-id": "buyer-1" }, { authorization: "Bearer agent-token" }]) {
      expect(
        (await startPayment(request("POST", "/x", { s, body: {}, headers }), idCtx("n1"))).status,
      ).toBe(403);
      expect((await getPayment(request("GET", "/x", { s, headers }), idCtx("n1"))).status).toBe(
        403,
      );
    }
    expect(http.log).toHaveLength(0);
  });

  it("writes need the CSRF token and same origin", async () => {
    boot(CONFIGURED);
    vi.stubGlobal("fetch", createHttpPayPal().fetch);
    const s = await signIn();
    expect(
      (await startPayment(request("POST", "/x", { s, csrf: false, body: {} }), idCtx("n1"))).status,
    ).toBe(403);
    expect(
      (
        await startPayment(
          request("POST", "/x", { s, body: {}, headers: { origin: "https://evil.example" } }),
          idCtx("n1"),
        )
      ).status,
    ).toBe(403);
  });
});

describe("a browser cannot supply an amount, currency, payee or id", () => {
  it.each([
    [{ amount: "1.00" }],
    [{ amountMinor: 1 }],
    [{ currency: "EUR" }],
    [{ payee: "attacker@example.com" }],
    [{ orderId: "FORGED" }],
    [{ transactionId: "tx_other" }],
    [{ agreementVersion: 9 }],
    [{ negotiationId: "other" }],
    [[]],
    [null],
    ["1.00"],
  ])("a body of %j is refused with 400 and nothing is sent", async (bad) => {
    boot(CONFIGURED);
    const http = createHttpPayPal();
    vi.stubGlobal("fetch", http.fetch);
    const s = await signIn();
    const id = await agree(s);
    for (const route of [startPayment, refreshPayment, authorizePayment]) {
      const res = await route(request("POST", "/x", { s, body: bad }), idCtx(id));
      expect(res.status).toBe(400);
      expect((await bodyOf(res)).error).toBe("NO_PARAMETERS_ALLOWED");
    }
    expect(http.log).toHaveLength(0);
  });
});

describe("PayPal not configured", () => {
  it("reads work; anything that would call PayPal is a 503 before any state changes", async () => {
    const db = boot(null);
    const http = createHttpPayPal();
    vi.stubGlobal("fetch", http.fetch);
    const s = await signIn();
    const id = await agree(s);
    const view = await getPayment(request("GET", "/x", { s }), idCtx(id));
    expect(view.status).toBe(200);
    expect((await bodyOf(view)).payment).toMatchObject({ state: "AGREED", moneyMoved: false });
    for (const route of [startPayment, authorizePayment]) {
      const res = await route(request("POST", "/x", { s, body: {} }), idCtx(id));
      expect(res.status).toBe(503);
      expect((await bodyOf(res)).error).toBe("PAYPAL_NOT_CONFIGURED");
    }
    expect(db.state(id)).toBe("AGREED");
    expect(http.log).toHaveLength(0);
  });
});

describe("the flow over HTTP, with the real client and provider against a fake PayPal", () => {
  it("start → buyer returns (not evidence) → buyer approves at PayPal → return → authorize", async () => {
    const db = boot(CONFIGURED);
    const http = createHttpPayPal();
    vi.stubGlobal("fetch", http.fetch);
    const s = await signIn();
    const id = await agree(s);
    const responses: string[] = [];
    const take = async (res: Response) => {
      const text = await res.clone().text();
      responses.push(text);
      return JSON.parse(text) as Record<string, any>;
    };

    // 1. start
    const started = await startPayment(request("POST", "/x", { s, body: {} }), idCtx(id));
    expect(started.status).toBe(200);
    const sj = await take(started);
    expect(sj.payment).toMatchObject({
      state: "ORDER_CREATED",
      amountText: "80.00 USD",
      moneyMoved: false,
      nextAction: "OPEN_APPROVAL",
    });
    expect(sj.payment.approveUrl).toMatch(/^https:\/\/www\.sandbox\.paypal\.com\//);
    expect(sj.result.performed).toBe(true);

    // what PayPal was actually sent
    const create = http
      .apiCalls()
      .find((r) => r.method === "POST" && r.path === "/v2/checkout/orders") as any;
    expect(create.json.purchase_units[0].amount).toEqual({ currency_code: "USD", value: "80.00" });
    expect(create.json.intent).toBe("AUTHORIZE");
    expect(create.headers["paypal-request-id"]).toMatch(/^pp:.+:CREATE_ORDER:1$/);
    expect(create.json.purchase_units[0].custom_id).toBe(
      db.read("SELECT transaction_id FROM negotiation_agreements WHERE negotiation_id = ?", id),
    );

    // 2. the browser comes back claiming success: nothing changes
    const orderId = sj.payment.paypalOrderId as string;
    const back = await paypalReturn(
      request(
        "GET",
        `/api/paypal/return?token=${orderId}&PayerID=FAKE&success=true&status=APPROVED`,
        { s },
      ),
    );
    expect(back.status).toBe(303);
    expect(back.headers.get("location")).toContain("/negotiations?payment=checked");
    expect(db.state(id)).toBe("ORDER_CREATED");

    // 3. authorizing now is refused: PayPal itself says not approved
    const early = await take(
      await authorizePayment(request("POST", "/x", { s, body: {} }), idCtx(id)),
    );
    expect(early.result.performed).toBe(false);
    expect(early.payment.state).toBe("ORDER_CREATED");
    expect(http.apiCalls().some((r) => r.path.endsWith("/authorize"))).toBe(false);

    // 4. the buyer approves at PayPal, the browser returns, the server asks PayPal
    http.approve(orderId);
    await paypalReturn(request("GET", `/api/paypal/return?token=${orderId}`, { s }));
    expect(db.state(id)).toBe("ORDER_APPROVED");

    // 5. authorize
    const auth = await take(
      await authorizePayment(request("POST", "/x", { s, body: {} }), idCtx(id)),
    );
    expect(auth.payment).toMatchObject({ state: "AUTHORIZED", moneyMoved: false });
    expect(auth.payment.headline).toMatch(/not charged/);
    expect(db.state(id)).toBe("AUTHORIZED");
    expect(http.apiCalls().filter((r) => r.path.endsWith("/authorize"))).toHaveLength(1);

    // 6. a repeat does nothing
    const again = await take(
      await authorizePayment(request("POST", "/x", { s, body: {} }), idCtx(id)),
    );
    expect(again.result.performed).toBe(false);
    expect(http.apiCalls().filter((r) => r.path.endsWith("/authorize"))).toHaveLength(1);

    // no response ever carried a credential or the access token
    for (const text of responses) {
      expect(text).not.toContain(TEST_CLIENT_SECRET);
      expect(text).not.toContain(TEST_CLIENT_ID);
      expect(text).not.toContain(TEST_TOKEN);
    }
  });

  it("the return endpoint: unknown order ids and malformed tokens never reach PayPal", async () => {
    boot(CONFIGURED);
    const http = createHttpPayPal();
    vi.stubGlobal("fetch", http.fetch);
    const s = await signIn();
    await agree(s);
    expect(
      (await paypalReturn(request("GET", "/api/paypal/return?token=FORGED123", { s }))).status,
    ).toBe(404);
    for (const token of ["", "lower", "../../x", "A".repeat(40), "A%20B"]) {
      const res = await paypalReturn(request("GET", `/api/paypal/return?token=${token}`, { s }));
      expect(res.status).toBe(303);
      expect(res.headers.get("location")).toContain("payment=unknown");
    }
    expect(
      (await paypalReturn(request("GET", "/api/paypal/return", { s }))).headers.get("location"),
    ).toContain("payment=unknown");
    expect(http.log).toHaveLength(0);
  });

  it("a network outage while creating is NOT a server error: the payment is NEEDS_RECONCILIATION and later settles", async () => {
    const db = boot(CONFIGURED);
    const http = createHttpPayPal();
    vi.stubGlobal("fetch", http.fetch);
    const s = await signIn();
    const id = await agree(s);
    http.behaviour.down = true;
    const res = await startPayment(request("POST", "/x", { s, body: {} }), idCtx(id));
    expect(res.status).toBe(200);
    const j = await bodyOf(res);
    expect(j.payment).toMatchObject({
      state: "NEEDS_RECONCILIATION",
      nextAction: "RECONCILE",
      moneyMoved: false,
    });
    expect(j.result.notes.join(" ")).toMatch(/may or may not have taken effect/);

    http.behaviour.down = false;
    const settled = await bodyOf(
      await refreshPayment(request("POST", "/x", { s, body: {} }), idCtx(id)),
    );
    expect(settled.payment.state).toBe("ORDER_CREATED");
    expect(http.orders.size).toBe(1);
    expect(db.state(id)).toBe("ORDER_CREATED");
  });

  it("a status check while PayPal is unreachable is a 502 with a correlation id, and changes nothing", async () => {
    const db = boot(CONFIGURED);
    const http = createHttpPayPal();
    vi.stubGlobal("fetch", http.fetch);
    const s = await signIn();
    const id = await agree(s);
    await startPayment(request("POST", "/x", { s, body: {} }), idCtx(id));
    http.behaviour.down = true;
    const res = await refreshPayment(request("POST", "/x", { s, body: {} }), idCtx(id));
    expect(res.status).toBe(502);
    const j = await bodyOf(res);
    expect(j.error).toBe("PAYPAL_UNAVAILABLE");
    expect(j.correlationId).toMatch(/^corr_/);
    expect(JSON.stringify(j)).not.toMatch(/socket|hang up|ECONN/);
    expect(db.state(id)).toBe("ORDER_CREATED");
  });

  it("an amount PayPal reports differently from the agreement is never accepted, and the response says so without any PayPal text", async () => {
    const db = boot(CONFIGURED);
    const http = createHttpPayPal();
    vi.stubGlobal("fetch", http.fetch);
    const s = await signIn();
    const id = await agree(s);
    http.behaviour.reportedValue = "80.01";
    const j = await bodyOf(await startPayment(request("POST", "/x", { s, body: {} }), idCtx(id)));
    expect(j.payment.state).toBe("NEEDS_RECONCILIATION");
    expect(j.payment.approveUrl).toBeNull();
    expect(j.payment.warnings.join(" ")).toContain("AMOUNT_MISMATCH");
    expect(db.state(id)).toBe("NEEDS_RECONCILIATION");
    const auth = await authorizePayment(request("POST", "/x", { s, body: {} }), idCtx(id));
    expect(auth.status).toBe(409);
    expect(http.apiCalls().some((r) => r.path.endsWith("/authorize"))).toBe(false);
  });

  it("the credentials are rejected by the sandbox -> an unknown outcome, never success, and nothing leaks", async () => {
    boot({ ...CONFIGURED, PAYPAL_CLIENT_SECRET: "EwrongSandboxSecret0123456789abcdefgh" });
    const http = createHttpPayPal();
    vi.stubGlobal("fetch", http.fetch);
    const s = await signIn();
    const id = await agree(s);
    const res = await startPayment(request("POST", "/x", { s, body: {} }), idCtx(id));
    const text = await res.text();
    expect(JSON.parse(text).payment.state).toBe("NEEDS_RECONCILIATION");
    expect(text).not.toMatch(/wrongSandboxSecret|invalid_client/);
    expect(http.orders.size).toBe(0);
  });
});
