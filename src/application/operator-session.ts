import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";

/**
 * Operator session primitives (pure; no framework, no I/O). Demo-grade authentication, documented as such:
 * one shared passcode from OPERATOR_PASSCODE. The cookie carries no secret: it is `v1.<expiry>.<nonce>.<hmac>`
 * signed with a key derived from the passcode, so changing the passcode signs everyone out.
 * A separate CSRF token (HMAC of the nonce) must accompany every state-changing request.
 */

export const SESSION_COOKIE = "pp_operator";
export const CSRF_HEADER = "x-csrf-token";
export const SESSION_TTL_MS = 8 * 60 * 60 * 1000;

const key = (passcode: string) =>
  createHash("sha256").update(`pactpay/session/v1:${passcode}`).digest();
const mac = (passcode: string, data: string) =>
  createHmac("sha256", key(passcode)).update(data).digest("hex");

function safeEqual(a: string, b: string): boolean {
  const x = createHash("sha256").update(a).digest();
  const y = createHash("sha256").update(b).digest();
  return timingSafeEqual(x, y);
}

/** Constant-time passcode comparison (compares digests, so length does not leak). */
export function passcodeMatches(expected: string, supplied: unknown): boolean {
  return typeof supplied === "string" && safeEqual(expected, supplied);
}

export type IssuedSession = { token: string; csrfToken: string; expiresAt: number };

export function issueSession(
  passcode: string,
  nowMs: number,
  nonce: string = randomBytes(16).toString("hex"),
): IssuedSession {
  const expiresAt = nowMs + SESSION_TTL_MS;
  const body = `v1.${expiresAt}.${nonce}`;
  return {
    token: `${body}.${mac(passcode, body)}`,
    csrfToken: mac(passcode, `csrf:${nonce}`),
    expiresAt,
  };
}

export type VerifiedSession = { nonce: string; expiresAt: number; csrfToken: string };

export function verifySession(
  passcode: string,
  token: string | undefined,
  nowMs: number,
): VerifiedSession | null {
  if (!token || token.length > 256) return null;
  const parts = token.split(".");
  if (parts.length !== 4 || parts[0] !== "v1") return null;
  const [, exp, nonce, sig] = parts as [string, string, string, string];
  if (!/^[0-9]{1,15}$/.test(exp) || !/^[0-9a-f]{32}$/.test(nonce) || !/^[0-9a-f]{64}$/.test(sig))
    return null;
  if (!safeEqual(sig, mac(passcode, `v1.${exp}.${nonce}`))) return null;
  const expiresAt = Number(exp);
  if (expiresAt <= nowMs) return null;
  return { nonce, expiresAt, csrfToken: mac(passcode, `csrf:${nonce}`) };
}

export function csrfMatches(
  session: VerifiedSession,
  supplied: string | null | undefined,
): boolean {
  return typeof supplied === "string" && safeEqual(session.csrfToken, supplied);
}

/** Pulls one cookie out of a Cookie header without any framework. */
export function readCookie(header: string | null | undefined, name: string): string | undefined {
  if (!header) return undefined;
  for (const part of header.split(";")) {
    const i = part.indexOf("=");
    if (i > 0 && part.slice(0, i).trim() === name) return part.slice(i + 1).trim();
  }
  return undefined;
}

/** Locks login attempts after repeated failures (global, not per-IP: a demo has one operator). */
export class LoginThrottle {
  private failures: number[] = [];
  private readonly max: number;
  private readonly windowMs: number;

  constructor(max = 5, windowMs = 60_000) {
    this.max = max;
    this.windowMs = windowMs;
  }

  private prune(nowMs: number) {
    this.failures = this.failures.filter((t) => nowMs - t < this.windowMs);
  }

  /** True when another attempt is allowed. */
  allowed(nowMs: number): boolean {
    this.prune(nowMs);
    return this.failures.length < this.max;
  }

  recordFailure(nowMs: number): void {
    this.prune(nowMs);
    this.failures.push(nowMs);
  }

  reset(): void {
    this.failures = [];
  }
}
