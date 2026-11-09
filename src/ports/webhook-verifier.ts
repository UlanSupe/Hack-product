/**
 * Decides whether a webhook delivery really came from PayPal, using PayPal's own verification service. The caller
 * passes the headers and the body EXACTLY as received. The webhook id is the one in our configuration, never one taken
 * from the message. A result of "VERIFIED" is the only thing that lets an event be stored or acted on.
 *
 * `verify` resolves "REJECTED" when PayPal answered that the signature does not verify, and THROWS a `ProviderError`
 * when it could not find out (network, 5xx, bad credentials): an unknown is never a pass and never a rejection.
 */

export type WebhookHeaders = {
  transmissionId: string;
  transmissionTime: string;
  certUrl: string;
  transmissionSig: string;
  authAlgo: string;
};

export interface WebhookVerifier {
  verify(input: {
    headers: WebhookHeaders;
    webhookId: string;
    /** The request body, byte for byte as it arrived. */
    rawBody: string;
  }): Promise<"VERIFIED" | "REJECTED">;
}
