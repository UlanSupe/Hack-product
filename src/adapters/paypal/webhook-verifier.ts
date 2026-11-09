import { z } from "zod";

import { ProviderError } from "../../ports/payment-provider.ts";
import type { WebhookVerifier } from "../../ports/webhook-verifier.ts";
import { createPayPalClient, type PayPalClientOptions } from "./client.ts";

/**
 * Verifies a webhook with PayPal's own service (`POST /v1/notifications/verify-webhook-signature`), the documented
 * "postback" mechanism. Offline verification (CRC32 + certificate download) is not implemented: the allowed certificate
 * hosts are unverified (docs/PAYPAL_INTEGRATION.md section 8, A7), and the postback needs no certificate fetch from us.
 *
 * The event is embedded in the request body exactly as received (the documentation requires that), never parsed and
 * re-serialized. PayPal documents that mock events from the webhook simulator cannot be verified this way, so they are
 * rejected here by design.
 *
 * Nothing is logged. The only values that leave this module are "VERIFIED", "REJECTED" or a ProviderError.
 */

const ResultSchema = z.object({ verification_status: z.string().max(32) });

export function createPayPalWebhookVerifier(options: PayPalClientOptions): WebhookVerifier {
  const client = createPayPalClient(options);
  return {
    async verify({ headers, webhookId, rawBody }) {
      // The event text is spliced in below, so it must be exactly one JSON object (anything else could change the envelope).
      let event: unknown;
      try {
        event = JSON.parse(rawBody);
      } catch {
        event = null;
      }
      if (event === null || typeof event !== "object" || Array.isArray(event)) {
        throw new ProviderError("MALFORMED", "The webhook body is not a JSON object.");
      }
      // The envelope is built from our own validated strings; only the event text is spliced in untouched.
      const envelope = JSON.stringify({
        auth_algo: headers.authAlgo,
        cert_url: headers.certUrl,
        transmission_id: headers.transmissionId,
        transmission_sig: headers.transmissionSig,
        transmission_time: headers.transmissionTime,
        webhook_id: webhookId,
      });
      const response = await client.send({
        method: "POST",
        path: "/v1/notifications/verify-webhook-signature",
        rawJson: `${envelope.slice(0, -1)},"webhook_event":${rawBody}}`,
      });
      const parsed = ResultSchema.safeParse(response.body);
      if (!parsed.success) {
        throw new ProviderError(
          "MALFORMED",
          "PayPal's verification reply was not in the expected shape.",
          {
            httpStatus: response.status,
            debugId: response.debugId,
          },
        );
      }
      if (parsed.data.verification_status === "SUCCESS") return "VERIFIED";
      if (parsed.data.verification_status === "FAILURE") return "REJECTED";
      throw new ProviderError(
        "MALFORMED",
        "PayPal's verification status was not SUCCESS or FAILURE.",
        {
          httpStatus: response.status,
          debugId: response.debugId,
        },
      );
    },
  };
}
