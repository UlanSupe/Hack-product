import { z } from "zod";

import { AGENT_RUNTIME_LIMITS } from "../domain/agent-contract.ts";

/**
 * Pure environment parsing. No I/O, no `server-only`, no logging: safe to unit test.
 * The only reader of `process.env` is `src/server/env.ts`.
 *
 * Rules (ARCHITECTURE section 10):
 *  - PayPal is SANDBOX ONLY: anything but the sandbox env/host is a hard error.
 *  - Blank values and `replace-with-...` placeholders (from .env.example) count as unset,
 *    so copying the example file never produces a "configured" credential.
 *  - Error messages never echo input values.
 */

const SANDBOX_API_BASE = "https://api-m.sandbox.paypal.com";
const PLACEHOLDER_PREFIX = "replace-with-";

/** Blank or placeholder strings become `undefined`; everything else passes through. */
const unsetIfBlank = (v: unknown): unknown => {
  if (typeof v !== "string") return v;
  const t = v.trim();
  return t === "" || t.startsWith(PLACEHOLDER_PREFIX) ? undefined : t;
};

const optionalSecret = z.preprocess(unsetIfBlank, z.string().min(1).optional());

/** A whole number from a string, within hard limits; blank means the default. Never echoes the input. */
const boundedInt = (limit: { min: number; max: number; default: number }) =>
  z.preprocess((v) => {
    const u = unsetIfBlank(v);
    return typeof u === "string" && /^[0-9]{1,9}$/.test(u) ? Number(u) : u;
  }, z.number().int().min(limit.min).max(limit.max).default(limit.default));

/** Like boundedInt but with no default: "not set" stays undefined so the caller can pick a mode-specific default. */
const optionalBoundedInt = (limit: { min: number; max: number }) =>
  z.preprocess((v) => {
    const u = unsetIfBlank(v);
    return typeof u === "string" && /^[0-9]{1,9}$/.test(u) ? Number(u) : u;
  }, z.number().int().min(limit.min).max(limit.max).optional());

const baseSchema = z.object({
  /**
   * "local" (default): development and tests. "demo": a hosted public demo (docs/DEPLOYMENT.md). Demo mode adds
   * startup checks (https base URL, operator passcode present) and the protections for an internet-facing demo.
   * It never changes what PayPal is: sandbox only in every mode.
   */
  DEPLOY_MODE: z.preprocess(
    unsetIfBlank,
    z.enum(["local", "demo"], { error: "must be 'local' or 'demo'" }).default("local"),
  ),
  APP_BASE_URL: z.preprocess(
    unsetIfBlank,
    z
      .url({ protocol: /^https?$/, error: "must be an http(s) URL" })
      .default("http://localhost:3000"),
  ),
  DATABASE_PATH: z.preprocess(unsetIfBlank, z.string().min(1).default("./data/pactpay.db")),

  PAYPAL_ENV: z.preprocess(
    unsetIfBlank,
    z
      .literal("sandbox", { error: "must be 'sandbox'; live PayPal is not supported" })
      .default("sandbox"),
  ),
  PAYPAL_API_BASE: z.preprocess(
    unsetIfBlank,
    z
      .literal(SANDBOX_API_BASE, { error: `must be exactly ${SANDBOX_API_BASE}` })
      .default(SANDBOX_API_BASE),
  ),
  PAYPAL_CLIENT_ID: optionalSecret,
  PAYPAL_CLIENT_SECRET: optionalSecret,
  PAYPAL_WEBHOOK_ID: optionalSecret,
  /** The sandbox business account that must receive the funds (an account id, not a secret). Unset: the payee cannot be verified and authorization is refused. */
  PAYPAL_MERCHANT_ID: z.preprocess(
    unsetIfBlank,
    z
      .string()
      .regex(/^[A-Z0-9]{8,32}$/, { error: "must be 1-32 upper-case letters and digits" })
      .optional(),
  ),
  /** Per PayPal call, in milliseconds. */
  PAYPAL_TIMEOUT_MS: boundedInt({ min: 1000, max: 60_000, default: 15_000 }),
  /** Where the buyer return/cancel URLs go in the create-order request (unverified which the sandbox prefers). */
  PAYPAL_EXPERIENCE_CONTEXT: z.preprocess(
    unsetIfBlank,
    z.enum(["payment_source", "application_context"]).default("payment_source"),
  ),

  AGENT_MODE: z.preprocess(
    unsetIfBlank,
    z
      .enum(["scripted", "llm"], {
        error: "must be 'scripted' or 'llm' (docs/AGENTS.md section 9)",
      })
      .default("scripted"),
  ),
  /** Which provider AGENT_MODE=llm talks to: the Anthropic Messages API (default) or Groq's OpenAI-compatible API. */
  AGENT_PROVIDER: z.preprocess(
    unsetIfBlank,
    z.enum(["anthropic", "groq"], { error: "must be 'anthropic' or 'groq'" }).default("anthropic"),
  ),
  /** Per model call, and the cap on calls per agent step. Unset: 15 s for the mocks, 60 s for a real model. */
  AGENT_TIMEOUT_MS: optionalBoundedInt(AGENT_RUNTIME_LIMITS.timeoutMs),
  AGENT_MAX_ATTEMPTS: boundedInt(AGENT_RUNTIME_LIMITS.maxAttempts),
  /** Only used when AGENT_MODE=llm. The model id is the operator's choice; there is no default. */
  AGENT_MODEL: optionalSecret,
  AGENT_MAX_OUTPUT_TOKENS: boundedInt(AGENT_RUNTIME_LIMITS.maxOutputTokens),
  ANTHROPIC_API_KEY: optionalSecret,
  GROQ_API_KEY: optionalSecret,

  OPERATOR_PASSCODE: z.preprocess(
    unsetIfBlank,
    z.string().min(16, { error: "must be at least 16 characters" }).optional(),
  ),
});

export type Env = z.infer<typeof baseSchema>;
export type EnvIssue = { path: string; message: string };
export type EnvResult = { ok: true; env: Env } | { ok: false; issues: EnvIssue[] };

/** `NEXT_PUBLIC_*` is inlined into the browser bundle: a secret there is a leak. */
const PUBLIC_SECRET_NAME = /^NEXT_PUBLIC_.*(SECRET|TOKEN|PASSWORD|PASSCODE|API_?KEY|PRIVATE)/i;

/**
 * Hosting platforms announce their public URL. In demo mode, when APP_BASE_URL is not set, Render's own
 * RENDER_EXTERNAL_URL is used, so the first deploy needs no manual step. An explicit APP_BASE_URL always wins.
 */
function withPlatformDefaults(
  raw: Record<string, string | undefined>,
): Record<string, string | undefined> {
  if (unsetIfBlank(raw.DEPLOY_MODE) !== "demo") return raw;
  if (unsetIfBlank(raw.APP_BASE_URL) !== undefined) return raw;
  const external = unsetIfBlank(raw.RENDER_EXTERNAL_URL);
  return typeof external === "string" ? { ...raw, APP_BASE_URL: external } : raw;
}

const LOCAL_HOST = /^(localhost|127\.0\.0\.1|\[::1\]|0\.0\.0\.0)$/i;

export function parseEnv(input: Record<string, string | undefined>): EnvResult {
  const raw = withPlatformDefaults(input);
  const issues: EnvIssue[] = [];

  for (const name of Object.keys(raw)) {
    if (PUBLIC_SECRET_NAME.test(name)) {
      issues.push({ path: name, message: "secret-looking variables must not use NEXT_PUBLIC_" });
    }
  }

  if (unsetIfBlank(raw.DEPLOY_MODE) === "demo") {
    // A public demo must be reachable over https at a real host, and must have an operator passcode: without one
    // nobody could use the operator console, and a deploy that looks healthy but is unusable is a mistake to refuse.
    const base = unsetIfBlank(raw.APP_BASE_URL);
    let usable = false;
    if (typeof base === "string") {
      try {
        const u = new URL(base);
        usable = u.protocol === "https:" && !LOCAL_HOST.test(u.hostname);
      } catch {
        /* an unparsable URL is reported by the schema below */
      }
    }
    if (!usable)
      issues.push({
        path: "APP_BASE_URL",
        message: "in demo mode this must be the public https URL (not localhost)",
      });
    if (unsetIfBlank(raw.OPERATOR_PASSCODE) === undefined)
      issues.push({
        path: "OPERATOR_PASSCODE",
        message: "required in demo mode (at least 16 characters)",
      });
  }

  const parsed = baseSchema.safeParse(raw);
  if (!parsed.success) {
    for (const i of parsed.error.issues) {
      issues.push({ path: i.path.join(".") || "(root)", message: i.message });
    }
  } else {
    const { PAYPAL_CLIENT_ID: id, PAYPAL_CLIENT_SECRET: secret } = parsed.data;
    if ((id === undefined) !== (secret === undefined)) {
      issues.push({
        path: "PAYPAL_CLIENT_ID/PAYPAL_CLIENT_SECRET",
        message: "set both or neither",
      });
    }
    // Explicit, never a silent fallback to the mocks: asking for a model without the means is a configuration error.
    if (parsed.data.AGENT_MODE === "llm") {
      const keyName = parsed.data.AGENT_PROVIDER === "groq" ? "GROQ_API_KEY" : "ANTHROPIC_API_KEY";
      for (const name of [keyName, "AGENT_MODEL"] as const) {
        if (parsed.data[name] === undefined)
          issues.push({ path: name, message: "required when AGENT_MODE=llm" });
      }
    }
  }

  return issues.length > 0 || !parsed.success
    ? { ok: false, issues }
    : { ok: true, env: parsed.data };
}
