import { describe, expect, it } from "vitest";

import {
  authorizedAtOf,
  checkOrder,
  failureOutcome,
  HONOR_PERIOD_MS,
  interpretOrder,
  observedMoney,
  PROVIDER_ERROR_KINDS,
  type ObservedAuthorization,
  type ObservedOrder,
  type OrderExpectation,
} from "@/domain/payment";

const E: OrderExpectation = {
  amountMinor: 8000,
  currency: "USD",
  customId: "tx_1",
  invoiceId: "INV-tx_1-1",
  merchantId: "MERCHANT01",
};

const auth = (over: Partial<ObservedAuthorization> = {}): ObservedAuthorization => ({
  id: "AUTH1",
  status: "CREATED",
  amount: { minor: 8000, currency: "USD" },
  customId: "tx_1",
  invoiceId: null,
  createTime: null,
  expirationTime: null,
  statusReason: null,
  ...over,
});

const order = (over: Partial<ObservedOrder> = {}): ObservedOrder => ({
  id: "ORDER1",
  status: "CREATED",
  intent: "AUTHORIZE",
  purchaseUnitCount: 1,
  amount: { minor: 8000, currency: "USD" },
  payeeMerchantId: "MERCHANT01",
  customId: "tx_1",
  invoiceId: "INV-tx_1-1",
  approveUrl: null,
  authorizations: [],
  captures: [],
  ...over,
});

describe("checkOrder compares PayPal's answer with our records", () => {
  it("a faithful order has no findings and a verified payee", () => {
    expect(checkOrder(order(), E)).toEqual({ findings: [], payee: "MATCH" });
  });

  it.each([
    [{ intent: "CAPTURE" }, "INTENT_NOT_AUTHORIZE"],
    [{ intent: null }, "INTENT_NOT_AUTHORIZE"],
    [{ purchaseUnitCount: 0 }, "UNIT_COUNT"],
    [{ purchaseUnitCount: 2 }, "UNIT_COUNT"],
    [{ amount: null }, "AMOUNT_MISSING"],
    [{ amount: { minor: 7999, currency: "USD" } }, "AMOUNT_MISMATCH"],
    [{ amount: { minor: 8001, currency: "USD" } }, "AMOUNT_MISMATCH"],
    [{ amount: { minor: 8000, currency: "EUR" } }, "CURRENCY_MISMATCH"],
    [{ customId: null }, "CUSTOM_ID_MISMATCH"],
    [{ customId: "tx_2" }, "CUSTOM_ID_MISMATCH"],
    [{ invoiceId: null }, "INVOICE_ID_MISMATCH"],
    [{ invoiceId: "INV-tx_1-2" }, "INVOICE_ID_MISMATCH"],
    [{ payeeMerchantId: "OTHER" }, "PAYEE_MISMATCH"],
    [
      {
        captures: [
          {
            id: "CAP1",
            status: "COMPLETED",
            amount: { minor: 8000, currency: "USD" },
            finalCapture: true,
            invoiceId: null,
            createTime: null,
            statusReason: null,
          },
        ],
      },
      "UNEXPECTED_CAPTURE",
    ],
  ] as const)("%j -> %s", (over, finding) => {
    expect(checkOrder(order(over as Partial<ObservedOrder>), E).findings).toContain(finding);
  });

  it("the payee is NOT_PINNED without a configured merchant and UNVERIFIABLE when PayPal does not say", () => {
    expect(checkOrder(order(), { ...E, merchantId: null }).payee).toBe("NOT_PINNED");
    expect(checkOrder(order({ payeeMerchantId: null }), E).payee).toBe("UNVERIFIABLE");
  });
});

describe("interpretOrder maps PayPal states to ours", () => {
  const target = (o: ObservedOrder, e = E) => {
    const i = interpretOrder(o, e);
    return i.kind === "OBSERVED" ? i.target : `ANOMALY:${i.findings.join(",")}`;
  };

  it("CREATED -> ORDER_CREATED, APPROVED -> ORDER_APPROVED, VOIDED -> CANCELLED", () => {
    expect(target(order({ status: "CREATED" }))).toBe("ORDER_CREATED");
    expect(target(order({ status: "APPROVED" }))).toBe("ORDER_APPROVED");
    expect(target(order({ status: "VOIDED" }))).toBe("CANCELLED");
  });

  it("an order COMPLETED with an authorization is judged by the authorization, never by COMPLETED", () => {
    const done = (a: Partial<ObservedAuthorization>) =>
      order({ status: "COMPLETED", authorizations: [auth(a)] });
    expect(target(done({ status: "CREATED" }))).toBe("AUTHORIZED");
    expect(target(done({ status: "PENDING" }))).toBe("AUTHORIZATION_PENDING");
    expect(target(done({ status: "DENIED" }))).toBe("FAILED");
    expect(target(done({ status: "VOIDED" }))).toBe("VOIDED");
    expect(target(done({ status: "CAPTURED" }))).toBe("ANOMALY:UNEXPECTED_CAPTURE");
    expect(target(done({ status: "PARTIALLY_CAPTURED" }))).toBe("ANOMALY:UNEXPECTED_CAPTURE");
    expect(target(done({ status: "WHATEVER" }))).toBe("ANOMALY:AUTHORIZATION_STATUS_UNEXPECTED");
  });

  it("COMPLETED with no authorization, or with several, is an anomaly", () => {
    expect(target(order({ status: "COMPLETED" }))).toBe("ANOMALY:AUTHORIZATION_COUNT");
    expect(
      target(order({ status: "COMPLETED", authorizations: [auth(), auth({ id: "AUTH2" })] })),
    ).toBe("ANOMALY:AUTHORIZATION_COUNT");
  });

  it("an authorization on a CREATED (unapproved) order is an anomaly", () => {
    expect(target(order({ status: "CREATED", authorizations: [auth()] }))).toBe(
      "ANOMALY:ORDER_ON_CREATED_HAS_AUTHORIZATION",
    );
  });

  it.each(["SAVED", "BANANA"])("status %s is an anomaly", (status) => {
    expect(target(order({ status }))).toBe("ANOMALY:UNEXPECTED_STATUS");
  });

  it("PAYER_ACTION_REQUIRED (what the live sandbox reports for a fresh order) is ORDER_CREATED; with an authorization it is still an anomaly", () => {
    expect(target(order({ status: "PAYER_ACTION_REQUIRED" }))).toBe("ORDER_CREATED");
    expect(target(order({ status: "PAYER_ACTION_REQUIRED", authorizations: [auth()] }))).toBe(
      "ANOMALY:UNEXPECTED_STATUS",
    );
  });

  it("an authorization whose amount, currency or custom_id differs from the agreement is an anomaly even if the order looks right", () => {
    const done = (a: Partial<ObservedAuthorization>) =>
      order({ status: "COMPLETED", authorizations: [auth(a)] });
    expect(target(done({ amount: { minor: 7999, currency: "USD" } }))).toBe(
      "ANOMALY:AUTHORIZATION_AMOUNT_MISMATCH",
    );
    expect(target(done({ amount: { minor: 8000, currency: "EUR" } }))).toBe(
      "ANOMALY:AUTHORIZATION_CURRENCY_MISMATCH",
    );
    expect(target(done({ amount: null }))).toBe("ANOMALY:AMOUNT_MISSING");
    expect(target(done({ customId: "tx_other" }))).toBe("ANOMALY:AUTHORIZATION_CUSTOM_ID_MISMATCH");
  });

  it("order-level mismatches always win, whatever the status", () => {
    for (const status of ["CREATED", "APPROVED", "COMPLETED", "VOIDED"]) {
      expect(target(order({ status, amount: { minor: 1, currency: "USD" } }))).toMatch(
        /^ANOMALY:AMOUNT_MISMATCH/,
      );
    }
  });

  it("carries a note when the payee could not be verified", () => {
    const i = interpretOrder(order(), { ...E, merchantId: null });
    expect(i.kind === "OBSERVED" && i.notes.join(" ")).toMatch(/not configured/);
  });
});

describe("failure classification (state machine 4.1)", () => {
  it.each([
    ["NETWORK", [], "UNKNOWN"],
    ["TIMEOUT", [], "UNKNOWN"],
    ["RATE_LIMITED", [], "UNKNOWN"],
    ["SERVER", [], "UNKNOWN"],
    ["AUTH", [], "UNKNOWN"],
    ["CONFLICT", [], "UNKNOWN"],
    ["ACCEPTED_INCOMPLETE", [], "UNKNOWN"],
    ["MALFORMED", [], "UNKNOWN"],
    ["REJECTED", [], "DEFINITE_FAILURE"],
    ["REJECTED", ["INSTRUMENT_DECLINED"], "DEFINITE_FAILURE"],
    ["NOT_FOUND", [], "DEFINITE_FAILURE"],
    ["REJECTED", ["ORDER_ALREADY_AUTHORIZED"], "UNKNOWN"],
    ["REJECTED", ["PREVIOUS_REQUEST_IN_PROGRESS"], "UNKNOWN"],
    ["REJECTED", ["DUPLICATE_INVOICE_ID"], "UNKNOWN"],
    ["REJECTED", ["ORDER_COMPLETED_OR_VOIDED"], "UNKNOWN"],
  ] as const)("%s %j -> %s", (kind, issues, outcome) => {
    expect(failureOutcome({ kind, issues })).toBe(outcome);
  });

  it("every kind is classified, and only a refusal that proves nothing happened is definite", () => {
    for (const kind of PROVIDER_ERROR_KINDS) {
      const o = failureOutcome({ kind, issues: [] });
      expect(o === "DEFINITE_FAILURE").toBe(kind === "REJECTED" || kind === "NOT_FOUND");
    }
  });
});

describe("amounts and times", () => {
  it("observedMoney is exact and strict", () => {
    expect(observedMoney({ currency_code: "USD", value: "80.05" })).toEqual({
      minor: 8005,
      currency: "USD",
    });
    expect(observedMoney({ currency_code: "USD", value: "0.10" })).toEqual({
      minor: 10,
      currency: "USD",
    });
    expect(observedMoney({ currency_code: "JPY", value: "500" })).toEqual({
      minor: 500,
      currency: "JPY",
    });
    for (const value of [
      "80.055",
      "80.5.1",
      "-1.00",
      "1e3",
      " 1.00",
      "1,00",
      "NaN",
      "9".repeat(30),
    ]) {
      expect(observedMoney({ currency_code: "USD", value }), value).toBeNull();
    }
    expect(observedMoney({ currency_code: "XYZ", value: "1.00" })).toBeNull();
    expect(observedMoney(undefined)).toBeNull();
  });

  it("the honor period starts at the earlier of PayPal's create_time and our own observation", () => {
    const seen = new Date("2026-10-13T12:00:00.000Z");
    const plus3d = (iso: string) => new Date(Date.parse(iso) + HONOR_PERIOD_MS).toISOString();
    expect(authorizedAtOf(null, seen)).toEqual({
      authorizedAt: seen.toISOString(),
      honorExpiresAt: plus3d(seen.toISOString()),
    });
    // PayPal says it began earlier: we are more conservative
    expect(authorizedAtOf("2026-10-13T09:00:00Z", seen).authorizedAt).toBe(
      "2026-10-13T09:00:00.000Z",
    );
    // a later or unparseable PayPal time never extends the window
    expect(authorizedAtOf("2026-10-14T09:00:00Z", seen).authorizedAt).toBe(seen.toISOString());
    expect(authorizedAtOf("garbage", seen).authorizedAt).toBe(seen.toISOString());
  });
});

describe("captures: only a COMPLETED, full, final capture on a CAPTURED authorization is paid", () => {
  const E2 = { ...E, authorizationId: "AUTH1" };
  const cap = (over: Record<string, unknown> = {}) => ({
    id: "CAP1",
    status: "COMPLETED",
    amount: { minor: 8000, currency: "USD" },
    finalCapture: true as boolean | null,
    invoiceId: null,
    createTime: null,
    statusReason: null,
    ...over,
  });
  const auth = (status: string, over: Record<string, unknown> = {}) => ({
    id: "AUTH1",
    status,
    amount: { minor: 8000, currency: "USD" },
    customId: "tx_1",
    invoiceId: null,
    createTime: null,
    expirationTime: null,
    statusReason: null,
    ...over,
  });
  const read = (o: Partial<ObservedOrder>, e = E2) => {
    const r = interpretOrder(order({ status: "COMPLETED", ...o }), e);
    return r.kind === "ANOMALY" ? `ANOMALY:${r.findings.join(",")}` : r.target;
  };

  it("COMPLETED capture on a CAPTURED authorization -> CAPTURED", () => {
    expect(read({ authorizations: [auth("CAPTURED")], captures: [cap()] })).toBe("CAPTURED");
  });
  it("a COMPLETED capture whose authorization does not say CAPTURED is not believed", () => {
    for (const status of ["CREATED", "PENDING", "PARTIALLY_CAPTURED", "VOIDED", "DENIED"]) {
      expect(read({ authorizations: [auth(status)], captures: [cap()] })).toMatch(/^ANOMALY:/);
    }
  });
  it("PENDING capture -> CAPTURE_PENDING (not paid); other statuses are anomalies", () => {
    expect(
      read({ authorizations: [auth("CREATED")], captures: [cap({ status: "PENDING" })] }),
    ).toBe("CAPTURE_PENDING");
    expect(
      read({ authorizations: [auth("CAPTURED")], captures: [cap({ status: "PENDING" })] }),
    ).toBe("CAPTURE_PENDING");
    expect(
      read({ authorizations: [auth("CREATED")], captures: [cap({ status: "SURPRISE" })] }),
    ).toBe("ANOMALY:CAPTURE_STATUS_UNEXPECTED");
  });
  it("REFUNDED and PARTIALLY_REFUNDED -> REVERSED", () => {
    for (const status of ["REFUNDED", "PARTIALLY_REFUNDED"]) {
      expect(read({ authorizations: [auth("CAPTURED")], captures: [cap({ status })] })).toBe(
        "REVERSED",
      );
    }
  });
  it("declined or failed captures are history: the hold is still AUTHORIZED, and the decline is remembered", () => {
    for (const status of ["DECLINED", "FAILED"]) {
      const r = interpretOrder(
        order({
          status: "COMPLETED",
          authorizations: [auth("CREATED")],
          captures: [cap({ status })],
        }),
        E2,
      );
      expect(r).toMatchObject({
        kind: "OBSERVED",
        target: "AUTHORIZED",
        captureDeclined: true,
        capture: null,
      });
    }
  });
  it("amount, currency, finality and identity mismatches are anomalies", () => {
    const a = [auth("CAPTURED")];
    expect(
      read({ authorizations: a, captures: [cap({ amount: { minor: 7999, currency: "USD" } })] }),
    ).toBe("ANOMALY:CAPTURE_AMOUNT_MISMATCH");
    expect(
      read({ authorizations: a, captures: [cap({ amount: { minor: 8000, currency: "EUR" } })] }),
    ).toBe("ANOMALY:CAPTURE_CURRENCY_MISMATCH");
    expect(read({ authorizations: a, captures: [cap({ amount: null })] })).toBe(
      "ANOMALY:AMOUNT_MISSING",
    );
    expect(read({ authorizations: a, captures: [cap({ finalCapture: false })] })).toBe(
      "ANOMALY:CAPTURE_NOT_FINAL",
    );
    expect(read({ authorizations: a, captures: [cap({ finalCapture: null })] })).toBe("CAPTURED"); // PayPal did not say
    expect(read({ authorizations: a, captures: [cap()] }, { ...E2, captureId: "CAPOTHER" })).toBe(
      "ANOMALY:CAPTURE_ID_MISMATCH",
    );
    expect(read({ authorizations: [auth("CAPTURED", { id: "AUTH9" })], captures: [cap()] })).toBe(
      "ANOMALY:AUTHORIZATION_ID_MISMATCH",
    );
  });
  it("two live captures are an anomaly; an authorization that says captured with no capture listed is too", () => {
    expect(
      read({ authorizations: [auth("CAPTURED")], captures: [cap(), cap({ id: "CAP2" })] }),
    ).toBe("ANOMALY:CAPTURE_COUNT");
    expect(read({ authorizations: [auth("CAPTURED")], captures: [] })).toBe(
      "ANOMALY:UNEXPECTED_CAPTURE",
    );
  });
  it("a VOIDED order is VOIDED only with a VOIDED authorization; without any authorization it is CANCELLED", () => {
    expect(read({ status: "VOIDED", authorizations: [auth("VOIDED")] })).toBe("VOIDED");
    expect(read({ status: "VOIDED", authorizations: [auth("CREATED")] })).toBe(
      "ANOMALY:UNEXPECTED_STATUS",
    );
    expect(read({ status: "VOIDED", authorizations: [] })).toBe("CANCELLED");
  });
});
