import { z } from "zod";

import { formatMinor, SUPPORTED_CURRENCIES, type SupportedCurrency } from "../../domain/mandate.ts";
import {
  observedMoney,
  type ObservedAuthorization,
  type ObservedOrder,
} from "../../domain/payment.ts";
import {
  ProviderError,
  type CreatedOrder,
  type CaptureRequest,
  type CreateOrderRequest,
  type PaymentProvider,
  type ProviderCall,
} from "../../ports/payment-provider.ts";
import { createPayPalClient, type PayPalClientOptions, type PayPalResponse } from "./client.ts";

/**
 * Orders v2 (create, show, authorize) and Payments v2 (capture, void) over the sandbox client. It turns PayPal's JSON
 * into the plain `ObservedOrder` shape and nothing more: it never decides whether an answer is acceptable and never
 * changes state. It has no refund, reauthorize or payout call.
 *
 * Paths and request shapes follow PayPal's Orders v2 OpenAPI document (read 2026-10-13). Unverified against a live
 * account: docs/PAYPAL_INTEGRATION.md section 12.
 */

/** `ORDER IDs`: the spec's pattern is `^[A-Z0-9]+$`, at most 36 characters. Checked before any path is built. */
const ORDER_ID = /^[A-Z0-9]{1,36}$/;
/** Authorization ids: the spec accepts any string, so the path part is restricted to plain id characters here. */
const AUTHORIZATION_ID = /^[A-Za-z0-9_-]{1,64}$/;

export type ExperienceContextStyle = "payment_source" | "application_context";

export type PayPalProviderOptions = PayPalClientOptions & {
  /**
   * Where the buyer-experience URLs go in the create request. PayPal's reference asks for
   * `application_context.return_url` when the JS SDK is not used, while newer shapes use
   * `payment_source.paypal.experience_context`; which one the sandbox accepts is unverified (Q3), so it is switchable.
   */
  experienceContext?: ExperienceContextStyle;
};

const Money = z.object({ currency_code: z.string().max(8), value: z.string().max(40) });
const Link = z.object({ href: z.string().max(2048), rel: z.string().max(64) });
const CaptureSchema = z.object({
  id: z.string().min(1).max(64),
  status: z.string().max(64),
  amount: Money.optional(),
  final_capture: z.boolean().optional(),
  invoice_id: z.string().max(255).optional(),
  create_time: z.string().max(64).optional(),
  status_details: z.object({ reason: z.string().max(64).optional() }).optional(),
});
const AuthorizationSchema = z.object({
  id: z.string().min(1).max(64),
  status: z.string().max(64),
  amount: Money.optional(),
  custom_id: z.string().max(255).optional(),
  invoice_id: z.string().max(255).optional(),
  create_time: z.string().max(64).optional(),
  expiration_time: z.string().max(64).optional(),
  status_details: z.object({ reason: z.string().max(64).optional() }).optional(),
});
const PurchaseUnit = z.object({
  amount: Money.optional(),
  payee: z.object({ merchant_id: z.string().max(64).optional() }).optional(),
  custom_id: z.string().max(255).optional(),
  invoice_id: z.string().max(255).optional(),
  payments: z
    .object({
      authorizations: z.array(AuthorizationSchema).max(20).optional(),
      captures: z.array(CaptureSchema).max(50).optional(),
    })
    .optional(),
});
const OrderSchema = z.object({
  id: z.string().min(1).max(64),
  status: z.string().max(64),
  intent: z.string().max(32).optional(),
  purchase_units: z.array(PurchaseUnit).max(20).optional(),
  links: z.array(Link).max(20).optional(),
});

/** The buyer-approval link is only handed on if it is https on a paypal.com host. */
export function safeApproveUrl(
  links: readonly { href: string; rel: string }[] | undefined,
): string | null {
  for (const link of links ?? []) {
    if (link.rel !== "approve" && link.rel !== "payer-action") continue;
    try {
      const url = new URL(link.href);
      if (
        url.protocol === "https:" &&
        (url.hostname === "paypal.com" || url.hostname.endsWith(".paypal.com"))
      ) {
        return url.toString();
      }
    } catch {
      // not a URL: skip it
    }
  }
  return null;
}

function parseOrder(response: PayPalResponse): ObservedOrder {
  const parsed = OrderSchema.safeParse(response.body);
  if (!parsed.success) {
    throw new ProviderError("MALFORMED", "PayPal's order reply was not in the expected shape.", {
      httpStatus: response.status,
      debugId: response.debugId,
    });
  }
  const o = parsed.data;
  const units = o.purchase_units ?? [];
  const unit = units.length === 1 ? units[0] : undefined;
  const authorizations: ObservedAuthorization[] = units.flatMap((u) =>
    (u.payments?.authorizations ?? []).map((a) => ({
      id: a.id,
      status: a.status,
      amount: observedMoney(a.amount),
      customId: a.custom_id ?? null,
      invoiceId: a.invoice_id ?? null,
      createTime: a.create_time ?? null,
      expirationTime: a.expiration_time ?? null,
      statusReason: a.status_details?.reason ?? null,
    })),
  );
  return {
    id: o.id,
    status: o.status,
    intent: o.intent ?? null,
    purchaseUnitCount: units.length,
    amount: observedMoney(unit?.amount),
    payeeMerchantId: unit?.payee?.merchant_id ?? null,
    customId: unit?.custom_id ?? null,
    invoiceId: unit?.invoice_id ?? null,
    approveUrl: safeApproveUrl(o.links),
    authorizations,
    captures: units.flatMap((u) =>
      (u.payments?.captures ?? []).map((c) => ({
        id: c.id,
        status: c.status,
        amount: observedMoney(c.amount),
        finalCapture: c.final_capture ?? null,
        invoiceId: c.invoice_id ?? null,
        createTime: c.create_time ?? null,
        statusReason: c.status_details?.reason ?? null,
      })),
    ),
  };
}

function assertAuthorizationId(id: string): void {
  if (!AUTHORIZATION_ID.test(id)) {
    throw new ProviderError(
      "MALFORMED",
      "The PayPal authorization id is not in the expected format.",
    );
  }
}

function assertOrderId(orderId: string): void {
  if (!ORDER_ID.test(orderId)) {
    throw new ProviderError("MALFORMED", "The PayPal order id is not in the expected format.");
  }
}

export function createPayPalProvider(options: PayPalProviderOptions): PaymentProvider {
  const client = createPayPalClient(options);
  const style: ExperienceContextStyle = options.experienceContext ?? "payment_source";

  return {
    name: "paypal-sandbox",

    async createOrder(req: CreateOrderRequest): Promise<CreatedOrder> {
      if (!(req.currency in SUPPORTED_CURRENCIES)) {
        throw new ProviderError("MALFORMED", "The currency is not supported by this build.");
      }
      const value = formatMinor(req.amountMinor, req.currency as SupportedCurrency);
      const buyerExperience = { return_url: req.returnUrl, cancel_url: req.cancelUrl };
      const response = await client.send({
        method: "POST",
        path: "/v2/checkout/orders",
        headers: { "paypal-request-id": req.requestId, prefer: "return=representation" },
        json: {
          intent: "AUTHORIZE",
          purchase_units: [
            {
              amount: { currency_code: req.currency, value },
              custom_id: req.customId,
              invoice_id: req.invoiceId,
              description: req.description,
            },
          ],
          ...(style === "payment_source"
            ? {
                payment_source: {
                  paypal: {
                    experience_context: {
                      ...buyerExperience,
                      brand_name: "PactPay Arena (sandbox)",
                      shipping_preference: "NO_SHIPPING",
                    },
                  },
                },
              }
            : { application_context: { ...buyerExperience, shipping_preference: "NO_SHIPPING" } }),
        },
      });
      if (response.status === 202) {
        throw new ProviderError(
          "ACCEPTED_INCOMPLETE",
          "PayPal accepted the request but has not finished it.",
          {
            httpStatus: 202,
            debugId: response.debugId,
          },
        );
      }
      const parsed = OrderSchema.safeParse(response.body);
      if (!parsed.success || !ORDER_ID.test(parsed.data.id)) {
        throw new ProviderError(
          "MALFORMED",
          "PayPal's create-order reply was not in the expected shape.",
          {
            httpStatus: response.status,
            debugId: response.debugId,
          },
        );
      }
      return {
        orderId: parsed.data.id,
        status: parsed.data.status,
        approveUrl: safeApproveUrl(parsed.data.links),
        httpStatus: response.status,
        debugId: response.debugId,
      };
    },

    async getOrder(orderId: string): Promise<ObservedOrder> {
      assertOrderId(orderId);
      const response = await client.send({
        method: "GET",
        path: `/v2/checkout/orders/${orderId}`,
      });
      const order = parseOrder(response);
      if (order.id !== orderId) {
        throw new ProviderError(
          "MALFORMED",
          "PayPal returned a different order than the one asked for.",
          {
            httpStatus: response.status,
            debugId: response.debugId,
          },
        );
      }
      return order;
    },

    async authorizeOrder(orderId: string, requestId: string): Promise<ProviderCall> {
      assertOrderId(orderId);
      const response = await client.send({
        method: "POST",
        path: `/v2/checkout/orders/${orderId}/authorize`,
        headers: { "paypal-request-id": requestId },
        // The live sandbox answers HTTP 415 to a POST with no body and no content type (observed 2026-11-08).
        json: {},
      });
      // 200 (idempotent replay) and 201 are success. 202 (accepted, not finished) and 207 (mixed results, only for
      // multi-unit orders) are not: the outcome is unknown until a read says otherwise.
      if (response.status !== 200 && response.status !== 201) {
        throw new ProviderError("ACCEPTED_INCOMPLETE", "PayPal did not finish the authorization.", {
          httpStatus: response.status,
          debugId: response.debugId,
        });
      }
      return { httpStatus: response.status, debugId: response.debugId };
    },

    async captureAuthorization(req: CaptureRequest): Promise<ProviderCall> {
      assertAuthorizationId(req.authorizationId);
      if (!(req.currency in SUPPORTED_CURRENCIES)) {
        throw new ProviderError("MALFORMED", "The currency is not supported by this build.");
      }
      const response = await client.send({
        method: "POST",
        path: `/v2/payments/authorizations/${req.authorizationId}/capture`,
        headers: { "paypal-request-id": req.requestId },
        // The whole agreed amount, as the final capture. No invoice_id: the order already carries ours, and a repeated
        // invoice id is a documented way for PayPal to refuse a request (DUPLICATE_INVOICE_ID).
        json: {
          amount: {
            currency_code: req.currency,
            value: formatMinor(req.amountMinor, req.currency as SupportedCurrency),
          },
          final_capture: true,
        },
      });
      // 201 (200 on an idempotent replay) is the documented success. Anything else 2xx is not finished.
      if (response.status !== 200 && response.status !== 201) {
        throw new ProviderError("ACCEPTED_INCOMPLETE", "PayPal did not finish the capture.", {
          httpStatus: response.status,
          debugId: response.debugId,
        });
      }
      return { httpStatus: response.status, debugId: response.debugId };
    },

    async voidAuthorization(authorizationId: string, requestId: string): Promise<ProviderCall> {
      assertAuthorizationId(authorizationId);
      const response = await client.send({
        method: "POST",
        path: `/v2/payments/authorizations/${authorizationId}/void`,
        headers: { "paypal-request-id": requestId },
        json: {}, // same reason as authorize; not yet exercised against the live sandbox
      });
      // 204 (no content) is the documented success; 200 only with a representation. Anything else 2xx is not finished.
      if (response.status !== 204 && response.status !== 200) {
        throw new ProviderError("ACCEPTED_INCOMPLETE", "PayPal did not finish the void.", {
          httpStatus: response.status,
          debugId: response.debugId,
        });
      }
      return { httpStatus: response.status, debugId: response.debugId };
    },
  };
}
