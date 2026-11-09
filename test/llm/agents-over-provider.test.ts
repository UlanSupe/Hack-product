import { describe, expect, it, vi } from "vitest";

import { createAnthropicTransport } from "@/adapters/llm/anthropic";
import { createBuyerAgent, createSellerAgent } from "@/agents";
import { createMockBuyerModel, createMockSellerModel } from "@/agents/mock-models";
import type { RuntimeEvent } from "@/agents/runtime";
import { DEMO_SELLER_CONFIG } from "@/agents";

import { FAST, REQUEST, compareInput, manualClock, view } from "../agents/helpers";
import {
  KEY,
  MODEL,
  fetchDelegatingTo,
  fetchStub,
  messageWith,
  providerError,
  response,
} from "./helpers";

/**
 * The real provider adapter under the real agents, with the network replaced by a scripted fetch. The agents
 * are the same ones the mocks run under, so everything below is the same validation, bounds and fallbacks.
 */

const offers = () => [view("offer-1")];

/** A reply the validators accept: whatever the deterministic buyer says for these offers. */
async function goodBuyerReply(): Promise<string> {
  const reply = await createMockBuyerModel().complete(
    {
      agent: "buyer",
      task: "COMPARE",
      system: "",
      prompt: JSON.stringify({ protocol: "x", task: "COMPARE", input: compareInput(offers()) }),
      attempt: 1,
      corrective: null,
      maxOutputChars: 8000,
    },
    { signal: new AbortController().signal },
  );
  if (reply.kind !== "text") throw new Error("the mock did not answer");
  return reply.text;
}
const buyerOver = (
  fetch: ReturnType<typeof fetchStub>,
  clock = manualClock(),
  onEvent?: (e: RuntimeEvent) => void,
) =>
  createBuyerAgent({
    model: createAnthropicTransport({ apiKey: KEY, model: MODEL, fetch }),
    runtime: { ...FAST, timeoutMs: 1000 },
    clock,
    ...(onEvent ? { onEvent } : {}),
  });

describe("a good provider reply goes through the same validation as a mock reply", () => {
  it("buyer compare: identical outcome to the mock buyer for the same offers", async () => {
    const input = compareInput(offers());
    const viaProvider = await buyerOver(fetchDelegatingTo(() => createMockBuyerModel())).compare(
      input,
    );
    const viaMock = await createBuyerAgent({
      model: createMockBuyerModel(),
      runtime: FAST,
    }).compare(input);
    expect(viaProvider.ok).toBe(true);
    expect(viaProvider.output).toEqual(viaMock.output);
  });

  it("seller open: identical outcome to the mock seller", async () => {
    const config = DEMO_SELLER_CONFIG;
    const input = { task: "OPEN" as const, request: REQUEST, round: 1, maxRounds: 3 };
    const provider = createSellerAgent({
      model: createAnthropicTransport({
        apiKey: KEY,
        model: MODEL,
        fetch: fetchDelegatingTo(() => createMockSellerModel(config)),
      }),
      config,
      runtime: FAST,
    });
    const mock = createSellerAgent({ model: createMockSellerModel(config), config, runtime: FAST });
    const a = await provider.open(input);
    const b = await mock.open(input);
    expect(a.ok, JSON.stringify(a)).toBe(b.ok);
    expect(a.output).toEqual(b.output);
  });
});

describe("a provider reply that is not a valid structured answer is not trusted", () => {
  it.each([
    ["prose", "Sure! I recommend offer-1."],
    [
      "json with an extra action",
      '{"kind":"RECOMMEND","offerId":"offer-1","reasons":["ok"],"approvePayment":true}',
    ],
    [
      "a reference to an offer that does not exist",
      '{"kind":"RECOMMEND","offerId":"offer-999","reasons":["cheap"]}',
    ],
    ["fenced json", '```json\n{"kind":"NONE"}\n```'],
  ])(
    "%s: falls back to NONE with a MALFORMED-type failure after one corrective retry",
    async (_n, text) => {
      const fetch = fetchStub(messageWith(text));
      const r = await buyerOver(fetch).compare(compareInput(offers()));
      expect(r.ok).toBe(false);
      expect(r.output.kind).toBe("NONE");
      expect(fetch.calls.length).toBeGreaterThan(1);
      expect(fetch.calls.length).toBeLessThanOrEqual(FAST.maxAttempts);
    },
  );

  it("recovers when the second attempt is valid (corrective retry)", async () => {
    const good = await goodBuyerReply();
    const fetch = fetchStub(messageWith("not json"), messageWith(good));
    const r = await buyerOver(fetch).compare(compareInput(offers()));
    expect(fetch.calls).toHaveLength(2);
    expect(r.ok, JSON.stringify(r)).toBe(true);
  });

  it("a refusal is final: no retry, safe fallback", async () => {
    const fetch = fetchStub(response(200, { stop_reason: "refusal", content: [] }));
    const r = await buyerOver(fetch).compare(compareInput(offers()));
    expect(fetch.calls).toHaveLength(1);
    expect(r.ok ? null : r.failure.kind).toBe("REFUSED");
    expect(r.output.kind).toBe("NONE");
  });

  it("a truncated reply is not parsed as an answer", async () => {
    const fetch = fetchStub(messageWith('{"kind":"RECOMM', "max_tokens"));
    const r = await buyerOver(fetch).compare(compareInput(offers()));
    expect(fetch.calls).toHaveLength(1);
    expect(r.ok ? null : r.failure.kind).toBe("TRANSPORT");
    expect(r.output.kind).toBe("NONE");
  });
});

describe("rate limits and provider errors", () => {
  it("429 with Retry-After: waits at least that long (not less than the backoff), then succeeds", async () => {
    const good = await goodBuyerReply();
    const fetch = fetchStub(
      providerError(429, "rate_limit_error", { "retry-after": "3" }),
      messageWith(good),
    );
    const clock = manualClock();
    const agent = createBuyerAgent({
      model: createAnthropicTransport({ apiKey: KEY, model: MODEL, fetch }),
      runtime: { ...FAST, timeoutMs: 1000, backoffBaseMs: 100, backoffMaxMs: 500 },
      clock,
    });
    await agent.compare(compareInput(offers()));
    expect(fetch.calls).toHaveLength(2);
    expect(clock.slept).toEqual([3000]);
  });

  it("a Retry-After longer than the remaining deadline fails fast instead of sleeping", async () => {
    const fetch = fetchStub(providerError(429, "rate_limit_error", { "retry-after": "500" }));
    const clock = manualClock();
    const agent = createBuyerAgent({
      model: createAnthropicTransport({ apiKey: KEY, model: MODEL, fetch }),
      runtime: { ...FAST, timeoutMs: 1000, totalDeadlineMs: 5000 },
      clock,
    });
    const r = await agent.compare(compareInput(offers()));
    expect(r.ok).toBe(false);
    expect(fetch.calls).toHaveLength(1);
    expect(clock.slept).toEqual([]);
    expect(r.output.kind).toBe("NONE");
  });

  it("persistent 429 exhausts the bounded attempts and reports a TRANSPORT failure with the request id", async () => {
    const fetch = fetchStub(providerError(429, "rate_limit_error"));
    const r = await buyerOver(fetch).compare(compareInput(offers()));
    expect(fetch.calls).toHaveLength(FAST.maxAttempts);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.failure).toMatchObject({
      kind: "TRANSPORT",
      attempts: FAST.maxAttempts,
      reference: "req_hdr_0001",
    });
    expect(r.output.kind).toBe("NONE");
  });

  it.each([
    [401, "authentication_error"],
    [402, "billing_error"],
    [403, "permission_error"],
    [400, "invalid_request_error"],
    [404, "not_found_error"],
  ])("HTTP %i is not retried", async (status, type) => {
    const fetch = fetchStub(providerError(status, type));
    const r = await buyerOver(fetch).compare(compareInput(offers()));
    expect(fetch.calls).toHaveLength(1);
    expect(r.ok ? null : r.failure.kind).toBe("TRANSPORT");
  });

  it.each([500, 504, 529])("HTTP %i is retried, then recovers", async (status) => {
    const fetch = fetchStub(
      providerError(status, "api_error"),
      messageWith(await goodBuyerReply()),
    );
    const r = await buyerOver(fetch).compare(compareInput(offers()));
    expect(fetch.calls).toHaveLength(2);
    expect(r.ok, JSON.stringify(r)).toBe(true);
  });

  it("a network error is retried within the bound", async () => {
    const fetch = fetchStub(new Error("ECONNRESET"));
    const r = await buyerOver(fetch).compare(compareInput(offers()));
    expect(fetch.calls).toHaveLength(FAST.maxAttempts);
    expect(r.ok).toBe(false);
  });
});

describe("timeouts", () => {
  it("a request that never answers is aborted at the per-attempt timeout (real timers)", async () => {
    const fetch = fetchStub("hang-until-abort");
    const agent = createBuyerAgent({
      model: createAnthropicTransport({ apiKey: KEY, model: MODEL, fetch }),
      runtime: { ...FAST, timeoutMs: 100, maxAttempts: 2 },
    });
    const started = Date.now();
    const r = await agent.compare(compareInput(offers()));
    expect(Date.now() - started).toBeLessThan(2000);
    expect(fetch.calls).toHaveLength(2);
    expect(r.ok ? null : r.failure.kind).toBe("TIMEOUT");
    expect(r.output.kind).toBe("NONE");
  });
});

describe("no secrets in anything the agents report or emit", () => {
  it("failure objects, events and console output never contain the key or provider text", async () => {
    const events: RuntimeEvent[] = [];
    const spies = (["log", "info", "warn", "error", "debug"] as const).map((m) =>
      vi.spyOn(console, m).mockImplementation(() => {}),
    );
    try {
      const results = [
        await buyerOver(fetchStub(providerError(401, "authentication_error")), manualClock(), (e) =>
          events.push(e),
        ).compare(compareInput(offers())),
        await buyerOver(fetchStub(providerError(429, "rate_limit_error")), manualClock(), (e) =>
          events.push(e),
        ).compare(compareInput(offers())),
        await buyerOver(fetchStub(new Error(`boom ${KEY}`)), manualClock(), (e) =>
          events.push(e),
        ).compare(compareInput(offers())),
        await buyerOver(fetchStub(messageWith(`leak ${KEY}`)), manualClock(), (e) =>
          events.push(e),
        ).compare(compareInput(offers())),
      ];
      const text = JSON.stringify([results, events]);
      expect(text).not.toContain(KEY);
      expect(text).not.toContain("secret detail");
      for (const s of spies) expect(s).not.toHaveBeenCalled();
    } finally {
      for (const s of spies) s.mockRestore();
    }
  });
});
