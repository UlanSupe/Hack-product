import { z } from "zod";

import { MAX_MINOR } from "./money.ts";

/**
 * Financial mandate rules (docs/MANDATE.md). Pure: usable on the server (authoritative) and in the
 * browser (instant hints). Money enters as DECIMAL STRINGS and leaves as integer minor units; no
 * float is ever involved, and nothing is rounded.
 */

/* ------------------------------------------------------------------ closed, server-owned lists */

/** Supported currencies and their number of minor-unit decimals. PayPal sandbox support per currency is unverified. */
export const SUPPORTED_CURRENCIES = {
  USD: { exponent: 2, label: "US dollar" },
  EUR: { exponent: 2, label: "Euro" },
  GBP: { exponent: 2, label: "Pound sterling" },
  JPY: { exponent: 0, label: "Japanese yen" },
} as const;
export type SupportedCurrency = keyof typeof SUPPORTED_CURRENCIES;
export const CURRENCY_CODES = Object.keys(SUPPORTED_CURRENCIES) as SupportedCurrency[];

/** Service categories a mandate can allow. Mirrored by the `service_categories` table (a test checks they agree). */
export const SERVICE_CATEGORIES = {
  COMPUTE: "Compute & GPU",
  STORAGE: "Storage & backup",
  DATA: "Data services",
  SOFTWARE: "Software subscriptions",
  DESIGN: "Design & creative",
  CONSULTING: "Consulting",
} as const;
export type ServiceCategory = keyof typeof SERVICE_CATEGORIES;
export const CATEGORY_CODES = Object.keys(SERVICE_CATEGORIES) as ServiceCategory[];

export const MAX_VALID_DAYS = 365;
const MAX_SELLERS = 20;
const MAX_DECIMAL_CHARS = 24;

/* ------------------------------------------------------------------ decimal-safe money */

export type DecimalResult = { ok: true; minor: number } | { ok: false; reason: string };

/**
 * Strict decimal string -> integer minor units. Accepts only `0`, `12`, `12.5`, `12.50` shapes:
 * no sign, no spaces, no thousands separators, no exponent, no leading zeros, and never more decimals
 * than the currency has (it refuses instead of rounding). JSON numbers are rejected on purpose.
 */
export function parseDecimalAmount(input: unknown, currency: SupportedCurrency): DecimalResult {
  if (typeof input !== "string")
    return { ok: false, reason: 'must be a decimal string such as "100.00"' };
  if (input.length === 0) return { ok: false, reason: "is required" };
  if (input.length > MAX_DECIMAL_CHARS) return { ok: false, reason: "is too long" };
  if (input.startsWith("-")) return { ok: false, reason: "must not be negative" };
  const m = /^(0|[1-9][0-9]*)(?:\.([0-9]+))?$/.exec(input);
  if (!m)
    return {
      ok: false,
      reason:
        "must be a plain decimal number like 100 or 100.50 (no signs, spaces, separators or exponent)",
    };
  const exponent = SUPPORTED_CURRENCIES[currency].exponent;
  const fraction = m[2] ?? "";
  if (fraction.length > exponent) {
    return {
      ok: false,
      reason:
        exponent === 0
          ? `${currency} has no decimal places`
          : `${currency} allows at most ${exponent} decimal places`,
    };
  }
  const minor = BigInt((m[1] as string) + fraction.padEnd(exponent, "0"));
  if (minor > BigInt(MAX_MINOR)) return { ok: false, reason: "is too large" };
  return { ok: true, minor: Number(minor) };
}

/** Integer minor units -> decimal string with exactly the currency's decimals, e.g. 10050 -> "100.50". */
export function formatMinor(minor: number, currency: SupportedCurrency): string {
  if (!Number.isSafeInteger(minor) || minor < 0)
    throw new RangeError("minor units must be a non-negative safe integer");
  const exponent = SUPPORTED_CURRENCIES[currency].exponent;
  const digits = BigInt(minor)
    .toString()
    .padStart(exponent + 1, "0");
  return exponent === 0 ? digits : `${digits.slice(0, -exponent)}.${digits.slice(-exponent)}`;
}

/**
 * An amount for the screen: integer minor units, never floating point, with the currency code ("450.00 USD").
 * Signed (a shortfall can be negative); a currency without a known exponent is shown with two decimals, as the
 * ISO 4217 majority is, rather than guessed at differently.
 */
export function formatMoney(minor: number, currency: string): string {
  if (!Number.isSafeInteger(minor)) throw new RangeError("minor units must be a safe integer");
  const code = currency in SUPPORTED_CURRENCIES ? (currency as SupportedCurrency) : null;
  const sign = minor < 0 ? "-" : "";
  const abs = Math.abs(minor);
  if (code !== null) return `${sign}${formatMinor(abs, code)} ${currency}`;
  const digits = BigInt(abs).toString().padStart(3, "0");
  return `${sign}${digits.slice(0, -2)}.${digits.slice(-2)} ${currency}`;
}

/* ------------------------------------------------------------------ validated mandate terms */

/** The fully validated, normalised rules. Amounts are minor units; lists are sorted and unique. */
export type MandateTerms = {
  currency: SupportedCurrency;
  totalBudgetMinor: number;
  /** Maximum amount of a single transaction (the per-transaction cap). */
  maxTransactionMinor: number;
  /** A transaction ABOVE this amount needs human approval. */
  approvalThresholdMinor: number;
  allowedCategories: ServiceCategory[];
  allowedSellerIds: string[];
  /** When true, every transaction needs human review before execution, whatever its amount. */
  requireReviewBeforeExecution: boolean;
  validDays: number;
};

export type FieldError = { field: string; message: string };
export type ValidationResult =
  { ok: true; terms: MandateTerms } | { ok: false; errors: FieldError[] };

/** The shape clients send and receive: money as decimal strings. Unknown keys are rejected. */
export type MandateInputFields = {
  currency: string;
  totalBudget: string;
  maxTransactionAmount: string;
  approvalThreshold: string;
  allowedCategories: string[];
  allowedSellerIds: string[];
  requireReviewBeforeExecution: boolean;
  validDays: number;
};

const required = (shape: string) => (iss: { input?: unknown }) =>
  iss.input === undefined ? "is required" : shape;
const clip = (v: unknown) => String(v).slice(0, 40);

const InputSchema = z.strictObject({
  currency: z.string({ error: required("must be a currency code such as USD") }),
  totalBudget: z.string({
    error: required('must be a decimal string such as "500.00" (not a JSON number)'),
  }),
  maxTransactionAmount: z.string({
    error: required('must be a decimal string such as "100.00" (not a JSON number)'),
  }),
  approvalThreshold: z.string({
    error: required('must be a decimal string such as "50.00" (not a JSON number)'),
  }),
  allowedCategories: z.array(z.string({ error: "must be text" }), {
    error: required("must be a list of categories"),
  }),
  allowedSellerIds: z.array(z.string({ error: "must be text" }), {
    error: required("must be a list of seller ids"),
  }),
  requireReviewBeforeExecution: z.boolean({ error: required("must be true or false") }),
  validDays: z.number({ error: required("must be a whole number of days") }),
});

const SELLER_ID = /^[a-z0-9_]{1,64}$/;

/**
 * The single validation entry point. Collects every problem (so a form can show them all) and never
 * throws. `raw` is untrusted: it may come from a browser, or from something pretending to be one.
 */
export function validateMandateInput(raw: unknown): ValidationResult {
  const errors: FieldError[] = [];
  const add = (field: string, message: string) => errors.push({ field, message });

  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    return { ok: false, errors: [{ field: "(root)", message: "must be an object" }] };
  }

  const parsed = InputSchema.safeParse(raw);
  const structural = new Set<string>();
  if (!parsed.success) {
    for (const issue of parsed.error.issues) {
      if (issue.code === "unrecognized_keys") {
        for (const key of issue.keys) {
          add(clip(key), "is not a recognised field and cannot be set through this request");
          structural.add(clip(key));
        }
        continue;
      }
      const field = String(issue.path[0] ?? "(root)");
      add(field, issue.message);
      structural.add(field);
    }
  }
  const obj = raw as Record<string, unknown>;
  const okField = (name: string) => !structural.has(name);

  // currency
  let currency: SupportedCurrency | undefined;
  if (okField("currency")) {
    const c = obj.currency as string;
    if ((CURRENCY_CODES as string[]).includes(c)) currency = c as SupportedCurrency;
    else
      add(
        "currency",
        `${JSON.stringify(clip(c))} is not supported; use one of ${CURRENCY_CODES.join(", ")} (uppercase)`,
      );
  }

  // amounts (need a valid currency to know the decimals)
  const amount = (field: keyof MandateInputFields): number | undefined => {
    if (!okField(field) || currency === undefined) return undefined;
    const r = parseDecimalAmount(obj[field], currency);
    if (r.ok) return r.minor;
    add(field, r.reason);
    return undefined;
  };
  const total = amount("totalBudget");
  const max = amount("maxTransactionAmount");
  const threshold = amount("approvalThreshold");

  if (total !== undefined && total <= 0) add("totalBudget", "must be greater than zero");
  if (max !== undefined && max <= 0) add("maxTransactionAmount", "must be greater than zero");
  if (total !== undefined && total > 0 && max !== undefined && max > 0 && max > total) {
    add("maxTransactionAmount", "must not exceed the total budget");
  }
  if (max !== undefined && max > 0 && threshold !== undefined && threshold > max) {
    add(
      "approvalThreshold",
      "must not exceed the maximum transaction amount (a higher threshold could never trigger)",
    );
  }

  // categories
  let categories: ServiceCategory[] | undefined;
  if (okField("allowedCategories")) {
    const list = obj.allowedCategories as string[];
    const bad = list.filter((c) => !(CATEGORY_CODES as string[]).includes(c));
    if (list.length === 0) add("allowedCategories", "choose at least one service category");
    else if (list.length > CATEGORY_CODES.length) add("allowedCategories", "has too many entries");
    else if (bad.length > 0)
      add(
        "allowedCategories",
        `unsupported categories: ${bad.map((b) => JSON.stringify(clip(b))).join(", ")}`,
      );
    else if (new Set(list).size !== list.length)
      add("allowedCategories", "must not contain duplicates");
    else categories = [...list].sort() as ServiceCategory[];
  }

  // sellers
  let sellers: string[] | undefined;
  if (okField("allowedSellerIds")) {
    const list = obj.allowedSellerIds as string[];
    if (list.length === 0) add("allowedSellerIds", "choose at least one seller");
    else if (list.length > MAX_SELLERS) add("allowedSellerIds", `at most ${MAX_SELLERS} sellers`);
    else if (list.some((s) => !SELLER_ID.test(s)))
      add("allowedSellerIds", "contains an invalid seller id");
    else if (new Set(list).size !== list.length)
      add("allowedSellerIds", "must not contain duplicates");
    else sellers = [...list].sort();
  }

  // validity
  let validDays: number | undefined;
  if (okField("validDays")) {
    const d = obj.validDays as number;
    if (!Number.isInteger(d) || d < 1 || d > MAX_VALID_DAYS)
      add("validDays", `must be a whole number of days from 1 to ${MAX_VALID_DAYS}`);
    else validDays = d;
  }

  if (
    errors.length > 0 ||
    !parsed.success ||
    currency === undefined ||
    total === undefined ||
    max === undefined ||
    threshold === undefined ||
    categories === undefined ||
    sellers === undefined ||
    validDays === undefined
  ) {
    return { ok: false, errors };
  }
  return {
    ok: true,
    terms: {
      currency,
      totalBudgetMinor: total,
      maxTransactionMinor: max,
      approvalThresholdMinor: threshold,
      allowedCategories: categories,
      allowedSellerIds: sellers,
      requireReviewBeforeExecution: parsed.data.requireReviewBeforeExecution,
      validDays,
    },
  };
}

/** Terms -> the client-facing field shape (used to pre-fill the editor). */
export function toInputFields(t: MandateTerms): MandateInputFields {
  return {
    currency: t.currency,
    totalBudget: formatMinor(t.totalBudgetMinor, t.currency),
    maxTransactionAmount: formatMinor(t.maxTransactionMinor, t.currency),
    approvalThreshold: formatMinor(t.approvalThresholdMinor, t.currency),
    allowedCategories: [...t.allowedCategories],
    allowedSellerIds: [...t.allowedSellerIds],
    requireReviewBeforeExecution: t.requireReviewBeforeExecution,
    validDays: t.validDays,
  };
}

/* ------------------------------------------------------------------ approval rule */

export type ApprovalRequirement = "REVIEW_REQUIRED" | "ABOVE_THRESHOLD" | "NOT_REQUIRED";

/**
 * Is human approval needed before executing a transaction of `totalMinor`?
 *  - REVIEW_REQUIRED: the mandate says every transaction is reviewed first.
 *  - ABOVE_THRESHOLD: strictly above the threshold (equal to it does NOT need approval).
 * The database enforces the same rule as a last line of defence (migration 0005).
 */
export function approvalRequirement(
  terms: Pick<MandateTerms, "requireReviewBeforeExecution" | "approvalThresholdMinor">,
  totalMinor: number,
): ApprovalRequirement {
  if (terms.requireReviewBeforeExecution) return "REVIEW_REQUIRED";
  return totalMinor > terms.approvalThresholdMinor ? "ABOVE_THRESHOLD" : "NOT_REQUIRED";
}

/** Plain-language statement of the exact rules, shown before approval and in the docs. */
export function describeRules(t: MandateTerms): string[] {
  const m = (v: number) => `${formatMinor(v, t.currency)} ${t.currency}`;
  return [
    `Total spending budget: ${m(t.totalBudgetMinor)}.`,
    `Maximum single transaction: ${m(t.maxTransactionMinor)}.`,
    t.requireReviewBeforeExecution
      ? "Every transaction needs human review and approval before it is executed."
      : `Transactions above ${m(t.approvalThresholdMinor)} need human approval before execution; transactions up to and including that amount do not.`,
    `Allowed service categories: ${t.allowedCategories.map((c) => SERVICE_CATEGORIES[c]).join(", ")}.`,
    `Allowed sellers: ${t.allowedSellerIds.join(", ")}.`,
    `Valid for ${t.validDays} day${t.validDays === 1 ? "" : "s"} from approval.`,
  ];
}
