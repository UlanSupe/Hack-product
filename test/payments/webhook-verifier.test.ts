import { describe, expect, it } from "vitest";

import { PAYPAL_SANDBOX_ORIGIN, type PayPalFetch } from "@/adapters/paypal/client";
import { createPayPalWebhookVerifier } from "@/adapters/paypal/webhook-verifier";
import { ProviderError } from "@/ports/payment-provider";

const CLIENT_ID = "AfakeSandboxClientId0123456789abcdef";
const SECRET = "EfakeSandboxClientSecret0123456789abcdef";
const TOKEN = "A21AAFakeAccessToken0123456789abcdefghijklmnop";

type Sent = {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string | undefined;
};

function stub(verify: { status: number; body: unknown } | Error) {
  const sent: Sent[] = [];
  const fetch: PayPalFetch = (url, init) => {
    sent.push({ url, method: init.method, headers: init.headers, body: init.body });
    if (url.endsWith("/v1/oauth2/token"))
      return Promise.resolve({
        status: 200,
        headers: { get: () => null },
        text: () =>
          Promise.resolve(
            JSON.stringify({
              access_token: TOKEN,
              token_type: "Bearer",
              expires_in: 32000,
              scope: "x",
            }),
          ),
      });
    if (verify instanceof Error) return Promise.reject(verify);
    return Promise.resolve({
      status: verify.status,
      headers: { get: () => null },
      text: () =>
        Promise.resolve(
          typeof verify.body === "string" ? verify.body : JSON.stringify(verify.body),
        ),
    });
  };
  const verifier = createPayPalWebhookVerifier({
    clientId: CLIENT_ID,
    clientSecret: SECRET,
    timeoutMs: 5000,
    fetch,
  });
  return { sent, verifier };
}

const input = (rawBody: string) => ({
  headers: {
    transmissionId: "tr-1",
    transmissionTime: "2026-10-13T10:00:00Z",
    certUrl: "https://api.sandbox.paypal.com/v1/notifications/certs/C1",
    transmissionSig: "c2ln",
    authAlgo: "SHA256withRSA",
  },
  webhookId: "WH-1",
  rawBody,
});

describe("the PayPal webhook verifier (postback)", () => {
  it("posts the documented envelope to the verification endpoint and splices the event in byte for byte", async () => {
    const { sent, verifier } = stub({ status: 200, body: { verification_status: "SUCCESS" } });
    const raw =
      '{ "id" : "E1",\n"event_type":"X","emoji":"\\ud83d\\ude00","n":1.50,"webhook_id":"ATTACKER" }';
    expect(await verifier.verify(input(raw))).toBe("VERIFIED");
    const call = sent[1] as Sent;
    expect([call.method, call.url]).toEqual([
      "POST",
      `${PAYPAL_SANDBOX_ORIGIN}/v1/notifications/verify-webhook-signature`,
    ]);
    expect(call.headers.authorization).toBe(`Bearer ${TOKEN}`);
    expect(call.body).toBe(
      `{"auth_algo":"SHA256withRSA","cert_url":"https://api.sandbox.paypal.com/v1/notifications/certs/C1","transmission_id":"tr-1","transmission_sig":"c2ln","transmission_time":"2026-10-13T10:00:00Z","webhook_id":"WH-1","webhook_event":${raw}}`,
    );
    // the envelope is valid JSON, and the webhook id is ours, not the message's
    const parsed = JSON.parse(call.body as string) as {
      webhook_id: string;
      webhook_event: { webhook_id: string };
    };
    expect(parsed.webhook_id).toBe("WH-1");
    expect(parsed.webhook_event.webhook_id).toBe("ATTACKER");
  });

  it("FAILURE is a rejection; anything else is an unknown, never a pass", async () => {
    expect(
      await stub({ status: 200, body: { verification_status: "FAILURE" } }).verifier.verify(
        input("{}"),
      ),
    ).toBe("REJECTED");
    for (const body of [{ verification_status: "MAYBE" }, { other: 1 }, "not json", ""]) {
      const e = await stub({ status: 200, body })
        .verifier.verify(input("{}"))
        .catch((x: unknown) => x);
      expect(e).toBeInstanceOf(ProviderError);
      expect((e as ProviderError).outcome).toBe("UNKNOWN");
    }
  });

  it("PayPal errors and network failures are unknowns carrying no provider text or secret", async () => {
    for (const verify of [
      { status: 500, body: { name: "INTERNAL_SERVER_ERROR", message: SECRET } },
      { status: 401, body: { name: "AUTHENTICATION_FAILURE" } },
      { status: 429, body: {} },
      new Error(`socket ${SECRET}`),
    ]) {
      const e = await stub(verify)
        .verifier.verify(input("{}"))
        .catch((x: unknown) => x);
      expect(e).toBeInstanceOf(ProviderError);
      expect((e as ProviderError).outcome).toBe("UNKNOWN");
      expect(JSON.stringify(e)).not.toContain(SECRET);
      expect((e as ProviderError).message).not.toContain(SECRET);
    }
  });

  it.each(["", "not json", "[1]", "null", "7", '"s"', '{"a":1} , "x":2'])(
    "a body that is not exactly one JSON object (%j) is refused before any request is made",
    async (raw) => {
      const { sent, verifier } = stub({ status: 200, body: { verification_status: "SUCCESS" } });
      await expect(verifier.verify(input(raw))).rejects.toBeInstanceOf(ProviderError);
      expect(sent).toHaveLength(0);
    },
  );
});
