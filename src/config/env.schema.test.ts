import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { parseEnv, type Env } from "./env.schema";

const ok = (raw: Record<string, string | undefined>): Env => {
  const r = parseEnv(raw);
  if (!r.ok) throw new Error(`expected ok, got ${JSON.stringify(r.issues)}`);
  return r.env;
};
const issuesOf = (raw: Record<string, string | undefined>) => {
  const r = parseEnv(raw);
  if (r.ok) throw new Error("expected failure");
  return r.issues;
};

describe("parseEnv", () => {
  it("accepts an empty environment and applies safe sandbox defaults", () => {
    const env = ok({});
    expect(env.PAYPAL_ENV).toBe("sandbox");
    expect(env.PAYPAL_API_BASE).toBe("https://api-m.sandbox.paypal.com");
    expect(env.AGENT_MODE).toBe("scripted");
    expect(env.PAYPAL_CLIENT_ID).toBeUndefined();
  });

  it("rejects anything but PayPal sandbox", () => {
    expect(issuesOf({ PAYPAL_ENV: "live" }).map((i) => i.path)).toContain("PAYPAL_ENV");
    expect(issuesOf({ PAYPAL_ENV: "production" }).map((i) => i.path)).toContain("PAYPAL_ENV");
    expect(issuesOf({ PAYPAL_API_BASE: "https://api-m.paypal.com" }).map((i) => i.path)).toContain(
      "PAYPAL_API_BASE",
    );
  });

  it("requires PayPal client id and secret together", () => {
    expect(issuesOf({ PAYPAL_CLIENT_ID: "abc" })[0]?.message).toBe("set both or neither");
    expect(issuesOf({ PAYPAL_CLIENT_SECRET: "abc" })[0]?.message).toBe("set both or neither");
    expect(ok({ PAYPAL_CLIENT_ID: "abc", PAYPAL_CLIENT_SECRET: "def" }).PAYPAL_CLIENT_ID).toBe(
      "abc",
    );
  });

  it("treats blank values and replace-with-* placeholders as unset", () => {
    const env = ok({
      PAYPAL_CLIENT_ID: "replace-with-your-sandbox-client-id",
      PAYPAL_CLIENT_SECRET: "replace-with-your-sandbox-client-secret",
      ANTHROPIC_API_KEY: "",
      OPERATOR_PASSCODE: "replace-with-a-long-random-passcode",
    });
    expect(env.PAYPAL_CLIENT_ID).toBeUndefined();
    expect(env.PAYPAL_CLIENT_SECRET).toBeUndefined();
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(env.OPERATOR_PASSCODE).toBeUndefined();
  });

  it("bounds the agent runtime: defaults, accepted values, and rejected garbage that never echoes the input", () => {
    const d = ok({});
    expect([d.AGENT_TIMEOUT_MS, d.AGENT_MAX_ATTEMPTS]).toEqual([undefined, 3]);
    expect(d.AGENT_MAX_OUTPUT_TOKENS).toBe(8192);
    const set = ok({ AGENT_TIMEOUT_MS: "5000", AGENT_MAX_ATTEMPTS: "2" });
    expect([set.AGENT_TIMEOUT_MS, set.AGENT_MAX_ATTEMPTS]).toEqual([5000, 2]);
    const blank = ok({ AGENT_TIMEOUT_MS: "", AGENT_MAX_ATTEMPTS: "  " });
    expect([blank.AGENT_TIMEOUT_MS, blank.AGENT_MAX_ATTEMPTS]).toEqual([undefined, 3]);
    expect(ok({ AGENT_TIMEOUT_MS: "100", AGENT_MAX_ATTEMPTS: "5" }).AGENT_MAX_ATTEMPTS).toBe(5);
    for (const [name, bad] of [
      ["AGENT_TIMEOUT_MS", "99"],
      ["AGENT_TIMEOUT_MS", "120001"],
      ["AGENT_TIMEOUT_MS", "abc"],
      ["AGENT_TIMEOUT_MS", "1e3"],
      ["AGENT_TIMEOUT_MS", "-5"],
      ["AGENT_TIMEOUT_MS", "15.5"],
      ["AGENT_TIMEOUT_MS", "9999999999999"],
      ["AGENT_MAX_ATTEMPTS", "0"],
      ["AGENT_MAX_ATTEMPTS", "6"],
      ["AGENT_MAX_ATTEMPTS", "many"],
      ["AGENT_MAX_ATTEMPTS", "3 attempts"],
    ] as const) {
      const issues = issuesOf({ [name]: bad });
      expect(
        issues.map((i) => i.path),
        `${name}=${bad}`,
      ).toContain(name);
      expect(JSON.stringify(issues)).not.toContain(bad === "abc" ? "abc" : "@@never@@");
    }
  });

  it("accepts llm mode only with a key and an explicit model id; nothing falls back silently", () => {
    expect(issuesOf({ AGENT_MODE: "llm" }).map((i) => i.path)).toEqual([
      "ANTHROPIC_API_KEY",
      "AGENT_MODEL",
    ]);
    expect(issuesOf({ AGENT_MODE: "llm", AGENT_MODEL: "m-1" }).map((i) => i.path)).toEqual([
      "ANTHROPIC_API_KEY",
    ]);
    // The placeholder from .env.example does not count as a key.
    expect(
      issuesOf({
        AGENT_MODE: "llm",
        AGENT_MODEL: "m-1",
        ANTHROPIC_API_KEY: "replace-with-your-key",
      }).map((i) => i.path),
    ).toEqual(["ANTHROPIC_API_KEY"]);
    const env = ok({
      AGENT_MODE: "llm",
      AGENT_MODEL: "m-1",
      ANTHROPIC_API_KEY: "sk-test-not-real",
    });
    expect([env.AGENT_MODE, env.AGENT_MODEL]).toEqual(["llm", "m-1"]);
    expect(issuesOf({ AGENT_MODE: "magic" }).map((i) => i.path)).toContain("AGENT_MODE");
    expect(issuesOf({ AGENT_MAX_OUTPUT_TOKENS: "10" }).map((i) => i.path)).toContain(
      "AGENT_MAX_OUTPUT_TOKENS",
    );
  });

  it("rejects weak operator passcodes", () => {
    expect(issuesOf({ OPERATOR_PASSCODE: "short" }).map((i) => i.path)).toContain(
      "OPERATOR_PASSCODE",
    );
  });

  it("rejects secret-looking NEXT_PUBLIC_ variables", () => {
    const paths = issuesOf({ NEXT_PUBLIC_PAYPAL_CLIENT_SECRET: "x" }).map((i) => i.path);
    expect(paths).toContain("NEXT_PUBLIC_PAYPAL_CLIENT_SECRET");
    expect(ok({ NEXT_PUBLIC_APP_NAME: "demo" })).toBeDefined();
  });

  it("never echoes input values in issues", () => {
    const leak = "super-secret-value-123";
    const issues = issuesOf({
      PAYPAL_API_BASE: `https://evil.example/${leak}`,
      PAYPAL_ENV: leak,
      AGENT_MODE: leak,
      OPERATOR_PASSCODE: leak.slice(0, 5),
      NEXT_PUBLIC_API_KEY: leak,
    });
    expect(issues.length).toBeGreaterThan(0);
    expect(JSON.stringify(issues)).not.toContain(leak);
    expect(JSON.stringify(issues)).not.toContain(leak.slice(0, 5));
  });

  it("accepts .env.example verbatim, with PayPal credentials treated as absent", () => {
    const raw: Record<string, string> = {};
    for (const line of readFileSync(".env.example", "utf8").split(/\r?\n/)) {
      const m = /^([A-Z0-9_]+)=(.*)$/.exec(line);
      if (m?.[1] !== undefined) raw[m[1]] = m[2] ?? "";
    }
    const env = ok(raw);
    expect(env.PAYPAL_CLIENT_ID).toBeUndefined();
    expect(env.OPERATOR_PASSCODE).toBeUndefined();
  });
});
