import { z } from "zod";

import type { ProviderErrorKind } from "../../domain/payment.ts";
import { ProviderError } from "../../ports/payment-provider.ts";

/**
 * Minimal HTTP + OAuth client for the PayPal SANDBOX API. It moves one request out and one parsed answer back.
 *
 * Safety properties (each has a test in test/payments/paypal-client.test.ts):
 *  - ONE hard-coded host (the sandbox). There is no setting that points the credentials anywhere else;
 *  - the client id/secret and the access token appear only in Authorization headers: never in a URL, a body, a log,
 *    an error message or a return value. Nothing in this module logs;
 *  - every call has a timeout and a response-size cap; a failed call becomes a `ProviderError` that carries only
 *    a kind, an HTTP status, the provider's debug id and upper-case issue codes (never provider free text);
 *  - the token is cached in memory only, refreshed before it expires, and refreshed once more after a 401.
 *
 * NOT VERIFIED AGAINST A LIVE ACCOUNT: see docs/PAYPAL_INTEGRATION.md.
 */

export const PAYPAL_SANDBOX_ORIGIN = "https://api-m.sandbox.paypal.com";

const MAX_BODY_CHARS = 1_000_000;
const TOKEN_REFRESH_MARGIN_MS = 60_000;
const ISSUE_TOKEN = /^[A-Z][A-Z0-9_]{1,63}$/;
const DEBUG_ID = /^[A-Za-z0-9_-]{6,64}$/;
/** Credentials are single printable tokens; anything else could split a header. */
const CREDENTIAL = /^[\x21-\x7e]{8,512}$/;

export type PayPalFetch = (
  url: string,
  init: { method: string; headers: Record<string, string>; body?: string; signal: AbortSignal },
) => Promise<{
  status: number;
  headers: { get(name: string): string | null };
  text(): Promise<string>;
}>;

export type PayPalClientOptions = {
  clientId: string;
  clientSecret: string;
  timeoutMs: number;
  /** For tests. Defaults to the global `fetch`, looked up at call time. */
  fetch?: PayPalFetch;
  /** For tests. */
  now?: () => number;
};

export type PayPalRequest = {
  method: "GET" | "POST";
  /** Path under the sandbox origin, e.g. `/v2/checkout/orders`. Built by this package from validated parts only. */
  path: string;
  json?: unknown;
  /** A body that is already serialized and must be sent byte for byte (used to embed a webhook event unchanged). */
  rawJson?: string;
  headers?: Record<string, string>;
};

export type PayPalResponse = {
  status: number;
  debugId: string | null;
  /** Parsed JSON, or null when the body was empty or not JSON. */
  body: unknown;
};

const TokenSchema = z.object({
  access_token: z.string().min(10).max(4096),
  expires_in: z
    .number()
    .int()
    .min(60)
    .max(7 * 24 * 3600),
  token_type: z.string().max(32),
  scope: z.string().max(4000).optional(),
});

/** Permission names look like `https://uri.paypal.com/services/payments/payment`. Only well-formed names are surfaced. */
const SCOPE_NAME = /^https:\/\/uri\.paypal\.com\/[A-Za-z0-9/_.-]{1,200}$/;

/** Throws a plain Error (never echoing the value) if the credentials could not be used safely. */
export function assertUsableCredentials(clientId: unknown, clientSecret: unknown): void {
  if (
    typeof clientId !== "string" ||
    !CREDENTIAL.test(clientId) ||
    clientId.startsWith("replace-with-")
  ) {
    throw new Error("The PayPal client id is missing or malformed.");
  }
  if (
    typeof clientSecret !== "string" ||
    !CREDENTIAL.test(clientSecret) ||
    clientSecret.startsWith("replace-with-")
  ) {
    throw new Error("The PayPal client secret is missing or malformed.");
  }
}

function kindForStatus(status: number): ProviderErrorKind {
  if (status === 401) return "AUTH";
  if (status === 404) return "NOT_FOUND";
  if (status === 409) return "CONFLICT";
  if (status === 429) return "RATE_LIMITED";
  if (status >= 500) return "SERVER";
  return "REJECTED"; // 400, 403, 422 and any other 4xx: PayPal looked at the request and refused it
}

function debugIdOf(headerValue: string | null, body: unknown): string | null {
  const fromBody =
    body !== null && typeof body === "object" && "debug_id" in body ? body.debug_id : null;
  for (const candidate of [headerValue, fromBody]) {
    if (typeof candidate === "string" && DEBUG_ID.test(candidate)) return candidate;
  }
  return null;
}

/** Issue codes only: `name` and `details[].issue`, if they look like upper-case tokens. Never `message` or `description`. */
function issuesOf(body: unknown): string[] {
  if (body === null || typeof body !== "object") return [];
  const out: string[] = [];
  const push = (v: unknown) => {
    if (typeof v === "string" && ISSUE_TOKEN.test(v) && !out.includes(v) && out.length < 10)
      out.push(v);
  };
  const b = body as { name?: unknown; details?: unknown };
  push(b.name);
  if (Array.isArray(b.details)) {
    for (const d of b.details.slice(0, 10)) {
      if (d !== null && typeof d === "object") push((d as { issue?: unknown }).issue);
    }
  }
  return out;
}

export type PayPalClient = {
  send(request: PayPalRequest): Promise<PayPalResponse>;
  /**
   * Requests a fresh token and reports ONLY its metadata (which permissions it carries and how long it lives), never
   * the token. This is what the connectivity smoke test prints.
   */
  probe(): Promise<{ scopes: string[]; expiresInSeconds: number }>;
};

export function createPayPalClient(options: PayPalClientOptions): PayPalClient {
  assertUsableCredentials(options.clientId, options.clientSecret);
  const { clientId, clientSecret } = options;
  const timeoutMs = Math.min(60_000, Math.max(1_000, Math.trunc(options.timeoutMs)));
  const doFetch: PayPalFetch = options.fetch ?? ((url, init) => globalThis.fetch(url, init));
  const now = options.now ?? (() => Date.now());

  let token: { value: string; expiresAt: number } | null = null;
  let tokenMeta: { scopes: string[]; expiresInSeconds: number } = {
    scopes: [],
    expiresInSeconds: 0,
  };
  let pendingToken: Promise<string> | null = null;

  /** One bounded HTTP exchange. Never throws anything but ProviderError. */
  async function exchange(
    method: string,
    path: string,
    headers: Record<string, string>,
    body: string | undefined,
  ): Promise<{ status: number; headers: { get(name: string): string | null }; text: string }> {
    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, timeoutMs);
    try {
      const response = await doFetch(`${PAYPAL_SANDBOX_ORIGIN}${path}`, {
        method,
        headers,
        ...(body === undefined ? {} : { body }),
        signal: controller.signal,
      });
      const text = await response.text();
      if (text.length > MAX_BODY_CHARS) {
        throw new ProviderError("MALFORMED", "The provider's reply was too large.", {
          httpStatus: response.status,
        });
      }
      return { status: response.status, headers: response.headers, text };
    } catch (err) {
      if (err instanceof ProviderError) throw err;
      // Whatever the network library said may contain URLs or headers; it is deliberately dropped.
      throw new ProviderError(
        timedOut ? "TIMEOUT" : "NETWORK",
        timedOut ? "The request to PayPal timed out." : "The request to PayPal failed.",
      );
    } finally {
      clearTimeout(timer);
    }
  }

  async function fetchToken(): Promise<string> {
    const basic = Buffer.from(`${clientId}:${clientSecret}`, "utf8").toString("base64");
    const res = await exchange(
      "POST",
      "/v1/oauth2/token",
      {
        "content-type": "application/x-www-form-urlencoded",
        accept: "application/json",
        authorization: `Basic ${basic}`,
      },
      "grant_type=client_credentials",
    );
    if (res.status < 200 || res.status >= 300) {
      // A rejected credential is AUTH; the body is never copied (it could echo the client id).
      throw new ProviderError(
        res.status >= 500 || res.status === 429 ? kindForStatus(res.status) : "AUTH",
        "PayPal did not issue an access token.",
        {
          httpStatus: res.status,
        },
      );
    }
    let parsed: z.infer<typeof TokenSchema>;
    try {
      const result = TokenSchema.safeParse(JSON.parse(res.text));
      if (!result.success) throw new Error("shape");
      parsed = result.data;
    } catch {
      throw new ProviderError("MALFORMED", "PayPal's token reply was not in the expected shape.", {
        httpStatus: res.status,
      });
    }
    token = {
      value: parsed.access_token,
      expiresAt: now() + parsed.expires_in * 1000 - TOKEN_REFRESH_MARGIN_MS,
    };
    tokenMeta = {
      scopes: (parsed.scope ?? "")
        .split(/\s+/)
        .filter((name) => SCOPE_NAME.test(name))
        .slice(0, 50),
      expiresInSeconds: parsed.expires_in,
    };
    return parsed.access_token;
  }

  async function accessToken(forceRefresh: boolean): Promise<string> {
    if (!forceRefresh && token !== null && now() < token.expiresAt) return token.value;
    if (forceRefresh) token = null;
    pendingToken ??= fetchToken().finally(() => {
      pendingToken = null;
    });
    return pendingToken;
  }

  async function call(request: PayPalRequest, forceRefresh: boolean) {
    const bearer = await accessToken(forceRefresh);
    return exchange(
      request.method,
      request.path,
      {
        accept: "application/json",
        ...(request.json === undefined && request.rawJson === undefined
          ? {}
          : { "content-type": "application/json" }),
        ...request.headers,
        authorization: `Bearer ${bearer}`,
      },
      request.rawJson ?? (request.json === undefined ? undefined : JSON.stringify(request.json)),
    );
  }

  return {
    async probe() {
      await accessToken(true);
      return { scopes: [...tokenMeta.scopes], expiresInSeconds: tokenMeta.expiresInSeconds };
    },

    async send(request) {
      let res = await call(request, false);
      if (res.status === 401) res = await call(request, true); // the token may have been revoked: one fresh try
      let body: unknown = null;
      if (res.text.length > 0) {
        try {
          body = JSON.parse(res.text);
        } catch {
          body = null;
        }
      }
      const debugId = debugIdOf(res.headers.get("paypal-debug-id"), body);
      if (res.status < 200 || res.status >= 300) {
        throw new ProviderError(kindForStatus(res.status), `PayPal answered HTTP ${res.status}.`, {
          httpStatus: res.status,
          debugId,
          issues: issuesOf(body),
        });
      }
      return { status: res.status, debugId, body };
    },
  };
}
