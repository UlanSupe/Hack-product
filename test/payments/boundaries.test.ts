import { spawnSync } from "node:child_process";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

import { describe, expect, it } from "vitest";

import { parseEnv } from "@/config/env.schema";

import { TEST_CLIENT_ID, TEST_CLIENT_SECRET, TEST_MERCHANT, TEST_TOKEN } from "./http-paypal";

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) return sourceFiles(p);
    return /\.(ts|tsx)$/.test(name) && !/\.test\.tsx?$/.test(name) ? [p] : [];
  });
}
const rel = (p: string) => relative(".", p).replaceAll("\\", "/");
const SRC = sourceFiles("src").map((p) => ({ path: rel(p), text: readFileSync(p, "utf8") }));
const importsOf = (text: string) =>
  [...text.matchAll(/from\s+["']([^"']+)["']/g)].map((m) => m[1] ?? "");

describe("provider calls stay out of UI components and policy evaluation", () => {
  it("only the server's composition roots (payments, webhooks) import the PayPal adapter", () => {
    const users = SRC.filter((f) => importsOf(f.text).some((i) => /adapters\/paypal/.test(i))).map(
      (f) => f.path,
    );
    expect(users).toEqual(["src/server/payment-service.ts", "src/server/webhook-service.ts"]);
  });

  it("the policy engine and the domain layer never import a provider, an adapter or the payment service", () => {
    const guarded = SRC.filter((f) => f.path.startsWith("src/domain/"));
    expect(guarded.length).toBeGreaterThan(10);
    for (const f of guarded) {
      for (const spec of importsOf(f.text)) {
        expect(spec, f.path).not.toMatch(
          /payment-provider|payment-store|adapters|application|\/server\//,
        );
      }
      expect(f.text, f.path).not.toMatch(/\bfetch\(|XMLHttpRequest|node:https?|node:net/);
    }
    // the engine itself does not even know the PayPal vocabulary beyond its own `observed` input
    const policy = SRC.find((f) => f.path === "src/domain/policy.ts")?.text ?? "";
    expect(importsOf(policy).filter((i) => /payment/.test(i))).toEqual([]);
  });

  it("negotiation and mandate services cannot start a payment: they import neither the payment service nor the provider", () => {
    for (const f of SRC.filter((s) =>
      /^src\/application\/(negotiations|negotiation-policy|negotiation-views|negotiation-demo|mandates)\.ts$/.test(
        s.path,
      ),
    )) {
      for (const spec of importsOf(f.text))
        expect(spec, f.path).not.toMatch(/payments|payment-provider|payment-store/);
    }
  });

  it("no client component reaches PayPal: no provider import, no PayPal host, no credential name", () => {
    const clients = SRC.filter((s) => /^\s*["']use client["']/.test(s.text));
    expect(clients.length).toBeGreaterThan(0);
    for (const f of clients) {
      for (const spec of importsOf(f.text)) {
        expect(spec, f.path).not.toMatch(
          /adapters|payment-provider|payment-store|payments$|\/server\//,
        );
      }
      expect(f.text, f.path).not.toMatch(
        /paypal\.com|PAYPAL_|client_secret|access_token|Authorization/i,
      );
    }
  });

  it("UI source outside the client console never fetches anything but this app's own API", () => {
    for (const f of SRC.filter((s) => s.path.startsWith("src/app/negotiations/"))) {
      for (const m of f.text.matchAll(/fetch\(\s*([^,)]+)/g)) {
        expect(m[1], f.path).toMatch(/^(path|`\/api\/|"\/api\/)/);
      }
    }
  });
});

describe("credentials", () => {
  it("the PayPal secret is read in exactly three source files: the env schema and the two composition roots (payments, webhooks)", () => {
    const readers = SRC.filter((f) => /PAYPAL_CLIENT_SECRET/.test(f.text))
      .map((f) => f.path)
      .sort();
    expect(readers).toEqual([
      "src/config/env.schema.ts",
      "src/server/payment-service.ts",
      "src/server/webhook-service.ts",
    ]);
    for (const f of SRC) expect(f.text, f.path).not.toMatch(/NEXT_PUBLIC_[A-Z_]*PAYPAL/);
  });

  it("the adapter has no logging, file, environment or shell surface, and one hard-coded host", () => {
    for (const path of ["src/adapters/paypal/client.ts", "src/adapters/paypal/provider.ts"]) {
      const text = SRC.find((f) => f.path === path)?.text ?? "";
      const code = text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
      expect(code, path).not.toMatch(
        /console\.|child_process|node:fs|\beval\(|new Function|require\(|process\.env|process\.std/,
      );
    }
    const hosts = new Set(
      ["client", "provider"].flatMap((n) =>
        [
          ...(SRC.find((f) => f.path === `src/adapters/paypal/${n}.ts`)?.text ?? "").matchAll(
            /https?:\/\/[a-z0-9.-]+/gi,
          ),
        ].map((m) => m[0]),
      ),
    );
    // the sandbox API host, plus the documented paypal.com checks on the approval link
    expect([...hosts].filter((h) => !/paypal\.com$/.test(h))).toEqual([]);
    expect([...hosts].filter((h) => h.includes("api-m"))).toEqual([
      "https://api-m.sandbox.paypal.com",
    ]);
  });

  it("the provider interface has capture and void but no refund, reauthorize or payout", () => {
    const port = SRC.find((f) => f.path === "src/ports/payment-provider.ts")?.text ?? "";
    const iface = port.slice(port.indexOf("export interface PaymentProvider"));
    expect(iface).toMatch(/createOrder/);
    expect(iface).toMatch(/getOrder/);
    expect(iface).toMatch(/authorizeOrder/);
    expect(iface).toMatch(/captureAuthorization/);
    expect(iface).toMatch(/voidAuthorization/);
    expect(iface).not.toMatch(/refund|payout|reauthorize/i);
  });
});

describe("environment settings", () => {
  const ok = (raw: Record<string, string>) => {
    const r = parseEnv(raw);
    if (!r.ok) throw new Error(JSON.stringify(r.issues));
    return r.env;
  };
  const paths = (raw: Record<string, string>) => {
    const r = parseEnv(raw);
    return r.ok ? [] : r.issues.map((i) => i.path);
  };

  it("PAYPAL_MERCHANT_ID, PAYPAL_TIMEOUT_MS and PAYPAL_EXPERIENCE_CONTEXT have safe defaults and bounds", () => {
    const d = ok({});
    expect([d.PAYPAL_MERCHANT_ID, d.PAYPAL_TIMEOUT_MS, d.PAYPAL_EXPERIENCE_CONTEXT]).toEqual([
      undefined,
      15_000,
      "payment_source",
    ]);
    expect(ok({ PAYPAL_MERCHANT_ID: "ABCDEFGH12345" }).PAYPAL_MERCHANT_ID).toBe("ABCDEFGH12345");
    expect(
      ok({ PAYPAL_MERCHANT_ID: "", PAYPAL_TIMEOUT_MS: "", PAYPAL_EXPERIENCE_CONTEXT: "" })
        .PAYPAL_TIMEOUT_MS,
    ).toBe(15_000);
    expect(ok({ PAYPAL_EXPERIENCE_CONTEXT: "application_context" }).PAYPAL_EXPERIENCE_CONTEXT).toBe(
      "application_context",
    );
    expect(ok({ PAYPAL_TIMEOUT_MS: "1000" }).PAYPAL_TIMEOUT_MS).toBe(1000);
    for (const bad of ["lower-case", "short", "ABC DEF12", "ABCDEFGH-1234"]) {
      expect(paths({ PAYPAL_MERCHANT_ID: bad }), bad).toContain("PAYPAL_MERCHANT_ID");
    }
    for (const bad of ["999", "60001", "abc", "1e3", "-5"]) {
      expect(paths({ PAYPAL_TIMEOUT_MS: bad }), bad).toContain("PAYPAL_TIMEOUT_MS");
    }
    expect(paths({ PAYPAL_EXPERIENCE_CONTEXT: "elsewhere" })).toContain(
      "PAYPAL_EXPERIENCE_CONTEXT",
    );
  });

  it("the sandbox is still the only environment, and a value is never echoed", () => {
    expect(paths({ PAYPAL_ENV: "live" })).toContain("PAYPAL_ENV");
    expect(paths({ PAYPAL_API_BASE: "https://api-m.paypal.com" })).toContain("PAYPAL_API_BASE");
    const r = parseEnv({ PAYPAL_MERCHANT_ID: "leaky-value-123" });
    expect(JSON.stringify(r)).not.toContain("leaky-value-123");
  });
});

describe("the PayPal smoke script (the real script, against an in-process fake instead of the network)", () => {
  const run = (args: string[], env: Record<string, string>, fake = true) =>
    spawnSync(
      process.execPath,
      [
        ...(fake ? ["--import", "./test/payments/smoke-preload.ts"] : []),
        "scripts/paypal-smoke.ts",
        ...args,
      ],
      {
        encoding: "utf8",
        env: {
          NODE_ENV: "test",
          PATH: process.env.PATH ?? "",
          SystemRoot: process.env.SystemRoot ?? "",
          PAYPAL_CLIENT_ID: "",
          PAYPAL_CLIENT_SECRET: "",
          PAYPAL_MERCHANT_ID: "",
          PAYPAL_WEBHOOK_ID: "",
          // the child reads .env.local when present; pin what the test depends on so a developer's real file cannot change it
          AGENT_MODE: "scripted",
          ...env,
        },
        timeout: 60_000,
      },
    );
  const CREDS = { PAYPAL_CLIENT_ID: TEST_CLIENT_ID, PAYPAL_CLIENT_SECRET: TEST_CLIENT_SECRET };

  it("without credentials it makes no call, says SKIPPED and NOT VERIFIED, and exits 0 (3 with --require)", () => {
    const soft = run([], {}, false);
    expect(soft.status).toBe(0);
    expect(soft.stdout).toMatch(/SKIPPED/);
    expect(soft.stdout).toMatch(/NOT VERIFIED/);
    expect(soft.stdout).not.toMatch(/VERIFIED by this run/);
    expect(run(["--require"], {}, false).status).toBe(3);
  });

  it("with credentials it reports the token's metadata only, and never a secret", () => {
    const r = run([], CREDS);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("PayPal sandbox issued an access token");
    expect(r.stdout).toContain("https://uri.paypal.com/services/payments/payment");
    expect(r.stdout).toContain("token acquisition VERIFIED by this run");
    expect(r.stdout).toContain("No order was created");
    for (const s of [TEST_CLIENT_ID, TEST_CLIENT_SECRET, TEST_TOKEN])
      expect(`${r.stdout}${r.stderr}`).not.toContain(s);
  });

  it("--create-order creates and reads back ONE unapproved order and reports the payee id so it can be pinned", () => {
    const r = run(["--create-order"], CREDS);
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/created order 5O19\d+ \(HTTP 201, status CREATED\)/);
    expect(r.stdout).toContain(`payee merchant id reported by PayPal: ${TEST_MERCHANT}`);
    expect(r.stdout).toMatch(/payee check: NOT_PINNED/);
    expect(r.stdout).toContain("findings: none");
    expect(r.stdout).toContain("order creation and read-back VERIFIED by this run");
    expect(r.stdout).toMatch(/nothing authorized or charged/);
    for (const s of [TEST_CLIENT_ID, TEST_CLIENT_SECRET, TEST_TOKEN])
      expect(`${r.stdout}${r.stderr}`).not.toContain(s);
  });

  it("with the merchant configured the payee is verified", () => {
    const r = run(["--create-order"], { ...CREDS, PAYPAL_MERCHANT_ID: TEST_MERCHANT });
    expect(r.stdout).toMatch(/payee check: MATCH/);
    const wrong = run(["--create-order"], { ...CREDS, PAYPAL_MERCHANT_ID: "SOMEONEELSE1" });
    expect(wrong.status).toBe(1);
    expect(wrong.stdout).toContain("PAYEE_MISMATCH");
    expect(wrong.stdout).toContain("did NOT match what was sent");
    expect(wrong.stdout).not.toContain("VERIFIED by this run");
  });

  it("rejected credentials are reported as a failure without echoing anything", () => {
    const r = run([], {
      PAYPAL_CLIENT_ID: TEST_CLIENT_ID,
      PAYPAL_CLIENT_SECRET: "EwrongSandboxSecret0123456789abcdefgh",
    });
    expect(r.status).toBe(1);
    expect(r.stdout).toMatch(/FAILED: could not get an access token: kind=AUTH http=401/);
    expect(r.stdout).toContain("NOT verified");
    expect(`${r.stdout}${r.stderr}`).not.toMatch(/wrongSandboxSecret|invalid_client/);
  });

  it("a half-configured pair is a configuration error, not a skip", () => {
    const r = run([], { PAYPAL_CLIENT_ID: TEST_CLIENT_ID });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("PAYPAL_CLIENT_ID/PAYPAL_CLIENT_SECRET");
  });

  it("is wired as an npm script", () => {
    const pkg = JSON.parse(readFileSync("package.json", "utf8")) as {
      scripts: Record<string, string>;
    };
    expect(pkg.scripts["paypal:smoke"]).toBe("node scripts/paypal-smoke.ts");
  });
});

describe("identifiers", () => {
  it("production-shaped PayPal-Request-Ids stay within the documented UUID-sized (38 byte) guidance", () => {
    // newId("tx") gives "tx_" + 14 characters; the attempt derives pp:{tx}:{ACTION}:{seq}, seq at most 3.
    const tx = `tx_${"a".repeat(14)}`;
    for (const action of ["CREATE_ORDER", "AUTHORIZE"]) {
      for (const seq of [1, 2, 3]) {
        expect(
          Buffer.byteLength(`pp:${tx}:${action}:${seq}`),
          `${action} ${seq}`,
        ).toBeLessThanOrEqual(38);
      }
    }
    // and the seed of a real id in this code base is exactly that shape
    const ids = readFileSync("src/server/negotiation-service.ts", "utf8");
    expect(ids).toMatch(/\$\{prefix\}_\$\{randomUUID\(\)\.replaceAll\("-", ""\)\.slice\(0, 14\)\}/);
  });
});
