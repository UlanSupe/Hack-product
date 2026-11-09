import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { openDatabase, one } from "@/adapters/sqlite/database";
import { prepareDatabase } from "@/adapters/sqlite/bootstrap";
import { GET as getFlagship } from "@/app/api/flagship/route";
import { GET as getHealth } from "@/app/api/health/route";
import { GET as paypalReturn } from "@/app/api/paypal/return/route";
import { RateWindow } from "@/application/rate-window";
import { parseEnv, type EnvIssue } from "@/config/env.schema";
import { assertSameOrigin, loginThrottle } from "@/server/operator-guard";
import { PUBLIC_COMPUTE_PER_MINUTE, publicCompute, takePublicCompute } from "@/server/public-limit";

import { bodyOf, boot, signIn } from "../payments/api-harness";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
  publicCompute.reset();
  loginThrottle.reset();
});

const PASS = "a-long-operator-passcode-for-tests";
const DEMO = {
  DEPLOY_MODE: "demo",
  APP_BASE_URL: "https://pactpay-arena.onrender.com",
  OPERATOR_PASSCODE: PASS,
};
const issues = (raw: Record<string, string | undefined>): EnvIssue[] => {
  const r = parseEnv(raw);
  return r.ok ? [] : r.issues;
};
const tmp = () => mkdtempSync(join(tmpdir(), "pactpay-deploy-"));

describe("demo-mode configuration is validated at startup", () => {
  it("a complete demo configuration is accepted, and PayPal credentials stay optional", () => {
    const r = parseEnv(DEMO);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.env.PAYPAL_CLIENT_ID).toBeUndefined();
  });

  it("refuses a non-https or localhost base URL, and a missing operator passcode, naming the variable only", () => {
    expect(
      issues({ ...DEMO, APP_BASE_URL: "http://pactpay.example" }).map((i) => i.path),
    ).toContain("APP_BASE_URL");
    expect(
      issues({ ...DEMO, APP_BASE_URL: "https://localhost:3000" }).map((i) => i.path),
    ).toContain("APP_BASE_URL");
    expect(issues({ ...DEMO, OPERATOR_PASSCODE: undefined }).map((i) => i.path)).toContain(
      "OPERATOR_PASSCODE",
    );
    // placeholders from the template count as unset, so a copied example file cannot start a public demo
    expect(
      issues({ ...DEMO, OPERATOR_PASSCODE: "replace-with-a-long-random-passcode" }).map(
        (i) => i.path,
      ),
    ).toContain("OPERATOR_PASSCODE");
  });

  it("falls back to the platform's own URL when APP_BASE_URL is unset, and an explicit one always wins", () => {
    const fromPlatform = parseEnv({
      DEPLOY_MODE: "demo",
      OPERATOR_PASSCODE: PASS,
      RENDER_EXTERNAL_URL: "https://my-demo.onrender.com",
    });
    expect(fromPlatform.ok && fromPlatform.env.APP_BASE_URL).toBe("https://my-demo.onrender.com");
    const explicit = parseEnv({
      ...DEMO,
      APP_BASE_URL: "https://demo.example.org",
      RENDER_EXTERNAL_URL: "https://my-demo.onrender.com",
    });
    expect(explicit.ok && explicit.env.APP_BASE_URL).toBe("https://demo.example.org");
    // the fallback applies only in demo mode: a local run never adopts a platform URL
    const local = parseEnv({ RENDER_EXTERNAL_URL: "https://my-demo.onrender.com" });
    expect(local.ok && local.env.APP_BASE_URL).toBe("http://localhost:3000");
  });

  it("local mode is unchanged, and an unknown mode is refused", () => {
    expect(parseEnv({}).ok).toBe(true);
    expect(issues({ DEPLOY_MODE: "production" }).map((i) => i.path)).toContain("DEPLOY_MODE");
  });

  it("PayPal stays sandbox-only in demo mode, and a secret behind NEXT_PUBLIC_ is still refused", () => {
    expect(issues({ ...DEMO, PAYPAL_ENV: "live" }).map((i) => i.path)).toContain("PAYPAL_ENV");
    expect(
      issues({ ...DEMO, PAYPAL_API_BASE: "https://api-m.paypal.com" }).map((i) => i.path),
    ).toContain("PAYPAL_API_BASE");
    expect(issues({ ...DEMO, NEXT_PUBLIC_PAYPAL_SECRET: "x" }).map((i) => i.path)).toContain(
      "NEXT_PUBLIC_PAYPAL_SECRET",
    );
  });
});

describe("the start script refuses a bad configuration before serving anything", () => {
  const run = (env: Record<string, string>) =>
    spawnSync(process.execPath, ["scripts/start.ts"], {
      encoding: "utf8",
      timeout: 30_000,
      // an empty base: nothing from the developer's own environment or .env files can leak into the run
      env: {
        NODE_ENV: "production",
        PATH: process.env.PATH ?? "",
        SystemRoot: process.env.SystemRoot ?? "",
        ...env,
      },
    });

  it("exits 1 for an invalid configuration, printing variable names and never values", () => {
    const secret = "short-secret";
    const r = run({
      DEPLOY_MODE: "demo",
      NODE_ENV: "production",
      OPERATOR_PASSCODE: secret,
      APP_BASE_URL: "http://x.test",
    });
    expect(r.status).toBe(1);
    const out = `${r.stdout}${r.stderr}`;
    expect(out).toContain("refusing to start");
    expect(out).toContain("OPERATOR_PASSCODE");
    expect(out).toContain("APP_BASE_URL");
    expect(out).not.toContain(secret);
  });

  it("refuses demo mode outside NODE_ENV=production and a nonsense PORT", () => {
    const base = { ...DEMO, DATABASE_PATH: join(tmp(), "x.db") };
    const notProd = run({ ...base, NODE_ENV: "development" });
    expect(notProd.status).toBe(1);
    expect(notProd.stderr).toContain("NODE_ENV");
    const badPort = run({ ...base, NODE_ENV: "production", PORT: "99999" });
    expect(badPort.status).toBe(1);
    expect(badPort.stderr).toContain("PORT");
  });

  it("does not create a database when the configuration is refused", () => {
    const dir = tmp();
    const path = join(dir, "never.db");
    run({ ...DEMO, DATABASE_PATH: path, NODE_ENV: "development" });
    expect(existsSync(path)).toBe(false);
  });

  it("does not load an .env file (a hosted instance reads only its environment)", () => {
    expect(readFileSync("scripts/start.ts", "utf8")).not.toMatch(/loadEnvFile|dotenv/);
  });
});

describe("migrations and demo data at startup", () => {
  it("creates the directory and file, applies every migration, seeds the synthetic demo data, and verifies the chain", () => {
    const path = join(tmp(), "nested", "dir", "p.db");
    const first = prepareDatabase(path, { seed: true, now: "2026-11-05T00:00:00.000Z" });
    expect(first.applied.length).toBeGreaterThanOrEqual(8);
    expect(first).toMatchObject({ seeded: true, chain: "VERIFIED" });
    const db = openDatabase(path, { readOnly: true });
    try {
      expect(one<{ n: number }>(db, "SELECT COUNT(*) AS n FROM sellers")?.n).toBe(2);
      expect(one<{ n: number }>(db, "SELECT COUNT(*) AS n FROM mandates")?.n).toBe(1);
    } finally {
      db.close();
    }
  });

  it("is idempotent: a restart applies nothing and seeds nothing twice", () => {
    const path = join(tmp(), "p.db");
    prepareDatabase(path, { seed: true, now: "2026-11-05T00:00:00.000Z" });
    const again = prepareDatabase(path, { seed: true, now: "2026-11-06T00:00:00.000Z" });
    expect(again.applied).toEqual([]);
    expect(again.seeded).toBe(false);
    expect(again.chain).toBe("VERIFIED");
  });

  it("seeds only when asked: a local start leaves the database empty", () => {
    const path = join(tmp(), "p.db");
    const r = prepareDatabase(path, { seed: false, now: "2026-11-05T00:00:00.000Z" });
    expect(r.seeded).toBe(false);
    const db = openDatabase(path, { readOnly: true });
    try {
      expect(one<{ n: number }>(db, "SELECT COUNT(*) AS n FROM sellers")?.n).toBe(0);
    } finally {
      db.close();
    }
  });
});

describe("health check", () => {
  const demoEnv = (path: string) => {
    for (const [k, v] of Object.entries({ ...DEMO, DATABASE_PATH: path })) vi.stubEnv(k, v);
  };

  it("demo mode: 503 'degraded' until the database is migrated, then 200 'ok'; never any secret or path", async () => {
    const path = join(tmp(), "h.db");
    demoEnv(path);
    const before = getHealth();
    expect(before.status).toBe(503);
    expect((await bodyOf(before)).status).toBe("degraded");
    prepareDatabase(path, { seed: true, now: new Date().toISOString() });
    const after = getHealth();
    expect(after.status).toBe(200);
    const body = await bodyOf(after);
    expect(body).toMatchObject({ status: "ok", deployMode: "demo", database: { state: "ready" } });
    const text = JSON.stringify(body);
    expect(text).not.toContain(PASS);
    expect(text).not.toContain(path);
    expect(after.headers.get("cache-control")).toBe("no-store");
  });

  it("local mode without a database still answers 200, so a fresh checkout can show the Arena", () => {
    vi.stubEnv("DATABASE_PATH", join(tmp(), "none.db"));
    vi.stubEnv("DEPLOY_MODE", "local");
    expect(getHealth().status).toBe(200);
  });

  it("an invalid configuration is a 503 that names variables, not values", async () => {
    vi.stubEnv("DEPLOY_MODE", "demo");
    vi.stubEnv("APP_BASE_URL", "http://insecure.test");
    vi.stubEnv("OPERATOR_PASSCODE", "");
    const res = getHealth();
    expect(res.status).toBe(503);
    const text = JSON.stringify(await bodyOf(res));
    expect(text).toContain("APP_BASE_URL");
    expect(text).not.toContain("insecure.test");
  });
});

describe("behind a TLS-terminating proxy", () => {
  it("accepts the browser's public origin even though the server sees an internal URL", () => {
    vi.stubEnv("APP_BASE_URL", "https://pactpay-arena.onrender.com");
    const internal = "http://10.0.0.5:10000/api/negotiations";
    const ok = new Request(internal, {
      method: "POST",
      headers: { origin: "https://pactpay-arena.onrender.com" },
    });
    expect(() => assertSameOrigin(ok)).not.toThrow();
  });

  it("still refuses a foreign origin, a look-alike origin and a cross-site fetch", () => {
    vi.stubEnv("APP_BASE_URL", "https://pactpay-arena.onrender.com");
    const internal = "http://10.0.0.5:10000/api/negotiations";
    for (const origin of [
      "https://evil.example",
      "https://pactpay-arena.onrender.com.evil.example",
      "http://pactpay-arena.onrender.com",
      "null",
    ])
      expect(
        () => assertSameOrigin(new Request(internal, { method: "POST", headers: { origin } })),
        origin,
      ).toThrow();
    expect(() =>
      assertSameOrigin(
        new Request(internal, {
          method: "POST",
          headers: { origin: "https://pactpay-arena.onrender.com", "sec-fetch-site": "cross-site" },
        }),
      ),
    ).toThrow();
  });

  it("the PayPal return redirect goes to the public URL, never to the internal address", async () => {
    boot();
    const s = await signIn();
    vi.stubEnv("APP_BASE_URL", "https://pactpay-arena.onrender.com");
    const res = await paypalReturn(
      new Request("http://10.0.0.5:10000/api/paypal/return?token=not-a-valid-id!", {
        headers: { cookie: s.cookie },
      }),
    );
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe(
      "https://pactpay-arena.onrender.com/negotiations?payment=unknown",
    );
  });
});

describe("response headers for a hosted demo", () => {
  const headersFor = async (mode: string) => {
    vi.resetModules();
    vi.stubEnv("DEPLOY_MODE", mode);
    const { default: config } = await import("../../next.config");
    const rules = await (
      config.headers as () => Promise<{ headers: { key: string; value: string }[] }[]>
    )();
    return Object.fromEntries((rules[0]?.headers ?? []).map((h) => [h.key, h.value]));
  };

  it("demo mode adds HSTS and noindex on top of the baseline headers", async () => {
    const h = await headersFor("demo");
    expect(h["Strict-Transport-Security"]).toBe("max-age=15552000");
    expect(h["X-Robots-Tag"]).toBe("noindex, nofollow");
    expect(h["X-Frame-Options"]).toBe("DENY");
    expect(h["X-Content-Type-Options"]).toBe("nosniff");
    expect(h["Permissions-Policy"]).toContain("payment=()");
  });

  it("local mode never sends HSTS (a developer's http://localhost must not be pinned to https)", async () => {
    const h = await headersFor("local");
    expect(h["Strict-Transport-Security"]).toBeUndefined();
    expect(h["X-Frame-Options"]).toBe("DENY");
  });
});

describe("protection for the public pages that cost CPU", () => {
  it("RateWindow allows `max` events per window and recovers as the window slides", () => {
    const w = new RateWindow(3, 1_000);
    expect([0, 100, 200, 300].map((t) => w.take(t))).toEqual([true, true, true, false]);
    expect(w.take(1_050)).toBe(true); // the first event has left the window
    expect(w.take(1_060)).toBe(false);
  });

  it("the replay answers 429 with Retry-After once the cap is reached, and recovers", async () => {
    const now = Date.now();
    for (let i = 0; i < PUBLIC_COMPUTE_PER_MINUTE; i++) takePublicCompute(now);
    expect(() => takePublicCompute(now + 1)).toThrow(/busy/);
    const limited = getFlagship(new Request("http://localhost:3000/api/flagship"));
    expect(limited.status).toBe(429);
    expect(limited.headers.get("retry-after")).toBe("30");
    expect((await bodyOf(limited)).error).toBe("BUSY");
    publicCompute.reset();
    expect(getFlagship(new Request("http://localhost:3000/api/flagship")).status).toBe(200);
  });

  it("the cap is generous for people: a normal burst is never limited", () => {
    for (let i = 0; i < 20; i++) expect(() => takePublicCompute(5_000 + i)).not.toThrow();
  });
});

describe("render.yaml (the Blueprint) holds no secret and matches the app", () => {
  const yaml = readFileSync("render.yaml", "utf8");
  const pkg = JSON.parse(readFileSync("package.json", "utf8")) as {
    scripts: Record<string, string>;
    engines: { node: string };
  };
  const vars = [
    ...yaml.matchAll(/- key: (\w+)\n((?:\s+(?:value|sync|generateValue):[^\n]*\n)*)/g),
  ].map((m) => ({ key: m[1] as string, body: m[2] as string }));
  const var_ = (k: string) => vars.find((v) => v.key === k);

  it("every secret is generated by the platform or prompted for in its dashboard, never written here", () => {
    for (const k of [
      "OPERATOR_PASSCODE",
      "PAYPAL_CLIENT_ID",
      "PAYPAL_CLIENT_SECRET",
      "PAYPAL_WEBHOOK_ID",
      "PAYPAL_MERCHANT_ID",
    ]) {
      const v = var_(k);
      expect(v, k).toBeDefined();
      expect(v?.body, k).not.toMatch(/value:/);
      expect(v?.body, k).toMatch(/generateValue: true|sync: false/);
    }
    expect(yaml).not.toMatch(/NEXT_PUBLIC_/);
    expect(yaml).not.toMatch(/ANTHROPIC_API_KEY/);
    expect(yaml).not.toMatch(/[A-Za-z0-9+/]{40,}={0,2}/); // no long base64-looking string
  });

  it("declares a demo, sandbox-only, scripted-agent, single-instance service", () => {
    expect(var_("DEPLOY_MODE")?.body).toContain("value: demo");
    expect(var_("PAYPAL_ENV")?.body).toContain("value: sandbox");
    expect(var_("AGENT_MODE")?.body).toContain("value: scripted");
    expect(var_("NODE_ENV")?.body).toContain("value: production");
    expect(yaml).toMatch(/plan: free/);
    expect(yaml.split("\n").filter((l) => /^\s*(numInstances|scaling):/.test(l))).toEqual([]);
  });

  it("uses commands and a health path that exist", () => {
    expect(yaml).toMatch(/startCommand: npm run start:demo/);
    expect(pkg.scripts["start:demo"]).toBe("node scripts/start.ts");
    expect(yaml).toMatch(
      /buildCommand: npm ci --include=dev && npm run build && npm run benchmark/,
    );
    expect(pkg.scripts.build).toBe("next build");
    expect(yaml).toMatch(/healthCheckPath: \/api\/health/);
    expect(existsSync("src/app/api/health/route.ts")).toBe(true);
    expect(existsSync("scripts/start.ts")).toBe(true);
  });

  it("pins the Node version the app was tested on, consistently", () => {
    const pinned = /key: NODE_VERSION\n\s+value: ([\d.]+)/.exec(yaml)?.[1];
    expect(pinned).toBe(readFileSync(".node-version", "utf8").trim());
    expect(Number((pinned ?? "0").split(".")[0])).toBeGreaterThanOrEqual(22);
    expect(pkg.engines.node).toMatch(/>=22\.18/); // native TypeScript stripping, which scripts/*.ts rely on
  });

  it("the template for local use stays free of the hosted settings' secrets", () => {
    const example = readFileSync(".env.example", "utf8");
    expect(example).toMatch(/DEPLOY_MODE/);
    expect(example).not.toMatch(/^DEPLOY_MODE=demo/m);
    expect(example).toMatch(/OPERATOR_PASSCODE=replace-with-/);
  });
});

describe("a hosted demo says so on every page", () => {
  it("shows a 'Public demo' chip only in demo mode", async () => {
    const { renderToStaticMarkup } = await import("react-dom/server");
    const { JourneyHeader } = await import("@/app/_journey/journey-header");
    vi.stubEnv("DEPLOY_MODE", "demo");
    expect(renderToStaticMarkup(JourneyHeader({ current: "start" }))).toContain("Public demo");
    vi.stubEnv("DEPLOY_MODE", "local");
    expect(renderToStaticMarkup(JourneyHeader({ current: "start" }))).not.toContain("Public demo");
  });
});
