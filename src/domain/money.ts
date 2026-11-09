/**
 * Money primitives. Amounts are non-negative integers in minor units (cents); never floats.
 * The SQLite schema enforces the same bounds (typeof integer, 0..MAX_SAFE_INTEGER) as a backstop.
 */

export const MAX_MINOR = Number.MAX_SAFE_INTEGER;

export function isMinor(n: unknown): n is number {
  return typeof n === "number" && Number.isSafeInteger(n) && n >= 0;
}

export function assertMinor(n: unknown, label = "amount"): number {
  if (!isMinor(n))
    throw new RangeError(`${label} must be a non-negative safe integer (minor units)`);
  return n;
}

const CURRENCY = /^[A-Z]{3}$/;

export function assertCurrency(c: unknown, label = "currency"): string {
  if (typeof c !== "string" || !CURRENCY.test(c)) {
    throw new RangeError(`${label} must be a 3-letter uppercase ISO 4217 code`);
  }
  return c;
}
