import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { evaluatePolicy } from "@/domain/policy";

import { ALL_SUBJECTS, valid } from "./fixtures";

const ROOT = process.cwd();
const ENTRY = resolve(ROOT, "src/domain/policy.ts");

/** Source without comments or string contents, so words in prose or messages cannot trip the scan. */
function code(file: string): string {
  return readFileSync(file, "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1")
    .replace(/`(?:\\[\s\S]|[^`\\])*`/g, "``")
    .replace(/"(?:\\.|[^"\\\n])*"/g, '""');
}

function importsOf(file: string): string[] {
  const src = readFileSync(file, "utf8");
  return [...src.matchAll(/^\s*(?:import|export)\s[^;]*?from\s+"([^"]+)"/gm)].map(
    (m) => m[1] as string,
  );
}

/** Every file reachable from the engine through relative imports. */
function reachable(entry: string): string[] {
  const seen = new Set<string>();
  const queue = [entry];
  while (queue.length > 0) {
    const file = queue.pop() as string;
    if (seen.has(file)) continue;
    seen.add(file);
    for (const spec of importsOf(file)) {
      if (spec.startsWith(".")) queue.push(resolve(dirname(file), spec));
    }
  }
  return [...seen];
}

describe("the policy engine is pure", () => {
  const files = reachable(ENTRY);

  it("reaches only pure domain files", () => {
    const rel = files.map((f) => f.replace(ROOT, "").replaceAll("\\", "/")).sort();
    expect(rel).toEqual([
      "/src/domain/canonical.ts",
      "/src/domain/mandate-hash.ts",
      "/src/domain/mandate.ts",
      "/src/domain/money.ts",
      "/src/domain/offer.ts",
      "/src/domain/policy.ts",
      "/src/domain/transaction-states.ts",
    ]);
    for (const f of files) expect(f).toMatch(/[\\/]src[\\/]domain[\\/]/);
  });

  it("imports only zod, node:crypto (hashing, in canonical.ts) and sibling domain files", () => {
    const allowed = (spec: string, file: string) =>
      spec.startsWith("./") ||
      spec === "zod" ||
      (spec === "node:crypto" && file.endsWith("canonical.ts"));
    for (const f of files) {
      for (const spec of importsOf(f)) expect(allowed(spec, f), `${f} imports ${spec}`).toBe(true);
    }
  });

  it("contains no network, filesystem, process, clock, randomness or dynamic-code usage", () => {
    const FORBIDDEN =
      /\bfetch\s*\(|XMLHttpRequest|WebSocket|\bnode:(?:http|https|net|dns|tls|fs|child_process|worker_threads|os|vm)\b|\bprocess\b|\brequire\s*\(|\bimport\s*\(|Date\.now|new Date\(\s*\)|Math\.random|\bsetTimeout\b|\bsetInterval\b|randomUUID|randomBytes|\bglobalThis\b|\beval\s*\(|new Function|\bPromise\b|\basync\b|\bawait\b/;
    for (const f of files) {
      const hit = FORBIDDEN.exec(code(f));
      expect(hit?.[0], `${f} uses ${hit?.[0]}`).toBeUndefined();
    }
  });

  it("is synchronous: it returns a decision, not a promise", () => {
    const d = evaluatePolicy(valid("CAPTURE")) as unknown;
    expect(d).not.toBeInstanceOf(Promise);
    expect((d as { then?: unknown }).then).toBeUndefined();
  });
});

describe("at runtime, with network, clock and randomness booby-trapped, every subject still evaluates", () => {
  afterEach(() => vi.restoreAllMocks());

  it("does not call fetch, Date.now, Math.random or new Date() without arguments", () => {
    const boom = (what: string) => () => {
      throw new Error(`policy engine touched ${what}`);
    };
    vi.stubGlobal("fetch", boom("fetch"));
    vi.spyOn(Date, "now").mockImplementation(boom("Date.now"));
    vi.spyOn(Math, "random").mockImplementation(boom("Math.random"));
    try {
      for (const s of ALL_SUBJECTS) {
        const d = evaluatePolicy(valid(s));
        expect(d.verdict).toBe("ALLOW");
        expect(d.reasonCodes).toEqual([]);
      }
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("the decision depends on the injected clock only", () => {
    const base = valid("ACCEPT_OFFER");
    const early = evaluatePolicy({ ...base, now: "2026-10-12T12:00:00.000Z" });
    const late = evaluatePolicy({ ...base, now: "2026-10-12T13:00:00.000Z" }); // offer validUntil is 13:00:00.000 exactly
    expect(early.verdict).toBe("ALLOW");
    expect(late.reasonCodes).toEqual(["OFFER_EXPIRED"]);
  });
});
