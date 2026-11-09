import type { ReasonCode, PolicySubject } from "@/domain/policy";
import type { TxState } from "@/domain/transaction-states";

/**
 * Adversarial scenario fixtures (docs/ADVERSARIAL_SUITE.md).
 *
 * A scenario is DATA: an initial state (a mandate setting plus setup steps that must succeed), an attack (steps
 * the attacker or a faulty agent performs), and what must be true afterwards. The runner (run.ts) is the only code
 * that interprets them, against the real services, an in-memory database and a scripted fake PayPal. Nothing in
 * this directory can reach a real payment account (see isolation.test.ts).
 */

export const ATTACK_CATEGORIES = [
  "BUDGET_ESCALATION",
  "CURRENCY_SUBSTITUTION",
  "PAYEE_SUBSTITUTION",
  "CATEGORY_MISMATCH",
  "CHANGED_AGREEMENT",
  "MANDATE_TAMPERING",
  "PROMPT_INJECTION",
  "APPROVAL_BYPASS",
  "DUPLICATE_REQUEST",
  "REPLAY",
  "INVALID_TRANSITION",
  "MALFORMED_AI_OUTPUT",
  "DELIVERABLES",
  "WEBHOOK_FORGERY",
] as const;
export type AttackCategory = (typeof ATTACK_CATEGORIES)[number];

/** Added to a scenario's test name so the report can count scenarios that document a limitation. */
export const LIMITATION_TAG = "[KNOWN LIMITATION]";

export type ActorKind = "OPERATOR" | "AGENT" | "SYSTEM" | "ANONYMOUS";

/** A value to set at a dotted path of a policy input, e.g. ["mandate.terms.maxTransactionMinor", 99999]. */
export type Patch = readonly [path: string, value: unknown];

export type Step =
  // ---- negotiation
  | { do: "open"; neg?: string; over?: Record<string, unknown>; actor?: ActorKind }
  | {
      do: "offer";
      as: string;
      neg?: string;
      seller?: string;
      /** unit price in minor units (lines and claimed total are kept consistent unless `offer` overrides them) */
      unit?: number;
      qty?: number;
      sku?: string;
      offer?: Record<string, unknown>;
      top?: Record<string, unknown>;
      actor?: ActorKind;
    }
  | {
      do: "counter";
      as: string;
      neg?: string;
      seller?: string;
      over?: Record<string, unknown>;
      actor?: ActorKind;
    }
  | {
      do: "accept";
      proposal: string;
      neg?: string;
      actor?: ActorKind;
      raw?: Record<string, unknown>;
    }
  | { do: "approve" | "disapprove" | "eligibility"; neg?: string; actor?: ActorKind }
  // ---- payment (a fake PayPal; never the real one)
  | {
      do: "pay";
      op: "start" | "refresh" | "authorize" | "capture" | "void";
      neg?: string;
      actor?: ActorKind;
    }
  | {
      do: "paypal";
      /** What the fake PayPal does from now on (amount/currency/payee substitution, partial captures...). */
      set?: Record<string, unknown>;
      buyerApproves?: boolean;
      /** A capture that appears at PayPal without us asking. */
      addCapture?: { amountMinor?: number };
    }
  | { do: "clock"; minutes: number }
  // ---- webhooks
  | {
      do: "webhook";
      event:
        | "ORDER_APPROVED"
        | "AUTHORIZATION_CREATED"
        | "CAPTURE_COMPLETED"
        | "CAPTURE_DENIED"
        | "UNKNOWN_TYPE";
      id: string;
      /** What PayPal's verification service answers. Default VERIFIED. */
      verdict?: "VERIFIED" | "REJECTED" | "UNAVAILABLE";
      /** Header overrides; null removes a header. */
      headers?: Record<string, string | null>;
      /** Replace the event body (e.g. an event that names an order we do not have). */
      resource?: Record<string, unknown>;
      /** Replace the whole body with this text. */
      rawBody?: string;
      /** Deliver the same request this many times (default 1); the outcome is the LAST delivery's. */
      times?: number;
    }
  // ---- direct attacks on the rules
  | { do: "policy"; subject: PolicySubject; patch?: readonly Patch[]; resealMandate?: boolean }
  | { do: "transition"; to: TxState; neg?: string }
  | { do: "sql"; sql: string; params?: readonly (string | number | null)[] }
  | {
      do: "mandate";
      op: "lowerCap" | "revoke" | "createDraft" | "approveDraft";
      capAmount?: string;
      actor?: ActorKind;
    }
  // ---- agents
  | { do: "agentRun"; script: string; request?: string }
  | { do: "modelReply"; reply: unknown; task?: "compare" | "interpret" };

export type AuditExpect = {
  type: string;
  actor?: string;
  provenance?: "LOCAL_DECISION" | "OBSERVED_EXTERNAL";
  /** Every key here must appear in the event payload with exactly this value (arrays/objects compared whole). */
  payload?: Record<string, unknown>;
};

export type Expect = {
  /** Subset match on the LAST attack step's outcome: verdict, reasonCodes, error, accepted, http, status... */
  outcome: Record<string, unknown>;
  /** The states of every transaction that exists, oldest first. [] means no transaction was ever created. */
  txStates: readonly TxState[];
  /** Total captured at the (fake) PayPal, in minor units. Default 0: no money moved. */
  capturedMinor?: number;
  /**
   * The money-moving calls (create order, authorize, capture, void) the ATTACK caused at the fake PayPal, in
   * order. Default: none. Read-only order lookups are not counted.
   */
  paypalCalls?: readonly string[];
  /**
   * Must appear, in this order, among the events the ATTACK recorded (other events may sit between them). An empty
   * list means the attack must have recorded no audit events at all.
   */
  audit: readonly AuditExpect[];
  /** Event types that must NOT appear. */
  forbidAudit?: readonly string[];
  /** Read-only checks on stored state: a SELECT returning one scalar. */
  rows?: readonly {
    sql: string;
    params?: readonly (string | number)[];
    equals: string | number | null;
  }[];
};

export type Scenario = {
  /** Stable id: category prefix + number. Used by `npm run adversarial -- -t <id>`. */
  id: string;
  category: AttackCategory;
  title: string;
  /** What the attacker is trying to achieve, in a sentence. */
  goal: string;
  /**
   * Set when the product does NOT fully stop this by itself. The scenario then pins what actually happens (so a
   * change is noticed) and the report lists it separately from clean passes. Never use it to excuse a failure.
   */
  limitation?: string;
  initial: {
    /** Mandate M1 overrides (minor units). Defaults: cap 100.00, budget 150.00, approval above 50.00, COMPUTE only. */
    mandate?: {
      capMinor?: number;
      budgetMinor?: number;
      thresholdMinor?: number;
      categories?: string[];
      review?: boolean;
    };
    /** The payee the (fake) PayPal reports. Default: the configured merchant. */
    paypalPayee?: string | null;
    /** Setup steps. Each must do what it says (an accepted offer, an approved order...) or the scenario errors. */
    steps: readonly Step[];
  };
  attack: readonly Step[];
  expect: Expect;
};

export type { ReasonCode };
