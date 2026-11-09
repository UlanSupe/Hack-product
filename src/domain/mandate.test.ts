import { describe, expect, it } from "vitest";

import {
  CATEGORY_CODES,
  CURRENCY_CODES,
  SERVICE_CATEGORIES,
  SUPPORTED_CURRENCIES,
  approvalRequirement,
  describeRules,
  formatMinor,
  parseDecimalAmount,
  toInputFields,
  validateMandateInput,
  type MandateInputFields,
  type SupportedCurrency,
} from "./mandate";

const valid = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  currency: "USD",
  totalBudget: "150.00",
  maxTransactionAmount: "100.00",
  approvalThreshold: "90.00",
  allowedCategories: ["COMPUTE"],
  allowedSellerIds: ["seller_acme"],
  requireReviewBeforeExecution: false,
  validDays: 30,
  ...over,
});

const errorsOf = (raw: unknown) => {
  const r = validateMandateInput(raw);
  if (r.ok) throw new Error("expected validation to fail");
  return r.errors;
};
const fieldsOf = (raw: unknown) => errorsOf(raw).map((e) => e.field);
const messageFor = (raw: unknown, field: string) =>
  errorsOf(raw).find((e) => e.field === field)?.message ?? "";

describe("parseDecimalAmount (decimal-safe, never rounds)", () => {
  const ok = (s: string, c: SupportedCurrency = "USD") => {
    const r = parseDecimalAmount(s, c);
    if (!r.ok) throw new Error(`expected ok for ${JSON.stringify(s)}: ${r.reason}`);
    return r.minor;
  };

  it.each([
    ["0", 0],
    ["0.00", 0],
    ["0.01", 1],
    ["0.1", 10], // the classic float trap: exactly 10 minor units
    ["0.10", 10],
    ["1", 100],
    ["100", 10_000],
    ["100.5", 10_050],
    ["100.50", 10_050],
    ["1234567.89", 123_456_789],
    ["90071992547409.91", Number.MAX_SAFE_INTEGER],
  ])("USD %s -> %d minor units", (input, minor) => {
    expect(ok(input)).toBe(minor);
  });

  it("uses the currency's decimals (JPY has none)", () => {
    expect(ok("500", "JPY")).toBe(500);
    expect(ok("12.34", "EUR")).toBe(1_234);
    for (const bad of ["500.0", "500.5", "500."])
      expect(parseDecimalAmount(bad, "JPY").ok).toBe(false);
    expect(messageForDecimal("0.5", "JPY")).toMatch(/no decimal places/);
  });

  it.each([
    ["negative", "-1", /must not be negative/],
    ["negative zero", "-0", /must not be negative/],
    ["negative decimal", "-0.01", /must not be negative/],
    ["plus sign", "+5", /plain decimal/],
    ["exponent", "1e3", /plain decimal/],
    ["thousands separator", "1,000.00", /plain decimal/],
    ["comma decimal", "1,5", /plain decimal/],
    ["leading space", " 10", /plain decimal/],
    ["trailing space", "10 ", /plain decimal/],
    ["trailing dot", "10.", /plain decimal/],
    ["leading dot", ".5", /plain decimal/],
    ["leading zeros", "007", /plain decimal/],
    ["hex", "0x10", /plain decimal/],
    ["NaN", "NaN", /plain decimal/],
    ["Infinity", "Infinity", /plain decimal/],
    ["currency symbol", "$10", /plain decimal/],
    ["non-ASCII digits", "١٢٣", /plain decimal/],
    ["empty", "", /required/],
    ["too many decimals", "0.001", /at most 2 decimal places/],
    ["sub-cent rounding trap", "10.999", /at most 2 decimal places/],
    ["beyond safe range", "90071992547409.92", /too large/],
    ["absurdly long", "1".repeat(30), /too long/],
  ])("rejects %s (%s)", (_name, input, pattern) => {
    const r = parseDecimalAmount(input, "USD");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(pattern);
  });

  it("rejects non-strings, including JSON numbers (a float must never reach money handling)", () => {
    for (const bad of [100, 0.1, null, undefined, true, [], {}, 10n]) {
      const r = parseDecimalAmount(bad, "USD");
      expect(r.ok, String(typeof bad)).toBe(false);
    }
  });

  it("round-trips with formatMinor for many values in every currency", () => {
    for (const c of CURRENCY_CODES) {
      for (const minor of [0, 1, 9, 10, 99, 100, 101, 12_345, 1_000_000, Number.MAX_SAFE_INTEGER]) {
        expect(ok(formatMinor(minor, c), c)).toBe(minor);
      }
      let seed = 12345;
      for (let i = 0; i < 200; i++) {
        seed = (seed * 1103515245 + 12345) % 2 ** 31;
        const minor = seed * 1000 + (seed % 997);
        expect(ok(formatMinor(minor, c), c)).toBe(minor);
      }
    }
  });
});

const messageForDecimal = (s: string, c: SupportedCurrency) => {
  const r = parseDecimalAmount(s, c);
  return r.ok ? "" : r.reason;
};

describe("formatMinor", () => {
  it("pads to the currency's decimals", () => {
    expect(formatMinor(0, "USD")).toBe("0.00");
    expect(formatMinor(5, "USD")).toBe("0.05");
    expect(formatMinor(10_050, "USD")).toBe("100.50");
    expect(formatMinor(7, "JPY")).toBe("7");
    expect(formatMinor(Number.MAX_SAFE_INTEGER, "USD")).toBe("90071992547409.91");
  });

  it("rejects negative, fractional and unsafe input", () => {
    for (const bad of [-1, 1.5, Number.NaN, Number.MAX_SAFE_INTEGER + 1])
      expect(() => formatMinor(bad, "USD")).toThrow(RangeError);
  });
});

describe("validateMandateInput: the happy path", () => {
  it("normalises a valid mandate into integer minor units, sorted unique lists", () => {
    const r = validateMandateInput(
      valid({
        allowedCategories: ["STORAGE", "COMPUTE"],
        allowedSellerIds: ["seller_b", "seller_a"],
      }),
    );
    expect(r).toEqual({
      ok: true,
      terms: {
        currency: "USD",
        totalBudgetMinor: 15_000,
        maxTransactionMinor: 10_000,
        approvalThresholdMinor: 9_000,
        allowedCategories: ["COMPUTE", "STORAGE"],
        allowedSellerIds: ["seller_a", "seller_b"],
        requireReviewBeforeExecution: false,
        validDays: 30,
      },
    });
  });

  it("handles JPY (no decimals) end to end", () => {
    const r = validateMandateInput(
      valid({
        currency: "JPY",
        totalBudget: "15000",
        maxTransactionAmount: "10000",
        approvalThreshold: "9000",
      }),
    );
    expect(r.ok && r.terms.totalBudgetMinor).toBe(15_000);
  });

  it("round-trips through toInputFields", () => {
    const r = validateMandateInput(valid());
    if (!r.ok) throw new Error("setup");
    const fields: MandateInputFields = toInputFields(r.terms);
    expect(fields).toMatchObject({
      totalBudget: "150.00",
      maxTransactionAmount: "100.00",
      approvalThreshold: "90.00",
    });
    expect(validateMandateInput(fields)).toEqual(r);
  });
});

describe("validateMandateInput: boundaries", () => {
  it.each([
    [
      "budget of one cent",
      { totalBudget: "0.01", maxTransactionAmount: "0.01", approvalThreshold: "0.00" },
    ],
    [
      "max equal to budget",
      { totalBudget: "100.00", maxTransactionAmount: "100.00", approvalThreshold: "100.00" },
    ],
    ["threshold of zero (everything needs approval)", { approvalThreshold: "0" }],
    ["threshold equal to the maximum", { approvalThreshold: "100.00" }],
    [
      "largest representable budget",
      {
        totalBudget: "90071992547409.91",
        maxTransactionAmount: "90071992547409.91",
        approvalThreshold: "0",
      },
    ],
    ["one day validity", { validDays: 1 }],
    ["365 days validity", { validDays: 365 }],
    ["every category", { allowedCategories: CATEGORY_CODES }],
  ])("accepts %s", (_n, over) => {
    expect(validateMandateInput(valid(over)).ok).toBe(true);
  });

  it.each([
    [
      "zero budget",
      { totalBudget: "0", maxTransactionAmount: "0", approvalThreshold: "0" },
      "totalBudget",
      /greater than zero/,
    ],
    [
      "zero maximum",
      { maxTransactionAmount: "0.00", approvalThreshold: "0" },
      "maxTransactionAmount",
      /greater than zero/,
    ],
    [
      "maximum one cent above budget",
      { totalBudget: "100.00", maxTransactionAmount: "100.01", approvalThreshold: "0" },
      "maxTransactionAmount",
      /must not exceed the total budget/,
    ],
    [
      "threshold one cent above maximum",
      { approvalThreshold: "100.01" },
      "approvalThreshold",
      /must not exceed the maximum/,
    ],
    [
      "budget one unit over the safe range",
      { totalBudget: "90071992547409.92" },
      "totalBudget",
      /too large/,
    ],
    ["zero days", { validDays: 0 }, "validDays", /from 1 to 365/],
    ["366 days", { validDays: 366 }, "validDays", /from 1 to 365/],
    ["fractional days", { validDays: 1.5 }, "validDays", /whole number/],
    ["negative days", { validDays: -5 }, "validDays", /from 1 to 365/],
  ])("rejects %s", (_n, over, field, pattern) => {
    expect(messageFor(valid(over), field)).toMatch(pattern);
  });
});

describe("validateMandateInput: negative amounts, currency, categories", () => {
  it.each(["totalBudget", "maxTransactionAmount", "approvalThreshold"])(
    "rejects a negative %s",
    (field) => {
      expect(messageFor(valid({ [field]: "-1.00" }), field)).toMatch(/must not be negative/);
    },
  );

  it.each(["usd", "US", "USDX", "BTC", "XXX", "", "U$D", " USD", "EURO"])(
    "rejects currency %j",
    (currency) => {
      expect(fieldsOf(valid({ currency }))).toContain("currency");
    },
  );

  it("does not report amount errors it cannot judge without a valid currency", () => {
    expect(fieldsOf(valid({ currency: "BTC", totalBudget: "-1" }))).toEqual(["currency"]);
  });

  it("explains which categories are unsupported", () => {
    expect(
      messageFor(valid({ allowedCategories: ["COMPUTE", "GAMBLING"] }), "allowedCategories"),
    ).toMatch(/unsupported categories: "GAMBLING"/);
    expect(messageFor(valid({ allowedCategories: ["compute"] }), "allowedCategories")).toMatch(
      /unsupported/,
    );
    expect(messageFor(valid({ allowedCategories: [] }), "allowedCategories")).toMatch(
      /at least one/,
    );
    expect(
      messageFor(valid({ allowedCategories: ["COMPUTE", "COMPUTE"] }), "allowedCategories"),
    ).toMatch(/duplicates/);
    expect(
      messageFor(valid({ allowedCategories: [...CATEGORY_CODES, "COMPUTE"] }), "allowedCategories"),
    ).toMatch(/too many/);
    expect(messageFor(valid({ allowedCategories: "COMPUTE" }), "allowedCategories")).toMatch(
      /list/,
    );
    expect(fieldsOf(valid({ allowedCategories: [1] }))).toContain("allowedCategories");
  });

  it("validates sellers", () => {
    expect(fieldsOf(valid({ allowedSellerIds: [] }))).toEqual(["allowedSellerIds"]);
    expect(fieldsOf(valid({ allowedSellerIds: ["Seller One"] }))).toEqual(["allowedSellerIds"]);
    expect(fieldsOf(valid({ allowedSellerIds: ["a", "a"] }))).toEqual(["allowedSellerIds"]);
    expect(fieldsOf(valid({ allowedSellerIds: ["../etc/passwd"] }))).toEqual(["allowedSellerIds"]);
    expect(
      fieldsOf(valid({ allowedSellerIds: Array.from({ length: 21 }, (_, i) => `s${i}`) })),
    ).toEqual(["allowedSellerIds"]);
  });

  it("rejects JSON numbers, booleans and objects where decimal strings are required", () => {
    for (const bad of [100, 0.1, true, null, {}, []]) {
      expect(messageFor(valid({ totalBudget: bad }), "totalBudget")).toMatch(
        /decimal string|is required/,
      );
    }
  });

  it("requires a real boolean for the review flag", () => {
    for (const bad of ["true", "false", 1, 0, null, "yes"])
      expect(fieldsOf(valid({ requireReviewBeforeExecution: bad }))).toEqual([
        "requireReviewBeforeExecution",
      ]);
    expect(validateMandateInput(valid({ requireReviewBeforeExecution: true })).ok).toBe(true);
  });

  it("rejects a numeric string for validDays (strict types)", () => {
    expect(fieldsOf(valid({ validDays: "30" }))).toEqual(["validDays"]);
  });
});

describe("validateMandateInput: missing fields and forged fields", () => {
  const FIELDS = [
    "currency",
    "totalBudget",
    "maxTransactionAmount",
    "approvalThreshold",
    "allowedCategories",
    "allowedSellerIds",
    "requireReviewBeforeExecution",
    "validDays",
  ];

  it.each(FIELDS)("reports %s as required when missing", (field) => {
    const raw = valid();
    delete raw[field];
    expect(errorsOf(raw)).toContainEqual({ field, message: "is required" });
  });

  it("reports every missing field at once for an empty object", () => {
    expect(fieldsOf({}).sort()).toEqual([...FIELDS].sort());
  });

  it.each([null, undefined, "string", 42, true, []])("rejects a non-object body (%j)", (raw) => {
    expect(errorsOf(raw)).toEqual([{ field: "(root)", message: "must be an object" }]);
  });

  it("rejects fields that would let a caller set approval state, version, authorship or ids", () => {
    for (const key of [
      "status",
      "version",
      "createdBy",
      "approved",
      "approvedBy",
      "id",
      "mandateId",
      "owner",
      "contentHash",
      "actor",
      "draft",
      "isAdmin",
    ]) {
      const errors = errorsOf(valid({ [key]: key === "approved" ? true : "ACTIVE" }));
      expect(errors, key).toContainEqual({
        field: key,
        message: expect.stringMatching(/not a recognised field/) as string,
      });
    }
  });

  it("rejects a prototype-pollution style key from JSON.parse", () => {
    const raw = JSON.parse('{"__proto__": {"approved": true}, "currency": "USD"}') as unknown;
    expect(fieldsOf(raw)).toContain("__proto__");
  });

  it("reports both a bad field and a forged field together", () => {
    expect(fieldsOf(valid({ totalBudget: "-1", status: "ACTIVE" })).sort()).toEqual([
      "status",
      "totalBudget",
    ]);
  });

  it("bounds the echo of attacker-controlled text in messages", () => {
    const long = "A".repeat(500);
    const errors = errorsOf(valid({ currency: long }));
    expect(JSON.stringify(errors).length).toBeLessThan(300);
  });
});

describe("approvalRequirement", () => {
  const terms = { requireReviewBeforeExecution: false, approvalThresholdMinor: 9_000 };

  it("does not require approval at or below the threshold, and does just above it", () => {
    expect(approvalRequirement(terms, 1)).toBe("NOT_REQUIRED");
    expect(approvalRequirement(terms, 8_999)).toBe("NOT_REQUIRED");
    expect(approvalRequirement(terms, 9_000)).toBe("NOT_REQUIRED"); // equal: not "above"
    expect(approvalRequirement(terms, 9_001)).toBe("ABOVE_THRESHOLD");
    expect(approvalRequirement(terms, 10_000)).toBe("ABOVE_THRESHOLD");
  });

  it("a threshold of zero means every non-zero transaction needs approval", () => {
    expect(approvalRequirement({ ...terms, approvalThresholdMinor: 0 }, 1)).toBe("ABOVE_THRESHOLD");
  });

  it("the review flag overrides the threshold for every amount", () => {
    const strict = { requireReviewBeforeExecution: true, approvalThresholdMinor: 9_000 };
    for (const total of [1, 9_000, 9_001, 10_000])
      expect(approvalRequirement(strict, total)).toBe("REVIEW_REQUIRED");
  });
});

describe("describeRules and the closed lists", () => {
  it("states the exact rules in plain language", () => {
    const r = validateMandateInput(valid());
    if (!r.ok) throw new Error("setup");
    const lines = describeRules(r.terms);
    expect(lines).toContain("Total spending budget: 150.00 USD.");
    expect(lines).toContain("Maximum single transaction: 100.00 USD.");
    expect(lines.join("\n")).toMatch(
      /above 90\.00 USD need human approval[^.]*up to and including that amount do not/,
    );
    expect(lines.join("\n")).toMatch(/Compute & GPU/);
    const strict = validateMandateInput(valid({ requireReviewBeforeExecution: true }));
    if (!strict.ok) throw new Error("setup");
    expect(describeRules(strict.terms).join("\n")).toMatch(
      /Every transaction needs human review and approval/,
    );
  });

  it("keeps the supported lists closed and consistent", () => {
    expect(CURRENCY_CODES).toEqual(["USD", "EUR", "GBP", "JPY"]);
    expect(Object.keys(SERVICE_CATEGORIES)).toEqual(CATEGORY_CODES);
    expect(SUPPORTED_CURRENCIES.JPY.exponent).toBe(0);
  });
});
