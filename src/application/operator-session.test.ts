import { describe, expect, it } from "vitest";

import {
  LoginThrottle,
  SESSION_TTL_MS,
  csrfMatches,
  issueSession,
  passcodeMatches,
  readCookie,
  verifySession,
} from "./operator-session";

const PASS = "correct horse battery staple";
const NOW = 1_800_000_000_000;

describe("passcodeMatches", () => {
  it("accepts only the exact passcode", () => {
    expect(passcodeMatches(PASS, PASS)).toBe(true);
    for (const bad of [
      "",
      "x",
      PASS + " ",
      PASS.toUpperCase(),
      PASS.slice(1),
      123,
      null,
      undefined,
      {},
      [PASS],
    ]) {
      expect(passcodeMatches(PASS, bad)).toBe(false);
    }
  });
});

describe("session tokens", () => {
  it("round-trips and carries no secret", () => {
    const s = issueSession(PASS, NOW);
    expect(s.expiresAt).toBe(NOW + SESSION_TTL_MS);
    expect(s.token).not.toContain(PASS);
    expect(s.csrfToken).not.toContain(PASS);
    const v = verifySession(PASS, s.token, NOW + 1);
    expect(v).toMatchObject({ expiresAt: s.expiresAt, csrfToken: s.csrfToken });
  });

  it("expires exactly at the expiry instant", () => {
    const s = issueSession(PASS, NOW);
    expect(verifySession(PASS, s.token, s.expiresAt - 1)).not.toBeNull();
    expect(verifySession(PASS, s.token, s.expiresAt)).toBeNull();
    expect(verifySession(PASS, s.token, s.expiresAt + 1)).toBeNull();
  });

  it("rejects a token signed with a different passcode (changing the passcode signs everyone out)", () => {
    const s = issueSession(PASS, NOW);
    expect(verifySession("another passcode entirely", s.token, NOW)).toBeNull();
  });

  it("rejects tampering with any part of the token", () => {
    const s = issueSession(PASS, NOW, "a".repeat(32));
    const [v, exp, nonce, sig] = s.token.split(".") as [string, string, string, string];
    const flipped = (h: string) => (h.startsWith("0") ? "1" : "0") + h.slice(1);
    for (const bad of [
      `${v}.${Number(exp) + 1_000_000}.${nonce}.${sig}`, // extend the expiry
      `${v}.${exp}.${"b".repeat(32)}.${sig}`, // swap the nonce
      `${v}.${exp}.${nonce}.${flipped(sig)}`, // corrupt the signature
      `v2.${exp}.${nonce}.${sig}`,
      `${v}.${exp}.${nonce}`,
      `${v}.${exp}.${nonce}.${sig}.extra`,
      `${v}.-5.${nonce}.${sig}`,
      "",
      "garbage",
      "x".repeat(300),
    ]) {
      expect(verifySession(PASS, bad, NOW), bad.slice(0, 40)).toBeNull();
    }
    expect(verifySession(PASS, undefined, NOW)).toBeNull();
  });

  it("derives a different CSRF token per session, and only the right one matches", () => {
    const a = issueSession(PASS, NOW, "a".repeat(32));
    const b = issueSession(PASS, NOW, "b".repeat(32));
    expect(a.csrfToken).not.toBe(b.csrfToken);
    const va = verifySession(PASS, a.token, NOW)!;
    expect(csrfMatches(va, a.csrfToken)).toBe(true);
    expect(csrfMatches(va, b.csrfToken)).toBe(false);
    for (const bad of ["", null, undefined, "x"]) expect(csrfMatches(va, bad)).toBe(false);
  });
});

describe("readCookie", () => {
  it("finds a named cookie among others and ignores lookalikes", () => {
    expect(readCookie("a=1; pp_operator=tok; b=2", "pp_operator")).toBe("tok");
    expect(readCookie("xpp_operator=no; pp_operator=yes", "pp_operator")).toBe("yes");
    expect(readCookie("pp_operator_x=no", "pp_operator")).toBeUndefined();
    expect(readCookie(null, "pp_operator")).toBeUndefined();
    expect(readCookie("", "pp_operator")).toBeUndefined();
  });
});

describe("LoginThrottle", () => {
  it("locks after the maximum failures inside the window and recovers afterwards", () => {
    const t = new LoginThrottle(3, 1_000);
    expect(t.allowed(0)).toBe(true);
    t.recordFailure(0);
    t.recordFailure(100);
    expect(t.allowed(200)).toBe(true);
    t.recordFailure(300);
    expect(t.allowed(400)).toBe(false);
    expect(t.allowed(999)).toBe(false); // all three failures are still inside the 1s window
    expect(t.allowed(1_000)).toBe(true); // the t=0 failure has expired; two remain, below the limit of three
  });

  it("allows again once old failures leave the window, and reset clears them", () => {
    const t = new LoginThrottle(2, 1_000);
    t.recordFailure(0);
    t.recordFailure(10);
    expect(t.allowed(500)).toBe(false);
    expect(t.allowed(1_011)).toBe(true);
    t.recordFailure(1_020);
    t.recordFailure(1_030);
    expect(t.allowed(1_040)).toBe(false);
    t.reset();
    expect(t.allowed(1_050)).toBe(true);
  });
});
