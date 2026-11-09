import { describe, expect, it, vi } from "vitest";

import { evaluatePolicy, exposureCounts, type PolicyInput, type ReasonCode } from "@/domain/policy";
import { TX_STATES, type TxState } from "@/domain/transaction-states";

import { cases } from "./cases";
import {
  ALL_SUBJECTS,
  APPROVAL_SUBJECTS,
  MONEY_SUBJECTS,
  approvedBy,
  mutate,
  reseal,
  valid,
  withTotal,
} from "./fixtures";

// These are deliberately heavy (tens of thousands of evaluations); a busy machine running the whole suite
// in parallel must not turn that into a spurious timeout.
vi.setConfig({ testTimeout: 60_000 });

/** Small, seeded, dependency-free PRNG (mulberry32). Same seed, same run: failures are reproducible. */
function rng(seed: number) {
  let a = seed >>> 0;
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return {
    next,
    int: (lo: number, hi: number) => lo + Math.floor(next() * (hi - lo + 1)),
    pick: <T>(xs: readonly T[]): T => xs[Math.floor(next() * xs.length)] as T,
    bool: (p = 0.5) => next() < p,
  };
}

function wellFormed(d: ReturnType<typeof evaluatePolicy>) {
  expect(["ALLOW", "DENY"]).toContain(d.verdict);
  // These are exactly the CHECK constraints on the policy_decisions table.
  if (d.verdict === "ALLOW") expect(d.reasonCodes).toEqual([]);
  else expect(d.reasonCodes.length).toBeGreaterThanOrEqual(1);
  expect(d.inputsHash).toMatch(/^[0-9a-f]{64}$/);
  expect(d.explanation.length).toBeGreaterThan(0);
  expect(d.explanation.length).toBeLessThanOrEqual(1200);
  expect(Object.isFrozen(d)).toBe(true);
  expect([...d.reasonCodes]).toEqual([...new Set(d.reasonCodes)].sort());
}

describe("oracle: money rules checked against an independent re-implementation", () => {
  const RELEASED: TxState[] = ["NEGOTIATING", "VOIDED", "REJECTED", "CANCELLED", "FAILED"];

  it("20,000 random cap / budget / threshold / exposure / approval combinations agree exactly", () => {
    const r = rng(20261012);
    for (let n = 0; n < 20_000; n++) {
      const subject = r.pick(MONEY_SUBJECTS);
      const cap = r.int(0, 40);
      const budget = r.int(0, 80);
      const threshold = r.int(0, 40);
      const review = r.bool(0.2);
      const total = r.int(0, 50);
      const others = Array.from({ length: r.int(0, 4) }, (_, k) => ({
        id: `tx_o${k}`,
        state: r.pick(TX_STATES),
        currency: "USD",
        totalMinor: r.int(0, 30),
      }));
      const approved = r.bool(0.5);

      const input = mutate(valid(subject), (d) => {
        withTotal(d, total);
        d.mandate.terms.maxTransactionMinor = cap;
        d.mandate.terms.totalBudgetMinor = budget;
        d.mandate.terms.approvalThresholdMinor = threshold;
        d.mandate.terms.requireReviewBeforeExecution = review;
        d.others = others;
        d.approval = approved && APPROVAL_SUBJECTS.includes(subject) ? approvedBy() : null;
      });

      const reserved = others
        .filter((o) => !RELEASED.includes(o.state))
        .reduce((s, o) => s + o.totalMinor, 0);
      const expected: ReasonCode[] = [];
      if (total === 0) expected.push("AMOUNT_NOT_POSITIVE");
      if (total > cap) expected.push("OVER_PER_TX_CAP");
      if (reserved + total > budget) expected.push("OVER_TOTAL_BUDGET");
      const needsApproval = review || total > threshold;
      if (APPROVAL_SUBJECTS.includes(subject) && needsApproval && !approved)
        expected.push("APPROVAL_REQUIRED");

      const d = evaluatePolicy(input);
      wellFormed(d);
      expect({
        n,
        subject,
        cap,
        budget,
        threshold,
        review,
        total,
        reserved,
        approved,
        codes: d.reasonCodes,
      }).toEqual({
        n,
        subject,
        cap,
        budget,
        threshold,
        review,
        total,
        reserved,
        approved,
        codes: expected.sort(),
      });
    }
  });

  it("the exposure table used by the engine agrees with the independent list", () => {
    for (const s of TX_STATES) expect(exposureCounts(s)).toBe(!RELEASED.includes(s));
  });
});

describe("ALLOW is a proof: every allowed decision satisfies the invariants, checked straight from the data", () => {
  it("5,000 random inputs: whenever the engine says ALLOW, the safety conditions hold", () => {
    const r = rng(777);
    let allowed = 0;
    for (let n = 0; n < 5000; n++) {
      const subject = r.pick(ALL_SUBJECTS);
      const input = mutate(valid(subject), (d) => {
        if (subject !== "VOID") {
          withTotal(d, r.int(1, 20000));
          d.mandate.terms.maxTransactionMinor = r.int(1, 20000);
          d.mandate.terms.totalBudgetMinor = r.int(1, 40000);
          d.mandate.terms.approvalThresholdMinor = r.int(0, 20000);
          d.mandate.terms.requireReviewBeforeExecution = r.bool(0.3);
          if (r.bool(0.5))
            d.others = [
              {
                id: "tx_o",
                state: r.pick(TX_STATES),
                currency: "USD",
                totalMinor: r.int(0, 30000),
              },
            ];
          if (r.bool(0.6) && APPROVAL_SUBJECTS.includes(subject)) d.approval = approvedBy();
          if (r.bool(0.1)) d.latestMandate.version = 3;
          if (r.bool(0.1)) d.mandate.terms.currency = r.pick(["EUR", "GBP", "JPY"] as const);
          if (r.bool(0.1)) d.actor = "AGENT";
        }
        if (r.bool(0.1)) d.transaction.state = r.pick(TX_STATES);
      });
      const d = evaluatePolicy(input);
      wellFormed(d);
      if (d.verdict !== "ALLOW") continue;
      allowed++;

      const t = input.mandate.terms;
      expect(d.subject).toBe(subject);
      if (subject === "VOID") {
        expect(input.transaction.state).toBe("AUTHORIZED");
        expect(input.attempts.captureSucceeded).toBe(false);
        continue;
      }
      const total = input.agreement?.totalMinor ?? input.offer?.storedServerTotalMinor ?? -1;
      expect(total).toBeGreaterThan(0);
      expect(total).toBeLessThanOrEqual(t.maxTransactionMinor);
      const reserved = input.others
        .filter((o) => exposureCounts(o.state))
        .reduce((s, o) => s + o.totalMinor, 0);
      expect(reserved + total).toBeLessThanOrEqual(t.totalBudgetMinor);
      expect(input.offer?.currency).toBe(t.currency);
      expect(t.allowedSellerIds).toContain(input.offer?.sellerId);
      for (const line of input.offer?.lines ?? [])
        expect(t.allowedCategories).toContain(line.category);
      expect(input.latestMandate.status).toBe("ACTIVE");
      expect(input.mandate.status).toBe("ACTIVE");
      if (subject !== "CAPTURE") expect(input.latestMandate.version).toBe(input.mandate.version);
      if (subject === "CAPTURE") expect(input.actor).toBe("OPERATOR");
      if (
        APPROVAL_SUBJECTS.includes(subject) &&
        (t.requireReviewBeforeExecution || total > t.approvalThresholdMinor)
      ) {
        expect(input.approval).toEqual(approvedBy());
      }
    }
    expect(allowed).toBeGreaterThan(300); // the sample really does exercise ALLOW, not only DENY
  });
});

describe("no combination of violations is ever allowed", () => {
  const violations = cases.filter((c) =>
    typeof c.codes === "function" ? true : c.codes.length > 0,
  );

  it("4,000 random stacks of 1-5 violations, across every subject, always DENY", () => {
    const r = rng(42);
    let multi = 0;
    for (let n = 0; n < 4000; n++) {
      const subject = r.pick(ALL_SUBJECTS);
      const pool = violations.filter((c) => c.subjects.includes(subject));
      if (pool.length === 0) continue;
      let input = valid(subject);
      if (APPROVAL_SUBJECTS.includes(subject)) input.approval = approvedBy();
      let applied = 0;
      let forged = false;
      for (let k = r.int(1, 5); k > 0; k--) {
        const c = r.pick(pool);
        const draft = structuredClone(input);
        try {
          c.change(draft);
        } catch {
          continue; // an earlier change removed what this one targets
        }
        input = draft;
        applied++;
        if (c.reseal === false) forged = true;
      }
      if (applied === 0) continue;
      if (!forged) reseal(input); // honest edits to the approved terms keep a matching hash
      if (applied > 1) multi++;
      const d = evaluatePolicy(input);
      wellFormed(d);
      expect(d.verdict, `stack #${n} on ${subject}`).toBe("DENY");
    }
    expect(multi).toBeGreaterThan(1000);
  });
});

describe("exhaustive corruption: damaging any single field of a valid input never yields ALLOW", () => {
  const POOL: unknown[] = [
    NaN,
    Infinity,
    -1,
    1.5,
    2 ** 60,
    Symbol("x"),
    () => 1,
    10n,
    new Date(0),
    Object.create(null) as object,
  ];

  /** Every path to a leaf (primitive or null), descending into arrays and objects. */
  function leaves(v: unknown, path: (string | number)[] = []): (string | number)[][] {
    if (v === null || typeof v !== "object") return [path];
    return Object.entries(v).flatMap(([k, c]) =>
      leaves(c, [...path, Array.isArray(v) ? Number(k) : k]),
    );
  }
  function setAt(root: unknown, path: (string | number)[], value: unknown, remove = false) {
    let cur = root as Record<string | number, unknown>;
    for (const k of path.slice(0, -1)) cur = cur[k] as Record<string | number, unknown>;
    const last = path[path.length - 1] as string | number;
    if (remove) delete cur[last];
    else cur[last] = value;
  }

  for (const subject of ALL_SUBJECTS) {
    const base = mutate(valid(subject), (d) => {
      if (APPROVAL_SUBJECTS.includes(subject)) d.approval = approvedBy();
    });
    const paths = leaves(base);

    it(`${subject}: ${paths.length} leaves x ${POOL.length} wrong-typed values are all denied`, () => {
      expect(evaluatePolicy(base).verdict).toBe("ALLOW");
      for (const path of paths) {
        for (const bad of POOL) {
          const copy = structuredClone(base);
          setAt(copy, path, bad);
          const d = evaluatePolicy(copy);
          if (d.verdict !== "DENY")
            throw new Error(`ALLOWED with ${path.join(".")} = ${String(typeof bad)}`);
          wellFormed(d);
        }
      }
    });

    it(`${subject}: removing any of the ${paths.length} leaves is denied`, () => {
      for (const path of paths) {
        const copy = structuredClone(base);
        setAt(copy, path, undefined, true);
        const d = evaluatePolicy(copy);
        if (d.verdict !== "DENY") throw new Error(`ALLOWED with ${path.join(".")} removed`);
      }
    });
  }
});

describe("totality: arbitrary garbage never throws and never allows", () => {
  function garbage(r: ReturnType<typeof rng>, depth = 0): unknown {
    const pool: (() => unknown)[] = [
      () => null,
      () => undefined,
      () => r.int(-5, 5),
      () => r.next() * 1e6,
      () => NaN,
      () => "x".repeat(r.int(0, 70)),
      () => r.pick(["CAPTURE", "ALLOW", "OPERATOR", "USD", "AGENT"]),
      () => r.bool(),
      () => 10n,
      () => Symbol("s"),
      () => () => 1,
    ];
    if (depth < 3) {
      pool.push(
        () => Array.from({ length: r.int(0, 3) }, () => garbage(r, depth + 1)),
        () =>
          Object.fromEntries(
            Array.from({ length: r.int(0, 4) }, () => [
              r.pick(["subject", "actor", "now", "claims", "offer", "x", "__proto__"]),
              garbage(r, depth + 1),
            ]),
          ),
      );
    }
    return r.pick(pool)();
  }

  it("5,000 random values", () => {
    const r = rng(9);
    for (let n = 0; n < 5000; n++) {
      const d = evaluatePolicy(garbage(r));
      expect(d.verdict).toBe("DENY");
      wellFormed(d);
    }
  });

  it("5,000 random objects that DO have a valid subject", () => {
    const r = rng(10);
    for (let n = 0; n < 5000; n++) {
      const raw = { ...(garbage(r) as object), subject: r.pick(ALL_SUBJECTS) };
      const d = evaluatePolicy(raw);
      expect(d.verdict).toBe("DENY");
      expect(d.subject).toBe(raw.subject);
      wellFormed(d);
    }
  });
});

describe("claims are inert", () => {
  const KEYS = [
    "transactionId",
    "mandateId",
    "mandateVersion",
    "offerId",
    "agreementId",
    "sellerId",
    "payeeRef",
    "currency",
    "amountMinor",
    "termsHash",
  ] as const;
  const WRONG: unknown[] = [
    null,
    0,
    -1,
    1,
    4499,
    4501,
    "",
    "x",
    "4500",
    "USD ",
    true,
    {},
    [],
    [4500],
    NaN,
    2 ** 53,
    "0".repeat(64),
  ];

  it("a wrong value in any claim, on any subject, is always a denial", () => {
    for (const subject of MONEY_SUBJECTS) {
      for (const key of KEYS) {
        for (const wrong of WRONG) {
          const input = mutate(valid(subject), (d) => {
            d.claims[key] = wrong;
          });
          const d = evaluatePolicy(input);
          const facts = valid(subject);
          // the only way a "wrong" value can pass is by coinciding with the true one (e.g. the number 1 as a currency can't)
          const truth: Record<string, unknown> = {
            transactionId: "tx_1",
            mandateId: "M1",
            mandateVersion: 2,
            offerId: "off_1",
            agreementId: facts.agreement?.id ?? null,
            sellerId: "seller_a",
            payeeRef: "payee_seller_a",
            currency: "USD",
            amountMinor: 4500,
            termsHash: facts.offer?.storedTermsHash,
          };
          const equalsTruth = Object.is(truth[key], wrong);
          expect(d.verdict, `${subject}.${key}=${String(typeof wrong)}`).toBe(
            equalsTruth ? "ALLOW" : "DENY",
          );
        }
      }
    }
  });

  it("supplying claims that equal the facts never changes a decision, and never fixes a denial", () => {
    const r = rng(5);
    for (let n = 0; n < 1000; n++) {
      const subject = r.pick(MONEY_SUBJECTS);
      const base = mutate(valid(subject), (d) => {
        if (r.bool()) d.actor = "AGENT";
        if (r.bool()) d.mandate.terms.maxTransactionMinor = 10;
      });
      const withClaims = mutate(base, (d) => {
        d.claims = {
          transactionId: "tx_1",
          mandateId: "M1",
          mandateVersion: 2,
          sellerId: "seller_a",
          currency: "USD",
        };
      });
      expect(evaluatePolicy(withClaims).reasonCodes).toEqual(evaluatePolicy(base).reasonCodes);
    }
  });
});

describe("determinism", () => {
  it("1,000 repeated evaluations of random inputs are identical", () => {
    const r = rng(3);
    for (let n = 0; n < 1000; n++) {
      const subject = r.pick(ALL_SUBJECTS);
      const input = mutate(valid(subject), (d) => {
        d.transaction.state = r.pick(TX_STATES);
        d.attempts.liveForSubject = r.bool(0.2);
      });
      expect(evaluatePolicy(structuredClone(input))).toEqual(evaluatePolicy(input));
    }
  });

  it("the input hash changes when, and only when, an evaluated field changes", () => {
    const a = evaluatePolicy(valid("CAPTURE"));
    expect(evaluatePolicy(valid("CAPTURE")).inputsHash).toBe(a.inputsHash);
    const other = mutate(valid("CAPTURE"), (d) => {
      d.now = "2026-10-12T12:00:00.001Z";
    });
    expect(evaluatePolicy(other).inputsHash).not.toBe(a.inputsHash);
    // key order is irrelevant: the hash is over canonical JSON
    const reordered = Object.fromEntries(
      Object.entries(valid("CAPTURE")).reverse(),
    ) as unknown as PolicyInput;
    expect(evaluatePolicy(reordered).inputsHash).toBe(a.inputsHash);
  });
});
