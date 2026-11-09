/**
 * A fake PayPal at the HTTP level: it answers the sandbox URLs with JSON in the shapes PayPal's Orders v2 and
 * Payments v2 document (capture, void),
 * so the real client, provider, service and routes can run together. A test double only: it proves how OUR code
 * handles documented shapes, nothing about PayPal itself.
 */

export const TEST_CLIENT_ID = "AfakeSandboxClientId0123456789abcdef";
export const TEST_CLIENT_SECRET = "EfakeSandboxClientSecret0123456789abcdef";
export const TEST_TOKEN = "A21AAFakeAccessToken0123456789abcdefghijklmnop";
export const TEST_MERCHANT = "MERCHANT01";
export const TEST_WEBHOOK_ID = "WH-HTTP-0001";
/** The only signature this fake PayPal's verification service accepts. */
export const TEST_WEBHOOK_SIG = "VALID-SIGNATURE-123";

type StoredOrder = {
  id: string;
  status: string;
  intent: string;
  unit: { amount: { currency_code: string; value: string }; custom_id: string; invoice_id: string };
  authorization: null | { id: string; status: string; createdAt: string };
  captures: { id: string; status: string }[];
};

export type LoggedRequest = {
  method: string;
  path: string;
  headers: Record<string, string>;
  json: unknown;
  /** The body exactly as sent. */
  rawBody: string | null;
};

export function createHttpPayPal() {
  const orders = new Map<string, StoredOrder>();
  const byRequestId = new Map<string, string>();
  const captureReplays = new Map<string, string>(); // PayPal-Request-Id -> capture id
  const voidReplays = new Set<string>();
  const log: LoggedRequest[] = [];
  let n = 0;
  const behaviour = {
    /** When set, every non-token call fails like this (network down: throws). */
    down: false,
    /** Override the amount PayPal reports back, to simulate a tampered/different order. */
    reportedValue: null as string | null,
    /** When set, the webhook verification service answers with this HTTP status and no verdict. */
    verifyHttpStatus: null as number | null,
    /** What a new capture reports. */
    captureStatus: "COMPLETED",
    /**
     * When true, the NEXT authorize or capture call takes effect at PayPal and then its response is lost (a timeout
     * after the work was done). The flag clears itself, so only that one call is affected.
     */
    dropNextResponse: false,
    /** When true, the NEXT capture call fails on the connection WITHOUT taking effect (it never reached PayPal). Self-clearing. */
    failNextCapture: false,
    /** When true, an order read hides the captures and shows the hold as CREATED (a read that has not caught up). */
    staleReads: false,
  };

  const orderJson = (o: StoredOrder, full = true) => ({
    id: o.id,
    status: o.status,
    intent: o.intent,
    purchase_units: [
      {
        reference_id: "default",
        amount: { ...o.unit.amount, value: behaviour.reportedValue ?? o.unit.amount.value },
        payee: { merchant_id: TEST_MERCHANT, email_address: "sb-merchant@business.example.com" },
        custom_id: o.unit.custom_id,
        invoice_id: o.unit.invoice_id,
        ...(o.authorization
          ? {
              payments: {
                authorizations: [
                  {
                    id: o.authorization.id,
                    status:
                      behaviour.staleReads && o.authorization.status === "CAPTURED"
                        ? "CREATED"
                        : o.authorization.status,
                    amount: o.unit.amount,
                    custom_id: o.unit.custom_id,
                    create_time: o.authorization.createdAt,
                    expiration_time: new Date(
                      Date.parse(o.authorization.createdAt) + 29 * 86_400_000,
                    ).toISOString(),
                  },
                ],
                ...(o.captures.length > 0 && !behaviour.staleReads
                  ? {
                      captures: o.captures.map((c) => ({
                        id: c.id,
                        status: c.status,
                        amount: o.unit.amount,
                        final_capture: true,
                        create_time: new Date().toISOString(),
                      })),
                    }
                  : {}),
              },
            }
          : {}),
      },
    ],
    links: [
      {
        href: `https://api.sandbox.paypal.com/v2/checkout/orders/${o.id}`,
        rel: "self",
        method: "GET",
      },
      ...(o.status === "CREATED" && full
        ? [
            {
              href: `https://www.sandbox.paypal.com/checkoutnow?token=${o.id}`,
              rel: "approve",
              method: "GET",
            },
          ]
        : []),
    ],
  });

  const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
    new Response(JSON.stringify(body), {
      status,
      headers: {
        "content-type": "application/json",
        "paypal-debug-id": "debug_http_001",
        ...headers,
      },
    });

  const fetch = (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = new URL(
      typeof input === "string" ? input : input instanceof URL ? input.href : input.url,
    );
    const headers = Object.fromEntries(
      Object.entries((init?.headers ?? {}) as Record<string, string>).map(([k, v]) => [
        k.toLowerCase(),
        v,
      ]),
    );
    const method = (init?.method ?? "GET").toUpperCase();
    const body = typeof init?.body === "string" && init.body.length > 0 ? init.body : null;
    const parsed = ((): unknown => {
      try {
        return body === null ? null : JSON.parse(body);
      } catch {
        return body;
      }
    })();
    log.push({ method, path: url.pathname, headers, json: parsed, rawBody: body });

    if (url.host !== "api-m.sandbox.paypal.com")
      return Promise.reject(new Error(`unexpected host ${url.host}`));

    if (url.pathname === "/v1/oauth2/token") {
      const expected = `Basic ${Buffer.from(`${TEST_CLIENT_ID}:${TEST_CLIENT_SECRET}`).toString("base64")}`;
      if (headers.authorization !== expected)
        return Promise.resolve(json(401, { error: "invalid_client" }));
      return Promise.resolve(
        json(200, {
          access_token: TEST_TOKEN,
          token_type: "Bearer",
          expires_in: 32000,
          scope: "https://uri.paypal.com/services/payments/payment",
          app_id: "APP-1",
          nonce: "n",
        }),
      );
    }
    if (headers.authorization !== `Bearer ${TEST_TOKEN}`)
      return Promise.resolve(json(401, { name: "AUTHENTICATION_FAILURE" }));
    if (behaviour.down) return Promise.reject(new Error("socket hang up"));
    // The live sandbox rejects a POST to these endpoints that has no JSON content type (HTTP 415, observed on authorize).
    if (
      method === "POST" &&
      /\/(authorize|void|capture)$/.test(url.pathname) &&
      headers["content-type"] !== "application/json"
    )
      return Promise.resolve(json(415, { name: "UNSUPPORTED_MEDIA_TYPE" }));

    if (method === "POST" && url.pathname === "/v2/checkout/orders") {
      const req = parsed as {
        intent: string;
        purchase_units: [
          {
            amount: { currency_code: string; value: string };
            custom_id: string;
            invoice_id: string;
          },
        ];
      };
      const rid = headers["paypal-request-id"];
      if (rid && byRequestId.has(rid))
        return Promise.resolve(
          json(200, orderJson(orders.get(byRequestId.get(rid) as string) as StoredOrder)),
        );
      const o: StoredOrder = {
        id: `5O19${String(++n).padStart(8, "0")}`,
        status: "CREATED",
        intent: req.intent,
        unit: req.purchase_units[0],
        authorization: null,
        captures: [],
      };
      orders.set(o.id, o);
      if (rid) byRequestId.set(rid, o.id);
      return Promise.resolve(json(201, orderJson(o)));
    }

    const m = /^\/v2\/checkout\/orders\/([A-Z0-9]+)(\/authorize)?$/.exec(url.pathname);
    if (m) {
      const o = orders.get(m[1] as string);
      if (!o)
        return Promise.resolve(
          json(404, { name: "RESOURCE_NOT_FOUND", details: [{ issue: "INVALID_RESOURCE_ID" }] }),
        );
      if (method === "GET" && !m[2]) return Promise.resolve(json(200, orderJson(o, false)));
      if (method === "POST" && m[2]) {
        if (o.authorization === null) {
          if (o.status !== "APPROVED")
            return Promise.resolve(
              json(422, {
                name: "UNPROCESSABLE_ENTITY",
                details: [{ issue: "ORDER_NOT_APPROVED" }],
              }),
            );
          // the hold begins now: a fixed date would put it outside the 3-day honor period as soon as the calendar moves on
          o.authorization = {
            id: `AUTH${String(++n).padStart(6, "0")}`,
            status: "CREATED",
            createdAt: new Date().toISOString(),
          };
          o.status = "COMPLETED";
        }
        if (behaviour.dropNextResponse) {
          behaviour.dropNextResponse = false;
          return Promise.reject(new Error("timeout after the authorization was placed"));
        }
        return Promise.resolve(json(201, orderJson(o)));
      }
    }
    if (method === "POST" && url.pathname === "/v1/notifications/verify-webhook-signature") {
      if (behaviour.verifyHttpStatus !== null)
        return Promise.resolve(json(behaviour.verifyHttpStatus, { name: "INTERNAL_SERVER_ERROR" }));
      const v = parsed as Record<string, unknown> | null;
      const event = v?.webhook_event;
      const ok =
        v !== null &&
        v.transmission_sig === TEST_WEBHOOK_SIG &&
        v.webhook_id === TEST_WEBHOOK_ID &&
        event !== null &&
        typeof event === "object";
      return Promise.resolve(json(200, { verification_status: ok ? "SUCCESS" : "FAILURE" }));
    }

    const pay = /^\/v2\/payments\/authorizations\/([A-Za-z0-9_-]+)\/(capture|void)$/.exec(
      url.pathname,
    );
    if (pay && method === "POST") {
      const o = [...orders.values()].find((x) => x.authorization?.id === pay[1]);
      const auth = o?.authorization;
      if (!o || !auth)
        return Promise.resolve(
          json(404, { name: "RESOURCE_NOT_FOUND", details: [{ issue: "INVALID_RESOURCE_ID" }] }),
        );
      const rid = headers["paypal-request-id"] ?? "";
      const refuse = (issue: string) =>
        Promise.resolve(json(422, { name: "UNPROCESSABLE_ENTITY", details: [{ issue }] }));
      if (pay[2] === "capture" && behaviour.failNextCapture) {
        behaviour.failNextCapture = false;
        return Promise.reject(new Error("connection reset before the capture was sent"));
      }
      if (pay[2] === "capture") {
        if (rid && captureReplays.has(rid)) {
          const cap = o.captures.find((c) => c.id === captureReplays.get(rid));
          return Promise.resolve(json(200, { id: cap?.id, status: cap?.status }));
        }
        if (auth.status === "VOIDED") return refuse("AUTHORIZATION_VOIDED");
        if (auth.status !== "CREATED") return refuse("MAX_CAPTURE_AMOUNT_EXCEEDED");
        const cap = { id: `CAP${String(++n).padStart(6, "0")}`, status: behaviour.captureStatus };
        o.captures.push(cap);
        if (cap.status === "COMPLETED") auth.status = "CAPTURED";
        if (rid) captureReplays.set(rid, cap.id);
        if (behaviour.dropNextResponse) {
          behaviour.dropNextResponse = false;
          return Promise.reject(new Error("timeout after the capture was made"));
        }
        return Promise.resolve(json(201, { id: cap.id, status: cap.status, final_capture: true }));
      }
      // void: 204 and no body
      if (!(rid && voidReplays.has(rid))) {
        if (auth.status !== "CREATED") return refuse("PREVIOUSLY_CAPTURED");
        auth.status = "VOIDED";
        if (rid) voidReplays.add(rid);
      }
      return Promise.resolve(
        new Response(null, { status: 204, headers: { "paypal-debug-id": "debug_void_204" } }),
      );
    }
    return Promise.resolve(json(404, { name: "RESOURCE_NOT_FOUND" }));
  };

  return {
    fetch,
    orders,
    log,
    behaviour,
    /** Calls to everything except the token endpoint. */
    apiCalls: () => log.filter((r) => r.path !== "/v1/oauth2/token"),
    approve: (id: string) => {
      (orders.get(id) as StoredOrder).status = "APPROVED";
    },
  };
}
