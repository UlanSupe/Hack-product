import { z } from "zod";

import { AGENT_RUNTIME_LIMITS } from "../../domain/agent-contract.ts";
import {
  TransportError,
  type ModelReply,
  type ModelRequest,
  type ModelTransport,
} from "../../ports/model-transport.ts";

/**
 * The one real model provider: Anthropic's Messages API, behind the same `ModelTransport` the deterministic
 * mocks implement. Everything the agents do with a reply (strict JSON, strict schemas, reference checks, bounded
 * retries, safe fallbacks) happens in the agent layer exactly as it does for the mocks; this file only moves one
 * prompt out and one reply back.
 *
 * Contract used (Anthropic API reference, platform.claude.com/docs/en/api): POST https://api.anthropic.com/v1/messages
 * with headers `x-api-key`, `anthropic-version` and `content-type`, and a body of `model`, `max_tokens`, optional
 * top-level `system`, and `messages`. A reply has `content` blocks (we read only `text` blocks) and a `stop_reason`;
 * `"refusal"` comes back as a normal HTTP 200. Errors are `{ type: "error", error: { type, message }, request_id }`.
 * NOT VERIFIED AGAINST A LIVE ACCOUNT: see docs/AGENTS.md section 9.
 *
 * Safety properties (each has a test):
 *  - the key travels only in the `x-api-key` header, to ONE hard-coded host; there is no setting that redirects it;
 *  - NO tools, tool choice, thinking settings, streaming or other options are sent: the model can only return text,
 *    and anything that is not a `text` block (thinking, tool_use...) is ignored, never executed;
 *  - nothing is logged, and no error text, response body, header or key is ever copied into a thrown error: failures
 *    carry only an HTTP status, a kind, a Retry-After number and a short request-id token;
 *  - the request and response sizes are bounded.
 */

export const ANTHROPIC_API_ORIGIN = "https://api.anthropic.com";
export const ANTHROPIC_VERSION = "2023-06-01";

export const MAX_RESPONSE_CHARS = 2_000_000;
const MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,99}$/; // "/" for provider-prefixed ids such as openai/gpt-oss-120b
/** An API key is a single printable token; anything with whitespace or control characters could split a header. */
const KEY_SHAPE = /^[\x21-\x7e]{16,512}$/;
/** The provider's request ids look like `req_011C...`; accept only a conservative token shape. */
const REFERENCE = /^[A-Za-z0-9_-]{6,80}$/;

export type FetchLike = (
  url: string,
  init: { method: string; headers: Record<string, string>; body: string; signal: AbortSignal },
) => Promise<{
  status: number;
  headers: { get(name: string): string | null };
  text(): Promise<string>;
}>;

export type AnthropicOptions = {
  apiKey: string;
  /** The model id, chosen by the operator. Never defaulted: the right id depends on the account. */
  model: string;
  maxOutputTokens?: number;
  /** For tests. Defaults to the global `fetch`, looked up at call time. */
  fetch?: FetchLike;
};

const ReplySchema = z.object({
  stop_reason: z.string().nullable().optional(),
  content: z.array(z.object({ type: z.string(), text: z.unknown().optional() })).max(200),
});

/** Throws a plain Error (without echoing the value) if the configuration cannot be used safely. */
export function assertUsableConfig(apiKey: unknown, model: unknown): void {
  if (typeof apiKey !== "string" || !KEY_SHAPE.test(apiKey) || apiKey.startsWith("replace-with-")) {
    throw new Error("The provider API key is missing or malformed.");
  }
  if (typeof model !== "string" || !MODEL_ID.test(model)) {
    throw new Error("The model id is missing or malformed.");
  }
}

export function kindFor(status: number): TransportError["kind"] {
  if (status === 429) return "RATE_LIMITED";
  if (status === 401 || status === 403) return "UNAUTHORIZED";
  if (status === 402) return "BILLING";
  if (status >= 500) return "UNAVAILABLE"; // 500 api_error, 504 timeout_error, 529 overloaded_error ...
  return "BAD_REQUEST"; // 400, 404, 409, 413 and any other 4xx: the request itself is the problem
}

/** `Retry-After: <seconds>` only; an HTTP-date or anything odd is ignored. Capped so one header cannot stall us. */
export function retryAfterMs(value: string | null): number | undefined {
  if (value === null || !/^[0-9]{1,6}$/.test(value.trim())) return undefined;
  return Math.min(Number(value.trim()) * 1000, AGENT_RUNTIME_LIMITS.totalDeadlineMs.max);
}

export const referenceOf = (value: string | null): string | undefined =>
  value !== null && REFERENCE.test(value) ? value : undefined;

export function createAnthropicTransport(options: AnthropicOptions): ModelTransport {
  assertUsableConfig(options.apiKey, options.model);
  const { apiKey, model } = options;
  const limits = AGENT_RUNTIME_LIMITS.maxOutputTokens;
  const maxTokens = Math.min(
    limits.max,
    Math.max(limits.min, Math.trunc(options.maxOutputTokens ?? limits.default)),
  );
  const doFetch: FetchLike = options.fetch ?? ((url, init) => globalThis.fetch(url, init));

  return {
    name: `anthropic:${model}`,

    async complete(request: ModelRequest, { signal }): Promise<ModelReply> {
      let response: Awaited<ReturnType<FetchLike>>;
      try {
        response = await doFetch(`${ANTHROPIC_API_ORIGIN}/v1/messages`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-api-key": apiKey,
            "anthropic-version": ANTHROPIC_VERSION,
          },
          // No `tools`, `tool_choice`, `thinking`, `stream` or `metadata`: text in, text out.
          body: JSON.stringify({
            model,
            max_tokens: maxTokens,
            system: request.system,
            messages: [{ role: "user", content: request.prompt }],
          }),
          signal,
        });
      } catch {
        // Whatever the network library said (it may contain URLs or headers) is deliberately dropped.
        throw new TransportError("NETWORK", "The request to the model provider failed.");
      }

      const reference = referenceOf(response.headers.get("request-id"));
      const details = {
        status: response.status,
        ...(reference === undefined ? {} : { reference }),
      };

      if (response.status < 200 || response.status >= 300) {
        const wait =
          response.status === 429 ? retryAfterMs(response.headers.get("retry-after")) : undefined;
        throw new TransportError(
          kindFor(response.status),
          `The provider answered HTTP ${response.status}.`,
          {
            ...details,
            ...(wait === undefined ? {} : { retryAfterMs: wait }),
          },
        );
      }

      let raw: string;
      try {
        raw = await response.text();
      } catch {
        throw new TransportError(
          "NETWORK",
          "The reply from the model provider could not be read.",
          details,
        );
      }
      if (raw.length > MAX_RESPONSE_CHARS) {
        throw new TransportError("UNAVAILABLE", "The provider's reply was too large.", details);
      }

      let parsed: z.infer<typeof ReplySchema>;
      try {
        const result = ReplySchema.safeParse(JSON.parse(raw));
        if (!result.success) throw new Error("shape");
        parsed = result.data;
      } catch {
        throw new TransportError(
          "UNAVAILABLE",
          "The provider's reply was not in the expected shape.",
          details,
        );
      }

      // A refusal is a normal 200 with this stop reason. Its category and any text are not copied anywhere.
      if (parsed.stop_reason === "refusal") return { kind: "refusal" };
      // Cut off: never hand half a JSON document to the validators as if it were an answer.
      if (
        parsed.stop_reason === "max_tokens" ||
        parsed.stop_reason === "model_context_window_exceeded"
      ) {
        throw new TransportError("TRUNCATED", "The provider's reply was cut off.", details);
      }

      // Only `text` blocks. Thinking blocks are ignored, and a tool_use block (we offer no tools, so it should not
      // exist) is ignored too: nothing the provider returns is ever executed.
      const text = parsed.content
        .flatMap((block) =>
          block.type === "text" && typeof block.text === "string" ? [block.text] : [],
        )
        .join("");
      return { kind: "text", text };
    },
  };
}
