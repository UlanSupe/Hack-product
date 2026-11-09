import { describe, expect, it, vi } from "vitest";

import {
  ANTHROPIC_VERSION,
  assertUsableConfig,
  createAnthropicTransport,
} from "@/adapters/llm/anthropic";
import { TransportError, type ModelRequest } from "@/ports/model-transport";

import { KEY, MODEL, fetchStub, messageWith, providerError, response } from "./helpers";

const REQUEST: ModelRequest = {
  agent: "buyer",
  task: "COMPARE",
  system: "SYSTEM TEXT",
  prompt: '{"task":"COMPARE","input":{}}',
  attempt: 1,
  corrective: null,
  maxOutputChars: 8000,
};
const ctx = () => ({ signal: new AbortController().signal });

const transport = (fetch: ReturnType<typeof fetchStub>, extra: { maxOutputTokens?: number } = {}) =>
  createAnthropicTransport({ apiKey: KEY, model: MODEL, fetch, ...extra });

async function failure(t: ReturnType<typeof transport>): Promise<TransportError> {
  try {
    await t.complete(REQUEST, ctx());
  } catch (e) {
    expect(e).toBeInstanceOf(TransportError);
    return e as TransportError;
  }
  throw new Error("expected a TransportError");
}

describe("request: what leaves the server", () => {
  it("sends exactly the documented request to the pinned host, with the key only in the x-api-key header", async () => {
    const fetch = fetchStub(messageWith('{"ok":true}'));
    await transport(fetch).complete(REQUEST, ctx());
    const [call] = fetch.calls;
    expect(call?.url).toBe("https://api.anthropic.com/v1/messages");
    expect(call?.headers).toEqual({
      "content-type": "application/json",
      "x-api-key": KEY,
      "anthropic-version": ANTHROPIC_VERSION,
    });
    expect(call?.body).toEqual({
      model: MODEL,
      max_tokens: 8192,
      system: "SYSTEM TEXT",
      messages: [{ role: "user", content: REQUEST.prompt }],
    });
    expect(JSON.stringify(call?.body)).not.toContain(KEY);
  });

  it("offers no tools, tool choice, thinking, streaming or other options", async () => {
    const fetch = fetchStub(messageWith("{}"));
    await transport(fetch).complete(REQUEST, ctx());
    expect(Object.keys(fetch.calls[0]?.body ?? {}).sort()).toEqual([
      "max_tokens",
      "messages",
      "model",
      "system",
    ]);
  });

  it("bounds the output budget into its limits", async () => {
    for (const [given, sent] of [
      [undefined, 8192],
      [10, 1024],
      [1_000_000, 32_000],
      [5000.9, 5000],
    ] as const) {
      const fetch = fetchStub(messageWith("{}"));
      await transport(fetch, given === undefined ? {} : { maxOutputTokens: given }).complete(
        REQUEST,
        ctx(),
      );
      expect(fetch.calls[0]?.body.max_tokens).toBe(sent);
    }
  });

  it("passes the abort signal to fetch", async () => {
    let seen: AbortSignal | undefined;
    const t = createAnthropicTransport({
      apiKey: KEY,
      model: MODEL,
      fetch: (_url, init) => {
        seen = init.signal;
        return Promise.resolve(messageWith("{}"));
      },
    });
    const controller = new AbortController();
    await t.complete(REQUEST, { signal: controller.signal });
    expect(seen).toBe(controller.signal);
  });
});

describe("configuration is checked before any call", () => {
  it.each([
    ["", MODEL],
    ["short", MODEL],
    ["replace-with-your-key-here", MODEL],
    [`${KEY}\nx-evil: 1`, MODEL],
    [`${KEY} with space`, MODEL],
    [KEY, ""],
    [KEY, "bad model"],
    [KEY, "m".repeat(101)],
    [undefined, MODEL],
    [KEY, undefined],
  ])("rejects key=%j model=%j without echoing them", (key, model) => {
    let message = "";
    try {
      assertUsableConfig(key, model);
    } catch (e) {
      message = (e as Error).message;
    }
    expect(message).not.toBe("");
    expect(message).not.toContain(KEY);
    expect(() =>
      createAnthropicTransport({ apiKey: key as string, model: model as string }),
    ).toThrow();
  });

  it("accepts a normal key and model id", () => {
    expect(() => assertUsableConfig(KEY, "family-model_1.2:tag")).not.toThrow();
    expect(transport(fetchStub()).name).toBe(`anthropic:${MODEL}`);
  });
});

describe("response handling", () => {
  it("returns the text blocks, joined", async () => {
    const fetch = fetchStub(
      response(200, {
        stop_reason: "end_turn",
        content: [
          { type: "text", text: '{"a":' },
          { type: "text", text: "1}" },
        ],
      }),
    );
    expect(await transport(fetch).complete(REQUEST, ctx())).toEqual({
      kind: "text",
      text: '{"a":1}',
    });
  });

  it("ignores thinking and tool_use blocks: nothing the provider returns is executed", async () => {
    const fetch = fetchStub(
      response(200, {
        stop_reason: "end_turn",
        content: [
          { type: "thinking", thinking: "secret reasoning", signature: "x" },
          { type: "tool_use", id: "t1", name: "run_shell", input: { cmd: "rm -rf /" } },
          { type: "tool_use", id: "t2", name: "x", text: "INJECTED", input: {} },
          { type: "redacted_thinking", text: "INJECTED" },
          { type: "text", text: "{}" },
        ],
      }),
    );
    expect(await transport(fetch).complete(REQUEST, ctx())).toEqual({ kind: "text", text: "{}" });
  });

  it("maps stop_reason refusal (a normal HTTP 200) to a refusal without carrying any text", async () => {
    const fetch = fetchStub(
      response(200, { stop_reason: "refusal", content: [{ type: "text", text: "I won't." }] }),
    );
    expect(await transport(fetch).complete(REQUEST, ctx())).toEqual({ kind: "refusal" });
  });

  it.each(["max_tokens", "model_context_window_exceeded"])(
    "treats stop_reason %s as TRUNCATED, never as a half answer",
    async (stop) => {
      const e = await failure(transport(fetchStub(messageWith('{"half":', stop))));
      expect([e.kind, e.retryable, e.status]).toEqual(["TRUNCATED", false, 200]);
    },
  );

  it.each([
    ["not json", "<html>bad gateway</html>"],
    ["wrong shape", { content: "text" }],
    ["array", []],
    [
      "too many blocks",
      { content: Array.from({ length: 201 }, () => ({ type: "text", text: "x" })) },
    ],
  ])("a 200 with an unusable body (%s) is UNAVAILABLE and echoes nothing", async (_name, body) => {
    const e = await failure(transport(fetchStub(response(200, body))));
    expect(e.kind).toBe("UNAVAILABLE");
    expect(e.message).not.toContain("html");
  });

  it("rejects an oversized body unread", async () => {
    const e = await failure(transport(fetchStub(response(200, "x".repeat(2_000_001)))));
    expect(e.kind).toBe("UNAVAILABLE");
  });

  it("a body that cannot be read is a NETWORK error", async () => {
    const broken = {
      status: 200,
      headers: { get: () => null },
      text: () => Promise.reject(new Error(KEY)),
    };
    const e = await failure(transport(fetchStub(broken)));
    expect(e.kind).toBe("NETWORK");
    expect(e.message).not.toContain(KEY);
  });
});

describe("provider errors are explicit, classified, and never copy provider text", () => {
  it.each([
    [400, "invalid_request_error", "BAD_REQUEST", false],
    [401, "authentication_error", "UNAUTHORIZED", false],
    [402, "billing_error", "BILLING", false],
    [403, "permission_error", "UNAUTHORIZED", false],
    [404, "not_found_error", "BAD_REQUEST", false],
    [409, "conflict_error", "BAD_REQUEST", false],
    [413, "request_too_large", "BAD_REQUEST", false],
    [429, "rate_limit_error", "RATE_LIMITED", true],
    [500, "api_error", "UNAVAILABLE", true],
    [504, "timeout_error", "UNAVAILABLE", true],
    [529, "overloaded_error", "UNAVAILABLE", true],
  ] as const)("HTTP %i (%s) -> %s, retryable=%s", async (status, type, kind, retryable) => {
    const e = await failure(transport(fetchStub(providerError(status, type))));
    expect([e.kind, e.retryable, e.status]).toEqual([kind, retryable, status]);
    expect(e.reference).toBe("req_hdr_0001");
    expect(`${e.message} ${e.name} ${JSON.stringify(e)}`).not.toContain(KEY);
    expect(e.message).not.toContain("secret detail");
  });

  it("honors Retry-After on 429 (seconds), capped, and ignores anything odd", async () => {
    const wait = async (value: string | undefined) =>
      (
        await failure(
          transport(
            fetchStub(
              providerError(429, "rate_limit_error", value ? { "retry-after": value } : {}),
            ),
          ),
        )
      ).retryAfterMs;
    expect(await wait("7")).toBe(7000);
    expect(await wait(" 7 ")).toBe(7000);
    expect(await wait("999999")).toBe(600_000);
    expect(await wait(undefined)).toBeNull(); // spend-limit 429s carry no Retry-After
    for (const odd of ["Wed, 21 Oct 2026 07:28:00 GMT", "-1", "1.5", "abc", "", "1e3"]) {
      expect(await wait(odd), odd).toBeNull();
    }
  });

  it("does not read Retry-After on other statuses", async () => {
    const e = await failure(
      transport(fetchStub(providerError(500, "api_error", { "retry-after": "5" }))),
    );
    expect(e.retryAfterMs).toBeNull();
  });

  it("keeps only a conservative request-id token", async () => {
    for (const [header, expected] of [
      ["req_011CabcDEF", "req_011CabcDEF"],
      ["<script>alert(1)</script>", null],
      ["a b c d e f", null],
      ["x", null],
    ] as const) {
      const e = await failure(
        transport(fetchStub(providerError(500, "api_error", { "request-id": header }))),
      );
      expect(e.reference, header).toBe(expected);
    }
  });

  it("a network failure is NETWORK and drops whatever the library said (it may contain the key)", async () => {
    const e = await failure(
      transport(fetchStub(new Error(`connect ECONNREFUSED with header x-api-key: ${KEY}`))),
    );
    expect([e.kind, e.retryable, e.status]).toEqual(["NETWORK", true, null]);
    expect(`${e.message} ${e.stack ?? ""}`).not.toContain(KEY);
    expect(e.cause).toBeUndefined();
  });
});

describe("nothing is logged", () => {
  it("writes nothing to the console on success or on any failure", async () => {
    const spies = (["log", "info", "warn", "error", "debug"] as const).map((m) =>
      vi.spyOn(console, m).mockImplementation(() => {}),
    );
    const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      for (const step of [
        messageWith("{}"),
        providerError(401, "authentication_error"),
        providerError(429, "rate_limit_error", { "retry-after": "1" }),
        new Error(KEY),
        response(200, "garbage"),
      ]) {
        try {
          await transport(fetchStub(step)).complete(REQUEST, ctx());
        } catch {
          // expected for the failing steps
        }
      }
      for (const s of [...spies, stdout, stderr]) expect(s).not.toHaveBeenCalled();
    } finally {
      for (const s of [...spies, stdout, stderr]) s.mockRestore();
    }
  });
});
