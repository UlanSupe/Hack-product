import type { z } from "zod";

import {
  AGENT_RUNTIME_LIMITS as LIMITS,
  BuyerCompareInputSchema,
  BuyerInterpretInputSchema,
  CompareOutputSchema,
  InterpretOutputSchema,
  SellerAnswerInputSchema,
  SellerAnswerOutputSchema,
  SellerConfigSchema,
  SellerCounterInputSchema,
  SellerOfferOutputSchema,
  SellerOpenInputSchema,
  type BuyerCompareInput,
  type BuyerInterpretInput,
  type CompareOutput,
  type InterpretOutput,
  type SellerAnswerInput,
  type SellerAnswerOutput,
  type SellerConfig,
  type SellerCounterInput,
  type SellerOfferOutput,
  type SellerOpenInput,
} from "../domain/agent-contract.ts";
import { checkSellerConstraints } from "../domain/offer-view.ts";
import { sanitizeUntrusted } from "../domain/untrusted-text.ts";
import type {
  AgentFailureKind,
  AgentResult,
  BuyerAgent,
  CallOptions,
  SellerAgent,
} from "../ports/agents.ts";
import type { ModelTransport } from "../ports/model-transport.ts";
import { parseModelJson } from "./parse.ts";
import { buildPrompt, systemPrompt } from "./prompts.ts";
import {
  execute,
  resolveRuntime,
  safeIssues,
  type AttemptResult,
  type Clock,
  type RuntimeEvent,
  type RuntimeOptions,
} from "./runtime.ts";

/**
 * Buyer and seller agents backed by a ModelTransport (a real provider or a deterministic mock).
 * Every reply, from either, takes the same road: size check, strict JSON, strict schema, reference and
 * constraint checks, bounded retries, then a typed result. Nothing a model says is trusted before that.
 */

export type AgentDeps = {
  model: ModelTransport;
  runtime?: Partial<RuntimeOptions>;
  clock?: Clock;
  onEvent?: (event: RuntimeEvent & { agent: string; task: string }) => void;
};

type Rejection = { kind: "UNKNOWN_REFERENCE" | "OUT_OF_CONSTRAINTS"; issues: string[] };

type Spec<I, O> = {
  agent: "buyer" | "seller";
  task: string;
  system: string;
  inputSchema: z.ZodType<I>;
  outputSchema: z.ZodType<O>;
  fallback: (reason: string) => O;
  check?: (input: I, output: O) => Rejection | null;
};

function zodIssues(error: z.ZodError): string[] {
  return error.issues.slice(0, 8).map((i) => {
    const path = i.path.map(String).join(".") || "(root)";
    if (i.code === "unrecognized_keys") {
      return `${path}: unknown field ${i.keys.map((k) => JSON.stringify(sanitizeUntrusted(k, 30))).join(", ")}`;
    }
    return `${path}: ${i.message}`;
  });
}

async function callAgent<I, O>(
  spec: Spec<I, O>,
  rawInput: unknown,
  deps: AgentDeps,
  options: CallOptions = {},
): Promise<AgentResult<O>> {
  const parsedInput = spec.inputSchema.safeParse(rawInput);
  if (!parsedInput.success) {
    return {
      ok: false,
      failure: {
        kind: "INPUT_REJECTED",
        message: "The agent input did not match its contract; no model call was made.",
        attempts: 0,
        issues: safeIssues(zodIssues(parsedInput.error)),
      },
      output: spec.fallback("input rejected"),
    };
  }
  const input = parsedInput.data;
  const bad = (
    kind: AgentFailureKind,
    message: string,
    issues: string[],
    retry: "NO" | "BACKOFF" | "CORRECTIVE",
  ): AttemptResult<O> => ({ ok: false, kind, retry, message, issues });

  const runtime = resolveRuntime(deps.runtime);
  const executed = await execute<O>(
    async (ctx) => {
      const reply = await deps.model.complete(
        {
          agent: spec.agent,
          task: spec.task,
          system: spec.system,
          prompt: buildPrompt(spec.task, input, ctx.corrective),
          attempt: ctx.attempt,
          corrective: ctx.corrective,
          maxOutputChars: LIMITS.maxOutputChars,
        },
        { signal: ctx.signal },
      );

      if (reply === null || typeof reply !== "object") {
        return bad(
          "TRANSPORT",
          "The model provider returned an unexpected reply type.",
          [],
          "BACKOFF",
        );
      }
      if (reply.kind === "refusal") {
        return bad("REFUSED", "The model declined to answer.", [], "NO"); // a final answer; never retried
      }
      if (reply.kind !== "text" || typeof reply.text !== "string") {
        return bad(
          "TRANSPORT",
          "The model provider returned an unexpected reply type.",
          [],
          "BACKOFF",
        );
      }
      if (reply.text.length > LIMITS.maxOutputChars) {
        return bad(
          "MALFORMED",
          "The model reply was too long.",
          [`the reply is longer than ${LIMITS.maxOutputChars} characters`],
          "CORRECTIVE",
        );
      }
      const json = parseModelJson(reply.text);
      if (!json.ok)
        return bad(
          "MALFORMED",
          "The model reply was not a JSON object.",
          [json.issue],
          "CORRECTIVE",
        );

      const parsed = spec.outputSchema.safeParse(json.value);
      if (!parsed.success) {
        return bad(
          "MALFORMED",
          "The model reply did not match the required shape.",
          zodIssues(parsed.error),
          "CORRECTIVE",
        );
      }
      const rejection = spec.check?.(input, parsed.data) ?? null;
      if (rejection) {
        return bad(
          rejection.kind,
          "The model reply broke a rule the server checks.",
          rejection.issues,
          "CORRECTIVE",
        );
      }
      return { ok: true, value: parsed.data };
    },
    runtime,
    {
      ...(deps.clock ? { clock: deps.clock } : {}),
      ...(options.signal ? { signal: options.signal } : {}),
      onEvent: (e) => deps.onEvent?.({ ...e, agent: spec.agent, task: spec.task }),
    },
  );

  if (executed.ok) return { ok: true, output: executed.value, attempts: executed.attempts };
  return {
    ok: false,
    failure: executed.failure,
    output: spec.fallback(`agent unavailable (${executed.failure.kind})`),
  };
}

/* ------------------------------------------------------------------ buyer */

/** A buyer may only point at offers it was shown. */
function checkCompareReferences(input: BuyerCompareInput, out: CompareOutput): Rejection | null {
  const known = new Set(input.offers.map((o) => o.offerId));
  const issues: string[] = [];
  const need = (field: string, id: string) => {
    if (!known.has(id)) issues.push(`${field}: not one of the offers in this comparison`);
  };
  if ("offerId" in out) need("offerId", out.offerId);
  if (out.kind === "RECOMMEND") {
    out.ranking.forEach((id, n) => need(`ranking.${n}`, id));
    if (new Set(out.ranking).size !== out.ranking.length)
      issues.push("ranking: must not repeat an offer");
    if (out.ranking.length > 0 && out.ranking[0] !== out.offerId) {
      issues.push("ranking: the first entry must be the recommended offer");
    }
  }
  return issues.length > 0 ? { kind: "UNKNOWN_REFERENCE", issues } : null;
}

export function createBuyerAgent(deps: AgentDeps): BuyerAgent {
  const none = (reason: string) => ({
    kind: "NONE" as const,
    reason: sanitizeUntrusted(reason, 200),
  });
  const interpretSpec: Spec<BuyerInterpretInput, InterpretOutput> = {
    agent: "buyer",
    task: "INTERPRET",
    system: systemPrompt("buyer", "INTERPRET"),
    inputSchema: BuyerInterpretInputSchema,
    outputSchema: InterpretOutputSchema,
    fallback: none,
  };
  const compareSpec: Spec<BuyerCompareInput, CompareOutput> = {
    agent: "buyer",
    task: "COMPARE",
    system: systemPrompt("buyer", "COMPARE"),
    inputSchema: BuyerCompareInputSchema,
    outputSchema: CompareOutputSchema,
    fallback: none,
    check: checkCompareReferences,
  };
  return {
    name: `buyer(${deps.model.name})`,
    interpret: (input, options) => callAgent(interpretSpec, input, deps, options),
    compare: (input, options) => callAgent(compareSpec, input, deps, options),
  };
}

/* ------------------------------------------------------------------ seller */

export type SellerAgentDeps = AgentDeps & {
  config: SellerConfig;
  /**
   * An honest seller's offers are checked against its own constraints (floor and list prices, lead time,
   * accurate total...) and rejected if they break them. Only a deliberately hostile TEST FIXTURE passes
   * `false`; it exists to prove the buyer side survives a seller that ignores its rules.
   */
  enforceConstraints?: boolean;
};

export function createSellerAgent(deps: SellerAgentDeps): SellerAgent {
  const config = SellerConfigSchema.parse(deps.config); // fail fast on a bad configuration
  const enforce = deps.enforceConstraints ?? true;
  const constraintsText = JSON.stringify({
    sellerId: config.sellerId,
    currency: config.currency,
    shippingMinor: config.shippingMinor,
    feesMinor: config.feesMinor,
    minLeadTimeDays: config.minLeadTimeDays,
    maxValidForMinutes: config.maxValidForMinutes,
    catalog: config.catalog,
  });
  const none = (reason: string) => ({
    kind: "NONE" as const,
    reason: sanitizeUntrusted(reason, 200),
  });
  const checkOffer = (_input: unknown, out: SellerOfferOutput): Rejection | null => {
    if (!enforce || out.kind !== "OFFER") return null;
    const violations = checkSellerConstraints(out.offer, config);
    return violations.length > 0
      ? { kind: "OUT_OF_CONSTRAINTS", issues: violations.map((v) => `offer: ${v}`) }
      : null;
  };
  const offerSpec = <I>(
    task: "OPEN" | "COUNTER",
    inputSchema: z.ZodType<I>,
  ): Spec<I, SellerOfferOutput> => ({
    agent: "seller",
    task,
    system: systemPrompt("seller", task, constraintsText),
    inputSchema,
    outputSchema: SellerOfferOutputSchema,
    fallback: none,
    check: checkOffer,
  });
  const openSpec = offerSpec<SellerOpenInput>("OPEN", SellerOpenInputSchema);
  const counterSpec = offerSpec<SellerCounterInput>("COUNTER", SellerCounterInputSchema);
  const answerSpec: Spec<SellerAnswerInput, SellerAnswerOutput> = {
    agent: "seller",
    task: "ANSWER",
    system: systemPrompt("seller", "ANSWER", constraintsText),
    inputSchema: SellerAnswerInputSchema,
    outputSchema: SellerAnswerOutputSchema,
    fallback: none,
  };
  return {
    name: `seller:${config.sellerId}(${deps.model.name})`,
    open: (input, options) => callAgent(openSpec, input, deps, options),
    counter: (input, options) => callAgent(counterSpec, input, deps, options),
    answer: (input, options) => callAgent(answerSpec, input, deps, options),
  };
}
