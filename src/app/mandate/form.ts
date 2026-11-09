import type { MandateInputFields } from "@/domain/mandate";

/** What the editor holds while the operator types: everything is text, exactly as typed. */
export type FormState = {
  currency: string;
  totalBudget: string;
  maxTransactionAmount: string;
  approvalThreshold: string;
  allowedCategories: string[];
  allowedSellerIds: string[];
  requireReviewBeforeExecution: boolean;
  validDays: string;
};

export const emptyForm = (): FormState => ({
  currency: "USD",
  totalBudget: "",
  maxTransactionAmount: "",
  approvalThreshold: "",
  allowedCategories: [],
  allowedSellerIds: [],
  requireReviewBeforeExecution: false,
  validDays: "30",
});

export const formFromFields = (f: MandateInputFields): FormState => ({
  currency: f.currency,
  totalBudget: f.totalBudget,
  maxTransactionAmount: f.maxTransactionAmount,
  approvalThreshold: f.approvalThreshold,
  allowedCategories: [...f.allowedCategories],
  allowedSellerIds: [...f.allowedSellerIds],
  requireReviewBeforeExecution: f.requireReviewBeforeExecution,
  validDays: String(f.validDays),
});

/**
 * Form -> the request's `fields`. Money stays a decimal STRING (never a number). Surrounding whitespace is
 * trimmed as a courtesy; the server still rejects anything that is not a plain decimal.
 * `validDays` is sent as a number when it looks like a whole number, otherwise as typed so the server explains.
 */
export function fieldsFromForm(f: FormState): Record<string, unknown> {
  const days = f.validDays.trim();
  return {
    currency: f.currency.trim(),
    totalBudget: f.totalBudget.trim(),
    maxTransactionAmount: f.maxTransactionAmount.trim(),
    approvalThreshold: f.approvalThreshold.trim(),
    allowedCategories: f.allowedCategories,
    allowedSellerIds: f.allowedSellerIds,
    requireReviewBeforeExecution: f.requireReviewBeforeExecution,
    validDays: /^[0-9]{1,6}$/.test(days) ? Number(days) : days,
  };
}

export const sameForm = (a: FormState, b: FormState): boolean =>
  JSON.stringify([
    a.currency,
    a.totalBudget,
    a.maxTransactionAmount,
    a.approvalThreshold,
    [...a.allowedCategories].sort(),
    [...a.allowedSellerIds].sort(),
    a.requireReviewBeforeExecution,
    a.validDays,
  ]) ===
  JSON.stringify([
    b.currency,
    b.totalBudget,
    b.maxTransactionAmount,
    b.approvalThreshold,
    [...b.allowedCategories].sort(),
    [...b.allowedSellerIds].sort(),
    b.requireReviewBeforeExecution,
    b.validDays,
  ]);
