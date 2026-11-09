import type { ModelTransport } from "../../ports/model-transport.ts";
import { createAnthropicTransport, type FetchLike } from "./anthropic.ts";
import { createGroqTransport } from "./groq.ts";

/** The one place that turns the AGENT_PROVIDER setting into a transport. */
export function createLlmTransport(o: {
  provider: "anthropic" | "groq";
  apiKey: string;
  model: string;
  maxOutputTokens?: number;
  fetch?: FetchLike;
}): ModelTransport {
  const { provider, ...rest } = o;
  return provider === "groq" ? createGroqTransport(rest) : createAnthropicTransport(rest);
}
