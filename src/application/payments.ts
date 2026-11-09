import { canonicalJson, sha256Hex } from "../domain/canonical.ts";
import { ConflictError, ForbiddenError, NotFoundError, UpstreamError } from "../domain/errors.ts";
import {
  authorizedAtOf,
  interpretOrder,
  ORDER_FINDINGS,
  RECONCILE_QUIET_MS,
  type Interpretation,
  type ObservedOrder,
  type OrderExpectation,
  type PayeeCheck,
} from "../domain/payment.ts";
import { evaluatePolicy, type PolicyDecision } from "../domain/policy.ts";
import { explainCodes, type Explanation } from "../domain/policy-explanations.ts";
import type { NegotiationActor } from "../domain/negotiation.ts";
import {
  canTransition,
  RECONCILE_TARGETS,
  type InFlightState,
  type TxState,
} from "../domain/transaction-states.ts";
import {
  ProviderError,
  type CreatedOrder,
  type PaymentProvider,
} from "../ports/payment-provider.ts";
import type {
  AttemptAction,
  AttemptInfo,
  PaymentContext,
  PaymentOps,
  PaymentStore,
} from "../ports/payment-store.ts";
import { buildPaymentView, type PaymentView } from "./payment-views.ts";

/**
 * The PayPal SANDBOX payment flow: create an order, read it back, authorize it (a hold), then either CAPTURE the hold
 * (the charge) or VOID it (release the hold). No refund, reauthorize or payout: docs/PAYPAL_INTEGRATION.md. An
 * authorization is a time-limited hold, not escrow, and nothing here promises a refund.
 *
 * The rules this module enforces:
 *  - WHAT is charged (amount, currency, transaction identity, agreement version) is read from stored, constrained
 *    rows (the ACTIVE agreement of the negotiation). No method here accepts an amount, currency, payee or id from a
 *    caller, so a browser cannot supply one.
 *  - The deterministic policy engine decides before any provider call that moves money (CREATE_ORDER, AUTHORIZE).
 *  - A write-ahead attempt row (with the PayPal-Request-Id) and the state change are one database transaction; the
 *    provider is called OUTSIDE it; the outcome is recorded in a second one.
 *  - Nothing PayPal returns is believed until it has been compared with our records. The authoritative evidence is
 *    an authenticated READ of the order (`getOrder`), never the redirect the browser comes back with, never a
 *    create/authorize response body on its own.
 *  - An ambiguous outcome (timeout, 5xx, 429, 409, 202, a mismatch) is NEEDS_RECONCILIATION, never success and never
 *    a failure that frees the budget.
 *  - Capture and void are never repeated on a hunch. After an unknown outcome a new request is possible only once a
 *    read shows the first had no effect AND the first was sent at least RECONCILE_QUIET_MS ago, so a slow request
 *    cannot be doubled by a fast retry. PayPal's own amount limit (the capture is the whole authorization) is the
 *    last backstop, not the first.
 */

export type PaymentConfig = {
  returnUrl: string;
  cancelUrl: string;
  /** PAYPAL_MERCHANT_ID. Null means the payee cannot be verified, and authorization is refused. */
  merchantId: string | null;
};

export type PaymentServiceDeps = {
  store: PaymentStore;
  /** Null when PayPal sandbox credentials are not configured: reading works, anything that would call PayPal is refused. */
  provider: PaymentProvider | null;
  now: () => Date;
  newId: (prefix: string) => string;
  config: PaymentConfig;
};

export type PaymentPolicyView = Explanation & {
  policyVersion: string;
  reasonCodes: string[];
};

export type PaymentResult = {
  /** False when nothing was sent to PayPal and nothing changed (a repeat, a refusal, or nothing to do). */
  performed: boolean;
  /** Our id for this operation; it is in the audit events. */
  correlationId: string;
  policy: PaymentPolicyView | null;
  notes: string[];
  view: PaymentView;
};

const SANDBOX_CURRENCY = "USD";
/** A payment may be attempted this many times per action (the schema allows sequence numbers 1 to 3). */
const MAX_ATTEMPTS_PER_ACTION = 3;

const ACTION_OF_STATE: Record<InFlightState, AttemptAction> = {
  CREATING_ORDER: "CREATE_ORDER",
  AUTHORIZING: "AUTHORIZE",
  CAPTURING: "CAPTURE",
  VOIDING: "VOID",
};
const inFlightAction = (state: TxState): AttemptAction | null =>
  (ACTION_OF_STATE as Partial<Record<TxState, AttemptAction>>)[state] ?? null;

const invoiceIdOf = (transactionId: string, seq: number): string => `INV-${transactionId}-${seq}`;
const hashOf = (value: unknown): string => sha256Hex(canonicalJson(value));

function requireOperator(actor: NegotiationActor): void {
  if (actor.kind !== "OPERATOR" || actor.id === "") {
    throw new ForbiddenError("only the signed-in operator may run payments");
  }
}

const describeFinding = (code: keyof typeof ORDER_FINDINGS): string => ORDER_FINDINGS[code];

function policyView(decision: PolicyDecision, subject: string): PaymentPolicyView {
  return {
    ...explainCodes(decision.verdict, decision.reasonCodes, subject),
    policyVersion: decision.policyVersion,
    reasonCodes: [...decision.reasonCodes],
  };
}

export function createPaymentService(deps: PaymentServiceDeps) {
  const { store, config } = deps;
  const needProvider = (): PaymentProvider => {
    if (deps.provider === null) {
      throw new UpstreamError("NOT_CONFIGURED", "PayPal sandbox is not configured on this server.");
    }
    return deps.provider;
  };
  const stamp = () => deps.now().toISOString();

  /* ------------------------------------------------------------ small helpers */

  const lastAttempt = (ops: PaymentOps, tx: string, action: AttemptAction) =>
    ops
      .attempts(tx)
      .filter((a) => a.action === action)
      .at(-1);

  const expectationFor = (ops: PaymentOps, c: PaymentContext): OrderExpectation => {
    const create = lastAttempt(ops, c.transactionId, "CREATE_ORDER");
    return {
      amountMinor: c.totalMinor,
      currency: c.currency,
      customId: c.transactionId,
      invoiceId: invoiceIdOf(c.transactionId, create?.seq ?? 1),
      merchantId: config.merchantId,
      authorizationId: c.paypalAuthorizationId,
      captureId: c.paypalCaptureId,
    };
  };

  const viewOf = (
    ops: PaymentOps,
    c: PaymentContext,
    extraWarnings: string[] = [],
  ): PaymentView => {
    const observedPayload = ops.latestAuditPayload(c.transactionId, "PAYPAL_ORDER_OBSERVED");
    const approve = observedPayload?.approveUrl;
    const payee = observedPayload?.payee;
    const anomaly = ops.latestAuditPayload(c.transactionId, "PAYPAL_ANOMALY");
    const warnings = [...extraWarnings];
    if (config.merchantId === null)
      warnings.push(
        "PAYPAL_MERCHANT_ID is not set, so the payee cannot be verified and authorization is refused.",
      );
    if (
      Array.isArray(anomaly?.findings) &&
      anomaly.findings.length > 0 &&
      c.txState === "NEEDS_RECONCILIATION"
    )
      warnings.push(
        `PayPal's record did not match the agreement (${(anomaly.findings as string[]).join(", ")}). Nothing was treated as done.`,
      );
    return buildPaymentView({
      context: c,
      attempts: ops.attempts(c.transactionId),
      history: ops.history(c.transactionId, 60),
      approveUrl: typeof approve === "string" ? approve : null,
      payeeCheck: typeof payee === "string" ? (payee as PayeeCheck) : null,
      warnings,
    });
  };

  const readContext = (negotiationId: string): PaymentContext =>
    store.transaction((ops) => {
      const c = ops.contextForNegotiation(negotiationId);
      if (!c) throw new NotFoundError("an active agreement for this negotiation");
      return c;
    });

  const snapshot = (
    negotiationId: string,
    correlationId: string,
    result: { performed: boolean; policy?: PaymentPolicyView | null; notes?: string[] },
  ): PaymentResult =>
    store.transaction((ops) => {
      const c = ops.contextForNegotiation(negotiationId);
      if (!c) throw new NotFoundError("an active agreement for this negotiation");
      return {
        performed: result.performed,
        correlationId,
        policy: result.policy ?? null,
        notes: result.notes ?? [],
        view: viewOf(ops, c),
      };
    });

  /** Marks the newest unfinished attempt for an action. */
  const settleAttempt = (
    ops: PaymentOps,
    c: PaymentContext,
    action: AttemptAction,
    status: "SUCCEEDED" | "FAILED_DEFINITE" | "UNKNOWN",
    now: string,
    http?: { httpStatus?: number | null; debugId?: string | null },
  ) => {
    const a = lastAttempt(ops, c.transactionId, action);
    if (a === undefined || (a.status !== "IN_FLIGHT" && a.status !== "UNKNOWN")) return;
    if (a.status === status) return; // UNKNOWN stays UNKNOWN: the schema has no such transition
    ops.finishAttempt({
      id: a.id,
      status,
      ...(http?.httpStatus !== undefined && http.httpStatus !== null
        ? { httpStatus: http.httpStatus }
        : {}),
      ...(http?.debugId !== undefined && http.debugId !== null ? { debugId: http.debugId } : {}),
      now,
    });
  };

  /**
   * A failed or ambiguous provider call, recorded. Unknown -> NEEDS_RECONCILIATION. A definite refusal of CREATE_ORDER
   * or AUTHORIZE -> FAILED. A definite refusal of CAPTURE or VOID only records the refusal and returns "CONFIRM": the
   * hold is still there only if a read says so, and the caller does that read.
   */
  const recordFailure = (
    ops: PaymentOps,
    c: PaymentContext,
    action: AttemptAction,
    err: ProviderError,
    now: string,
    correlationId: string,
    patch: { paypalOrderId?: string } = {},
  ): "DONE" | "CONFIRM" => {
    const definite = err.outcome === "DEFINITE_FAILURE";
    settleAttempt(ops, c, action, definite ? "FAILED_DEFINITE" : "UNKNOWN", now, {
      httpStatus: err.httpStatus,
      debugId: err.debugId,
    });
    const details = {
      correlationId,
      action,
      providerError: err.kind,
      httpStatus: err.httpStatus,
      debugId: err.debugId,
      issues: [...err.issues],
    };
    if (definite && (action === "CAPTURE" || action === "VOID")) {
      ops.audit({
        ts: now,
        actor: "PAYPAL_API",
        type: "PAYPAL_CALL_REFUSED",
        transactionId: c.transactionId,
        payload: details,
      });
      return "CONFIRM";
    }
    if (definite) {
      ops.transition({
        transactionId: c.transactionId,
        expectedVersion: c.txVersion,
        to: "FAILED",
        now,
        actor: "PAYPAL_API",
        details,
      });
    } else if (c.txState !== "NEEDS_RECONCILIATION") {
      ops.transition({
        transactionId: c.transactionId,
        expectedVersion: c.txVersion,
        to: "NEEDS_RECONCILIATION",
        now,
        actor: "PAYPAL_API",
        ...(patch.paypalOrderId === undefined ? {} : { patch }),
        details,
      });
    } else {
      ops.audit({
        ts: now,
        actor: "PAYPAL_API",
        type: "PAYPAL_CALL_STILL_UNKNOWN",
        transactionId: c.transactionId,
        payload: details,
      });
    }
    return "DONE";
  };

  /**
   * Applies one verified reading of the order to the transaction, if the transition table allows it. Returns a note
   * for the screen. A reading that disagrees with our records changes nothing (an in-flight call becomes
   * NEEDS_RECONCILIATION instead of success).
   *
   * Reading "the capture/void did not happen" is the dangerous one, because acting on it allows a second request. It
   * is believed only when the first request was refused outright, or was left unknown and is older than
   * RECONCILE_QUIET_MS; a 2xx answer followed by a read that shows nothing is a contradiction and stays unknown.
   */
  function applyObservation(
    ops: PaymentOps,
    c: PaymentContext,
    interp: Interpretation,
    observed: ObservedOrder,
    now: Date,
    correlationId: string,
    approveUrl: string | null,
    http: { httpStatus: number | null; debugId: string | null } | null = null,
  ): string[] {
    const ts = now.toISOString();
    const notes: string[] = [];
    const action = inFlightAction(c.txState); // set only while a call is in flight
    /** The state the call being settled started from (the in-flight state, or the one we are reconciling). */
    const origin: TxState =
      c.txState === "NEEDS_RECONCILIATION" && c.reconcilingFrom !== null
        ? c.reconcilingFrom
        : c.txState;
    const settling: AttemptAction | null =
      inFlightAction(origin) ?? (origin === "CAPTURE_PENDING" ? "CAPTURE" : null);

    /** An in-flight call whose outcome this reading does not settle becomes NEEDS_RECONCILIATION. */
    const park = (details: Record<string, unknown>) => {
      if (action === null) return;
      settleAttempt(ops, c, action, "UNKNOWN", ts);
      ops.transition({
        transactionId: c.transactionId,
        expectedVersion: c.txVersion,
        to: "NEEDS_RECONCILIATION",
        now: ts,
        actor: "PAYPAL_API",
        patch: c.paypalOrderId === null ? { paypalOrderId: observed.id } : {},
        details: { correlationId, ...details },
      });
    };

    if (interp.kind === "ANOMALY") {
      const findings = interp.findings;
      ops.audit({
        ts,
        actor: "PAYPAL_API",
        type: "PAYPAL_ANOMALY",
        transactionId: c.transactionId,
        payload: { correlationId, orderId: observed.id, status: observed.status, findings },
      });
      notes.push(
        `PayPal's record does not match the agreement: ${findings.map(describeFinding).join(" ")}`,
      );
      park({ findings });
      return notes;
    }

    const { target, authorization, capture } = interp;
    ops.audit({
      ts,
      actor: "PAYPAL_API",
      type: "PAYPAL_ORDER_OBSERVED",
      provenance: "OBSERVED_EXTERNAL",
      transactionId: c.transactionId,
      payload: {
        correlationId,
        orderId: observed.id,
        status: observed.status,
        authorizationStatus: authorization?.status ?? null,
        captureStatus: capture?.status ?? null,
        target,
        payee: interp.payee,
        approveUrl,
      },
    });
    notes.push(...interp.notes);
    if (target === c.txState) return notes;

    // A hold that is gone while a capture was in progress means the capture cannot succeed: FAILED, not VOIDED.
    const to: TxState =
      target === "VOIDED" && (origin === "CAPTURING" || origin === "CAPTURE_PENDING")
        ? "FAILED"
        : target;

    const attempt = settling === null ? undefined : lastAttempt(ops, c.transactionId, settling);
    const attemptStatus = attempt?.status;

    if ((origin === "CAPTURING" || origin === "VOIDING") && to === "AUTHORIZED") {
      const quiet =
        attempt !== undefined &&
        Date.parse(ts) - Date.parse(attempt.startedAt) >= RECONCILE_QUIET_MS;
      const concluded =
        attemptStatus === "FAILED_DEFINITE" ||
        (attemptStatus === "UNKNOWN" && c.txState === "NEEDS_RECONCILIATION" && quiet);
      if (!concluded) {
        park({ reason: "no effect is visible yet, but that is not conclusive", target });
        notes.push(
          http !== null
            ? "PayPal accepted the request but the order does not show its effect yet; the outcome needs a status check."
            : "PayPal shows no effect yet, but the request was sent less than a minute ago or its outcome is unresolved. Nothing was repeated; check again shortly.",
        );
        return notes;
      }
    }

    const viaReconciliation =
      action !== null &&
      !canTransition(c.txState, to) &&
      attemptStatus === "FAILED_DEFINITE" &&
      RECONCILE_TARGETS[c.txState as InFlightState].includes(to);
    let allowed =
      c.txState === "NEEDS_RECONCILIATION" && c.reconcilingFrom !== null
        ? RECONCILE_TARGETS[c.reconcilingFrom].includes(to)
        : canTransition(c.txState, to) || viaReconciliation;
    // A pending capture goes back to a usable hold only when PayPal lists that capture as declined or failed.
    if (origin === "CAPTURE_PENDING" && to === "AUTHORIZED" && !interp.captureDeclined)
      allowed = false;

    if (!allowed) {
      if (action !== null) {
        park({ reason: "observation does not fit the in-flight action", target });
        notes.push(
          "PayPal's answer did not match what was requested; the outcome needs a status check.",
        );
      } else {
        ops.audit({
          ts,
          actor: "PAYPAL_API",
          type: "PAYPAL_OBSERVATION_NOT_APPLIED",
          transactionId: c.transactionId,
          payload: { correlationId, from: c.txState, target },
        });
        notes.push(
          `PayPal reports ${target.toLowerCase().replaceAll("_", " ")}, which this build cannot record from the current state.`,
        );
      }
      return notes;
    }

    // The attempt that this observation settles.
    if (origin === "CREATING_ORDER")
      settleAttempt(ops, c, "CREATE_ORDER", "SUCCEEDED", ts, http ?? undefined);
    if (origin === "AUTHORIZING") {
      // Back to ORDER_APPROVED means the authorization did NOT happen: the attempt failed definitely so a new one may start.
      settleAttempt(
        ops,
        c,
        "AUTHORIZE",
        to === "ORDER_APPROVED" ? "FAILED_DEFINITE" : "SUCCEEDED",
        ts,
        http ?? undefined,
      );
    }
    if (settling === "CAPTURE") {
      // A pending capture is not final, so its attempt stays UNKNOWN (not SUCCEEDED): if PayPal later declines it, the
      // attempt can still be closed as FAILED_DEFINITE and another capture may be tried.
      settleAttempt(
        ops,
        c,
        "CAPTURE",
        to === "CAPTURED" || to === "REVERSED"
          ? "SUCCEEDED"
          : to === "CAPTURE_PENDING"
            ? "UNKNOWN"
            : "FAILED_DEFINITE",
        ts,
        http ?? undefined,
      );
    }
    if (settling === "VOID") {
      settleAttempt(
        ops,
        c,
        "VOID",
        to === "VOIDED" ? "SUCCEEDED" : "FAILED_DEFINITE",
        ts,
        http ?? undefined,
      );
    }

    const patch: Parameters<PaymentOps["transition"]>[0]["patch"] = {};
    if (c.paypalOrderId === null) patch.paypalOrderId = observed.id;
    // The hold's identity and clock are written once. A later AUTHORIZED reading (after a declined capture) must not
    // restart the honor period.
    if (
      to === "AUTHORIZED" &&
      c.paypalAuthorizationId === null &&
      authorization !== null &&
      authorization.amount !== null
    ) {
      const times = authorizedAtOf(authorization.createTime, now);
      patch.paypalAuthorizationId = authorization.id;
      patch.authorizedMinor = authorization.amount.minor;
      patch.authorizedAt = times.authorizedAt;
      patch.honorExpiresAt = times.honorExpiresAt;
    }
    if (
      to === "CAPTURED" &&
      c.paypalCaptureId === null &&
      capture !== null &&
      capture.amount !== null
    ) {
      patch.paypalCaptureId = capture.id;
      patch.capturedMinor = capture.amount.minor;
    }
    const details = {
      correlationId,
      observedOrderStatus: observed.status,
      authorizationStatus: authorization?.status ?? null,
      captureStatus: capture?.status ?? null,
      ...(to === target ? {} : { observedTarget: target }),
    };
    let version = c.txVersion;
    if (viaReconciliation) {
      // The refusal is proven, so the hold's real state can be taken in one step (the table routes it through here).
      ops.transition({
        transactionId: c.transactionId,
        expectedVersion: version,
        to: "NEEDS_RECONCILIATION",
        now: ts,
        actor: "PAYPAL_API",
        details: { correlationId, reason: "the request was refused" },
      });
      version += 1;
    }
    ops.transition({
      transactionId: c.transactionId,
      expectedVersion: version,
      to,
      now: ts,
      actor: "PAYPAL_API",
      patch,
      details,
    });
    return notes;
  }

  /** Reads the order back and applies it. Used after create and after authorize, and by every status check. */
  async function observeAndApply(
    negotiationId: string,
    orderId: string,
    correlationId: string,
    http: { httpStatus: number | null; debugId: string | null; approveUrl: string | null } | null,
    /** Receives the order that was read, for callers that need to judge something against it. */
    sink?: { observed?: ObservedOrder },
  ): Promise<string[]> {
    let observed: ObservedOrder;
    try {
      observed = await needProvider().getOrder(orderId);
      if (sink) sink.observed = observed;
    } catch (err) {
      const e =
        err instanceof ProviderError ? err : new ProviderError("NETWORK", "The read failed.");
      const outcome = store.transaction((ops) => {
        const c = ops.contextForNegotiation(negotiationId);
        if (!c) throw new NotFoundError("an active agreement for this negotiation");
        const ts = stamp();
        const action = inFlightAction(c.txState);
        ops.audit({
          ts,
          actor: "PAYPAL_API",
          type: "PAYPAL_READ_FAILED",
          transactionId: c.transactionId,
          payload: {
            correlationId,
            providerError: e.kind,
            httpStatus: e.httpStatus,
            debugId: e.debugId,
          },
        });
        if (action !== null) {
          settleAttempt(ops, c, action, "UNKNOWN", ts, {
            httpStatus: http?.httpStatus ?? e.httpStatus,
            debugId: http?.debugId ?? e.debugId,
          });
          ops.transition({
            transactionId: c.transactionId,
            expectedVersion: c.txVersion,
            to: "NEEDS_RECONCILIATION",
            now: ts,
            actor: "PAYPAL_API",
            patch: c.paypalOrderId === null ? { paypalOrderId: orderId } : {},
            details: { correlationId, reason: "the confirming read failed", providerError: e.kind },
          });
          return [
            "PayPal accepted the request but the confirming read failed; the outcome needs a status check.",
          ];
        }
        return null;
      });
      if (outcome === null) {
        throw new UpstreamError(
          "UNAVAILABLE",
          "PayPal could not be reached to check the status. Try again.",
          {
            correlationId,
            reference: e.debugId,
          },
        );
      }
      return outcome;
    }

    return store.transaction((ops) => {
      const c = ops.contextForNegotiation(negotiationId);
      if (!c) throw new NotFoundError("an active agreement for this negotiation");
      if (c.paypalOrderId !== null && c.paypalOrderId !== observed.id)
        throw new ConflictError("PayPal returned a different order than this transaction's.");
      const interp = interpretOrder(observed, expectationFor(ops, c));
      return applyObservation(
        ops,
        c,
        interp,
        observed,
        deps.now(),
        correlationId,
        http?.approveUrl ?? observed.approveUrl,
        http === null ? null : { httpStatus: http.httpStatus, debugId: http.debugId },
      );
    });
  }

  /** The CREATE_ORDER call (also used to replay the SAME request id during reconciliation). */
  async function runCreate(
    negotiationId: string,
    c: PaymentContext,
    attempt: { id: string; seq: number; requestId: string },
    correlationId: string,
  ): Promise<string[]> {
    let created: CreatedOrder;
    try {
      created = await needProvider().createOrder({
        requestId: attempt.requestId,
        amountMinor: c.totalMinor,
        currency: c.currency,
        customId: c.transactionId,
        invoiceId: invoiceIdOf(c.transactionId, attempt.seq),
        description: `PactPay Arena sandbox payment ${c.agreementId}`,
        returnUrl: config.returnUrl,
        cancelUrl: config.cancelUrl,
      });
    } catch (err) {
      const e =
        err instanceof ProviderError ? err : new ProviderError("NETWORK", "The request failed.");
      return store.transaction((ops) => {
        const cur = ops.contextForNegotiation(negotiationId);
        if (!cur) throw new NotFoundError("an active agreement for this negotiation");
        recordFailure(ops, cur, "CREATE_ORDER", e, stamp(), correlationId);
        return [
          e.outcome === "DEFINITE_FAILURE"
            ? "PayPal refused to create the order. Nothing was charged."
            : "The request to PayPal may or may not have taken effect. Use “Check status”.",
        ];
      });
    }
    return observeAndApply(negotiationId, created.orderId, correlationId, {
      httpStatus: created.httpStatus,
      debugId: created.debugId,
      approveUrl: created.approveUrl,
    });
  }

  /* ------------------------------------------------------------ capture and void */

  /** Repeats and races: these states already hold the answer, so a second request sends nothing. */
  const NOOP: Record<"CAPTURE" | "VOID", Partial<Record<TxState, string>>> = {
    CAPTURE: {
      CAPTURING:
        "A capture is already in progress; nothing new was sent to PayPal. Use “Check status”.",
      CAPTURE_PENDING:
        "PayPal reports the capture as pending. It is not paid yet; nothing new was sent. Use “Check status”.",
      CAPTURED: "The payment was already captured; nothing new was sent to PayPal.",
      REVERSED:
        "The captured payment was refunded or reversed at PayPal; nothing new was sent to PayPal.",
    },
    VOID: {
      VOIDING:
        "A release is already in progress; nothing new was sent to PayPal. Use “Check status”.",
      VOIDED: "The hold was already released; nothing new was sent to PayPal.",
    },
  };
  /** States in which the request is wrong, not merely repeated. */
  const BLOCKED: Record<"CAPTURE" | "VOID", Partial<Record<TxState, string>>> = {
    CAPTURE: {
      VOIDING: "The hold is being released; a voided authorization cannot be captured.",
      VOIDED: "The hold was released (voided); it cannot be captured.",
      AUTHORIZING: "An earlier request is unresolved. Use “Check status” first.",
      NEEDS_RECONCILIATION: "An earlier request is unresolved. Use “Check status” first.",
      AUTHORIZATION_PENDING:
        "PayPal has not finished the authorization, so nothing is held to capture.",
    },
    VOID: {
      CAPTURING:
        "A capture is in progress; an authorization that is being captured cannot be voided.",
      CAPTURE_PENDING: "A capture is pending at PayPal; the authorization cannot be voided now.",
      CAPTURED: "The authorization was captured; a captured authorization cannot be voided.",
      REVERSED: "The payment was captured and then refunded or reversed; there is no hold to void.",
      AUTHORIZING: "An earlier request is unresolved. Use “Check status” first.",
      NEEDS_RECONCILIATION: "An earlier request is unresolved. Use “Check status” first.",
      AUTHORIZATION_PENDING:
        "PayPal has not finished the authorization, so there is no hold to release.",
    },
  };

  /**
   * CAPTURE (collect the held funds: the only step after which a payment counts as paid) and VOID (release the hold)
   * share one shape, because they carry the same risks:
   *  1. only an AUTHORIZED hold qualifies; a repeat or a race lands on the state that already holds the answer;
   *  2. PayPal is asked fresh, and the hold must match our records (order, authorization id, payee, amount, currency);
   *  3. the policy engine decides, from stored rows plus that observation;
   *  4. attempt + state change are one database transaction (the second request finds the state moved and sends nothing);
   *  5. the request goes out OUTSIDE the transaction with the attempt's stable PayPal-Request-Id;
   *  6. nothing is believed until the order is read again.
   * The amount of a capture is the agreement's total from our database, never a value supplied by a caller.
   */
  async function finalize(
    kind: "CAPTURE" | "VOID",
    actor: NegotiationActor,
    negotiationId: string,
  ): Promise<PaymentResult> {
    requireOperator(actor);
    needProvider();
    const correlationId = deps.newId("corr");
    const c0 = readContext(negotiationId);
    const verb = kind === "CAPTURE" ? "captured" : "released";

    const repeat = NOOP[kind][c0.txState];
    if (repeat !== undefined)
      return snapshot(negotiationId, correlationId, { performed: false, notes: [repeat] });
    const blocked = BLOCKED[kind][c0.txState];
    if (blocked !== undefined) throw new ConflictError(blocked);
    if (c0.txState !== "AUTHORIZED")
      throw new ConflictError(
        `A payment in state ${c0.txState} cannot be ${verb}: only an authorized hold can be.`,
      );
    if (c0.paypalOrderId === null || c0.paypalAuthorizationId === null)
      throw new ConflictError("There is no PayPal authorization for this payment.");

    // 1. Ask PayPal. A failure here changes nothing.
    let observed: ObservedOrder;
    try {
      observed = await needProvider().getOrder(c0.paypalOrderId);
    } catch (err) {
      const e =
        err instanceof ProviderError ? err : new ProviderError("NETWORK", "The read failed.");
      throw new UpstreamError(
        "UNAVAILABLE",
        "PayPal could not be reached to confirm the hold. Nothing was changed.",
        { correlationId, reference: e.debugId },
      );
    }

    // 2. Policy, write-ahead attempt and state change: one database transaction.
    const prep = store.transaction((ops) => {
      const c = ops.contextForNegotiation(negotiationId);
      if (!c) throw new NotFoundError("an active agreement for this negotiation");
      if (c.txVersion !== c0.txVersion) {
        const note = NOOP[kind][c.txState];
        if (note !== undefined) return { kind: "ALREADY" as const, note };
        throw new ConflictError(
          "The payment changed while you were working. Reload and try again.",
        );
      }
      const ts = stamp();
      const refuse = (notes: string[]) => ({ kind: "REFUSED" as const, notes });
      const interp = interpretOrder(observed, expectationFor(ops, c));
      if (interp.kind === "ANOMALY") {
        applyObservation(ops, c, interp, observed, deps.now(), correlationId, null);
        return refuse([
          `PayPal's record does not match the agreement: ${interp.findings.map(describeFinding).join(" ")} Nothing was ${verb}.`,
        ]);
      }
      // A void may also find the hold already gone at PayPal (it lapsed or was released elsewhere).
      const alreadyGone = kind === "VOID" && interp.target === "VOIDED";
      if ((interp.target !== "AUTHORIZED" && !alreadyGone) || interp.authorization === null) {
        const applied = applyObservation(ops, c, interp, observed, deps.now(), correlationId, null);
        return refuse([
          `PayPal does not show a usable hold (it reports ${interp.target.toLowerCase().replaceAll("_", " ")}). Nothing was ${verb}.`,
          ...applied,
        ]);
      }
      if (
        ops.attempts(c.transactionId).filter((a) => a.action === kind).length >=
        MAX_ATTEMPTS_PER_ACTION
      ) {
        return refuse([
          kind === "CAPTURE"
            ? "PayPal refused the capture three times for this payment. Release the hold instead."
            : "PayPal refused the release three times for this payment.",
        ]);
      }

      const money = interp.authorization.amount;
      const decision = evaluatePolicy(
        ops.policyInput({
          subject: kind,
          transactionId: c.transactionId,
          now: ts,
          actor: "OPERATOR",
          observed:
            kind === "CAPTURE" && money !== null
              ? {
                  amountMinor: money.minor,
                  currency: money.currency,
                  // The agreement names a logical payee; the funds go to the one configured sandbox merchant, which
                  // can vouch for it only if PayPal reported exactly that merchant.
                  payeeRef: interp.payee === "MATCH" ? c.payeeRef : "UNVERIFIED_PAYEE",
                }
              : null,
        }),
      );
      ops.recordDecision({
        id: deps.newId("pd"),
        subject: kind,
        transactionId: c.transactionId,
        verdict: decision.verdict,
        reasonCodes: [...decision.reasonCodes],
        inputsHash: decision.inputsHash,
        mandateId: c.mandateId,
        mandateVersion: c.mandateVersion,
        decidedAt: ts,
      });
      if (decision.verdict === "DENY") {
        ops.audit({
          ts,
          actor: "OPERATOR",
          type: "PAYMENT_POLICY_DENIED",
          transactionId: c.transactionId,
          payload: { correlationId, subject: kind, reasonCodes: [...decision.reasonCodes] },
        });
        return { kind: "DENIED" as const, decision };
      }

      ops.transition({
        transactionId: c.transactionId,
        expectedVersion: c.txVersion,
        to: kind === "CAPTURE" ? "CAPTURING" : "VOIDING",
        now: ts,
        actor: "OPERATOR",
        details: {
          correlationId,
          agreementVersion: c.agreementVersion,
          mandateVersion: c.mandateVersion,
        },
      });
      const attempt = ops.beginAttempt({
        id: deps.newId("att"),
        transactionId: c.transactionId,
        action: kind,
        requestHash: hashOf({
          orderId: c.paypalOrderId,
          authorizationId: c.paypalAuthorizationId,
          amountMinor: c.totalMinor,
          currency: c.currency,
        }),
        now: ts,
      });
      if (alreadyGone) {
        ops.audit({
          ts,
          actor: "SYSTEM",
          type: "PAYPAL_VOID_NOT_NEEDED",
          transactionId: c.transactionId,
          payload: { correlationId, reason: "PayPal already shows the authorization as voided" },
        });
      }
      return {
        kind: "PROCEED" as const,
        attempt,
        orderId: c.paypalOrderId as string,
        authorizationId: c.paypalAuthorizationId as string,
        amountMinor: c.totalMinor,
        currency: c.currency,
        skipCall: alreadyGone,
      };
    });

    if (prep.kind === "ALREADY") {
      return snapshot(negotiationId, correlationId, { performed: false, notes: [prep.note] });
    }
    if (prep.kind === "REFUSED") {
      return snapshot(negotiationId, correlationId, { performed: false, notes: prep.notes });
    }
    if (prep.kind === "DENIED") {
      return snapshot(negotiationId, correlationId, {
        performed: false,
        policy: policyView(prep.decision, kind),
        notes: [`The policy check refused. Nothing was sent to PayPal.`],
      });
    }

    // 3. The request, outside any database transaction.
    const notes: string[] = [];
    let called: { httpStatus: number; debugId: string | null } | null = null;
    if (!prep.skipCall) {
      try {
        called =
          kind === "CAPTURE"
            ? await needProvider().captureAuthorization({
                requestId: prep.attempt.requestId,
                authorizationId: prep.authorizationId,
                amountMinor: prep.amountMinor,
                currency: prep.currency,
              })
            : await needProvider().voidAuthorization(prep.authorizationId, prep.attempt.requestId);
      } catch (err) {
        const e =
          err instanceof ProviderError ? err : new ProviderError("NETWORK", "The request failed.");
        const verdict = store.transaction((ops) => {
          const cur = ops.contextForNegotiation(negotiationId);
          if (!cur) throw new NotFoundError("an active agreement for this negotiation");
          return recordFailure(ops, cur, kind, e, stamp(), correlationId);
        });
        if (verdict === "DONE") {
          return snapshot(negotiationId, correlationId, {
            performed: true,
            notes: [
              "The request to PayPal may or may not have taken effect. Nothing was repeated. Use “Check status”.",
            ],
          });
        }
        notes.push("PayPal refused the request; the hold is checked before anything else happens.");
      }
    }

    // 4. Believe nothing until PayPal is asked again.
    notes.push(
      ...(await observeAndApply(
        negotiationId,
        prep.orderId,
        correlationId,
        called === null ? null : { ...called, approveUrl: null },
      )),
    );
    return snapshot(negotiationId, correlationId, { performed: true, notes });
  }

  /* ------------------------------------------------------------ public operations */

  const operations = {
    /** The current payment, from stored state only (no PayPal call). */
    view(actor: NegotiationActor, negotiationId: string): PaymentView {
      requireOperator(actor);
      return store.transaction((ops) => {
        const c = ops.contextForNegotiation(negotiationId);
        if (!c) throw new NotFoundError("an active agreement for this negotiation");
        return viewOf(ops, c);
      });
    },

    /**
     * Creates the PayPal order for the negotiation's ACTIVE agreement. A repeat (or a double click) never creates a
     * second order: only an AGREED transaction can start, and starting moves it out of AGREED in the same database
     * transaction that writes the attempt.
     */
    async start(actor: NegotiationActor, negotiationId: string): Promise<PaymentResult> {
      requireOperator(actor);
      needProvider(); // refuse BEFORE any state changes if PayPal is not configured
      const correlationId = deps.newId("corr");

      const prep = store.transaction((ops) => {
        const c = ops.contextForNegotiation(negotiationId);
        if (!c) throw new NotFoundError("an active agreement for this negotiation");
        if (c.txState !== "AGREED") return { kind: "EXISTING" as const };
        if (c.currency !== SANDBOX_CURRENCY)
          throw new ConflictError("PayPal sandbox payments are limited to USD in this build.");

        const ts = stamp();
        const decision = evaluatePolicy(
          ops.policyInput({
            subject: "CREATE_ORDER",
            transactionId: c.transactionId,
            now: ts,
            actor: "OPERATOR",
            observed: null,
          }),
        );
        ops.recordDecision({
          id: deps.newId("pd"),
          subject: "CREATE_ORDER",
          transactionId: c.transactionId,
          verdict: decision.verdict,
          reasonCodes: [...decision.reasonCodes],
          inputsHash: decision.inputsHash,
          mandateId: c.mandateId,
          mandateVersion: c.mandateVersion,
          decidedAt: ts,
        });
        if (decision.verdict === "DENY") {
          ops.audit({
            ts,
            actor: "OPERATOR",
            type: "PAYMENT_POLICY_DENIED",
            transactionId: c.transactionId,
            payload: {
              correlationId,
              subject: "CREATE_ORDER",
              reasonCodes: [...decision.reasonCodes],
            },
          });
          return { kind: "DENIED" as const, decision };
        }

        ops.transition({
          transactionId: c.transactionId,
          expectedVersion: c.txVersion,
          to: "CREATING_ORDER",
          now: ts,
          actor: "OPERATOR",
          details: { correlationId, agreementVersion: c.agreementVersion },
        });
        const attempt = ops.beginAttempt({
          id: deps.newId("att"),
          transactionId: c.transactionId,
          action: "CREATE_ORDER",
          requestHash: hashOf({
            agreementId: c.agreementId,
            amountMinor: c.totalMinor,
            currency: c.currency,
            customId: c.transactionId,
          }),
          now: ts,
        });
        return {
          kind: "PROCEED" as const,
          ctx: { ...c, txState: "CREATING_ORDER" as const, txVersion: c.txVersion + 1 },
          attempt,
        };
      });

      if (prep.kind === "EXISTING") {
        return snapshot(negotiationId, correlationId, {
          performed: false,
          notes: [
            "A payment was already started for this agreement; nothing new was sent to PayPal.",
          ],
        });
      }
      if (prep.kind === "DENIED") {
        return snapshot(negotiationId, correlationId, {
          performed: false,
          policy: policyView(prep.decision, "CREATE_ORDER"),
          notes: ["The policy check refused to start the payment. Nothing was sent to PayPal."],
        });
      }

      const notes = await runCreate(negotiationId, prep.ctx, prep.attempt, correlationId);
      return snapshot(negotiationId, correlationId, { performed: true, notes });
    },

    /**
     * Asks PayPal what really happened and applies it. This is the only thing the return-from-PayPal redirect is
     * allowed to trigger, and the way every ambiguous outcome is settled.
     */
    async refresh(actor: NegotiationActor, negotiationId: string): Promise<PaymentResult> {
      requireOperator(actor);
      const correlationId = deps.newId("corr");
      const c = readContext(negotiationId);

      // Nothing to ask PayPal about.
      if (["AGREED", "FAILED", "CANCELLED", "VOIDED", "REJECTED", "REVERSED"].includes(c.txState)) {
        return snapshot(negotiationId, correlationId, { performed: false });
      }
      needProvider();

      if (c.paypalOrderId === null) {
        // The create call's outcome is unknown and the order id was never learned: replay the SAME request id.
        if (c.txState === "NEEDS_RECONCILIATION" && c.reconcilingFrom === "CREATING_ORDER") {
          const prep = store.transaction((ops) => {
            const cur = ops.contextForNegotiation(negotiationId);
            if (!cur) throw new NotFoundError("an active agreement for this negotiation");
            const a = lastAttempt(ops, cur.transactionId, "CREATE_ORDER");
            if (a === undefined || a.status !== "UNKNOWN") return { kind: "NOTHING" as const };
            const ts = stamp();
            const sameRequest =
              a.requestHash ===
              hashOf({
                agreementId: cur.agreementId,
                amountMinor: cur.totalMinor,
                currency: cur.currency,
                customId: cur.transactionId,
              });
            if (!sameRequest || a.tries >= 3) {
              // Not recoverable: nothing can have been charged before the buyer approves an order we never learned of.
              ops.finishAttempt({ id: a.id, status: "FAILED_DEFINITE", now: ts });
              ops.transition({
                transactionId: cur.transactionId,
                expectedVersion: cur.txVersion,
                to: "FAILED",
                now: ts,
                actor: "SYSTEM",
                details: {
                  correlationId,
                  reason: sameRequest ? "replay budget used" : "the agreement changed",
                },
              });
              return { kind: "GAVE_UP" as const };
            }
            ops.retryAttempt(a.id);
            return {
              kind: "REPLAY" as const,
              ctx: cur,
              attempt: { id: a.id, seq: a.seq, requestId: a.requestId },
            };
          });
          if (prep.kind === "REPLAY") {
            const notes = await runCreate(negotiationId, prep.ctx, prep.attempt, correlationId);
            return snapshot(negotiationId, correlationId, { performed: true, notes });
          }
          return snapshot(negotiationId, correlationId, {
            performed: false,
            notes:
              prep.kind === "GAVE_UP"
                ? [
                    "The order could not be recovered. Nothing was charged; this agreement can no longer be paid.",
                  ]
                : [],
          });
        }
        return snapshot(negotiationId, correlationId, {
          performed: false,
          notes: ["A request is still in progress."],
        });
      }

      const notes = await observeAndApply(negotiationId, c.paypalOrderId, correlationId, null);
      return snapshot(negotiationId, correlationId, { performed: true, notes });
    },

    /**
     * Places the hold (AUTHORIZE) after PayPal itself reports the buyer approved. The approval is confirmed by a read,
     * the policy engine is asked with that observation, and the result is read back before it is believed.
     */
    async authorize(actor: NegotiationActor, negotiationId: string): Promise<PaymentResult> {
      requireOperator(actor);
      needProvider();
      const correlationId = deps.newId("corr");
      const c0 = readContext(negotiationId);

      if (
        [
          "AUTHORIZED",
          "CAPTURING",
          "CAPTURE_PENDING",
          "CAPTURED",
          "VOIDING",
          "VOIDED",
          "REVERSED",
        ].includes(c0.txState)
      ) {
        return snapshot(negotiationId, correlationId, {
          performed: false,
          notes: ["The payment is already authorized; nothing new was sent to PayPal."],
        });
      }
      if (
        c0.txState === "AUTHORIZING" ||
        c0.txState === "NEEDS_RECONCILIATION" ||
        c0.txState === "AUTHORIZATION_PENDING"
      ) {
        throw new ConflictError("An earlier request is unresolved. Use “Check status” first.");
      }
      if (c0.txState !== "ORDER_CREATED" && c0.txState !== "ORDER_APPROVED") {
        throw new ConflictError(`A payment in state ${c0.txState} cannot be authorized.`);
      }
      if (c0.paypalOrderId === null)
        throw new ConflictError("There is no PayPal order to authorize.");

      // 1. Ask PayPal. A failure here changes nothing.
      let observed: ObservedOrder;
      try {
        observed = await needProvider().getOrder(c0.paypalOrderId);
      } catch (err) {
        const e =
          err instanceof ProviderError ? err : new ProviderError("NETWORK", "The read failed.");
        throw new UpstreamError(
          "UNAVAILABLE",
          "PayPal could not be reached to confirm the approval. Nothing was changed.",
          {
            correlationId,
            reference: e.debugId,
          },
        );
      }

      // 2. Record the verified approval (if new), ask the policy engine, and write the attempt ahead.
      const prep = store.transaction((ops) => {
        const c = ops.contextForNegotiation(negotiationId);
        if (!c) throw new NotFoundError("an active agreement for this negotiation");
        if (c.txVersion !== c0.txVersion)
          throw new ConflictError(
            "The payment changed while you were working. Reload and try again.",
          );
        const ts = stamp();
        const interp = interpretOrder(observed, expectationFor(ops, c));
        if (interp.kind === "ANOMALY") {
          applyObservation(ops, c, interp, observed, deps.now(), correlationId, null);
          return {
            kind: "REFUSED" as const,
            notes: [
              `PayPal's record does not match the agreement: ${interp.findings.map(describeFinding).join(" ")} Nothing was authorized.`,
            ],
          };
        }
        if (interp.target === "ORDER_CREATED") {
          applyObservation(
            ops,
            c,
            interp,
            observed,
            deps.now(),
            correlationId,
            observed.approveUrl,
          );
          return {
            kind: "REFUSED" as const,
            notes: ["PayPal says the buyer has not approved yet. Nothing was authorized."],
          };
        }
        if (interp.target !== "ORDER_APPROVED") {
          applyObservation(ops, c, interp, observed, deps.now(), correlationId, null);
          return {
            kind: "REFUSED" as const,
            notes: [
              "PayPal reports a state that does not allow authorizing now. Nothing was sent.",
            ],
          };
        }

        let cur = c;
        if (c.txState === "ORDER_CREATED") {
          applyObservation(ops, c, interp, observed, deps.now(), correlationId, null);
          cur = ops.contextForNegotiation(negotiationId) as PaymentContext;
        }
        if (cur.txState !== "ORDER_APPROVED") {
          return { kind: "REFUSED" as const, notes: ["The payment is not in an approved state."] };
        }

        const decision = evaluatePolicy(
          ops.policyInput({
            subject: "AUTHORIZE",
            transactionId: cur.transactionId,
            now: ts,
            actor: "OPERATOR",
            observed: {
              amountMinor: (observed.amount as { minor: number }).minor,
              currency: (observed.amount as { currency: string }).currency,
              // The agreement's payee is a logical seller reference. The money goes to the one configured sandbox
              // merchant, so the observation can only vouch for the logical payee if that merchant is verified.
              payeeRef: interp.payee === "MATCH" ? cur.payeeRef : "UNVERIFIED_PAYEE",
            },
          }),
        );
        ops.recordDecision({
          id: deps.newId("pd"),
          subject: "AUTHORIZE",
          transactionId: cur.transactionId,
          verdict: decision.verdict,
          reasonCodes: [...decision.reasonCodes],
          inputsHash: decision.inputsHash,
          mandateId: cur.mandateId,
          mandateVersion: cur.mandateVersion,
          decidedAt: ts,
        });
        if (decision.verdict === "DENY") {
          ops.audit({
            ts,
            actor: "OPERATOR",
            type: "PAYMENT_POLICY_DENIED",
            transactionId: cur.transactionId,
            payload: {
              correlationId,
              subject: "AUTHORIZE",
              reasonCodes: [...decision.reasonCodes],
            },
          });
          return { kind: "DENIED" as const, decision };
        }

        ops.transition({
          transactionId: cur.transactionId,
          expectedVersion: cur.txVersion,
          to: "AUTHORIZING",
          now: ts,
          actor: "OPERATOR",
          details: { correlationId, agreementVersion: cur.agreementVersion },
        });
        const attempt = ops.beginAttempt({
          id: deps.newId("att"),
          transactionId: cur.transactionId,
          action: "AUTHORIZE",
          requestHash: hashOf({
            orderId: cur.paypalOrderId,
            amountMinor: cur.totalMinor,
            currency: cur.currency,
          }),
          now: ts,
        });
        return { kind: "PROCEED" as const, attempt, orderId: cur.paypalOrderId as string };
      });

      if (prep.kind === "REFUSED") {
        return snapshot(negotiationId, correlationId, { performed: false, notes: prep.notes });
      }
      if (prep.kind === "DENIED") {
        return snapshot(negotiationId, correlationId, {
          performed: false,
          policy: policyView(prep.decision, "AUTHORIZE"),
          notes: ["The policy check refused to authorize. Nothing was sent to PayPal."],
        });
      }

      // 3. The authorize call, outside any database transaction.
      let call: { httpStatus: number; debugId: string | null };
      try {
        call = await needProvider().authorizeOrder(prep.orderId, prep.attempt.requestId);
      } catch (err) {
        const e =
          err instanceof ProviderError ? err : new ProviderError("NETWORK", "The request failed.");
        const notes = store.transaction((ops) => {
          const cur = ops.contextForNegotiation(negotiationId);
          if (!cur) throw new NotFoundError("an active agreement for this negotiation");
          recordFailure(ops, cur, "AUTHORIZE", e, stamp(), correlationId);
          return [
            e.outcome === "DEFINITE_FAILURE"
              ? "PayPal refused the authorization. Nothing was held or charged."
              : "The request to PayPal may or may not have taken effect. Use “Check status”.",
          ];
        });
        return snapshot(negotiationId, correlationId, { performed: true, notes });
      }

      // 4. Believe nothing until PayPal is asked again.
      const notes = await observeAndApply(negotiationId, prep.orderId, correlationId, {
        httpStatus: call.httpStatus,
        debugId: call.debugId,
        approveUrl: null,
      });
      return snapshot(negotiationId, correlationId, { performed: true, notes });
    },

    /**
     * Collects the held funds (a final, full capture of the agreed total). The only place a payment becomes "paid" is a
     * capture that PayPal reports COMPLETED when the order is read back. Operator only; no parameters.
     */
    capture: (actor: NegotiationActor, negotiationId: string) =>
      finalize("CAPTURE", actor, negotiationId),

    /** Releases the hold (void). Allowed only for an authorized, uncaptured hold. Operator only; no parameters. */
    voidHold: (actor: NegotiationActor, negotiationId: string) =>
      finalize("VOID", actor, negotiationId),

    /**
     * A VERIFIED PayPal webhook named this order. The event itself proves nothing: this asks PayPal for the order and
     * applies what the READ shows, exactly like a status check. Callable only by the system (the webhook service); a
     * browser-facing route never reaches it. Returns what was read so the caller can judge the event against it.
     */
    async reconcileOrder(
      actor: NegotiationActor,
      paypalOrderId: string,
    ): Promise<
      | { kind: "UNKNOWN_ORDER" }
      | { kind: "TERMINAL"; transactionId: string; state: TxState }
      | {
          kind: "READ";
          transactionId: string;
          before: TxState;
          after: TxState;
          observed: ObservedOrder;
        }
    > {
      if (actor.kind !== "SYSTEM")
        throw new ForbiddenError("only the system may reconcile from a webhook");
      const context = store.transaction((ops) => ops.contextForOrderId(paypalOrderId));
      if (!context) return { kind: "UNKNOWN_ORDER" };
      if (
        ["AGREED", "FAILED", "CANCELLED", "VOIDED", "REJECTED", "REVERSED"].includes(
          context.txState,
        )
      )
        return { kind: "TERMINAL", transactionId: context.transactionId, state: context.txState };
      needProvider();
      const sink: { observed?: ObservedOrder } = {};
      await observeAndApply(context.negotiationId, paypalOrderId, deps.newId("corr"), null, sink);
      const after = readContext(context.negotiationId);
      return {
        kind: "READ",
        transactionId: context.transactionId,
        before: context.txState,
        after: after.txState,
        observed: sink.observed as ObservedOrder,
      };
    },

    /**
     * The browser came back from PayPal. The query string is NOT evidence: we only look the order up in our own
     * records (an unknown id is refused before any PayPal call) and then ask PayPal.
     */
    async confirmReturn(actor: NegotiationActor, paypalOrderId: string): Promise<PaymentResult> {
      requireOperator(actor);
      const context = store.transaction((ops) => ops.contextForOrderId(paypalOrderId));
      if (!context) throw new NotFoundError("a payment for that PayPal order");
      return operations.refresh(actor, context.negotiationId);
    },
  };
  return operations;
}

export type PaymentService = ReturnType<typeof createPaymentService>;
export type { AttemptInfo };
