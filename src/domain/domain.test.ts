import { describe, expect, it } from "vitest";

import { canonicalJson, sha256Hex } from "./canonical";
import { assertCurrency, assertMinor, isMinor } from "./money";
import {
  IN_FLIGHT_STATES,
  RECONCILE_TARGETS,
  TERMINAL_STATES,
  TRANSITIONS,
  TX_STATES,
  canTransition,
} from "./transaction-states";

describe("canonicalJson / sha256Hex", () => {
  it("is independent of key order and has no whitespace", () => {
    expect(canonicalJson({ b: 1, a: { d: [3, 2], c: null } })).toBe(
      '{"a":{"c":null,"d":[3,2]},"b":1}',
    );
    expect(canonicalJson({ a: 1, b: 2 })).toBe(canonicalJson({ b: 2, a: 1 }));
  });

  it("keeps array order and escapes strings", () => {
    expect(canonicalJson(["b", "a"])).toBe('["b","a"]');
    expect(canonicalJson('he said "hi"\n')).toBe('"he said \\"hi\\"\\n"');
  });

  it.each([
    ["undefined", undefined],
    ["NaN", Number.NaN],
    ["Infinity", Number.POSITIVE_INFINITY],
    ["bigint", 1n],
    ["Date", new Date(0)],
    ["Map", new Map()],
    ["function", () => 1],
    ["object holding undefined", { a: undefined }],
  ])("rejects values with no single canonical form: %s", (_name, value) => {
    expect(() => canonicalJson(value)).toThrow(TypeError);
  });

  it("matches the published SHA-256 test vector", () => {
    expect(sha256Hex("abc")).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
  });
});

describe("money primitives", () => {
  it("accepts only non-negative safe integers", () => {
    for (const ok of [0, 1, 99, Number.MAX_SAFE_INTEGER]) expect(isMinor(ok)).toBe(true);
    for (const bad of [
      -1,
      1.5,
      Number.NaN,
      Number.MAX_SAFE_INTEGER + 1,
      "100",
      null,
      undefined,
      10n,
    ]) {
      expect(isMinor(bad)).toBe(false);
      expect(() => assertMinor(bad)).toThrow(RangeError);
    }
  });

  it("validates ISO-4217-shaped currency codes", () => {
    expect(assertCurrency("USD")).toBe("USD");
    for (const bad of ["usd", "US", "USDX", "U5D", "", 1, null])
      expect(() => assertCurrency(bad)).toThrow(RangeError);
  });
});

describe("transaction state table", () => {
  const states = new Set<string>(TX_STATES);

  it("has 18 unique states and 39 unique, valid transitions", () => {
    expect(states.size).toBe(18);
    expect(TX_STATES).toHaveLength(18);
    const keys = TRANSITIONS.map(([f, t]) => `${f}>${t}`);
    expect(new Set(keys).size).toBe(keys.length);
    expect(keys).toHaveLength(39);
    for (const [f, t] of TRANSITIONS) {
      expect(states.has(f) && states.has(t), `${f}>${t}`).toBe(true);
      expect(f).not.toBe(t);
    }
  });

  it("terminal states have no outgoing edges; CAPTURED only goes to REVERSED", () => {
    for (const s of TERMINAL_STATES) expect(TRANSITIONS.filter(([f]) => f === s)).toEqual([]);
    expect(TRANSITIONS.filter(([f]) => f === "CAPTURED").map(([, t]) => t)).toEqual(["REVERSED"]);
  });

  it("every state is reachable from NEGOTIATING", () => {
    const seen = new Set<string>(["NEGOTIATING"]);
    const queue = ["NEGOTIATING"];
    while (queue.length > 0) {
      const cur = queue.shift() as string;
      for (const [f, t] of TRANSITIONS) {
        if (f !== cur || seen.has(t)) continue;
        seen.add(t);
        queue.push(t);
      }
    }
    expect([...states].filter((s) => !seen.has(s))).toEqual([]);
  });

  it("every in-flight state can fall into NEEDS_RECONCILIATION, and reconcile targets are legal edges", () => {
    for (const s of IN_FLIGHT_STATES)
      expect(canTransition(s, "NEEDS_RECONCILIATION"), s).toBe(true);
    for (const [from, targets] of Object.entries(RECONCILE_TARGETS)) {
      expect(IN_FLIGHT_STATES).toContain(from);
      for (const t of targets)
        expect(canTransition("NEEDS_RECONCILIATION", t), `${from}->${t}`).toBe(true);
    }
  });

  it("rejects the dangerous shortcuts", () => {
    expect(canTransition("AUTHORIZED", "CAPTURED")).toBe(false); // must pass through CAPTURING
    expect(canTransition("NEGOTIATING", "AUTHORIZED")).toBe(false);
    expect(canTransition("VOIDED", "AUTHORIZED")).toBe(false);
    expect(canTransition("CAPTURED", "VOIDING")).toBe(false);
    expect(canTransition("AGREED", "CAPTURED")).toBe(false);
  });
});
