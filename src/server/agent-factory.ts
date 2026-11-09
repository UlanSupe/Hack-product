import "server-only";

import type { FetchLike } from "@/adapters/llm/anthropic";
import { createLlmTransport } from "@/adapters/llm/select";
import type { LiveModel } from "@/application/negotiation-demo";
import type { Env } from "@/config/env.schema";
import { AGENT_RUNTIME_LIMITS } from "@/domain/agent-contract";

/**
 * Turns validated configuration into the real model the operator may ask for. Returns `undefined` unless
 * AGENT_MODE=llm; there is no silent fallback in either direction (llm mode without a key or model is rejected
 * by the env parser, and scripted mode never constructs a provider client). The key stays inside the transport.
 */
export function liveModelFrom(env: Env, fetch?: FetchLike): LiveModel | undefined {
  const provider = env.AGENT_PROVIDER;
  const apiKey = provider === "groq" ? env.GROQ_API_KEY : env.ANTHROPIC_API_KEY;
  const model = env.AGENT_MODEL;
  if (env.AGENT_MODE !== "llm" || apiKey === undefined || model === undefined) return undefined;
  const timeoutMs = env.AGENT_TIMEOUT_MS ?? AGENT_RUNTIME_LIMITS.llmDefaultTimeoutMs;
  const maxAttempts = env.AGENT_MAX_ATTEMPTS;
  return {
    transport: createLlmTransport({
      provider,
      apiKey,
      model,
      maxOutputTokens: env.AGENT_MAX_OUTPUT_TOKENS,
      ...(fetch ? { fetch } : {}),
    }),
    runtime: {
      timeoutMs,
      maxAttempts,
      totalDeadlineMs: Math.min(AGENT_RUNTIME_LIMITS.totalDeadlineMs.max, timeoutMs * maxAttempts),
    },
  };
}
