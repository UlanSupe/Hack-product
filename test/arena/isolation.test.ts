import { readFileSync } from "node:fs";

import { afterEach, describe, expect, it, vi } from "vitest";

import { SCENARIOS, runExperiment } from "@/application/arena";
import { executeUnchecked } from "@/application/arena-baseline";
import { SimulatedLedger, type BuyerProposal } from "@/domain/experiment";

import { freshDb } from "../persistence/helpers";

/**
 * The unsafe baseline must have no route to real money. Three independent lines are checked here: what the code is
 * able to import, what a run actually does at runtime, and what the database would refuse.
 */

const read = (p: string) => readFileSync(new URL(`../../${p}`, import.meta.url), "utf8");
const importsOf = (src: string): string[] =>
  [...src.matchAll(/(?:^|\n)\s*(?:import|export)\b[^;]*?from\s+["']([^"']+)["']/g)].map(
    (m) => m[1] as string,
  );

const FILES = [
  "src/application/arena-baseline.ts",
  "src/application/arena.ts",
  "src/domain/experiment.ts",
  "src/domain/experiment-scenarios.ts",
];

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("the experiment cannot import anything that can move real money", () => {
  it.each(FILES)("%s imports only the domain and itself", (file) => {
    const specs = importsOf(read(file));
    expect(specs.length).toBeGreaterThan(0);
    for (const spec of specs) {
      expect(spec, `${file} imports ${spec}`).toMatch(
        /^\.\.?\/(domain\/)?[a-z-]+\.ts$|^\.\/[a-z-]+\.ts$/,
      );
      expect(spec).not.toMatch(/adapters|ports|server|config|payment|paypal|webhook|agents|env/i);
    }
  });

  it.each(FILES)(
    "%s never reads the environment, the network, the filesystem or the clock",
    (file) => {
      const code = read(file)
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/^\s*\/\/.*$/gm, "");
      expect(code).not.toMatch(
        /process\.env|\bfetch\s*\(|XMLHttpRequest|node:fs|node:http|child_process|Date\.now|new Date\(\)|Math\.random|crypto\.random/,
      );
    },
  );

  it("the baseline executor's only way to spend is a SimulatedLedger", () => {
    const src = read("src/application/arena-baseline.ts");
    expect(src).toMatch(/ledger: SimulatedLedger/);
    expect(importsOf(src)).toEqual(["../domain/experiment.ts"]);
    const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    expect(code).not.toMatch(/policy/i); // it never consults the policy engine
  });

  it("the page and the routes reach the experiment through the application layer only", () => {
    for (const f of [
      "src/app/page.tsx",
      "src/app/api/arena/runs/route.ts",
      "src/app/api/arena/runs/[scenarioId]/route.ts",
    ]) {
      for (const spec of importsOf(read(f)))
        expect(spec, f).not.toMatch(/adapters|server\/|paypal|payment/);
    }
  });
});

describe("a run touches nothing outside memory", () => {
  it("makes no network call and ignores PayPal credentials, even if they are set", () => {
    const fetchSpy = vi.fn(() =>
      Promise.reject(new Error("the experiment must not use the network")),
    );
    vi.stubGlobal("fetch", fetchSpy);
    vi.stubEnv("PAYPAL_CLIENT_ID", "AfakeSandboxClientId0123456789abcdef");
    vi.stubEnv("PAYPAL_CLIENT_SECRET", "EfakeSandboxClientSecret0123456789abcdef");
    vi.stubEnv("PAYPAL_MERCHANT_ID", "MERCHANT01");
    for (const s of SCENARIOS) runExperiment({ scenarioId: s.id });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("every settlement in both modes is a labelled simulated receipt, never a PayPal id", () => {
    for (const s of SCENARIOS) {
      const r = runExperiment({ scenarioId: s.id })!;
      for (const mode of [r.baseline, r.protected]) {
        expect(mode.provider).toBe("SIMULATED");
        for (const st of mode.steps) {
          if (st.settlement) {
            expect(st.settlement.receiptId).toMatch(/^SIM-[BP]-\d{3}$/);
            expect(st.settlement.label).toBe("SIMULATED");
          }
        }
      }
    }
    // the seller's story may mention PayPal; what must never appear is a PayPal object, a credential or a token
    const settlements = SCENARIOS.flatMap((s) => {
      const r = runExperiment({ scenarioId: s.id })!;
      return [...r.baseline.steps, ...r.protected.steps].map((st) => st.settlement);
    });
    expect(JSON.stringify(settlements)).not.toMatch(/paypal|order|authoriz|capture/i);
    const text = JSON.stringify(SCENARIOS.map((s) => runExperiment({ scenarioId: s.id })));
    expect(text).not.toMatch(/access_token|client_secret|Bearer |api-m.sandbox/i);
  });

  it("the result carries no secret-looking key", () => {
    const text = JSON.stringify(runExperiment({ scenarioId: "S1" }));
    expect(text).not.toMatch(/secret|password|api[_-]?key|token/i);
  });
});

describe("the simulated ledger is only a ledger", () => {
  it("refuses amounts that are not positive safe integers", () => {
    const ledger = new SimulatedLedger("T");
    for (const bad of [
      0,
      -1,
      0.5,
      Number.NaN,
      Number.POSITIVE_INFINITY,
      Number.MAX_SAFE_INTEGER + 2,
    ]) {
      expect(() => ledger.debit({ amountMinor: bad, payeeRef: "p", currency: "USD" })).toThrow(
        RangeError,
      );
    }
    expect(ledger.totalMinor).toBe(0);
  });

  it("numbers its receipts and keeps a copy-only view of them", () => {
    const ledger = new SimulatedLedger("T");
    ledger.debit({ amountMinor: 100, payeeRef: "p", currency: "USD" });
    ledger.debit({ amountMinor: 250, payeeRef: "q", currency: "USD" });
    expect(ledger.receipts.map((r) => r.receiptId)).toEqual(["SIM-T-001", "SIM-T-002"]);
    expect(ledger.totalMinor).toBe(350);
    (ledger.receipts as unknown[]).length = 0; // editing the returned copy changes nothing
    expect(ledger.totalMinor).toBe(350);
    expect(ledger.simulated).toBe(true);
  });

  it("the baseline executor does exactly what it is told and nothing else (that is the unsafety)", () => {
    const ledger = new SimulatedLedger("B");
    const pay: BuyerProposal = {
      kind: "PAY",
      offerId: "o",
      sellerId: "s",
      payeeRef: "payee_anyone",
      amountMinor: 999_999,
      currency: "EUR",
      rationale: "x",
    };
    expect(executeUnchecked(pay, ledger)).toMatchObject({
      amountMinor: 999_999,
      payeeRef: "payee_anyone",
      currency: "EUR",
    });
    expect(executeUnchecked({ kind: "DECLINE", reason: "no" }, ledger)).toBeNull();
    expect(executeUnchecked({ kind: "ASK_HUMAN", reason: "no" }, ledger)).toBeNull();
  });
});

describe("the database would also refuse a baseline run that touched PayPal", () => {
  const insert = (
    db: ReturnType<typeof freshDb>,
    mode: string,
    provider: string,
    tx: string | null,
  ) =>
    db
      .prepare(
        `INSERT INTO attack_runs (id, scenario_id, fixture_version, seed, mode, provider, transaction_id, currency, mandate_cap_minor, started_at)
         VALUES ('r1', 'S1', 'v1', 's', ?, ?, ?, 'USD', 10000, '2026-10-14T09:00:00.000Z')`,
      )
      .run(mode, provider, tx);

  it("an UNSAFE_BASELINE run must be SIMULATED and must have no transaction", () => {
    const db = freshDb();
    expect(() => insert(db, "UNSAFE_BASELINE", "PAYPAL_SANDBOX", null)).toThrow();
    expect(() => insert(db, "UNSAFE_BASELINE", "SIMULATED", "tx_1")).toThrow();
    expect(() => insert(db, "UNSAFE_BASELINE", "SIMULATED", null)).not.toThrow();
  });
});
