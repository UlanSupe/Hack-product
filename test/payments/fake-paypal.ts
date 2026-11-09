import type { ObservedAuthorization, ObservedCapture, ObservedOrder } from "@/domain/payment";
import {
  ProviderError,
  type CaptureRequest,
  type CreatedOrder,
  type CreateOrderRequest,
  type PaymentProvider,
  type ProviderCall,
} from "@/ports/payment-provider";

/**
 * A scripted stand-in for PayPal's Orders and Payments APIs, with just enough behaviour to exercise the payment
 * service: idempotent create/capture/void by request id, buyer approval as a separate act, authorize that needs
 * approval, capture and void with PayPal's documented refusals, and fault injection that can LOSE THE RESPONSE of a
 * call that did take effect (the dangerous case).
 *
 * It is a test double. It proves how OUR code reacts to the shapes PayPal documents; it proves nothing about PayPal.
 */

export type FakeCapture = {
  id: string;
  status: string;
  amountMinor: number;
  currency: string;
  finalCapture: boolean | null;
};

export type FakeOrder = {
  id: string;
  status: string;
  intent: string;
  amountMinor: number;
  currency: string;
  customId: string | null;
  invoiceId: string | null;
  payeeMerchantId: string | null;
  purchaseUnits: number;
  approveUrl: string | null;
  authorization: {
    id: string;
    status: string;
    amountMinor: number;
    currency: string;
    customId: string | null;
    createTime: string | null;
  } | null;
  captures: FakeCapture[];
  requestId: string;
};

export type Op =
  "createOrder" | "getOrder" | "authorizeOrder" | "captureAuthorization" | "voidAuthorization";
export type Fault = { op: Op; when: "before" | "after"; error: ProviderError };

export const rejected = (issue: string, httpStatus = 422) =>
  new ProviderError("REJECTED", "refused", {
    httpStatus,
    issues: [issue],
    debugId: "dbg_rejected_1",
  });
export const unknownFailure = (
  kind:
    | "NETWORK"
    | "TIMEOUT"
    | "SERVER"
    | "RATE_LIMITED"
    | "CONFLICT"
    | "ACCEPTED_INCOMPLETE"
    | "MALFORMED",
) =>
  new ProviderError(kind, "unknown", {
    httpStatus:
      kind === "SERVER"
        ? 503
        : kind === "RATE_LIMITED"
          ? 429
          : kind === "CONFLICT"
            ? 409
            : kind === "ACCEPTED_INCOMPLETE"
              ? 202
              : null,
    debugId: "dbg_unknown_1",
  });

export function createFakePayPal(options: { merchantId?: string | null } = {}) {
  const merchantId = options.merchantId === undefined ? "MERCHANT01" : options.merchantId;
  const orders = new Map<string, FakeOrder>();
  const byRequestId = new Map<string, string>();
  const calls: {
    op: Op;
    requestId?: string;
    orderId?: string;
    authorizationId?: string;
    amountMinor?: number;
    currency?: string;
  }[] = [];
  const captureByRequestId = new Set<string>();
  const voidByRequestId = new Set<string>();
  const faults: Fault[] = [];
  let seq = 0;
  const behaviour = {
    /** What an authorize call produces. */
    authorizationStatus: "CREATED" as string,
    /** Added to the authorization amount, to simulate PayPal authorizing a different amount. */
    authorizationAmountDelta: 0,
    /** Added to the created order's amount, to simulate PayPal creating a different order. */
    createAmountDelta: 0,
    createCurrency: null as string | null,
    createCustomId: undefined as string | null | undefined,
    createInvoiceId: undefined as string | null | undefined,
    createIntent: "AUTHORIZE",
    createPurchaseUnits: 1,
    payeeMerchantId: merchantId,
    approveUrl: "https://www.sandbox.paypal.com/checkoutnow?token=ORDER" as string | null,
    /** What a capture call produces: COMPLETED, PENDING, DECLINED... */
    captureStatus: "COMPLETED" as string,
    /** Added to the capture amount PayPal records, to simulate a different capture. */
    captureAmountDelta: 0,
    captureFinal: true as boolean | null,
    /** The order status after a void. */
    voidOrderStatus: "COMPLETED",
    /** Simulates a read that has not caught up: captures are hidden and a CAPTURED hold reads as CREATED. */
    staleReads: false,
  };

  const takeFault = (op: Op, when: "before" | "after"): ProviderError | null => {
    const i = faults.findIndex((f) => f.op === op && f.when === when);
    return i < 0 ? null : (faults.splice(i, 1)[0] as Fault).error;
  };

  const observe = (o: FakeOrder): ObservedOrder => {
    const stale = behaviour.staleReads;
    return {
      id: o.id,
      status: o.status,
      intent: o.intent,
      purchaseUnitCount: o.purchaseUnits,
      amount: { minor: o.amountMinor, currency: o.currency },
      payeeMerchantId: o.payeeMerchantId,
      customId: o.customId,
      invoiceId: o.invoiceId,
      approveUrl: o.status === "CREATED" ? o.approveUrl : null,
      authorizations:
        o.authorization === null
          ? []
          : [
              {
                id: o.authorization.id,
                status:
                  stale && o.authorization.status === "CAPTURED"
                    ? "CREATED"
                    : o.authorization.status,
                amount: { minor: o.authorization.amountMinor, currency: o.authorization.currency },
                customId: o.authorization.customId,
                invoiceId: null,
                createTime: o.authorization.createTime,
                expirationTime: null,
                statusReason: null,
              } satisfies ObservedAuthorization,
            ],
      captures: stale
        ? []
        : o.captures.map((c): ObservedCapture => ({
            id: c.id,
            status: c.status,
            amount: { minor: c.amountMinor, currency: c.currency },
            finalCapture: c.finalCapture,
            invoiceId: null,
            createTime: null,
            statusReason: null,
          })),
    };
  };

  const provider: PaymentProvider = {
    name: "fake-paypal",

    createOrder(req: CreateOrderRequest): Promise<CreatedOrder> {
      calls.push({ op: "createOrder", requestId: req.requestId });
      const before = takeFault("createOrder", "before");
      if (before) return Promise.reject(before);

      let httpStatus = 201;
      let order: FakeOrder;
      const existingId = byRequestId.get(req.requestId);
      if (existingId !== undefined) {
        order = orders.get(existingId) as FakeOrder; // PayPal-Request-Id replay: the same order, not a new one
        httpStatus = 200;
      } else {
        order = {
          id: `ORDER${String(++seq).padStart(4, "0")}`,
          status: "CREATED",
          intent: behaviour.createIntent,
          amountMinor: req.amountMinor + behaviour.createAmountDelta,
          currency: behaviour.createCurrency ?? req.currency,
          customId:
            behaviour.createCustomId === undefined ? req.customId : behaviour.createCustomId,
          invoiceId:
            behaviour.createInvoiceId === undefined ? req.invoiceId : behaviour.createInvoiceId,
          payeeMerchantId: behaviour.payeeMerchantId,
          purchaseUnits: behaviour.createPurchaseUnits,
          approveUrl: behaviour.approveUrl,
          authorization: null,
          captures: [],
          requestId: req.requestId,
        };
        orders.set(order.id, order);
        byRequestId.set(req.requestId, order.id);
      }
      const after = takeFault("createOrder", "after");
      if (after) return Promise.reject(after);
      return Promise.resolve({
        orderId: order.id,
        status: order.status,
        approveUrl: order.approveUrl,
        httpStatus,
        debugId: "dbg_create_ok",
      });
    },

    getOrder(orderId: string): Promise<ObservedOrder> {
      calls.push({ op: "getOrder", orderId });
      const before = takeFault("getOrder", "before");
      if (before) return Promise.reject(before);
      const order = orders.get(orderId);
      if (!order)
        return Promise.reject(new ProviderError("NOT_FOUND", "no such order", { httpStatus: 404 }));
      const after = takeFault("getOrder", "after");
      if (after) return Promise.reject(after);
      return Promise.resolve(observe(order));
    },

    authorizeOrder(orderId: string, requestId: string): Promise<ProviderCall> {
      calls.push({ op: "authorizeOrder", orderId, requestId });
      const before = takeFault("authorizeOrder", "before");
      if (before) return Promise.reject(before);
      const order = orders.get(orderId);
      if (!order)
        return Promise.reject(new ProviderError("NOT_FOUND", "no such order", { httpStatus: 404 }));
      if (order.authorization === null) {
        if (order.status !== "APPROVED") return Promise.reject(rejected("ORDER_NOT_APPROVED"));
        order.authorization = {
          id: `AUTH${String(++seq).padStart(4, "0")}`,
          status: behaviour.authorizationStatus,
          amountMinor: order.amountMinor + behaviour.authorizationAmountDelta,
          currency: order.currency,
          customId: order.customId,
          createTime: null,
        };
        order.status = "COMPLETED";
      }
      const after = takeFault("authorizeOrder", "after");
      if (after) return Promise.reject(after);
      return Promise.resolve({ httpStatus: 201, debugId: "dbg_auth_ok" });
    },

    captureAuthorization(req: CaptureRequest): Promise<ProviderCall> {
      calls.push({
        op: "captureAuthorization",
        requestId: req.requestId,
        authorizationId: req.authorizationId,
        amountMinor: req.amountMinor,
        currency: req.currency,
      });
      const before = takeFault("captureAuthorization", "before");
      if (before) return Promise.reject(before);
      const order = [...orders.values()].find((o) => o.authorization?.id === req.authorizationId);
      if (!order || order.authorization === null)
        return Promise.reject(
          new ProviderError("NOT_FOUND", "no such authorization", { httpStatus: 404 }),
        );
      let httpStatus = 201;
      if (captureByRequestId.has(req.requestId)) {
        httpStatus = 200; // PayPal-Request-Id replay: the earlier capture, not a second one
      } else {
        if (order.authorization.status === "VOIDED")
          return Promise.reject(rejected("AUTHORIZATION_VOIDED"));
        if (
          order.authorization.status !== "CREATED" ||
          req.amountMinor > order.authorization.amountMinor
        )
          return Promise.reject(rejected("MAX_CAPTURE_AMOUNT_EXCEEDED"));
        captureByRequestId.add(req.requestId);
        order.captures.push({
          id: `CAP${String(++seq).padStart(4, "0")}`,
          status: behaviour.captureStatus,
          amountMinor: req.amountMinor + behaviour.captureAmountDelta,
          currency: req.currency,
          finalCapture: behaviour.captureFinal,
        });
        if (behaviour.captureStatus === "COMPLETED") order.authorization.status = "CAPTURED";
      }
      const after = takeFault("captureAuthorization", "after");
      if (after) return Promise.reject(after);
      return Promise.resolve({ httpStatus, debugId: "dbg_capture_ok" });
    },

    voidAuthorization(authorizationId: string, requestId: string): Promise<ProviderCall> {
      calls.push({ op: "voidAuthorization", requestId, authorizationId });
      const before = takeFault("voidAuthorization", "before");
      if (before) return Promise.reject(before);
      const order = [...orders.values()].find((o) => o.authorization?.id === authorizationId);
      if (!order || order.authorization === null)
        return Promise.reject(
          new ProviderError("NOT_FOUND", "no such authorization", { httpStatus: 404 }),
        );
      if (!voidByRequestId.has(requestId)) {
        if (order.authorization.status !== "CREATED")
          return Promise.reject(rejected("PREVIOUSLY_CAPTURED"));
        voidByRequestId.add(requestId);
        order.authorization.status = "VOIDED";
        order.status = behaviour.voidOrderStatus;
      }
      const after = takeFault("voidAuthorization", "after");
      if (after) return Promise.reject(after);
      return Promise.resolve({ httpStatus: 204, debugId: "dbg_void_ok" });
    },
  };

  return {
    provider,
    orders,
    calls,
    behaviour,
    count: (op: Op) => calls.filter((c) => c.op === op).length,
    /** The next call of this kind fails. "after" means it TOOK EFFECT but the caller never hears back. */
    failNext: (fault: Fault) => faults.push(fault),
    /** The buyer logs in at PayPal and approves. */
    approve: (id: string) => {
      (orders.get(id) as FakeOrder).status = "APPROVED";
    },
    /** Anything else PayPal might say about an order. */
    patch: (id: string, patch: Partial<FakeOrder>) => {
      Object.assign(orders.get(id) as FakeOrder, patch);
    },
    patchAuthorization: (id: string, patch: Partial<NonNullable<FakeOrder["authorization"]>>) => {
      Object.assign((orders.get(id) as FakeOrder).authorization as object, patch);
    },
    only: () => [...orders.values()][0] as FakeOrder,
    /** A capture that appears at PayPal without our asking (the dashboard, another client, a late completion). */
    addCapture: (id: string, capture: Partial<FakeCapture> = {}) => {
      const o = orders.get(id) as FakeOrder;
      o.captures.push({
        id: `CAP${String(++seq).padStart(4, "0")}`,
        status: "COMPLETED",
        amountMinor: o.amountMinor,
        currency: o.currency,
        finalCapture: true,
        ...capture,
      });
      if ((capture.status ?? "COMPLETED") === "COMPLETED" && o.authorization)
        o.authorization.status = "CAPTURED";
    },
    /** A pending capture completes (or is declined) at PayPal. */
    settleCapture: (id: string, status: string) => {
      const o = orders.get(id) as FakeOrder;
      const cap = o.captures.at(-1) as FakeCapture;
      cap.status = status;
      if (o.authorization) o.authorization.status = status === "COMPLETED" ? "CAPTURED" : "CREATED";
    },
    /** Refund of the (completed) capture, as seen at PayPal. */
    refundCapture: (id: string) => {
      const o = orders.get(id) as FakeOrder;
      (o.captures.at(-1) as FakeCapture).status = "REFUNDED";
    },
  };
}

export type FakePayPal = ReturnType<typeof createFakePayPal>;
