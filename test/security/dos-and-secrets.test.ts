import { afterEach, describe, expect, it, vi } from "vitest";

import { MAX_WEBHOOK_BODY_BYTES } from "@/application/webhooks";
import { MAX_BODY_BYTES } from "@/server/http";
import { POST as openNegotiation } from "@/app/api/negotiations/route";
import { POST as paypalWebhook } from "@/app/api/webhooks/paypal/route";
import { loginThrottle } from "@/server/operator-guard";

import { bodyOf, boot, CONFIGURED, request, signIn } from "../payments/api-harness";
import { createHttpPayPal, TEST_WEBHOOK_ID, TEST_WEBHOOK_SIG } from "../payments/http-paypal";

/**
 * Security review, part 2: resource exhaustion on the two kinds of entry point (a signed-in operator's JSON body and
 * PayPal's unauthenticated webhook), and what leaks into responses, the audit trail and the database.
 */

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  loginThrottle.reset();
});

/** A request whose body is a stream of `total` bytes and which declares NO content-length (like a chunked upload). */
function streamed(url: string, headers: Record<string, string>, total: number, chunk = 64 * 1024) {
  const state = { pulled: 0 };
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (state.pulled >= total) return controller.close();
      const n = Math.min(chunk, total - state.pulled);
      state.pulled += n;
      controller.enqueue(new Uint8Array(n).fill(0x20));
    },
  });
  const req = new Request(url, { method: "POST", headers, body, duplex: "half" } as RequestInit);
  req.headers.delete("content-length");
  return { req, state };
}

const WEBHOOK_HEADERS = () => ({
  "content-type": "application/json",
  "paypal-transmission-id": `tr-${Math.random().toString(36).slice(2, 12)}`,
  "paypal-transmission-time": new Date().toISOString(),
  "paypal-cert-url": "https://api.sandbox.paypal.com/v1/notifications/certs/CERT-TEST",
  "paypal-transmission-sig": TEST_WEBHOOK_SIG,
  "paypal-auth-algo": "SHA256withRSA",
});

describe("bodies are bounded while they are read, not after", () => {
  it("a webhook body with no content-length is cut off at the limit instead of being read whole", async () => {
    boot({ ...CONFIGURED, PAYPAL_WEBHOOK_ID: TEST_WEBHOOK_ID });
    const http = createHttpPayPal();
    vi.stubGlobal("fetch", http.fetch);
    const total = 8 * 1024 * 1024;
    const { req, state } = streamed(
      "http://localhost:3000/api/webhooks/paypal",
      WEBHOOK_HEADERS(),
      total,
    );
    const res = await paypalWebhook(req);
    expect(res.status).toBe(413);
    expect(state.pulled).toBeLessThan(MAX_WEBHOOK_BODY_BYTES + 256 * 1024);
    expect(http.log).toHaveLength(0); // nothing was sent to PayPal for it
  });

  it("an operator request with no content-length is cut off at the JSON limit", async () => {
    boot();
    const s = await signIn();
    const { req, state } = streamed(
      "http://localhost:3000/api/negotiations",
      {
        "content-type": "application/json",
        cookie: s.cookie,
        "x-csrf-token": s.csrf,
        origin: "http://localhost:3000",
      },
      8 * 1024 * 1024,
    );
    const res = await openNegotiation(req);
    expect(res.status).toBe(413);
    expect(state.pulled).toBeLessThan(MAX_BODY_BYTES + 256 * 1024);
  });

  it("a declared oversize body is refused on the header alone", async () => {
    boot({ ...CONFIGURED, PAYPAL_WEBHOOK_ID: TEST_WEBHOOK_ID });
    vi.stubGlobal("fetch", createHttpPayPal().fetch);
    const req = new Request("http://localhost:3000/api/webhooks/paypal", {
      method: "POST",
      headers: { ...WEBHOOK_HEADERS(), "content-length": String(MAX_WEBHOOK_BODY_BYTES + 1) },
      body: "{}",
    });
    expect((await paypalWebhook(req)).status).toBe(413);
  });
});

describe("the unauthenticated webhook cannot be used to burn PayPal API calls", () => {
  it("only a bounded number of unverified deliveries per minute reach PayPal's verification service", async () => {
    boot({ ...CONFIGURED, PAYPAL_WEBHOOK_ID: TEST_WEBHOOK_ID });
    const http = createHttpPayPal();
    vi.stubGlobal("fetch", http.fetch);
    const statuses = new Map<number, number>();
    for (let i = 0; i < 200; i++) {
      const res = await paypalWebhook(
        new Request("http://localhost:3000/api/webhooks/paypal", {
          method: "POST",
          headers: WEBHOOK_HEADERS(),
          body: JSON.stringify({ id: `WH-FLOOD-${i}`, event_type: "X.Y", resource: {} }),
        }),
      );
      statuses.set(res.status, (statuses.get(res.status) ?? 0) + 1);
    }
    const verifyCalls = http.log.filter((r) => r.path.includes("verify-webhook-signature")).length;
    expect(verifyCalls).toBeLessThanOrEqual(120);
    expect(statuses.get(429) ?? 0).toBeGreaterThan(0);
  }, 30_000);

  it("ordinary traffic is unaffected: a handful of genuine deliveries all reach verification", async () => {
    boot({ ...CONFIGURED, PAYPAL_WEBHOOK_ID: TEST_WEBHOOK_ID });
    const http = createHttpPayPal();
    vi.stubGlobal("fetch", http.fetch);
    for (let i = 0; i < 10; i++) {
      const res = await paypalWebhook(
        new Request("http://localhost:3000/api/webhooks/paypal", {
          method: "POST",
          headers: WEBHOOK_HEADERS(),
          body: JSON.stringify({ id: `WH-OK-${i}`, event_type: "X.Y", resource: {} }),
        }),
      );
      expect(res.status).not.toBe(429);
    }
    expect(http.log.filter((r) => r.path.includes("verify-webhook-signature"))).toHaveLength(10);
  });
});

describe("responses and stored records never carry the secrets", () => {
  it("a full flow with a marked client secret and access token leaves neither anywhere", async () => {
    const SECRET = "EfakeSandboxClientSecret0123456789abcdef";
    const TOKEN = "A21AAFakeAccessToken0123456789abcdefghijklmnop";
    const path = boot({
      ...CONFIGURED,
      PAYPAL_WEBHOOK_ID: TEST_WEBHOOK_ID,
      OPERATOR_PASSCODE: "a-long-operator-passcode-for-tests",
    });
    const http = createHttpPayPal();
    vi.stubGlobal("fetch", http.fetch);
    const logs: string[] = [];
    for (const m of ["log", "error", "warn", "info", "debug"] as const)
      vi.spyOn(console, m).mockImplementation(
        (...a: unknown[]) => void logs.push(a.map(String).join(" ")),
      );
    const s = await signIn();

    const { agree } = await import("../payments/api-harness");
    const { POST: start } = await import("@/app/api/negotiations/[id]/payment/route");
    const { POST: authorize } = await import("@/app/api/negotiations/[id]/payment/authorize/route");
    const { POST: capture } = await import("@/app/api/negotiations/[id]/payment/capture/route");
    const { idCtx } = await import("../payments/api-harness");
    const id = await agree(s);
    const bodies: string[] = [];
    const run = async (
      h: (r: Request, c: { params: Promise<{ id: string }> }) => Promise<Response>,
    ) => {
      const res = await h(request("POST", "/x", { s, body: {} }), idCtx(id));
      bodies.push(JSON.stringify([res.status, Object.fromEntries(res.headers), await res.text()]));
    };
    await run(start);
    http.approve([...http.orders.keys()][0] as string);
    await run(authorize);
    http.behaviour.down = true; // a failing PayPal: its error handling must not echo anything either
    await run(capture);
    http.behaviour.down = false;

    const rows = boot_dump(path);
    const everything = [...bodies, ...logs, rows].join("\n");
    for (const secret of [SECRET, TOKEN, "a-long-operator-passcode-for-tests", s.csrf]) {
      expect(everything.includes(secret), `leaked ${secret.slice(0, 8)}...`).toBe(false);
    }
    expect(everything).not.toMatch(/Basic [A-Za-z0-9+/=]{20,}/);
    expect(everything).not.toMatch(/Bearer [A-Za-z0-9._-]{12,}/);
    // and the audit trail still names what happened
    expect(rows).toContain("PAYPAL_ORDER_OBSERVED");
    expect(
      await bodyOf(
        (await import("@/app/api/operator/session/route")).GET(request("GET", "/x", { s })),
      ),
    ).not.toHaveProperty("passcode");
  });
});

import { openDatabase } from "@/adapters/sqlite/database";

/** Every text cell of every table that records events, as one string. */
function boot_dump(path: { path: string }): string {
  const db = openDatabase(path.path, { readOnly: true });
  try {
    const out: string[] = [];
    for (const t of [
      "audit_events",
      "payment_attempts",
      "webhook_events",
      "policy_decisions",
      "negotiation_policy_checks",
      "idempotency_keys",
    ]) {
      try {
        out.push(JSON.stringify(db.prepare(`SELECT * FROM ${t}`).all()));
      } catch {
        /* a table that does not exist in this schema */
      }
    }
    return out.join("\n");
  } finally {
    db.close();
  }
}
