import {
  failureOutcome,
  type FailureOutcome,
  type ObservedOrder,
  type ProviderErrorKind,
} from "../domain/payment.ts";

/**
 * The only door to the payment provider. Callers (application/) pass values the SERVER derived from stored
 * records; the provider never receives anything from a browser or an agent. It reports what the provider said as
 * plain data (`ObservedOrder`) and throws `ProviderError` for every failure.
 *
 * Deliberately absent: refund, reauthorize, payout (docs/PAYPAL_INTEGRATION.md). Capture and void are here, but they
 * are write-only: what they did is established by reading the order back (`getOrder`), never by their own answer.
 */

export class ProviderError extends Error {
  readonly kind: ProviderErrorKind;
  readonly httpStatus: number | null;
  /** The provider's debug id, if it gave a well-formed one. A support reference, not a secret. */
  readonly debugId: string | null;
  /** Provider issue codes (upper-case tokens only), never free text. */
  readonly issues: readonly string[];

  constructor(
    kind: ProviderErrorKind,
    message: string,
    details: {
      httpStatus?: number | null;
      debugId?: string | null;
      issues?: readonly string[];
    } = {},
  ) {
    super(message);
    this.name = "ProviderError";
    this.kind = kind;
    this.httpStatus = details.httpStatus ?? null;
    this.debugId = details.debugId ?? null;
    this.issues = details.issues ?? [];
  }

  get outcome(): FailureOutcome {
    return failureOutcome(this);
  }
}

export type CreateOrderRequest = {
  /** `PayPal-Request-Id`: stable per attempt, so a retry of the SAME attempt cannot create a second order. */
  requestId: string;
  amountMinor: number;
  currency: string;
  customId: string;
  invoiceId: string;
  description: string;
  returnUrl: string;
  cancelUrl: string;
};

export type CreatedOrder = {
  orderId: string;
  /** Verbatim from the provider; informational only. The authoritative read is `getOrder`. */
  status: string;
  approveUrl: string | null;
  httpStatus: number;
  debugId: string | null;
};

export type CaptureRequest = {
  /** `PayPal-Request-Id`: stable per attempt, so a replay of the SAME attempt cannot capture twice. */
  requestId: string;
  /** The authorization id the SERVER stored for the transaction. */
  authorizationId: string;
  /** The full agreed total. Always the whole amount: this build never captures part of a hold. */
  amountMinor: number;
  currency: string;
};

export type ProviderCall = { httpStatus: number; debugId: string | null };

export interface PaymentProvider {
  /** A label for audit and screens, e.g. "paypal-sandbox". */
  readonly name: string;
  createOrder(request: CreateOrderRequest): Promise<CreatedOrder>;
  getOrder(orderId: string): Promise<ObservedOrder>;
  /** Sends the authorize call. The result is read back with `getOrder`; the response body is not trusted. */
  authorizeOrder(orderId: string, requestId: string): Promise<ProviderCall>;
  /** Captures the whole authorization (`final_capture`). A 2xx answer is not proof of payment: read the order back. */
  captureAuthorization(request: CaptureRequest): Promise<ProviderCall>;
  /** Releases the hold. A 2xx answer is not proof either: read the order back. */
  voidAuthorization(authorizationId: string, requestId: string): Promise<ProviderCall>;
}
