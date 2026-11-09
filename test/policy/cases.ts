import {
  HONOR_MARGIN_MS,
  type PolicyInput,
  type PolicySubject,
  type ReasonCode,
} from "@/domain/policy";

import {
  ALL_SUBJECTS,
  APPROVAL_SUBJECTS,
  MONEY_SUBJECTS,
  NOW,
  NOW_MS,
  TOTAL,
  approvedBy,
  iso,
  must,
  mutate,
  rehash,
  valid,
  withTotal,
} from "./fixtures";

export const ZEROS = "0".repeat(64);
export const S_FRESH: PolicySubject[] = ["ACCEPT_OFFER", "CREATE_ORDER", "AUTHORIZE"];
export const S_POST: PolicySubject[] = ["CREATE_ORDER", "AUTHORIZE", "CAPTURE"];

/** A valid input plus, where the action needs one, an operator approval (so money cases isolate one rule). */
export function ready(s: PolicySubject): PolicyInput {
  const i = valid(s);
  if (APPROVAL_SUBJECTS.includes(s)) i.approval = approvedBy();
  return i;
}

/** One entry per rule violation (or deliberate non-violation). Shared by the per-rule and the combination tests. */
export type Case = {
  name: string;
  subjects: PolicySubject[];
  change: (d: PolicyInput) => void;
  codes: ReasonCode[] | ((s: PolicySubject) => ReasonCode[]);
  /** false = do NOT re-seal the mandate hash after the change: models a forged or substituted mandate row. */
  reseal?: boolean;
};

/** Apply a case to a copy of `base`. */
export function applyCase(base: PolicyInput, c: Case): PolicyInput {
  return mutate(base, c.change, { reseal: c.reseal ?? true });
}

export const cases: Case[] = [
  /* ---- authority */
  {
    name: "an agent asks for capture",
    subjects: ["CAPTURE"],
    change: (d) => {
      d.actor = "AGENT";
    },
    codes: ["ACTOR_NOT_PERMITTED"],
  },
  {
    name: "the system asks for capture (release is human-only)",
    subjects: ["CAPTURE"],
    change: (d) => {
      d.actor = "SYSTEM";
    },
    codes: ["ACTOR_NOT_PERMITTED"],
  },
  {
    name: "an agent asks for order creation / authorization",
    subjects: ["CREATE_ORDER", "AUTHORIZE"],
    change: (d) => {
      d.actor = "AGENT";
    },
    codes: ["ACTOR_NOT_PERMITTED"],
  },

  /* ---- identity claims */
  {
    name: "the request names another transaction",
    subjects: ALL_SUBJECTS,
    change: (d) => {
      d.claims.transactionId = "tx_2";
    },
    codes: ["TRANSACTION_MISMATCH"],
  },
  {
    name: "the offer belongs to another transaction",
    subjects: MONEY_SUBJECTS,
    change: (d) => {
      must(d.offer).transactionId = "tx_2";
    },
    codes: ["TRANSACTION_MISMATCH"],
  },

  /* ---- mandate version / status / freshness */
  {
    name: "the client presents mandate version 1 (older than pinned)",
    subjects: MONEY_SUBJECTS,
    change: (d) => {
      d.claims.mandateVersion = 1;
    },
    codes: ["MANDATE_VERSION_MISMATCH"],
  },
  {
    name: "the client presents mandate version 3 (newer than pinned)",
    subjects: MONEY_SUBJECTS,
    change: (d) => {
      d.claims.mandateVersion = 3;
    },
    codes: ["MANDATE_VERSION_MISMATCH"],
  },
  {
    name: "the client presents the version as a string",
    subjects: MONEY_SUBJECTS,
    change: (d) => {
      d.claims.mandateVersion = "2";
    },
    codes: ["MANDATE_VERSION_MISMATCH"],
  },
  {
    name: "the client names another mandate",
    subjects: MONEY_SUBJECTS,
    change: (d) => {
      d.claims.mandateId = "M2";
    },
    codes: ["MANDATE_MISMATCH"],
  },
  {
    name: "a newer mandate version exists (stale pin)",
    subjects: S_FRESH,
    change: (d) => {
      d.latestMandate.version = 3;
    },
    codes: ["MANDATE_STALE"],
  },
  {
    name: "a newer mandate version exists, but capture of an authorized hold is allowed",
    subjects: ["CAPTURE"],
    change: (d) => {
      d.latestMandate.version = 3;
    },
    codes: [],
  },
  {
    name: "the latest version is a revocation",
    subjects: S_FRESH,
    change: (d) => {
      d.latestMandate.version = 3;
      d.latestMandate.status = "REVOKED";
    },
    codes: ["MANDATE_REVOKED", "MANDATE_STALE"],
  },
  {
    name: "the latest version is a revocation (capture is still blocked)",
    subjects: ["CAPTURE"],
    change: (d) => {
      d.latestMandate.version = 3;
      d.latestMandate.status = "REVOKED";
    },
    codes: ["MANDATE_REVOKED"],
  },
  {
    name: "the latest row is REVOKED at the same version",
    subjects: MONEY_SUBJECTS,
    change: (d) => {
      d.latestMandate.status = "REVOKED";
    },
    codes: ["MANDATE_REVOKED"],
  },
  {
    name: "the pinned row itself is REVOKED",
    subjects: MONEY_SUBJECTS,
    change: (d) => {
      d.mandate.status = "REVOKED";
    },
    codes: ["MANDATE_REVOKED"],
  },
  {
    name: "the 'latest' row is older than the pinned one (impossible)",
    subjects: MONEY_SUBJECTS,
    change: (d) => {
      d.latestMandate.version = 1;
    },
    codes: ["MANDATE_VERSION_MISMATCH"],
  },
  {
    name: "the loaded mandate row is not the version the transaction pinned",
    subjects: MONEY_SUBJECTS,
    change: (d) => {
      d.transaction.mandateVersion = 1;
    },
    codes: ["MANDATE_VERSION_MISMATCH"],
  },
  {
    name: "the transaction is pinned to another mandate",
    subjects: MONEY_SUBJECTS,
    change: (d) => {
      d.transaction.mandateId = "M2";
    },
    codes: ["MANDATE_MISMATCH"],
  },
  {
    name: "the latest row belongs to another mandate",
    subjects: MONEY_SUBJECTS,
    change: (d) => {
      d.latestMandate.id = "M2";
    },
    codes: ["MANDATE_MISMATCH"],
  },
  {
    name: "the agreement was made under another mandate version",
    subjects: S_POST,
    change: (d) => {
      must(d.agreement).mandateVersion = 1;
    },
    codes: ["MANDATE_VERSION_MISMATCH"],
  },
  {
    name: "the agreement was made under another mandate",
    subjects: S_POST,
    change: (d) => {
      must(d.agreement).mandateId = "M2";
    },
    codes: ["MANDATE_MISMATCH"],
  },
  {
    name: "the mandate expired (now == expiresAt)",
    subjects: S_FRESH,
    change: (d) => {
      d.mandate.expiresAt = NOW;
    },
    codes: ["MANDATE_EXPIRED"],
  },
  {
    name: "the mandate expired, but capture of an authorized hold is allowed",
    subjects: ["CAPTURE"],
    change: (d) => {
      d.mandate.expiresAt = NOW;
    },
    codes: [],
  },
  {
    name: "the mandate expires one millisecond from now",
    subjects: MONEY_SUBJECTS,
    change: (d) => {
      d.mandate.expiresAt = iso(NOW_MS + 1);
    },
    codes: [],
  },

  /* ---- the mandate terms must be exactly the approved version */
  {
    name: "the terms were raised but the approved hash was kept (forged row)",
    subjects: MONEY_SUBJECTS,
    reseal: false,
    change: (d) => {
      d.mandate.terms.maxTransactionMinor = 1_000_000_000;
      d.mandate.terms.totalBudgetMinor = 1_000_000_000;
    },
    codes: ["MANDATE_INTEGRITY"],
  },
  {
    name: "draft terms were substituted for the approved ones",
    subjects: MONEY_SUBJECTS,
    reseal: false,
    change: (d) => {
      d.mandate.terms.allowedCategories = ["COMPUTE", "STORAGE", "DESIGN"];
      d.mandate.terms.approvalThresholdMinor = 10_000;
    },
    codes: ["MANDATE_INTEGRITY"],
  },
  {
    name: "the review requirement was switched off but the hash was kept",
    subjects: MONEY_SUBJECTS,
    reseal: false,
    change: (d) => {
      d.mandate.terms.requireReviewBeforeExecution = !d.mandate.terms.requireReviewBeforeExecution;
    },
    codes: ["MANDATE_INTEGRITY"],
  },
  {
    name: "the seller allow-list was widened but the hash was kept",
    subjects: MONEY_SUBJECTS,
    reseal: false,
    change: (d) => {
      d.mandate.terms.allowedSellerIds = [...d.mandate.terms.allowedSellerIds, "seller_x"];
    },
    codes: ["MANDATE_INTEGRITY"],
  },
  {
    name: "the expiry was extended but the hash was kept",
    subjects: MONEY_SUBJECTS,
    reseal: false,
    change: (d) => {
      d.mandate.expiresAt = "2030-01-01T00:00:00.000Z";
    },
    codes: ["MANDATE_INTEGRITY"],
  },
  {
    name: "the mandate owner was changed but the hash was kept",
    subjects: MONEY_SUBJECTS,
    reseal: false,
    change: (d) => {
      d.mandate.ownerId = "someone_else";
    },
    codes: ["MANDATE_INTEGRITY"],
  },
  {
    name: "the stored hash itself is wrong",
    subjects: MONEY_SUBJECTS,
    reseal: false,
    change: (d) => {
      d.mandate.contentHash = ZEROS;
    },
    codes: ["MANDATE_INTEGRITY"],
  },
  {
    name: "a revoked row is presented as active (status flipped, hash kept)",
    subjects: MONEY_SUBJECTS,
    reseal: false,
    change: (d) => {
      d.mandate.status = "REVOKED";
    },
    codes: ["MANDATE_INTEGRITY", "MANDATE_REVOKED"],
  },

  /* ---- offer */
  {
    name: "no offer is supplied",
    subjects: MONEY_SUBJECTS,
    change: (d) => {
      d.offer = null;
    },
    codes: ["OFFER_REQUIRED"],
  },
  ...(["SUPERSEDED", "EXPIRED", "REJECTED", "ACCEPTED"] as const).map((status): Case => ({
    name: `an offer that is ${status} is accepted`,
    subjects: ["ACCEPT_OFFER"],
    change: (d) => {
      must(d.offer).status = status;
    },
    codes: ["OFFER_NOT_OPEN"],
  })),
  ...(["OPEN", "SUPERSEDED", "EXPIRED", "REJECTED"] as const).map((status): Case => ({
    name: `the offer behind an agreement is ${status}`,
    subjects: S_POST,
    change: (d) => {
      must(d.offer).status = status;
    },
    codes: ["OFFER_NOT_ACCEPTED"],
  })),
  {
    name: "the offer validity ends exactly now",
    subjects: ["ACCEPT_OFFER"],
    change: (d) => {
      must(d.offer).validUntil = NOW;
    },
    codes: ["OFFER_EXPIRED"],
  },
  {
    name: "the offer is valid for one more millisecond",
    subjects: ["ACCEPT_OFFER"],
    change: (d) => {
      must(d.offer).validUntil = iso(NOW_MS + 1);
    },
    codes: [],
  },
  {
    name: "an offer past its validity no longer matters once agreed",
    subjects: S_POST,
    change: (d) => {
      must(d.offer).validUntil = iso(NOW_MS - 1000);
    },
    codes: [],
  },
  {
    name: "the offer has no lines (otherwise consistent)",
    subjects: MONEY_SUBJECTS,
    change: (d) => {
      const o = must(d.offer);
      o.lines = [];
      o.shippingMinor = TOTAL;
      rehash(d);
    },
    codes: ["OFFER_EMPTY"],
  },

  /* ---- totals and hashes */
  {
    name: "the seller claims a lower total than the lines add up to",
    subjects: MONEY_SUBJECTS,
    change: (d) => {
      must(d.offer).claimedTotalMinor = 4000;
    },
    codes: ["TOTAL_MISMATCH"],
  },
  {
    name: "the stored server total is wrong",
    subjects: MONEY_SUBJECTS,
    change: (d) => {
      must(d.offer).storedServerTotalMinor = 1;
    },
    codes: ["TOTAL_MISMATCH"],
  },
  {
    name: "a line quantity is changed without updating anything else",
    subjects: MONEY_SUBJECTS,
    change: (d) => {
      must(must(d.offer).lines[0]).qty = 2;
    },
    codes: (s) =>
      s === "ACCEPT_OFFER"
        ? ["TERMS_HASH_MISMATCH", "TOTAL_MISMATCH"]
        : ["AMOUNT_MISMATCH", "TERMS_HASH_MISMATCH", "TOTAL_MISMATCH"],
  },
  {
    name: "the stored terms hash is wrong",
    subjects: MONEY_SUBJECTS,
    change: (d) => {
      must(d.offer).storedTermsHash = ZEROS;
    },
    codes: ["TERMS_HASH_MISMATCH"],
  },
  {
    name: "the agreement carries a different terms hash",
    subjects: S_POST,
    change: (d) => {
      must(d.agreement).termsHash = ZEROS;
    },
    codes: ["TERMS_HASH_MISMATCH"],
  },
  {
    name: "the client presents a different terms hash",
    subjects: MONEY_SUBJECTS,
    change: (d) => {
      d.claims.termsHash = ZEROS;
    },
    codes: ["TERMS_HASH_MISMATCH"],
  },
  {
    name: "the agreement total is one minor unit off",
    subjects: S_POST,
    change: (d) => {
      must(d.agreement).totalMinor = TOTAL + 1;
    },
    codes: ["AMOUNT_MISMATCH"],
  },
  {
    name: "the agreement is for a different offer",
    subjects: S_POST,
    change: (d) => {
      must(d.agreement).offerId = "off_2";
    },
    codes: ["AGREEMENT_MISMATCH"],
  },
  {
    name: "the agreement payee is not the catalog payee",
    subjects: S_POST,
    change: (d) => {
      must(d.agreement).payeeRef = "payee_evil";
    },
    codes: ["PAYEE_MISMATCH"],
  },
  {
    name: "the agreement currency is EUR",
    subjects: S_POST,
    change: (d) => {
      must(d.agreement).currency = "EUR";
    },
    codes: ["CURRENCY_MISMATCH"],
  },
  {
    name: "the offer is priced in EUR (hash kept consistent)",
    subjects: MONEY_SUBJECTS,
    change: (d) => {
      must(d.offer).currency = "EUR";
      rehash(d);
    },
    codes: ["CURRENCY_MISMATCH"],
  },

  /* ---- agreement */
  {
    name: "there is no agreement",
    subjects: S_POST,
    change: (d) => {
      d.agreement = null;
    },
    codes: ["AGREEMENT_REQUIRED"],
  },
  {
    name: "the transaction has no agreement attached",
    subjects: S_POST,
    change: (d) => {
      d.transaction.agreementId = null;
    },
    codes: ["AGREEMENT_MISMATCH"],
  },
  {
    name: "the transaction has another agreement attached",
    subjects: S_POST,
    change: (d) => {
      d.transaction.agreementId = "agr_9";
    },
    codes: ["AGREEMENT_MISMATCH"],
  },
  {
    name: "an offer is accepted a second time",
    subjects: ["ACCEPT_OFFER"],
    change: (d) => {
      d.agreement = valid("CREATE_ORDER").agreement;
      d.transaction.agreementId = "agr_1";
    },
    codes: ["AGREEMENT_EXISTS"],
  },
  {
    name: "the transaction already points at an agreement",
    subjects: ["ACCEPT_OFFER"],
    change: (d) => {
      d.transaction.agreementId = "agr_1";
    },
    codes: ["AGREEMENT_EXISTS"],
  },
  {
    name: "the client names another agreement",
    subjects: S_POST,
    change: (d) => {
      d.claims.agreementId = "agr_9";
    },
    codes: ["AGREEMENT_MISMATCH"],
  },
  {
    name: "the client names an agreement before one exists",
    subjects: ["ACCEPT_OFFER"],
    change: (d) => {
      d.claims.agreementId = "agr_1";
    },
    codes: ["AGREEMENT_MISMATCH"],
  },
  {
    name: "the client names another offer",
    subjects: MONEY_SUBJECTS,
    change: (d) => {
      d.claims.offerId = "off_9";
    },
    codes: ["AGREEMENT_MISMATCH"],
  },

  /* ---- client-claimed amount / currency / payee are compared, never used */
  ...(
    [
      1,
      TOTAL - 1,
      TOTAL + 1,
      0,
      -TOTAL,
      TOTAL + 0.5,
      "4500",
      NaN,
      Infinity,
      null,
      [TOTAL],
      { v: TOTAL },
      true,
    ] as unknown[]
  ).map((claim): Case => ({
    name: `the client claims amount ${Object.is(claim, -0) ? "-0" : (JSON.stringify(claim) ?? String(typeof claim))} (${typeof claim})`,
    subjects: MONEY_SUBJECTS,
    change: (d) => {
      d.claims.amountMinor = claim;
    },
    codes: ["AMOUNT_MISMATCH"],
  })),
  ...(["EUR", "usd", "US", "", null, 840] as unknown[]).map((claim): Case => ({
    name: `the client claims currency ${String(claim)}`,
    subjects: MONEY_SUBJECTS,
    change: (d) => {
      d.claims.currency = claim;
    },
    codes: ["CURRENCY_MISMATCH"],
  })),
  {
    name: "the client claims another payee",
    subjects: MONEY_SUBJECTS,
    change: (d) => {
      d.claims.payeeRef = "payee_evil";
    },
    codes: ["PAYEE_MISMATCH"],
  },
  {
    name: "the client claims another (allowed) seller",
    subjects: MONEY_SUBJECTS,
    change: (d) => {
      d.claims.sellerId = "seller_b";
    },
    codes: ["PAYEE_MISMATCH"],
  },
  {
    name: "the client's claims all match the facts",
    subjects: MONEY_SUBJECTS,
    change: (d) => {
      d.claims = {
        transactionId: "tx_1",
        mandateId: "M1",
        mandateVersion: 2,
        offerId: "off_1",
        sellerId: "seller_a",
        payeeRef: "payee_seller_a",
        currency: "USD",
        amountMinor: TOTAL,
        termsHash: must(d.offer).storedTermsHash,
      };
    },
    codes: [],
  },

  /* ---- seller allow-list, category, catalog price */
  {
    name: "the seller is not on the allow-list",
    subjects: MONEY_SUBJECTS,
    change: (d) => {
      must(d.offer).sellerId = "seller_x";
      rehash(d);
    },
    codes: ["PAYEE_NOT_ALLOWED"],
  },
  {
    name: "the allow-list is empty",
    subjects: MONEY_SUBJECTS,
    change: (d) => {
      d.mandate.terms.allowedSellerIds = [];
    },
    codes: ["PAYEE_NOT_ALLOWED"],
  },
  {
    name: "a line is in a category the mandate does not allow",
    subjects: MONEY_SUBJECTS,
    change: (d) => {
      must(must(d.offer).lines[0]).category = "DESIGN";
    },
    codes: ["CATEGORY_NOT_ALLOWED"],
  },
  {
    name: "a category differs only by case",
    subjects: MONEY_SUBJECTS,
    change: (d) => {
      must(must(d.offer).lines[0]).category = "compute";
    },
    codes: ["CATEGORY_NOT_ALLOWED"],
  },
  {
    name: "a line has no known category",
    subjects: MONEY_SUBJECTS,
    change: (d) => {
      must(must(d.offer).lines[0]).category = null;
    },
    codes: ["CATEGORY_UNKNOWN"],
  },
  {
    name: "the mandate allows no category",
    subjects: MONEY_SUBJECTS,
    change: (d) => {
      d.mandate.terms.allowedCategories = [];
    },
    codes: ["CATEGORY_NOT_ALLOWED"],
  },
  {
    name: "one allowed line hides one disallowed line",
    subjects: MONEY_SUBJECTS,
    change: (d) => {
      const o = must(d.offer);
      o.lines = [
        {
          sku: "GPU-PACK",
          qty: 1,
          unitPriceMinor: 2000,
          catalogUnitPriceMinor: 2000,
          category: "COMPUTE",
        },
        {
          sku: "LOGO",
          qty: 1,
          unitPriceMinor: 2000,
          catalogUnitPriceMinor: 2000,
          category: "DESIGN",
        },
      ];
      rehash(d);
    },
    codes: ["CATEGORY_NOT_ALLOWED"],
  },
  {
    name: "a line is not in the catalog",
    subjects: MONEY_SUBJECTS,
    change: (d) => {
      must(must(d.offer).lines[0]).catalogUnitPriceMinor = null;
    },
    codes: ["PRICE_NOT_IN_CATALOG"],
  },
  {
    name: "a line is priced below the catalog price (a negotiated discount)",
    subjects: MONEY_SUBJECTS,
    change: (d) => {
      withTotal(d, 3000);
      must(must(d.offer).lines[0]).catalogUnitPriceMinor = 4000;
    },
    codes: [],
  },
  {
    name: "a line is one unit above the catalog price",
    subjects: MONEY_SUBJECTS,
    change: (d) => {
      must(must(d.offer).lines[0]).catalogUnitPriceMinor = 3999;
    },
    codes: ["PRICE_NOT_IN_CATALOG"],
  },

  /* ---- amount sanity */
  {
    name: "the total is zero",
    subjects: MONEY_SUBJECTS,
    change: (d) => {
      withTotal(d, 0);
    },
    codes: ["AMOUNT_NOT_POSITIVE"],
  },
  {
    name: "the lines overflow the money range",
    subjects: MONEY_SUBJECTS,
    change: (d) => {
      const o = must(d.offer);
      const line = must(o.lines[0]);
      line.qty = 2;
      line.unitPriceMinor = Number.MAX_SAFE_INTEGER;
      line.catalogUnitPriceMinor = Number.MAX_SAFE_INTEGER;
      rehash(d);
    },
    codes: ["AMOUNT_OVERFLOW"],
  },

  /* ---- per-transaction cap */
  {
    name: "the total is one minor unit above the cap",
    subjects: MONEY_SUBJECTS,
    change: (d) => {
      withTotal(d, 10001);
    },
    codes: ["OVER_PER_TX_CAP"],
  },

  /* ---- cumulative exposure */
  {
    name: "two other transactions have the same id",
    subjects: MONEY_SUBJECTS,
    change: (d) => {
      d.others = [
        { id: "tx_2", state: "VOIDED", currency: "USD", totalMinor: 1 },
        { id: "tx_2", state: "VOIDED", currency: "USD", totalMinor: 1 },
      ];
    },
    codes: ["EXPOSURE_INVALID"],
  },
  {
    name: "another counted transaction is in another currency",
    subjects: MONEY_SUBJECTS,
    change: (d) => {
      d.others = [{ id: "tx_2", state: "AUTHORIZED", currency: "EUR", totalMinor: 1 }];
    },
    codes: ["EXPOSURE_INVALID"],
  },
  {
    name: "other transactions already use the whole budget",
    subjects: MONEY_SUBJECTS,
    change: (d) => {
      d.others = [{ id: "tx_2", state: "CAPTURED", currency: "USD", totalMinor: 15000 }];
    },
    codes: ["OVER_TOTAL_BUDGET"],
  },
  {
    name: "two huge reservations cannot wrap the sum around",
    subjects: MONEY_SUBJECTS,
    change: (d) => {
      d.others = [
        { id: "tx_2", state: "AUTHORIZED", currency: "USD", totalMinor: Number.MAX_SAFE_INTEGER },
        { id: "tx_3", state: "AUTHORIZED", currency: "USD", totalMinor: Number.MAX_SAFE_INTEGER },
      ];
    },
    codes: ["OVER_TOTAL_BUDGET"],
  },

  /* ---- human approval */
  {
    name: "above the threshold with no approval",
    subjects: APPROVAL_SUBJECTS,
    change: (d) => {
      withTotal(d, 5001);
      d.approval = null;
    },
    codes: ["APPROVAL_REQUIRED"],
  },
  {
    name: "the mandate forces review and none was given",
    subjects: APPROVAL_SUBJECTS,
    change: (d) => {
      d.mandate.terms.requireReviewBeforeExecution = true;
      d.approval = null;
    },
    codes: ["APPROVAL_REQUIRED"],
  },
  {
    name: "the operator rejected the transaction (approval not even required)",
    subjects: APPROVAL_SUBJECTS,
    change: (d) => {
      d.approval = { agreementId: "agr_1", decision: "REJECTED", decidedBy: "OPERATOR" };
    },
    codes: ["APPROVAL_REJECTED"],
  },
  {
    name: "the operator rejected a transaction that required approval",
    subjects: APPROVAL_SUBJECTS,
    change: (d) => {
      withTotal(d, 6000);
      d.approval = { agreementId: "agr_1", decision: "REJECTED", decidedBy: "OPERATOR" };
    },
    codes: ["APPROVAL_REJECTED"],
  },
  {
    name: "the approval was recorded by an agent",
    subjects: APPROVAL_SUBJECTS,
    change: (d) => {
      withTotal(d, 6000);
      d.approval = approvedBy("agr_1", "AGENT");
    },
    codes: ["APPROVAL_NOT_HUMAN"],
  },
  {
    name: "the approval says 'operator' in lower case",
    subjects: APPROVAL_SUBJECTS,
    change: (d) => {
      d.approval = approvedBy("agr_1", "operator");
    },
    codes: ["APPROVAL_NOT_HUMAN"],
  },
  {
    name: "the approval is for another agreement",
    subjects: APPROVAL_SUBJECTS,
    change: (d) => {
      withTotal(d, 6000);
      d.approval = approvedBy("agr_9");
    },
    codes: ["APPROVAL_MISMATCH"],
  },
  {
    name: "an approval exists before any agreement",
    subjects: ["ACCEPT_OFFER"],
    change: (d) => {
      d.approval = approvedBy();
    },
    codes: ["APPROVAL_MISMATCH"],
  },

  /* ---- duplicates and replays */
  {
    name: "a live attempt for this action exists",
    subjects: ["CREATE_ORDER", "AUTHORIZE", "CAPTURE", "VOID"],
    change: (d) => {
      d.attempts.liveForSubject = true;
    },
    codes: ["DUPLICATE_ATTEMPT"],
  },
  {
    name: "a capture already succeeded",
    subjects: ["CAPTURE"],
    change: (d) => {
      d.attempts.captureSucceeded = true;
    },
    codes: ["DUPLICATE_CAPTURE"],
  },
  {
    name: "void after a successful capture",
    subjects: ["VOID"],
    change: (d) => {
      d.attempts.captureSucceeded = true;
    },
    codes: ["VOID_AFTER_CAPTURE"],
  },

  /* ---- fresh PayPal observation */
  {
    name: "no fresh observation was supplied",
    subjects: ["AUTHORIZE", "CAPTURE"],
    change: (d) => {
      d.observed = null;
    },
    codes: ["OBSERVATION_REQUIRED"],
  },
  {
    name: "PayPal shows a different amount",
    subjects: ["AUTHORIZE", "CAPTURE"],
    change: (d) => {
      must(d.observed).amountMinor = TOTAL + 1;
    },
    codes: ["AMOUNT_MISMATCH"],
  },
  {
    name: "PayPal shows a different currency",
    subjects: ["AUTHORIZE", "CAPTURE"],
    change: (d) => {
      must(d.observed).currency = "EUR";
    },
    codes: ["CURRENCY_MISMATCH"],
  },
  {
    name: "PayPal shows a different payee",
    subjects: ["AUTHORIZE", "CAPTURE"],
    change: (d) => {
      must(d.observed).payeeRef = "payee_evil";
    },
    codes: ["PAYEE_MISMATCH"],
  },
  {
    name: "an observation is irrelevant before PayPal is involved",
    subjects: ["ACCEPT_OFFER", "CREATE_ORDER"],
    change: (d) => {
      d.observed = { amountMinor: 1, currency: "EUR", payeeRef: "x" };
    },
    codes: [],
  },

  /* ---- authorization honor period */
  {
    name: "the honor period is not recorded",
    subjects: ["CAPTURE"],
    change: (d) => {
      d.transaction.honorExpiresAt = null;
    },
    codes: ["HONOR_WINDOW_UNKNOWN"],
  },
  {
    name: "now is exactly one safety margin before the end",
    subjects: ["CAPTURE"],
    change: (d) => {
      d.transaction.honorExpiresAt = iso(NOW_MS + HONOR_MARGIN_MS);
    },
    codes: ["HONOR_PERIOD_ENDED"],
  },
  {
    name: "now is one millisecond earlier than that",
    subjects: ["CAPTURE"],
    change: (d) => {
      d.transaction.honorExpiresAt = iso(NOW_MS + HONOR_MARGIN_MS + 1);
    },
    codes: [],
  },
  {
    name: "the honor period already ended",
    subjects: ["CAPTURE"],
    change: (d) => {
      d.transaction.honorExpiresAt = iso(NOW_MS - 1);
    },
    codes: ["HONOR_PERIOD_ENDED"],
  },
];
