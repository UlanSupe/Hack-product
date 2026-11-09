/* eslint-disable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-explicit-any -- these tests inspect untyped API JSON structurally */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { createAnthropicTransport } from "@/adapters/llm/anthropic";
import { openDatabase } from "@/adapters/sqlite/database";
import { migrate } from "@/adapters/sqlite/migrate";
import { seedDevelopment } from "@/adapters/sqlite/seed";
import { GET as overview, POST as openNegotiation } from "@/app/api/negotiations/route";
import { POST as runDemo } from "@/app/api/negotiations/[id]/demo/route";
import { POST as login } from "@/app/api/operator/session/route";
import { createNegotiationDemo } from "@/application/negotiation-demo";
import { ConflictError, ForbiddenError } from "@/domain/errors";
import { loginThrottle } from "@/server/operator-guard";

import { AGENT, ANON, OP, makeWorld } from "../negotiation/world";
import { KEY, MODEL, fetchDelegatingTo, fetchStub, providerError } from "./helpers";

const PASSCODE = "a-long-operator-passcode-for-tests";
const BASE = "http://localhost:3000";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  loginThrottle.reset();
});

function boot(env: Record<string, string> = {}) {
  const file = join(mkdtempSync(join(tmpdir(), "pactpay-llm-api-")), "t.db");
  const db = openDatabase(file);
  migrate(db);
  seedDevelopment(db, new Date().toISOString());
  db.close();
  vi.stubEnv("DATABASE_PATH", file);
  vi.stubEnv("OPERATOR_PASSCODE", PASSCODE);
  for (const [k, v] of Object.entries(env)) vi.stubEnv(k, v);
  return {
    count: (table: string) => {
      const d = openDatabase(file, { readOnly: true });
      const n = (d.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
      d.close();
      return n;
    },
  };
}

const LLM_ENV = { AGENT_MODE: "llm", AGENT_MODEL: MODEL, ANTHROPIC_API_KEY: KEY };

type Session = { cookie: string; csrf: string };
function request(method: string, path: string, body?: unknown, s?: Session): Request {
  const headers: Record<string, string> = {};
  if (body !== undefined) headers["content-type"] = "application/json";
  if (s) {
    headers.cookie = s.cookie;
    headers["x-csrf-token"] = s.csrf;
  }
  if (method !== "GET") headers.origin = BASE;
  return new Request(`${BASE}${path}`, {
    method,
    headers,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}
const bodyOf = async (res: Response) => (await res.json()) as Record<string, any>;
const idCtx = (id: string) => ({ params: Promise.resolve({ id }) });

async function signIn(): Promise<Session> {
  const res = await login(request("POST", "/api/operator/session", { passcode: PASSCODE }));
  const cookie = (res.headers.get("set-cookie") ?? "").split(";")[0] as string;
  const { csrfToken } = (await res.json()) as { csrfToken: string };
  return { cookie, csrf: csrfToken };
}
async function openOne(s: Session): Promise<string> {
  const res = await openNegotiation(
    request(
      "POST",
      "/api/negotiations",
      {
        mandateId: "M1",
        category: "COMPUTE",
        quantity: 1,
        summary: "One GPU pack",
        maxTotal: null,
        neededWithinDays: null,
        requiredDeliverables: [],
        invitedSellerIds: ["seller_acme", "seller_backup_demo"],
        timeoutMinutes: 60,
      },
      s,
    ),
  );
  return (await bodyOf(res)).negotiation.id as string;
}

describe("the model is opt-in, per run, and only when configured", () => {
  it("without AGENT_MODE=llm there is no model, the overview says so, and asking for one is refused with no network call", async () => {
    boot();
    const fetch = fetchStub(providerError(500, "api_error"));
    vi.stubGlobal("fetch", fetch);
    const s = await signIn();
    expect(
      (await bodyOf(await overview(request("GET", "/api/negotiations", undefined, s)))).agents,
    ).toEqual({
      modelAvailable: false,
    });
    const id = await openOne(s);
    const res = await runDemo(request("POST", "/x", { agents: "model" }, s), idCtx(id));
    expect(res.status).toBe(409);
    expect(JSON.stringify(await bodyOf(res))).toMatch(/No model provider is configured/);
    expect(fetch.calls).toHaveLength(0);
  });

  it("with AGENT_MODE=llm the overview offers the model, but the default run still uses the mocks and makes no provider call", async () => {
    boot(LLM_ENV);
    const fetch = fetchDelegatingTo();
    vi.stubGlobal("fetch", fetch);
    const s = await signIn();
    expect(
      (await bodyOf(await overview(request("GET", "/api/negotiations", undefined, s)))).agents,
    ).toEqual({
      modelAvailable: true,
    });
    const id = await openOne(s);
    for (const body of [{}, { agents: "mock" }]) {
      const res = await runDemo(request("POST", "/x", body, s), idCtx(id));
      expect(res.status, JSON.stringify(body)).toBe(200);
      expect((await bodyOf(res)).demo.source).toBe("mock");
    }
    expect(fetch.calls).toHaveLength(0);
  });

  it("an explicit model run goes through the provider adapter and records proposals like the mocks do; nothing is accepted, approved or paid", async () => {
    const db = boot(LLM_ENV);
    const fetch = fetchDelegatingTo();
    vi.stubGlobal("fetch", fetch);
    const s = await signIn();
    const id = await openOne(s);
    const res = await runDemo(request("POST", "/x", { agents: "model" }, s), idCtx(id));
    expect(res.status).toBe(200);
    const body = await bodyOf(res);
    expect(body.demo.source).toBe("model");
    expect(body.demo.problems).toEqual([]);
    expect(body.demo.recorded.offers).toBeGreaterThanOrEqual(1);
    expect(fetch.calls.length).toBeGreaterThanOrEqual(1);
    for (const c of fetch.calls) {
      expect(c.url).toBe("https://api.anthropic.com/v1/messages");
      expect(c.headers["x-api-key"]).toBe(KEY);
      expect(Object.keys(c.body).sort()).toEqual(["max_tokens", "messages", "model", "system"]);
    }
    expect(body.negotiation.status).toBe("OPEN");
    expect(db.count("negotiation_agreements")).toBe(0);
    expect(db.count("transaction_approvals")).toBe(0);
    expect(db.count("transactions")).toBe(0);
    expect(db.count("payment_attempts")).toBe(0);
    expect(JSON.stringify(body)).not.toContain(KEY);
  });

  it("a model run and a mock run produce the same recorded result when the provider answers like the mock does", async () => {
    boot(LLM_ENV);
    vi.stubGlobal("fetch", fetchDelegatingTo());
    const s = await signIn();
    const a = await bodyOf(
      await runDemo(request("POST", "/x", { agents: "mock" }, s), idCtx(await openOne(s))),
    );
    const b = await bodyOf(
      await runDemo(request("POST", "/x", { agents: "model" }, s), idCtx(await openOne(s))),
    );
    expect([b.demo.status, b.demo.recorded, b.demo.steps]).toEqual([
      a.demo.status,
      a.demo.recorded,
      a.demo.steps,
    ]);
  });

  it("a provider that is down or rate limited yields a clear AGENT_FAILURE: nothing recorded, nothing paid, no key in the response", async () => {
    const db = boot({ ...LLM_ENV, AGENT_TIMEOUT_MS: "2000", AGENT_MAX_ATTEMPTS: "2" });
    const fetch = fetchStub(providerError(429, "rate_limit_error", { "retry-after": "0" }));
    vi.stubGlobal("fetch", fetch);
    const s = await signIn();
    const id = await openOne(s);
    const res = await runDemo(request("POST", "/x", { agents: "model" }, s), idCtx(id));
    expect(res.status).toBe(200);
    const text = JSON.stringify(await res.clone().json());
    const body = await bodyOf(res);
    expect(body.demo.status).toBe("AGENT_FAILURE");
    expect(body.demo.recorded).toEqual({ offers: 0, counters: 0 });
    expect(fetch.calls.length).toBeGreaterThanOrEqual(1);
    expect(db.count("negotiation_proposals")).toBe(0);
    expect(db.count("transactions")).toBe(0);
    expect(text).not.toContain(KEY);
    expect(text).not.toContain("secret detail");
  });

  it("rejects an unknown or extended body before doing anything", async () => {
    boot(LLM_ENV);
    const fetch = fetchStub(providerError(500, "api_error"));
    vi.stubGlobal("fetch", fetch);
    const s = await signIn();
    const id = await openOne(s);
    for (const bad of [{ agents: "gpt" }, { agents: "model", model: "other" }, { agents: 1 }, []]) {
      const res = await runDemo(request("POST", "/x", bad, s), idCtx(id));
      expect(res.status, JSON.stringify(bad)).toBe(400);
    }
    expect(fetch.calls).toHaveLength(0);
  });

  it("an anonymous caller cannot trigger a model run", async () => {
    boot(LLM_ENV);
    const fetch = fetchStub(providerError(500, "api_error"));
    vi.stubGlobal("fetch", fetch);
    const res = await runDemo(request("POST", "/x", { agents: "model" }), idCtx("x"));
    expect(res.status).toBe(401);
    expect(fetch.calls).toHaveLength(0);
  });
});

describe("model runs are operator-only, one at a time, and rate limited", () => {
  const liveWith = (
    fetch: ReturnType<typeof fetchStub>,
    extra: { maxRuns?: number; now?: () => number } = {},
  ) => ({
    transport: createAnthropicTransport({ apiKey: KEY, model: MODEL, fetch }),
    runtime: { timeoutMs: 1000, maxAttempts: 1, totalDeadlineMs: 2000 },
    ...extra,
  });

  it("agents and anonymous callers cannot start any run, and nothing is sent", async () => {
    const w = makeWorld();
    const fetch = fetchDelegatingTo();
    const demo = createNegotiationDemo({ service: w.svc, store: w.store, live: liveWith(fetch) });
    const neg = w.open();
    for (const who of [AGENT, ANON]) {
      await expect(demo.run(who, neg.id, "model")).rejects.toThrow(ForbiddenError);
      await expect(demo.run(who, neg.id, "mock")).rejects.toThrow(ForbiddenError);
    }
    expect(fetch.calls).toHaveLength(0);
  });

  it("limits model runs per window and frees the slot as the window passes", async () => {
    const w = makeWorld();
    let t = 1_000_000;
    const demo = createNegotiationDemo({
      service: w.svc,
      store: w.store,
      live: liveWith(fetchDelegatingTo(), { maxRuns: 2, now: () => t }),
    });
    const neg = w.open();
    await demo.run(OP, neg.id, "model");
    await demo.run(OP, neg.id, "model");
    await expect(demo.run(OP, neg.id, "model")).rejects.toThrow(/Too many model runs/);
    await demo.run(OP, neg.id, "mock"); // mocks are never limited
    t += 600_000;
    await expect(demo.run(OP, neg.id, "model")).resolves.toMatchObject({ source: "model" });
  });

  it("runs at most one model run at a time", async () => {
    const w = makeWorld();
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => (release = resolve));
    const inner = fetchDelegatingTo();
    const slow = fetchStub(async (call) => {
      await gate;
      return inner(call.url, {
        method: "POST",
        headers: call.headers,
        body: JSON.stringify(call.body),
        signal: new AbortController().signal,
      });
    });
    const demo = createNegotiationDemo({ service: w.svc, store: w.store, live: liveWith(slow) });
    const neg = w.open();
    const first = demo.run(OP, neg.id, "model");
    await expect(demo.run(OP, neg.id, "model")).rejects.toThrow(ConflictError);
    release();
    await first;
    await expect(demo.run(OP, neg.id, "model")).resolves.toBeDefined();
  });

  it("a failed run still frees the slot", async () => {
    const w = makeWorld();
    const demo = createNegotiationDemo({
      service: w.svc,
      store: w.store,
      live: liveWith(fetchStub(providerError(401, "authentication_error"))),
    });
    const neg = w.open();
    const out = await demo.run(OP, neg.id, "model");
    expect(out.status).toBe("AGENT_FAILURE");
    await expect(demo.run(OP, neg.id, "model")).resolves.toMatchObject({ status: "AGENT_FAILURE" });
  });
});
