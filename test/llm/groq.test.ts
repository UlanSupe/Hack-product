import { describe, expect, it, vi } from "vitest";

import { createGroqTransport } from "@/adapters/llm/groq";
import { createLlmTransport } from "@/adapters/llm/select";
import { parseEnv } from "@/config/env.schema";
import { TransportError, type ModelRequest } from "@/ports/model-transport";

import { KEY, fetchStub, response } from "./helpers";

const MODEL = "openai/gpt-oss-120b";
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
const completion = (content: unknown, finish_reason = "stop") =>
  response(
    200,
    { choices: [{ index: 0, finish_reason, message: { role: "assistant", content } }] },
    { "x-request-id": "req_groq_0001" },
  );
const transport = (fetch: ReturnType<typeof fetchStub>) =>
  createGroqTransport({ apiKey: KEY, model: MODEL, fetch });

async function failure(fetch: ReturnType<typeof fetchStub>): Promise<TransportError> {
  try {
    await transport(fetch).complete(REQUEST, ctx());
  } catch (e) {
    expect(e).toBeInstanceOf(TransportError);
    return e as TransportError;
  }
  throw new Error("expected a TransportError");
}

describe("the Groq provider: what leaves the server", () => {
  it("sends the documented request to the pinned host, with the key only in the Authorization header", async () => {
    const fetch = fetchStub(completion('{"ok":true}'));
    await transport(fetch).complete(REQUEST, ctx());
    const [call] = fetch.calls;
    expect(call?.url).toBe("https://api.groq.com/openai/v1/chat/completions");
    expect(call?.headers).toEqual({
      "content-type": "application/json",
      authorization: `Bearer ${KEY}`,
    });
    expect(call?.body).toEqual({
      model: MODEL,
      max_tokens: 8192,
      messages: [
        { role: "system", content: "SYSTEM TEXT" },
        { role: "user", content: REQUEST.prompt },
      ],
    });
    expect(JSON.stringify(call?.body)).not.toContain(KEY);
  });

  it("offers no tools, streaming or other options: the model can only return text", async () => {
    const fetch = fetchStub(completion("{}"));
    await transport(fetch).complete(REQUEST, ctx());
    expect(Object.keys(fetch.calls[0]?.body ?? {}).sort()).toEqual([
      "max_tokens",
      "messages",
      "model",
    ]);
  });

  it("accepts provider-prefixed model ids, and refuses a malformed key or model", () => {
    expect(() => createGroqTransport({ apiKey: KEY, model: "openai/gpt-oss-20b" })).not.toThrow();
    expect(() => createGroqTransport({ apiKey: "short", model: MODEL })).toThrow(/key/);
    expect(() => createGroqTransport({ apiKey: KEY, model: "bad model" })).toThrow(/model/);
    expect(() => createGroqTransport({ apiKey: KEY, model: "../x" })).toThrow(/model/);
  });
});

describe("the Groq provider: replies", () => {
  it("returns the message text", async () => {
    const reply = await transport(fetchStub(completion('{"a":1}'))).complete(REQUEST, ctx());
    expect(reply).toEqual({ kind: "text", text: '{"a":1}' });
  });

  it("a reply without text content is empty text for the validators to reject, never an exception or a guess", async () => {
    expect(await transport(fetchStub(completion(null))).complete(REQUEST, ctx())).toEqual({
      kind: "text",
      text: "",
    });
  });

  it("content_filter is a refusal without any text; a length stop is TRUNCATED, never half a document", async () => {
    expect(
      await transport(fetchStub(completion("secret", "content_filter"))).complete(REQUEST, ctx()),
    ).toEqual({ kind: "refusal" });
    const e = await failure(fetchStub(completion('{"half":', "length")));
    expect(e.kind).toBe("TRUNCATED");
  });

  it("a reply of the wrong shape is UNAVAILABLE", async () => {
    expect((await failure(fetchStub(response(200, { nope: 1 })))).kind).toBe("UNAVAILABLE");
    expect((await failure(fetchStub(response(200, { choices: [] })))).kind).toBe("UNAVAILABLE");
    expect((await failure(fetchStub(response(200, "not json")))).kind).toBe("UNAVAILABLE");
  });
});

describe("the Groq provider: errors never copy provider text", () => {
  it.each([
    [400, "BAD_REQUEST"],
    [401, "UNAUTHORIZED"],
    [429, "RATE_LIMITED"],
    [503, "UNAVAILABLE"],
  ] as const)("HTTP %i is %s and carries only a status and a request id", async (status, kind) => {
    const e = await failure(
      fetchStub(
        response(
          status,
          { error: { message: `secret ${KEY}` } },
          { "x-request-id": "req_groq_0002", "retry-after": "2" },
        ),
      ),
    );
    expect(e.kind).toBe(kind);
    expect(`${e.message} ${JSON.stringify(e)}`).not.toContain(KEY);
    expect(e.message).not.toContain("secret");
  });

  it("writes nothing to the console", async () => {
    const spies = (["log", "info", "warn", "error", "debug"] as const).map((m) =>
      vi.spyOn(console, m).mockImplementation(() => undefined),
    );
    await transport(fetchStub(completion("{}"))).complete(REQUEST, ctx());
    await failure(fetchStub(response(500, {})));
    for (const s of spies) expect(s).not.toHaveBeenCalled();
    for (const s of spies) s.mockRestore();
  });
});

describe("provider selection", () => {
  it("createLlmTransport picks the provider by name", () => {
    expect(createLlmTransport({ provider: "groq", apiKey: KEY, model: MODEL }).name).toBe(
      `groq:${MODEL}`,
    );
    expect(createLlmTransport({ provider: "anthropic", apiKey: KEY, model: "m-1" }).name).toBe(
      "anthropic:m-1",
    );
  });

  it("llm mode with AGENT_PROVIDER=groq needs GROQ_API_KEY, not ANTHROPIC_API_KEY", () => {
    const issues = (e: Record<string, string>) => {
      const r = parseEnv({ NODE_ENV: "test", ...e });
      return r.ok ? [] : r.issues.map((i) => i.path);
    };
    const base = { AGENT_MODE: "llm", AGENT_PROVIDER: "groq", AGENT_MODEL: MODEL };
    expect(issues(base)).toEqual(["GROQ_API_KEY"]);
    expect(issues({ ...base, ANTHROPIC_API_KEY: KEY })).toEqual(["GROQ_API_KEY"]);
    expect(issues({ ...base, GROQ_API_KEY: KEY })).toEqual([]);
    expect(issues({ ...base, AGENT_PROVIDER: "other", GROQ_API_KEY: KEY })).toContain(
      "AGENT_PROVIDER",
    );
  });
});
