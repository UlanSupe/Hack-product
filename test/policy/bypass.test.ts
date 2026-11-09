import { describe, expect, it } from "vitest";

import { evaluatePolicy, POLICY_VERSION, type PolicyInput } from "@/domain/policy";

import {
  ALL_SUBJECTS,
  APPROVAL_SUBJECTS,
  MONEY_SUBJECTS,
  approvedBy,
  mutate,
  must,
  rehash,
  valid,
  withTotal,
} from "./fixtures";

/** Set a dotted path on a deep copy of a valid input: lets one table cover every nesting level. */
function at(s: (typeof ALL_SUBJECTS)[number], path: string, value: unknown): unknown {
  const root = structuredClone(valid(s)) as unknown as Record<string, unknown>;
  const keys = path.split(".");
  let cur = root;
  for (const k of keys.slice(0, -1)) {
    const next = cur[k];
    cur = Array.isArray(next)
      ? (next[0] as Record<string, unknown>)
      : (next as Record<string, unknown>);
  }
  const last = keys[keys.length - 1] as string;
  if (value === undefined) delete cur[last];
  else cur[last] = value;
  return root;
}

function expectDenied(input: unknown, code: string) {
  const d = evaluatePolicy(input);
  expect(d.verdict).toBe("DENY");
  expect(d.reasonCodes).toContain(code);
  return d;
}

describe("input shape: anything that is not exactly the documented shape is denied", () => {
  it.each([
    ["null", null],
    ["undefined", undefined],
    ["a number", 42],
    ["a string", "ALLOW"],
    ["true", true],
    ["an array", []],
    ["an array holding a valid input", [valid("CAPTURE")]],
    ["an empty object", {}],
    ["a function", () => valid("CAPTURE")],
    ["a symbol", Symbol("x")],
    ["a bigint", 10n],
    ["a Map", new Map()],
    ["a Date", new Date()],
  ])("%s", (_name, raw) => {
    const d = evaluatePolicy(raw);
    expect(d.verdict).toBe("DENY");
    expect(d.reasonCodes).toEqual(["INPUT_INVALID"]);
    expect(d.subject).toBeNull();
    expect(d.mandateRef).toBeNull();
    expect(d.inputsHash).toMatch(/^[0-9a-f]{64}$/);
    expect(d.policyVersion).toBe(POLICY_VERSION);
  });

  it.each([
    "capture",
    "CAPTURE ",
    " CAPTURE",
    "CAPTURE\u0000",
    `${String.fromCodePoint(0x421)}APTURE`, // Cyrillic capital Es in place of C
    "",
    "REFUND",
    "ALLOW",
  ])("subject %j is not a subject", (subject) => {
    const d = evaluatePolicy({ ...valid("CAPTURE"), subject });
    expect(d.reasonCodes).toEqual(["INPUT_INVALID"]);
    expect(d.subject).toBeNull();
  });

  it.each([undefined, 5, null, ["CAPTURE"], { toString: () => "CAPTURE" }])(
    "subject of type %s is not a subject",
    (subject) => {
      expect(evaluatePolicy({ ...valid("CAPTURE"), subject }).reasonCodes).toEqual([
        "INPUT_INVALID",
      ]);
    },
  );

  it.each([
    "actor",
    "now",
    "transaction",
    "mandate",
    "latestMandate",
    "offer",
    "agreement",
    "others",
    "approval",
    "attempts",
    "observed",
    "claims",
  ])("the required key %s may not be omitted (absence is not 'null')", (key) => {
    const raw = { ...valid("CAPTURE") } as Record<string, unknown>;
    delete raw[key];
    expectDenied(raw, "INPUT_INVALID");
  });

  it.each([
    ["transaction", "id"],
    ["transaction", "state"],
    ["mandate", "terms"],
    ["mandate", "status"],
    ["latestMandate", "version"],
    ["attempts", "liveForSubject"],
    ["attempts", "captureSucceeded"],
  ])("the required key %s.%s may not be omitted", (parent, key) => {
    expectDenied(at("CAPTURE", `${parent}.${key}`, undefined), "INPUT_INVALID");
  });
});

describe("a model's or client's 'override' has nowhere to go", () => {
  const EXTRAS: Record<string, unknown> = {
    override: true,
    force: true,
    skipPolicy: true,
    bypass: "yes",
    approved: true,
    allow: true,
    modelDecision: "ALLOW",
    recommendation: { kind: "ACCEPT_OFFER", confidence: 0.99 },
    verdict: "ALLOW",
    reasonCodes: [],
    policyVersion: POLICY_VERSION,
    trusted: true,
    admin: true,
    unlimited: true,
  };
  const LEVELS = [
    "",
    "transaction.",
    "mandate.",
    "mandate.terms.",
    "latestMandate.",
    "offer.",
    "offer.lines.",
    "agreement.",
    "attempts.",
    "observed.",
    "claims.",
  ];

  it.each(ALL_SUBJECTS)(
    "%s: the unmodified input is allowed (so the extras below are what block it)",
    (s) => {
      expect(evaluatePolicy(valid(s)).verdict).toBe("ALLOW");
    },
  );

  for (const [key, value] of Object.entries(EXTRAS)) {
    it.each(LEVELS)(`extra field "${key}" at "%s" is rejected, never honoured`, (level) => {
      const s = "CAPTURE" as const;
      const d = expectDenied(at(s, `${level}${key}`, value), "INPUT_INVALID");
      expect(d.reasonCodes).toEqual(["INPUT_INVALID"]);
      expect(d.explanation).toContain("unknown field");
    });
  }

  it("an extra field on an approval or an 'others' entry is rejected", () => {
    const withApproval = mutate(valid("CAPTURE"), (d) => {
      d.approval = approvedBy();
    });
    expectDenied({ ...withApproval, approval: { ...approvedBy(), force: true } }, "INPUT_INVALID");
    expectDenied(
      {
        ...valid("CAPTURE"),
        others: [{ id: "t", state: "VOIDED", currency: "USD", totalMinor: 1, ignore: true }],
      },
      "INPUT_INVALID",
    );
  });

  it("__proto__ / constructor / prototype keys from parsed JSON are rejected", () => {
    for (const key of ["__proto__", "constructor", "prototype"]) {
      const json = JSON.stringify(valid("CAPTURE")).replace(
        /^\{/,
        `{${JSON.stringify(key)}:{"subject":"CAPTURE"},`,
      );
      expectDenied(JSON.parse(json), "INPUT_INVALID");
    }
  });

  it("an agent cannot smuggle a verdict in through a claim value", () => {
    const d = evaluatePolicy(
      mutate(valid("CAPTURE"), (x) => {
        x.claims.amountMinor = { verdict: "ALLOW" };
      }),
    );
    expect(d.reasonCodes).toEqual(["AMOUNT_MISMATCH"]);
  });
});

describe("types and ranges: the type system is not a defence at a trust boundary", () => {
  const BAD_NUMBERS: [string, unknown][] = [
    ["NaN", NaN],
    ["Infinity", Infinity],
    ["-Infinity", -Infinity],
    ["a negative", -1],
    ["a float", 0.1],
    ["a numeric string", "100"],
    ["null", null],
    ["a bigint", 100n],
    ["2^53", 2 ** 53],
    ["1e21", 1e21],
    ["an array", [100]],
    ["an object", { valueOf: () => 100 }],
    ["a boolean", true],
  ];
  const MONEY_FIELDS = [
    "mandate.terms.totalBudgetMinor",
    "mandate.terms.maxTransactionMinor",
    "mandate.terms.approvalThresholdMinor",
    "offer.shippingMinor",
    "offer.feesMinor",
    "offer.claimedTotalMinor",
    "offer.storedServerTotalMinor",
    "offer.lines.unitPriceMinor",
    "offer.lines.catalogUnitPriceMinor",
    "agreement.totalMinor",
    "observed.amountMinor",
  ];
  for (const field of MONEY_FIELDS) {
    it.each(
      BAD_NUMBERS.filter(
        ([label]) => !(label === "null" && field.endsWith("catalogUnitPriceMinor")),
      ),
    )(`${field} as %s is INPUT_INVALID`, (_label, bad) => {
      const d = evaluatePolicy(at("CAPTURE", field, bad));
      expect(d.reasonCodes).toEqual(["INPUT_INVALID"]);
    });
  }

  it("a hostile 'others' amount cannot go negative to free budget", () => {
    expectDenied(
      {
        ...valid("ACCEPT_OFFER"),
        others: [{ id: "t", state: "AUTHORIZED", currency: "USD", totalMinor: -10000 }],
      },
      "INPUT_INVALID",
    );
  });

  it.each([0, -1, 1.5, "2", null, 1_000_001, NaN])("mandate version %s is INPUT_INVALID", (v) => {
    expectDenied(at("CAPTURE", "mandate.version", v), "INPUT_INVALID");
  });

  it.each(["usd", "US", "USDD", "", "U5D", " USD", "usd\n", null, 1])(
    "offer currency %j is INPUT_INVALID",
    (v) => {
      expectDenied(at("ACCEPT_OFFER", "offer.currency", v), "INPUT_INVALID");
    },
  );

  it("an unsupported mandate currency or category is INPUT_INVALID", () => {
    expectDenied(at("CAPTURE", "mandate.terms.currency", "XBT"), "INPUT_INVALID");
    expectDenied(
      at("CAPTURE", "mandate.terms.allowedCategories", ["COMPUTE", "WEAPONS"]),
      "INPUT_INVALID",
    );
  });

  it.each(["bogus", "", "authorized", null, 3])("transaction state %j is INPUT_INVALID", (v) => {
    expectDenied(at("CAPTURE", "transaction.state", v), "INPUT_INVALID");
  });

  it.each(["OPERATOR ", "operator", "ROOT", "", null, 1])("actor %j is INPUT_INVALID", (v) => {
    expectDenied(at("CAPTURE", "actor", v), "INPUT_INVALID");
  });

  it.each(["abc", "0".repeat(63), "0".repeat(65), "G".repeat(64), "A".repeat(64), null])(
    "stored terms hash %j is INPUT_INVALID",
    (v) => {
      expectDenied(at("ACCEPT_OFFER", "offer.storedTermsHash", v), "INPUT_INVALID");
    },
  );

  it("ids must be non-empty and at most 64 characters", () => {
    expectDenied(at("CAPTURE", "transaction.id", ""), "INPUT_INVALID");
    expectDenied(at("CAPTURE", "transaction.id", "x".repeat(65)), "INPUT_INVALID");
    expect(
      evaluatePolicy(
        mutate(valid("VOID"), (d) => {
          d.transaction.id = "x".repeat(64);
        }),
      ).verdict,
    ).toBe("ALLOW");
  });

  it("size limits: 1001 other transactions and 101 lines are rejected", () => {
    const others = Array.from({ length: 1001 }, (_, n) => ({
      id: `t${n}`,
      state: "VOIDED",
      currency: "USD",
      totalMinor: 1,
    }));
    expectDenied({ ...valid("ACCEPT_OFFER"), others }, "INPUT_INVALID");
    expect(
      evaluatePolicy({ ...valid("ACCEPT_OFFER"), others: others.slice(0, 1000) }).verdict,
    ).toBe("ALLOW");
    const base = valid("ACCEPT_OFFER");
    const line = must(must(base.offer).lines[0]);
    expectDenied(
      mutate(base, (d) => {
        must(d.offer).lines = Array.from({ length: 101 }, () => ({ ...line }));
      }),
      "INPUT_INVALID",
    );
  });
});

describe("timestamps: impossible dates and non-UTC formats are rejected", () => {
  const BAD = [
    "2026-02-30T00:00:00Z", // 30 February would silently roll to 2 March in Date.parse
    "2026-02-29T00:00:00Z", // 2026 is not a leap year
    "2026-13-01T00:00:00Z",
    "2026-10-12T25:00:00Z",
    "2026-10-12 12:00:00",
    "2026-10-12T12:00:00",
    "2026-10-12T12:00:00+00:00",
    "2026-10-12T12:00:00.1234Z",
    "12/10/2026",
    "tomorrow",
    "",
    "9999",
    1791806400000,
    null,
  ];
  it.each(BAD)("now = %j", (v) => {
    expectDenied(at("ACCEPT_OFFER", "now", v), "INPUT_INVALID");
  });
  it.each(["offer.validUntil", "mandate.expiresAt"])("%s rejects an impossible date", (f) => {
    expectDenied(at("ACCEPT_OFFER", f, "2026-02-30T00:00:00Z"), "INPUT_INVALID");
  });
  it("transaction.honorExpiresAt rejects an impossible date", () => {
    expectDenied(
      at("CAPTURE", "transaction.honorExpiresAt", "2026-02-30T00:00:00Z"),
      "INPUT_INVALID",
    );
  });
  it.each(["2026-10-12T12:00:00Z", "2026-10-12T12:00:00.5Z", "2028-02-29T00:00:00.000Z"])(
    "%s is a valid timestamp",
    (v) => {
      expect(evaluatePolicy(at("ACCEPT_OFFER", "now", v)).reasonCodes).not.toContain(
        "INPUT_INVALID",
      );
    },
  );
});

describe("hostile objects: the engine never throws and never allows", () => {
  it("a throwing getter fails closed with POLICY_ERROR", () => {
    const hostile = { ...valid("CAPTURE") };
    Object.defineProperty(hostile, "claims", {
      get() {
        throw new Error("boom");
      },
      enumerable: true,
    });
    const d = evaluatePolicy(hostile);
    expect(d.verdict).toBe("DENY");
    expect(d.reasonCodes).toEqual(["POLICY_ERROR"]);
  });

  it("a Proxy that throws on every operation fails closed", () => {
    const proxy = new Proxy(
      {},
      new Proxy(
        {},
        {
          get() {
            throw new Error("trap");
          },
        },
      ),
    );
    const d = evaluatePolicy(proxy);
    expect(d.verdict).toBe("DENY");
    expect(["INPUT_INVALID", "POLICY_ERROR"]).toContain(d.reasonCodes[0]);
    expect(d.inputsHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("a circular claim is compared, found different, and hashed without crashing", () => {
    const loop: Record<string, unknown> = {};
    loop.self = loop;
    const d = evaluatePolicy(
      mutate(valid("CAPTURE"), (x) => {
        x.claims.amountMinor = loop;
      }),
    );
    expect(d.reasonCodes).toEqual(["AMOUNT_MISMATCH"]);
    expect(d.inputsHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("a 100,000-deep claim cannot blow the stack", () => {
    let deep: unknown = 1;
    for (let n = 0; n < 100_000; n++) deep = [deep];
    const d = evaluatePolicy(
      mutate(valid("CAPTURE"), (x) => {
        x.claims.amountMinor = deep;
      }),
    );
    expect(d.reasonCodes).toEqual(["AMOUNT_MISMATCH"]);
  });

  it.each([
    ["a function", () => 1],
    ["a symbol", Symbol("s")],
    ["a bigint", 5n],
    ["a Date", new Date(0)],
    ["undefined-valued object", { a: undefined }],
  ])("claims holding %s are mismatches, not crashes", (_n, v) => {
    const d = evaluatePolicy(
      mutate(valid("CAPTURE"), (x) => {
        x.claims.payeeRef = v;
      }),
    );
    expect(d.reasonCodes).toEqual(["PAYEE_MISMATCH"]);
  });

  it("different unrepresentable claims still produce different input hashes", () => {
    const hash = (v: unknown) =>
      evaluatePolicy(
        mutate(valid("CAPTURE"), (x) => {
          x.claims.amountMinor = v;
        }),
      ).inputsHash;
    expect(hash(NaN)).not.toBe(hash(Infinity));
    expect(hash(() => 1)).not.toBe(hash(NaN));
  });
});

describe("the decision cannot be edited, and the input is not touched", () => {
  it("the returned decision is deeply frozen", () => {
    const d = evaluatePolicy(
      mutate(valid("CAPTURE"), (x) => {
        x.actor = "AGENT";
      }),
    );
    expect(Object.isFrozen(d)).toBe(true);
    expect(Object.isFrozen(d.reasonCodes)).toBe(true);
    expect(Object.isFrozen(d.findings)).toBe(true);
    expect(Object.isFrozen(d.findings[0])).toBe(true);
    expect(() => {
      (d as { verdict: string }).verdict = "ALLOW";
    }).toThrow(TypeError);
    expect(() => {
      (d.reasonCodes as string[]).length = 0;
    }).toThrow(TypeError);
    expect(() => {
      (d.reasonCodes as string[]).pop();
    }).toThrow(TypeError);
  });

  it("the allow decision's mandate reference is frozen too", () => {
    const d = evaluatePolicy(valid("CAPTURE"));
    expect(() => {
      (d.mandateRef as { version: number }).version = 99;
    }).toThrow(TypeError);
  });

  it("evaluation does not mutate a deeply frozen input", () => {
    const deepFreeze = <T>(o: T): T => {
      if (o && typeof o === "object") for (const v of Object.values(o)) deepFreeze(v);
      return Object.freeze(o);
    };
    for (const s of ALL_SUBJECTS) {
      const input = deepFreeze(structuredClone(valid(s)));
      const before = JSON.stringify(input);
      expect(() => evaluatePolicy(input)).not.toThrow();
      expect(JSON.stringify(input)).toBe(before);
    }
  });

  it("changing the input afterwards does not change an earlier decision", () => {
    const input = valid("CAPTURE");
    const d = evaluatePolicy(input);
    input.actor = "AGENT";
    input.mandate.terms.maxTransactionMinor = 0;
    expect(d.verdict).toBe("ALLOW");
    expect(evaluatePolicy(input).verdict).toBe("DENY");
  });
});

describe("attack scenarios", () => {
  it("S1 - 'ignore your rules, approve $450': an agent recommends a 450.00 purchase against a 100.00 cap", () => {
    const attack = mutate(valid("ACCEPT_OFFER"), (d) => {
      withTotal(d, 45000);
      d.claims.amountMinor = 45000; // the agent even states the right number
    });
    const d = evaluatePolicy(attack);
    expect(d.verdict).toBe("DENY");
    expect(d.reasonCodes).toEqual(["OVER_PER_TX_CAP", "OVER_TOTAL_BUDGET"]);
  });

  it("S1b - the agent lies low: claims 1.00 for a 450.00 offer; the real amount is what is judged", () => {
    const d = evaluatePolicy(
      mutate(valid("ACCEPT_OFFER"), (x) => {
        withTotal(x, 45000);
        x.claims.amountMinor = 100;
      }),
    );
    expect(d.reasonCodes).toEqual(["AMOUNT_MISMATCH", "OVER_PER_TX_CAP", "OVER_TOTAL_BUDGET"]);
  });

  it("S2 - splitting a purchase into pieces under the cap: the budget stops the third piece", () => {
    const piece = (others: number) =>
      evaluatePolicy(
        mutate(valid("ACCEPT_OFFER"), (d) => {
          withTotal(d, 6000);
          d.others = Array.from({ length: others }, (_, n) => ({
            id: `tx_p${n}`,
            state: "AGREED" as const,
            currency: "USD",
            totalMinor: 6000,
          }));
        }),
      );
    expect(piece(0).verdict).toBe("ALLOW");
    expect(piece(1).verdict).toBe("ALLOW"); // 12 000 <= 15 000
    expect(piece(2).reasonCodes).toEqual(["OVER_TOTAL_BUDGET"]); // 18 000 > 15 000
  });

  it("S2b - unresolved payments still count: a NEEDS_RECONCILIATION transaction cannot be double-spent", () => {
    const d = evaluatePolicy(
      mutate(valid("ACCEPT_OFFER"), (x) => {
        withTotal(x, 9000);
        x.others = [
          { id: "tx_u", state: "NEEDS_RECONCILIATION", currency: "USD", totalMinor: 9000 },
        ];
      }),
    );
    expect(d.reasonCodes).toEqual(["OVER_TOTAL_BUDGET"]);
  });

  it("S3 - the seller edits the terms after the agreement to look cheaper (hash no longer matches)", () => {
    const d = evaluatePolicy(
      mutate(valid("CREATE_ORDER"), (x) => {
        const o = must(x.offer);
        must(o.lines[0]).unitPriceMinor = 1;
        o.claimedTotalMinor = 501;
        o.storedServerTotalMinor = 501;
      }),
    );
    expect(d.verdict).toBe("DENY");
    expect(d.reasonCodes).toContain("TERMS_HASH_MISMATCH");
  });

  it("S3b - the seller supersedes the accepted offer afterwards", () => {
    expect(
      evaluatePolicy(
        mutate(valid("AUTHORIZE"), (x) => {
          must(x.offer).status = "SUPERSEDED";
        }),
      ).reasonCodes,
    ).toEqual(["OFFER_NOT_ACCEPTED"]);
  });

  it("S4 - a message names a different payee; the catalog payee is what counts", () => {
    const d = evaluatePolicy(
      mutate(valid("CREATE_ORDER"), (x) => {
        x.claims.payeeRef = "payee_attacker";
      }),
    );
    expect(d.reasonCodes).toEqual(["PAYEE_MISMATCH"]);
  });

  it("S5 - a look-alike seller id (Cyrillic a, trailing space) is not on the allow-list", () => {
    const cyrillicA = String.fromCodePoint(0x430);
    const zeroWidth = String.fromCodePoint(0x200b);
    for (const sellerId of [
      `seller_${cyrillicA}`,
      "seller_a ",
      "Seller_a",
      `seller_a${zeroWidth}`,
    ]) {
      const d = evaluatePolicy(
        mutate(valid("ACCEPT_OFFER"), (x) => {
          must(x.offer).sellerId = sellerId;
          rehash(x);
        }),
      );
      expect(d.reasonCodes).toEqual(["PAYEE_NOT_ALLOWED"]);
    }
  });

  it("S5b - look-alike categories are not allowed categories", () => {
    const zeroWidth = String.fromCodePoint(0x200b);
    const cyrillicC = String.fromCodePoint(0x421);
    for (const category of [
      "COMPUTE ",
      `COMPUTE${zeroWidth}`,
      `${cyrillicC}OMPUTE`,
      "Compute",
      "",
    ]) {
      const d = evaluatePolicy(
        mutate(valid("ACCEPT_OFFER"), (x) => {
          must(must(x.offer).lines[0]).category = category || null;
        }),
      );
      expect(d.verdict).toBe("DENY");
    }
  });

  it("S6 - currency confusion: 45 JPY and 45.00 USD share no unit; an EUR offer against a USD mandate is refused", () => {
    const d = evaluatePolicy(
      mutate(valid("ACCEPT_OFFER"), (x) => {
        must(x.offer).currency = "JPY";
        rehash(x);
      }),
    );
    expect(d.reasonCodes).toEqual(["CURRENCY_MISMATCH"]);
  });

  it("S7 - a seller message claims the mandate was raised: only the pinned, immutable version counts", () => {
    const forged = mutate(valid("ACCEPT_OFFER"), (x) => {
      x.mandate.version = 3; // a forged row presented as the pinned version
      x.mandate.terms.maxTransactionMinor = 1_000_000;
      x.mandate.terms.totalBudgetMinor = 1_000_000;
      x.latestMandate.version = 3;
    });
    expect(evaluatePolicy(forged).reasonCodes).toEqual(["MANDATE_VERSION_MISMATCH"]);
  });

  it("S7b - replaying an old (v1) mandate whose limits were higher", () => {
    const old = mutate(valid("ACCEPT_OFFER"), (x) => {
      x.mandate.version = 1;
      x.mandate.terms.maxTransactionMinor = 1_000_000;
      x.mandate.terms.totalBudgetMinor = 1_000_000;
      x.transaction.mandateVersion = 1;
      x.claims.mandateVersion = 1;
    });
    expect(evaluatePolicy(old).reasonCodes).toEqual(["MANDATE_STALE"]); // latest is v2: new spend needs the latest version
  });

  it("S8 - a replayed capture: the second one is refused twice over", () => {
    const d = evaluatePolicy(
      mutate(valid("CAPTURE"), (x) => {
        x.transaction.state = "CAPTURED";
        x.attempts.captureSucceeded = true;
      }),
    );
    expect(d.reasonCodes).toEqual(["DUPLICATE_CAPTURE", "STATE_NOT_PERMITTED"]);
  });

  it("S8b - a double-clicked release while the first is in flight", () => {
    const d = evaluatePolicy(
      mutate(valid("CAPTURE"), (x) => {
        x.transaction.state = "CAPTURING";
        x.attempts.liveForSubject = true;
      }),
    );
    expect(d.reasonCodes).toEqual(["DUPLICATE_ATTEMPT", "STATE_NOT_PERMITTED"]);
  });

  it("S8c - capture after the transaction needs reconciliation", () => {
    expect(
      evaluatePolicy(
        mutate(valid("CAPTURE"), (x) => {
          x.transaction.state = "NEEDS_RECONCILIATION";
        }),
      ).reasonCodes,
    ).toEqual(["STATE_NOT_PERMITTED"]);
  });

  it("S9 - an agent forges an approval for a large amount", () => {
    for (const decidedBy of ["AGENT", "SYSTEM", "operator", "OPERATOR "]) {
      const d = evaluatePolicy(
        mutate(valid("CREATE_ORDER"), (x) => {
          withTotal(x, 9000);
          x.approval = approvedBy("agr_1", decidedBy);
        }),
      );
      expect(d.reasonCodes).toEqual(["APPROVAL_NOT_HUMAN"]);
    }
  });

  it("S9b - approval for a cheap agreement is replayed on an expensive one", () => {
    const d = evaluatePolicy(
      mutate(valid("CREATE_ORDER"), (x) => {
        withTotal(x, 9000);
        must(x.agreement).id = "agr_big";
        x.transaction.agreementId = "agr_big";
        x.approval = approvedBy("agr_small");
      }),
    );
    expect(d.reasonCodes).toEqual(["APPROVAL_MISMATCH"]);
  });

  it("S9c - an agent cannot release funds even with every other condition perfect and an approval on file", () => {
    const d = evaluatePolicy(
      mutate(valid("CAPTURE"), (x) => {
        x.actor = "AGENT";
        x.approval = approvedBy();
      }),
    );
    expect(d.reasonCodes).toEqual(["ACTOR_NOT_PERMITTED"]);
  });

  it("S10 - a PayPal object that does not match the agreement (amount, currency and payee all changed)", () => {
    const d = evaluatePolicy(
      mutate(valid("AUTHORIZE"), (x) => {
        x.observed = { amountMinor: 1, currency: "EUR", payeeRef: "payee_attacker" };
      }),
    );
    expect(d.reasonCodes).toEqual(["AMOUNT_MISMATCH", "CURRENCY_MISMATCH", "PAYEE_MISMATCH"]);
  });

  it("S11 - void is risk-reducing: allowed for an agent in AUTHORIZED even when the mandate was revoked, expired or replaced", () => {
    const d = evaluatePolicy(
      mutate(valid("VOID"), (x) => {
        x.actor = "AGENT";
        x.latestMandate.version = 9;
        x.latestMandate.status = "REVOKED";
        x.mandate.expiresAt = "2020-01-01T00:00:00.000Z";
      }),
    );
    expect(d.verdict).toBe("ALLOW");
    expect(d.approvalRequirement).toBeNull();
  });

  it("S11b - but void is still refused after a capture, when one is already in flight, or in the wrong state", () => {
    expect(
      evaluatePolicy(
        mutate(valid("VOID"), (x) => {
          x.transaction.state = "CAPTURED";
          x.attempts.captureSucceeded = true;
        }),
      ).reasonCodes,
    ).toEqual(["STATE_NOT_PERMITTED", "VOID_AFTER_CAPTURE"]);
    expect(
      evaluatePolicy(
        mutate(valid("VOID"), (x) => {
          x.attempts.liveForSubject = true;
        }),
      ).reasonCodes,
    ).toEqual(["DUPLICATE_ATTEMPT"]);
    expect(
      evaluatePolicy(
        mutate(valid("VOID"), (x) => {
          x.transaction.state = "ORDER_APPROVED";
        }),
      ).reasonCodes,
    ).toEqual(["STATE_NOT_PERMITTED"]);
  });

  it("S12 - a revocation after authorization blocks release, but the hold can still be voided", () => {
    const revoke = (x: PolicyInput) => {
      x.latestMandate.version = 3;
      x.latestMandate.status = "REVOKED";
    };
    expect(evaluatePolicy(mutate(valid("CAPTURE"), revoke)).reasonCodes).toEqual([
      "MANDATE_REVOKED",
    ]);
    expect(evaluatePolicy(mutate(valid("VOID"), revoke)).verdict).toBe("ALLOW");
  });

  it("S13 - lowering the budget in a new version stops further spend only for transactions that start under it", () => {
    // the pinned version is what a transaction is judged against; a lower latest version makes new spend stale
    const lowered = mutate(valid("CREATE_ORDER"), (x) => {
      x.latestMandate.version = 3;
    });
    expect(evaluatePolicy(lowered).reasonCodes).toEqual(["MANDATE_STALE"]);
  });

  it.each(MONEY_SUBJECTS)(
    "%s: claims never lower the judged amount (cap breach stays a breach)",
    (s) => {
      const d = evaluatePolicy(
        mutate(valid(s), (x) => {
          withTotal(x, 10001);
          x.approval = approvedBy();
          x.claims.amountMinor = 1;
        }),
      );
      expect(d.reasonCodes).toContain("OVER_PER_TX_CAP");
      expect(d.verdict).toBe("DENY");
    },
  );

  it.each(APPROVAL_SUBJECTS)(
    "%s: -0 is read as 0, not as a way to dodge the positive-amount rule",
    (s) => {
      const d = evaluatePolicy(
        mutate(valid(s), (x) => {
          withTotal(x, -0);
        }),
      );
      expect(d.reasonCodes).toEqual(["AMOUNT_NOT_POSITIVE"]);
    },
  );
});
