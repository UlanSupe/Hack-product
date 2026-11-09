import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { loginThrottle } from "@/server/operator-guard";

import { bodyOf, boot, request, signIn, type Session } from "../payments/api-harness";

/**
 * Security review, part 1: EVERY route module under src/app/api, discovered from the file system, is exercised
 * without trusting that its author remembered the guard. A new route that is not classified below fails this file.
 */

type Handler = (
  req: Request,
  ctx: { params: Promise<Record<string, string>> },
) => Response | Promise<Response>;
const MODULES = import.meta.glob<Record<string, unknown>>("../../src/app/api/**/route.ts");
const METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE"] as const;
const PARAMS = { id: "neg_x", pid: "ofr_x", scenarioId: "S1" };
const ctx = { params: Promise.resolve(PARAMS) };

/** Routes that are deliberately reachable without an operator session, and why. Anything else must answer 401. */
const PUBLIC: Record<string, string> = {
  "arena/runs/route.ts GET": "simulated experiment, no database, no PayPal",
  "arena/runs/[scenarioId]/route.ts GET": "simulated experiment, no database, no PayPal",
  "flagship/route.ts GET": "throwaway in-memory database, simulated money",
  "health/route.ts GET": "status only",
  "cockpit/route.ts GET": "benchmark rows are public; database rows need the operator",
  "operator/session/route.ts GET": "reports whether the caller is signed in",
  "operator/session/route.ts POST": "the login itself (throttled)",
  "webhooks/paypal/route.ts POST": "authenticated by PayPal's signature, not a session",
};

type Entry = { file: string; method: (typeof METHODS)[number]; handler: Handler };

let routes: Entry[] = [];
let session: Session;

beforeAll(async () => {
  for (const [path, load] of Object.entries(MODULES)) {
    const mod = await load();
    const file = path.split("/src/app/api/")[1] ?? path.split("src/app/api/")[1] ?? path;
    for (const method of METHODS) {
      const h = mod[method];
      if (typeof h === "function") routes.push({ file, method, handler: h as Handler });
    }
  }
  routes = routes.sort((a, b) => `${a.file}${a.method}`.localeCompare(`${b.file}${b.method}`));
});

afterEach(() => {
  vi.unstubAllEnvs();
  loginThrottle.reset();
});

const key = (r: Entry) => `${r.file} ${r.method}`;
const call = (r: Entry, req: Request) => Promise.resolve(r.handler(req, ctx));

describe("route inventory", () => {
  it("finds the routes (so the sweep below cannot pass by checking nothing)", () => {
    expect(routes.length).toBeGreaterThan(30);
    expect(routes.some((r) => r.file.startsWith("negotiations/[id]/payment/capture"))).toBe(true);
    expect(routes.some((r) => r.file.startsWith("webhooks/paypal"))).toBe(true);
  });

  it("every public exception names a route that exists", () => {
    const keys = new Set(routes.map(key));
    for (const k of Object.keys(PUBLIC)) expect(keys.has(k), k).toBe(true);
  });
});

describe("no session: every route not on the public list is refused", () => {
  it("answers 401 and does nothing", async () => {
    boot();
    const failures: string[] = [];
    for (const r of routes) {
      if (PUBLIC[key(r)] !== undefined) continue;
      const body = r.method === "GET" ? {} : { body: {} };
      const res = await call(r, request(r.method, `/api/${r.file}`, body));
      // The one deliberate exception: the buyer's browser return from PayPal is a page navigation, so without a session it is
      // sent to the console to sign in (303) instead of receiving JSON. It reads nothing and changes nothing.
      if (key(r) === "paypal/return/route.ts GET") {
        if (
          res.status !== 303 ||
          !res.headers.get("location")?.endsWith("/negotiations?payment=signin")
        )
          failures.push(`${key(r)} -> ${res.status} ${res.headers.get("location")}`);
        continue;
      }
      if (res.status !== 401) failures.push(`${key(r)} -> ${res.status}`);
    }
    expect(failures).toEqual([]);
  });

  it("the public routes reveal no database row or secret to an anonymous caller", async () => {
    boot();
    for (const r of routes) {
      if (PUBLIC[key(r)] === undefined || r.file.startsWith("operator/session")) continue;
      if (r.file.startsWith("webhooks")) continue;
      const res = await call(
        r,
        request(r.method, `/api/${r.file}`, r.method === "GET" ? {} : { body: {} }),
      );
      const text = await res.text();
      expect(text, key(r)).not.toMatch(
        /PASSCODE|CLIENT_SECRET|access_token|Bearer |tx_[0-9a-f]{8}|neg_[0-9a-f]{8}/i,
      );
    }
  });
});

describe("with the operator's cookie", () => {
  it("an agent (header) is refused on every operator route, reads included", async () => {
    boot();
    session = await signIn();
    const failures: string[] = [];
    for (const r of routes) {
      if (PUBLIC[key(r)] !== undefined) continue;
      for (const headers of [
        { "x-agent-id": "buyer-1" },
        { authorization: "Bearer agent-token" },
      ]) {
        const res = await call(
          r,
          request(r.method, `/api/${r.file}`, {
            s: session,
            headers,
            ...(r.method === "GET" ? {} : { body: {} }),
          }),
        );
        if (res.status !== 403)
          failures.push(`${key(r)} ${Object.keys(headers)[0]} -> ${res.status}`);
      }
    }
    expect(failures).toEqual([]);
  });

  it("every state-changing operator route refuses a missing CSRF token and a foreign origin", async () => {
    boot();
    session = await signIn();
    const failures: string[] = [];
    for (const r of routes) {
      if (PUBLIC[key(r)] !== undefined || r.method === "GET") continue;
      const noCsrf = await call(
        r,
        request(r.method, `/api/${r.file}`, { s: session, csrf: false, body: {} }),
      );
      if (noCsrf.status !== 403) failures.push(`${key(r)} no csrf -> ${noCsrf.status}`);
      const foreign = await call(
        r,
        request(r.method, `/api/${r.file}`, {
          s: session,
          body: {},
          headers: { origin: "https://evil.example" },
        }),
      );
      if (foreign.status !== 403) failures.push(`${key(r)} foreign origin -> ${foreign.status}`);
      const wrongToken = await call(
        r,
        request(r.method, `/api/${r.file}`, { s: { ...session, csrf: "0".repeat(64) }, body: {} }),
      );
      if (wrongToken.status !== 403) failures.push(`${key(r)} wrong csrf -> ${wrongToken.status}`);
    }
    expect(failures).toEqual([]);
  });

  it("forged, truncated, re-signed and expired cookies are no session", async () => {
    boot();
    const real = await signIn();
    const token = real.cookie.split("=")[1] as string;
    const [v, exp, nonce, sig] = token.split(".") as [string, string, string, string];
    const bad = [
      "pp_operator=",
      "pp_operator=v1",
      `pp_operator=${v}.${exp}.${nonce}`,
      `pp_operator=${v}.${exp}.${nonce}.${"0".repeat(64)}`,
      `pp_operator=${v}.${Number(exp) + 1}.${nonce}.${sig}`, // extended lifetime, old signature
      `pp_operator=${v}.${exp}.${"f".repeat(32)}.${sig}`, // another nonce, old signature
      `pp_operator=${v}.1.${nonce}.${sig}`,
      `pp_operator=${token}.extra`,
      `pp_operator=${"a".repeat(300)}`,
      `other=${token}`,
    ];
    const capture = routes.find((r) =>
      r.file.startsWith("negotiations/[id]/payment/capture"),
    ) as Entry;
    for (const cookie of bad) {
      const res = await call(
        capture,
        request("POST", "/x", { body: {}, headers: { cookie, "x-csrf-token": real.csrf } }),
      );
      expect(res.status, cookie.slice(0, 40)).toBe(401);
    }
    // a signature computed for another passcode (someone who guessed the format but not the secret)
    const other = await (async () => {
      const { issueSession } = await import("@/application/operator-session");
      return issueSession("a-different-passcode-entirely-0000", Date.now());
    })();
    const res = await call(
      capture,
      request("POST", "/x", {
        body: {},
        headers: { cookie: `pp_operator=${other.token}`, "x-csrf-token": other.csrfToken },
      }),
    );
    expect(res.status).toBe(401);
  });

  it("the login is throttled and never says which part was wrong", async () => {
    boot();
    const login = routes.find(
      (r) => r.file === "operator/session/route.ts" && r.method === "POST",
    ) as Entry;
    const attempt = (passcode: string) =>
      call(login, request("POST", "/api/operator/session", { body: { passcode } }));
    const first = await attempt("wrong-one");
    expect(first.status).toBe(401);
    expect((await bodyOf(first)).message).toBe("Incorrect passcode.");
    for (let i = 0; i < 4; i++) await attempt(`wrong-${i}`);
    const locked = await attempt("a-long-operator-passcode-for-tests"); // even the right one is refused while locked
    expect(locked.status).toBe(429);
    expect(locked.headers.get("retry-after")).toBe("60");
  });
});

describe("hostile input never produces an unhandled error", () => {
  const IDS = [
    "x'; DROP TABLE transactions; --",
    "' OR '1'='1",
    "../../etc/passwd",
    "a".repeat(500),
    "%00",
    "<script>alert(1)</script>",
    "‮evil",
    "💥".repeat(40),
    "",
  ];
  const BODIES: unknown[] = [
    {},
    [],
    null,
    "text",
    7,
    { __proto__: { admin: true } },
    JSON.parse('{"__proto__":{"isOperator":true},"constructor":{"prototype":{"x":1}}}'),
    { amountMinor: 1, currency: "EUR", payee: "x", total: -1 },
    { a: "x".repeat(10_000) },
    { n: Number.MAX_VALUE },
    { fields: { maxTransactionAmount: "9".repeat(400) } },
  ];

  it("returns a handled status (never a bare 500) for hostile ids and bodies on every operator route", async () => {
    boot();
    session = await signIn();
    const bad: string[] = [];
    const leaks: string[] = [];
    for (const r of routes) {
      if (PUBLIC[key(r)] !== undefined) continue;
      for (const id of IDS) {
        for (const body of r.method === "GET" ? [undefined] : BODIES) {
          const handlerCtx = { params: Promise.resolve({ id, pid: id, scenarioId: id }) };
          const req = request(r.method, `/api/${r.file}`, {
            s: session,
            ...(body === undefined ? {} : { body }),
          });
          const res = await Promise.resolve(r.handler(req, handlerCtx));
          const text = await res.text();
          if (res.status === 500 || res.status === 502)
            bad.push(
              `${key(r)} id=${JSON.stringify(id).slice(0, 20)} body=${JSON.stringify(body)?.slice(0, 30)} -> ${res.status} ${text.slice(0, 80)}`,
            );
          if (/SQLITE|constraint failed|at\s+\S+\s+\(|node_modules|\.ts:\d+|Error:/.test(text))
            leaks.push(`${key(r)} -> ${text.slice(0, 120)}`);
        }
      }
    }
    expect(bad.slice(0, 10)).toEqual([]);
    expect(leaks.slice(0, 10)).toEqual([]);
  }, 120_000);
});
