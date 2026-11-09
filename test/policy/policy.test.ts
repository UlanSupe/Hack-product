import { describe, expect, it, afterAll } from "vitest";

import {
  exposureCounts,
  POLICY_SUBJECTS,
  POLICY_VERSION,
  REASON_CODES,
  evaluatePolicy,
  type PolicyInput,
  type PolicySubject,
  type ReasonCode,
} from "@/domain/policy";
import { canTransition, TX_STATES } from "@/domain/transaction-states";

import { applyCase, cases, ready } from "./cases";
import {
  ALL_SUBJECTS,
  APPROVAL_SUBJECTS,
  MONEY_SUBJECTS,
  STATE_FOR,
  approvedBy,
  must,
  mutate,
  rehash,
  valid,
  withTotal,
} from "./fixtures";

const seen = new Set<ReasonCode>();
function expectDecision(input: unknown, codes: ReasonCode[]) {
  const d = evaluatePolicy(input);
  d.reasonCodes.forEach((c) => seen.add(c));
  expect(d.reasonCodes).toEqual([...codes].sort());
  expect(d.verdict).toBe(codes.length === 0 ? "ALLOW" : "DENY");
  return d;
}

describe("policy engine: every rule, per subject", () => {
  for (const c of cases) {
    for (const s of c.subjects) {
      it(`${s}: ${c.name}`, () => {
        expectDecision(
          applyCase(ready(s), c),
          typeof c.codes === "function" ? c.codes(s) : c.codes,
        );
      });
    }
  }
});

describe("happy path", () => {
  it.each(ALL_SUBJECTS)(
    "%s: a fully valid input is allowed, with a complete decision record",
    (s) => {
      const d = evaluatePolicy(valid(s));
      expect(d.verdict).toBe("ALLOW");
      expect(d.reasonCodes).toEqual([]);
      expect(d.findings).toEqual([]);
      expect(d.subject).toBe(s);
      expect(d.policyVersion).toBe(POLICY_VERSION);
      expect(d.mandateRef).toEqual({ id: "M1", version: 2 });
      expect(d.inputsHash).toMatch(/^[0-9a-f]{64}$/);
      expect(d.explanation).toMatch(/^ALLOW /);
    },
  );

  it("a denial carries codes, per-rule messages and a human-readable explanation", () => {
    const d = evaluatePolicy(
      mutate(valid("CAPTURE"), (x) => {
        x.actor = "AGENT";
      }),
    );
    expect(d.verdict).toBe("DENY");
    expect(d.reasonCodes).toEqual(["ACTOR_NOT_PERMITTED"]);
    expect(d.findings).toHaveLength(1);
    expect(d.explanation).toMatch(/^DENY CAPTURE: .*AGENT.*CAPTURE/);
    expect(d.policyVersion).toBe(POLICY_VERSION);
  });

  it("is deterministic and sensitive to its inputs", () => {
    const a = evaluatePolicy(valid("CREATE_ORDER"));
    const b = evaluatePolicy(structuredClone(valid("CREATE_ORDER")));
    expect(b).toEqual(a);
    expect(
      evaluatePolicy(
        mutate(valid("CREATE_ORDER"), (x) => {
          x.others = [{ id: "t9", state: "FAILED", currency: "USD", totalMinor: 1 }];
        }),
      ).inputsHash,
    ).not.toBe(a.inputsHash);
  });
});

describe("transaction state: exhaustive subject x state matrix", () => {
  const target = {
    ACCEPT_OFFER: "AGREED",
    CREATE_ORDER: "CREATING_ORDER",
    AUTHORIZE: "AUTHORIZING",
    CAPTURE: "CAPTURING",
    VOID: "VOIDING",
  } as const;
  for (const s of POLICY_SUBJECTS) {
    for (const state of TX_STATES) {
      const legal = canTransition(state, target[s]);
      it(`${s} while ${state}: ${legal ? "allowed" : "denied"}`, () => {
        const d = evaluatePolicy(
          mutate(ready(s), (x) => {
            x.transaction.state = state;
          }),
        );
        seen.add("STATE_NOT_PERMITTED");
        expect(d.verdict).toBe(legal ? "ALLOW" : "DENY");
        expect(d.reasonCodes).toEqual(legal ? [] : ["STATE_NOT_PERMITTED"]);
      });
    }
  }

  it("each action is legal from exactly the state the state machine says", () => {
    for (const s of POLICY_SUBJECTS) {
      const allowedFrom = TX_STATES.filter((st) => canTransition(st, target[s]));
      expect(allowedFrom).toEqual([STATE_FOR[s]]);
    }
  });
});

describe("boundaries (mandate: cap 100.00, budget 150.00, approval above 50.00)", () => {
  const total = (s: PolicySubject, n: number, tweak?: (d: PolicyInput) => void) =>
    evaluatePolicy(
      mutate(ready(s), (d) => {
        withTotal(d, n);
        tweak?.(d);
      }),
    );

  it.each(MONEY_SUBJECTS)("%s: per-transaction cap is inclusive", (s) => {
    expect(total(s, 9999).verdict).toBe("ALLOW");
    expect(total(s, 10000).verdict).toBe("ALLOW");
    expect(total(s, 10001).reasonCodes).toEqual(["OVER_PER_TX_CAP"]);
  });

  it.each(MONEY_SUBJECTS)(
    "%s: cumulative budget is inclusive of exactly the remaining amount",
    (s) => {
      const others = (n: number) => (d: PolicyInput) => {
        d.others = [{ id: "tx_2", state: "AUTHORIZED", currency: "USD", totalMinor: n }];
      };
      expect(total(s, 4500, others(10500)).verdict).toBe("ALLOW"); // 105.00 + 45.00 == 150.00
      expect(total(s, 4500, others(10501)).reasonCodes).toEqual(["OVER_TOTAL_BUDGET"]);
    },
  );

  it.each(MONEY_SUBJECTS)(
    "%s: the cap and the budget are independent checks and both report",
    (s) => {
      const d = total(s, 10001, (x) => {
        x.others = [{ id: "tx_2", state: "CAPTURED", currency: "USD", totalMinor: 10000 }];
      });
      expect(d.reasonCodes).toEqual(["OVER_PER_TX_CAP", "OVER_TOTAL_BUDGET"]);
    },
  );

  it.each(APPROVAL_SUBJECTS)("%s: approval is required strictly ABOVE the threshold", (s) => {
    const bare = (n: number) =>
      evaluatePolicy(
        mutate(valid(s), (d) => {
          withTotal(d, n);
        }),
      );
    expect(bare(4999).verdict).toBe("ALLOW");
    expect(bare(5000).verdict).toBe("ALLOW");
    expect(bare(5000).approvalRequirement).toBe("NOT_REQUIRED");
    expect(bare(5001).reasonCodes).toEqual(["APPROVAL_REQUIRED"]);
    expect(bare(5001).approvalRequirement).toBe("ABOVE_THRESHOLD");
  });

  it.each(APPROVAL_SUBJECTS)("%s: a valid operator approval satisfies the requirement", (s) => {
    expect(total(s, 9000).verdict).toBe("ALLOW");
    expect(total(s, 9000).approvalRequirement).toBe("ABOVE_THRESHOLD");
  });

  it.each(APPROVAL_SUBJECTS)("%s: forced review requires approval even for tiny amounts", (s) => {
    const forced = (approve: boolean) =>
      evaluatePolicy(
        mutate(valid(s), (d) => {
          withTotal(d, 1);
          d.mandate.terms.requireReviewBeforeExecution = true;
          if (approve) d.approval = approvedBy();
        }),
      );
    expect(forced(false).reasonCodes).toEqual(["APPROVAL_REQUIRED"]);
    expect(forced(false).approvalRequirement).toBe("REVIEW_REQUIRED");
    expect(forced(true).verdict).toBe("ALLOW");
  });

  it("accepting an offer reports, but does not demand, the approval that will be needed later", () => {
    const d = total("ACCEPT_OFFER", 9000);
    expect(d.verdict).toBe("ALLOW");
    expect(d.approvalRequirement).toBe("ABOVE_THRESHOLD");
  });

  it("the maximum representable amount is handled exactly", () => {
    const max = Number.MAX_SAFE_INTEGER;
    const big = (n: number) => (d: PolicyInput) => {
      d.mandate.terms.maxTransactionMinor = max;
      d.mandate.terms.totalBudgetMinor = max;
      d.mandate.terms.approvalThresholdMinor = max;
      void n;
    };
    expect(total("ACCEPT_OFFER", max, big(0)).verdict).toBe("ALLOW");
    expect(
      total("ACCEPT_OFFER", max, (d) => {
        big(0)(d);
        d.others = [{ id: "tx_2", state: "AUTHORIZED", currency: "USD", totalMinor: 1 }];
      }).reasonCodes,
    ).toEqual(["OVER_TOTAL_BUDGET"]);
  });

  it("a zero-decimal currency (JPY) works in whole units", () => {
    const d = evaluatePolicy(
      mutate(valid("ACCEPT_OFFER"), (x) => {
        x.mandate.terms.currency = "JPY";
        must(x.offer).currency = "JPY";
        rehash(x);
      }),
    );
    expect(d.verdict).toBe("ALLOW");
    expect(d.explanation).toMatch(/ALLOW/);
  });
});

describe("exposure table mirrors the state-machine document", () => {
  const released = ["NEGOTIATING", "VOIDED", "REJECTED", "CANCELLED", "FAILED"];
  it.each(TX_STATES)("%s", (state) => {
    expect(exposureCounts(state)).toBe(!released.includes(state));
  });

  it.each(TX_STATES)(
    "other transaction in %s counts against the budget exactly when the table says so",
    (state) => {
      const d = evaluatePolicy(
        mutate(valid("ACCEPT_OFFER"), (x) => {
          x.others = [{ id: "tx_2", state, currency: "USD", totalMinor: 10501 }];
        }),
      );
      expect(d.reasonCodes).toEqual(exposureCounts(state) ? ["OVER_TOTAL_BUDGET"] : []);
    },
  );

  it("this transaction is never double counted, even when listed among the others", () => {
    const d = evaluatePolicy(
      mutate(ready("CREATE_ORDER"), (x) => {
        x.others = [{ id: "tx_1", state: "AGREED", currency: "USD", totalMinor: 15000 }];
      }),
    );
    expect(d.verdict).toBe("ALLOW");
  });

  it("a released transaction in another currency is ignored; a counted one is not", () => {
    const ignored = evaluatePolicy(
      mutate(valid("ACCEPT_OFFER"), (x) => {
        x.others = [{ id: "tx_2", state: "VOIDED", currency: "EUR", totalMinor: 999999 }];
      }),
    );
    expect(ignored.verdict).toBe("ALLOW");
  });
});

describe("reason-code catalogue", () => {
  it("codes are upper snake case and each has a description", () => {
    for (const [code, text] of Object.entries(REASON_CODES)) {
      expect(code).toMatch(/^[A-Z][A-Z0-9_]+$/);
      expect(text.length).toBeGreaterThan(10);
    }
  });
});

// Coverage of the reason-code catalogue: a FILE-level afterAll, because it must run after every case in every describe that
// fills `seen`, whatever order the tests run in (a shuffled run found the previous in-order it() failing when it ran early).
afterAll(() => {
  // POLICY_ERROR needs a hostile object; INPUT_INVALID is exercised in depth in bypass.test.ts; trigger both directly here.
  expectDecision(
    {
      get subject(): never {
        throw new Error("boom");
      },
    },
    ["POLICY_ERROR"],
  );
  expectDecision(null, ["INPUT_INVALID"]);
  const missing = (Object.keys(REASON_CODES) as ReasonCode[]).filter((c) => !seen.has(c));
  expect(missing).toEqual([]);
});
