import { z } from "zod";

import { AGENT_RUNTIME_LIMITS } from "../../domain/agent-contract.ts";
import {
  TransportError,
  type ModelReply,
  type ModelRequest,
  type ModelTransport,
} from "../../ports/model-transport.ts";
import {
  MAX_RESPONSE_CHARS,
  assertUsableConfig,
  kindFor,
  referenceOf,
  retryAfterMs,
  type FetchLike,
} from "./anthropic.ts";

/**
 * Groq's OpenAI-compatible Chat Completions API behind the same `ModelTransport` as the Anthropic provider.
 * POST https://api.groq.com/openai/v1/chat/completions with `Authorization: Bearer <key>`, a body of `model`,
 * `max_tokens` and `messages` (a system and a user message), and a reply of `choices[0].message.content` with a
 * `finish_reason`. Groq offers a free tier, which is why it exists next to the Anthropic provider.
 *
 * Same safety properties as the Anthropic provider (each is tested): the key goes to ONE hard-coded host and only in
 * the Authorization header; no tools, streaming or other options are sent, so the model can only return text; nothing
 * is logged and no response text, header or key is copied into an error; request and response sizes are bounded; a cut
 * off reply is an error, never half a JSON document.
 */
export const GROQ_API_ORIGIN = "https://api.groq.com";

const ReplySchema = z.object({
  choices: z
    .array(
      z.object({
        finish_reason: z.string().nullable().optional(),
        message: z.object({ content: z.unknown().optional() }).optional(),
      }),
    )
    .max(20),
});

export type GroqOptions = {
  apiKey: string;
  /** The model id, chosen by the operator (for example a Llama model from Groq's list). Never defaulted. */
  model: string;
  maxOutputTokens?: number;
  fetch?: FetchLike;
};

export function createGroqTransport(options: GroqOptions): ModelTransport {
  assertUsableConfig(options.apiKey, options.model);
  const { apiKey, model } = options;
  const limits = AGENT_RUNTIME_LIMITS.maxOutputTokens;
  const maxTokens = Math.min(
    limits.max,
    Math.max(limits.min, Math.trunc(options.maxOutputTokens ?? limits.default)),
  );
  const doFetch: FetchLike = options.fetch ?? ((url, init) => globalThis.fetch(url, init));

  return {
    name: `groq:${model}`,

    async complete(request: ModelRequest, { signal }): Promise<ModelReply> {
      let response: Awaited<ReturnType<FetchLike>>;
      try {
        response = await doFetch(`${GROQ_API_ORIGIN}/openai/v1/chat/completions`, {
          method: "POST",
          headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
          body: JSON.stringify({
            model,
            max_tokens: maxTokens,
            messages: [
              { role: "system", content: request.system },
              { role: "user", content: request.prompt },
            ],
          }),
          signal,
        });
      } catch {
        throw new TransportError("NETWORK", "The request to the model provider failed.");
      }

      const reference = referenceOf(response.headers.get("x-request-id"));
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
          { ...details, ...(wait === undefined ? {} : { retryAfterMs: wait }) },
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

      let choice: z.infer<typeof ReplySchema>["choices"][number];
      try {
        const result = ReplySchema.safeParse(JSON.parse(raw));
        const first = result.success ? result.data.choices[0] : undefined;
        if (first === undefined) throw new Error("shape");
        choice = first;
      } catch {
        throw new TransportError(
          "UNAVAILABLE",
          "The provider's reply was not in the expected shape.",
          details,
        );
      }

      if (choice.finish_reason === "content_filter") return { kind: "refusal" };
      if (choice.finish_reason === "length")
        throw new TransportError("TRUNCATED", "The provider's reply was cut off.", details);

      const text = choice.message?.content;
      return { kind: "text", text: typeof text === "string" ? text : "" };
    },
  };
}
