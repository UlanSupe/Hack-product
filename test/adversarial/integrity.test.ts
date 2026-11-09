import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { ALL_SCENARIOS, SCENARIOS_BY_CATEGORY } from "./fixtures";
import { runScenario } from "./run";
import { ATTACK_CATEGORIES, type Scenario } from "./types";

/**
 * Checks on the suite itself: that it is deterministic, order-independent, isolated from every payment account,
 * complete for the categories it promises, and able to FAIL. A suite that cannot fail proves nothing.
 */

const PREFIX: Record<string, string> = {
  BUDGET_ESCALATION: "BUD",
  CURRENCY_SUBSTITUTION: "CUR",
  PAYEE_SUBSTITUTION: "PAY",
  CATEGORY_MISMATCH: "CAT",
  CHANGED_AGREEMENT: "CHG",
  MANDATE_TAMPERING: "MAN",
  PROMPT_INJECTION: "INJ",
  APPROVAL_BYPASS: "APR",
  DUPLICATE_REQUEST: "DUP",
  REPLAY: "REP",
  INVALID_TRANSITION: "TRN",
  MALFORMED_AI_OUTPUT: "AIO",
  DELIVERABLES: "DLV",
  WEBHOOK_FORGERY: "HOOK",
};

const fetchTrap = vi.fn(() => {
  throw new Error("adversarial suite: network access is forbidden");
});
beforeAll(() => {
  vi.stubGlobal("fetch", fetchTrap);
});
afterAll(() => {
  expect(fetchTrap).not.toHaveBeenCalled();
  vi.unstubAllGlobals();
});

describe("the fixtures", () => {
  it("cover every promised attack category with at least five scenarios each", () => {
    expect(SCENARIOS_BY_CATEGORY.map(([c]) => c)).toEqual([...ATTACK_CATEGORIES]);
    for (const [category, list] of SCENARIOS_BY_CATEGORY) {
      expect(list.length, category).toBeGreaterThanOrEqual(5);
    }
  });

  it("have unique ids, ids that match their category, and unique titles", () => {
    const ids = ALL_SCENARIOS.map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(new Set(ALL_SCENARIOS.map((s) => s.title)).size).toBe(ALL_SCENARIOS.length);
    for (const s of ALL_SCENARIOS) {
      expect(s.id.startsWith(`${PREFIX[s.category]}-`), `${s.id} in ${s.category}`).toBe(true);
      expect(s.id).toMatch(/^[A-Z]+-\d{2}$/);
    }
  });

  it("each define the four things the suite promises: initial state, attack input, policy/outcome result, transaction state, audit", () => {
    for (const s of ALL_SCENARIOS) {
      expect(s.goal.length, s.id).toBeGreaterThan(10);
      expect(Array.isArray(s.initial.steps), s.id).toBe(true);
      expect(s.attack.length, `${s.id} has an attack`).toBeGreaterThan(0);
      expect(
        Object.keys(s.expect.outcome).length,
        `${s.id} states an expected result`,
      ).toBeGreaterThan(0);
      expect(Array.isArray(s.expect.txStates), `${s.id} states the transaction state`).toBe(true);
      expect(Array.isArray(s.expect.audit), `${s.id} states the audit events`).toBe(true);
    }
  });

  it("only mark a limitation when they say what it is", () => {
    for (const s of ALL_SCENARIOS) {
      if (s.limitation !== undefined) expect(s.limitation.length, s.id).toBeGreaterThan(40);
    }
  });
});

describe("determinism", () => {
  it(
    "every scenario produces a byte-identical transcript when run twice",
    { timeout: 120_000 },
    async () => {
      for (const s of ALL_SCENARIOS) {
        const a = await runScenario(s);
        const b = await runScenario(s);
        expect(b.transcriptHash, s.id).toBe(a.transcriptHash);
      }
    },
  );

  it(
    "does not depend on the order scenarios run in (no state is shared between them)",
    { timeout: 120_000 },
    async () => {
      const forward = new Map<string, string>();
      for (const s of ALL_SCENARIOS) forward.set(s.id, (await runScenario(s)).transcriptHash);
      for (const s of [...ALL_SCENARIOS].reverse()) {
        expect((await runScenario(s)).transcriptHash, s.id).toBe(forward.get(s.id));
      }
    },
  );

  it("does not read the clock or randomness: dates and ids all come from the injected clock", () => {
    const here = join(import.meta.dirname);
    const files = [join(here, "run.ts"), join(here, "world.ts")];
    for (const f of files) {
      const code = stripComments(readFileSync(f, "utf8"));
      expect(code, f).not.toMatch(
        /Date\.now|new Date\(\)|Math\.random|randomUUID|performance\.now/,
      );
    }
  });
});

describe("isolation from real payment accounts", () => {
  const dir = import.meta.dirname;
  const sources = [
    ...readdirSync(dir).filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts")),
    ...readdirSync(join(dir, "fixtures")).map((f) => join("fixtures", f)),
  ];

  it("imports no real PayPal client, environment loader or credential module", () => {
    for (const f of sources) {
      const text = readFileSync(join(dir, f), "utf8");
      const specs = [...text.matchAll(/from\s+["']([^"']+)["']/g)].map((m) => m[1] as string);
      for (const spec of specs) {
        expect(spec, `${f} imports ${spec}`).not.toMatch(
          /adapters\/paypal|server\/env|server\/payments|server\/webhooks|config\/env|dotenv/,
        );
      }
    }
  });

  it("reads no environment variable and makes no network call", () => {
    for (const f of sources) {
      const code = stripComments(readFileSync(join(dir, f), "utf8"));
      expect(code, f).not.toMatch(
        /process\.env|import\.meta\.env|\bfetch\s*\(|XMLHttpRequest|node:https?\b|node:net\b/,
      );
    }
  });

  it("the only payment provider in the world is the scripted fake", () => {
    const world = readFileSync(join(dir, "world.ts"), "utf8");
    expect(world).toMatch(/createFakePayPal/);
    expect(world).toMatch(/provider: fake\.provider/);
  });

  it("holds no credential-looking literal", () => {
    for (const f of sources) {
      const text = readFileSync(join(dir, f), "utf8");
      expect(text, f).not.toMatch(
        /client_secret|PAYPAL_CLIENT_SECRET|access_token|Bearer\s+[A-Za-z0-9]/i,
      );
    }
  });
});

describe("the suite can fail (negative controls)", () => {
  const find = (id: string): Scenario => {
    const s = ALL_SCENARIOS.find((x) => x.id === id);
    if (!s) throw new Error(id);
    return s;
  };
  const withExpect = (s: Scenario, over: Partial<Scenario["expect"]>): Scenario => ({
    ...s,
    expect: { ...s.expect, ...over },
  });

  it("reports a wrong policy reason code", async () => {
    const s = find("BUD-01");
    const r = await runScenario(
      withExpect(s, { outcome: { ...s.expect.outcome, reasonCodes: ["OVER_PER_TX_CAP"] } }),
    );
    expect(r.pass).toBe(false);
    expect(r.failures.join("\n")).toMatch(/outcome\.reasonCodes/);
  });

  it("reports a wrong transaction state", async () => {
    const r = await runScenario(withExpect(find("BUD-01"), { txStates: ["AGREED"] }));
    expect(r.pass).toBe(false);
    expect(r.failures.join("\n")).toMatch(/txStates/);
  });

  it("reports money that moved when none was expected", async () => {
    const r = await runScenario(withExpect(find("DUP-04"), { capturedMinor: 0 }));
    expect(r.pass).toBe(false);
    expect(r.failures.join("\n")).toMatch(/capturedMinor/);
  });

  it("reports a money-moving call that was not expected", async () => {
    const r = await runScenario(withExpect(find("BUD-07"), { paypalCalls: [] }));
    expect(r.pass).toBe(false);
    expect(r.failures.join("\n")).toMatch(/paypalCalls/);
  });

  it("reports a missing audit event, and an audit event that must not exist", async () => {
    const missing = await runScenario(
      withExpect(find("BUD-01"), { audit: [{ type: "TX_APPROVAL_RECORDED" }] }),
    );
    expect(missing.pass).toBe(false);
    expect(missing.failures.join("\n")).toMatch(/audit\[0\]/);
    const forbidden = await runScenario(
      withExpect(find("BUD-01"), { forbidAudit: ["POLICY_DENIED"] }),
    );
    expect(forbidden.pass).toBe(false);
    expect(forbidden.failures.join("\n")).toMatch(/must not appear/);
  });

  it("reports events recorded when the scenario claims there should be none", async () => {
    const r = await runScenario(withExpect(find("BUD-01"), { audit: [] }));
    expect(r.pass).toBe(false);
    expect(r.failures.join("\n")).toMatch(/expected no audit events/);
  });

  it("reports a setup step that did not do what it was meant to, instead of attacking a wrong state", async () => {
    const s = find("APR-01");
    const broken: Scenario = {
      ...s,
      initial: { ...s.initial, steps: [{ do: "open" }, { do: "accept", proposal: "o1" }] as never },
    };
    const missing = await runScenario(broken);
    expect(missing.pass).toBe(false);
    expect(missing.failures[0]).toMatch(/^setup step 1 \(accept\).*no proposal named/);
    const refused: Scenario = {
      ...s,
      initial: {
        ...s.initial,
        steps: [
          { do: "open" },
          { do: "offer", as: "o1", unit: 45_000 },
          { do: "accept", proposal: "o1" },
        ],
      },
    };
    const r = await runScenario(refused);
    expect(r.pass).toBe(false);
    expect(r.failures[0]).toMatch(/^setup step 2 \(accept\)/);
  });

  it("reports a violated invariant even when the fixture does not mention it", async () => {
    // A privileged writer drops the append-only guard and edits history. The scenario's own expectations are all
    // satisfied (both statements succeed); only the suite-wide invariant (the audit chain must verify) notices.
    const s = find("APR-01");
    const r = await runScenario({
      ...s,
      attack: [
        { do: "sql", sql: "DROP TRIGGER audit_events_no_update" },
        { do: "sql", sql: "UPDATE audit_events SET payload = '{}' WHERE seq = 1" },
      ],
      expect: { outcome: { ok: true }, txStates: ["AGREED"], audit: [] },
    });
    expect(r.pass).toBe(false);
    expect(r.failures.join(" | ")).toMatch(/invariant: audit chain failed: seq 1 HASH_MISMATCH/);
  });
});

function stripComments(code: string): string {
  return code.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
}
