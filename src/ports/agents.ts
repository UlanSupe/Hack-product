import type {
  BuyerCompareInput,
  BuyerInterpretInput,
  CompareOutput,
  InterpretOutput,
  SellerAnswerInput,
  SellerAnswerOutput,
  SellerCounterInput,
  SellerOfferOutput,
  SellerOpenInput,
} from "../domain/agent-contract.ts";

/**
 * The buyer and seller agent interfaces. They are deliberately small and deliberately limited:
 *  - every method takes a typed input and returns a validated, structured PROPOSAL;
 *  - there is no method (and no output kind) to approve or change a mandate, authorize, capture,
 *    release or void a payment, or to evaluate policy. Those belong to the operator and to the
 *    server-side ActionGateway / Policy Engine, which no agent can reach;
 *  - no method throws: a failure comes back as `ok: false` together with a safe fallback output.
 */

export const AGENT_FAILURES = [
  "INPUT_REJECTED",
  "TIMEOUT",
  "REFUSED",
  "MALFORMED",
  "UNKNOWN_REFERENCE",
  "OUT_OF_CONSTRAINTS",
  "TRANSPORT",
  "ABORTED",
] as const;
export type AgentFailureKind = (typeof AGENT_FAILURES)[number];

export type AgentFailure = {
  kind: AgentFailureKind;
  /** Written by us. Never contains model or seller text. */
  message: string;
  /** Model calls made (0 when the input was rejected before any call). */
  attempts: number;
  /** Field paths and short reasons from validation, sanitized and bounded. */
  issues: string[];
  /** The provider's request id for a failed call, if it gave one: a short token for support, never a secret. */
  reference?: string;
};

/**
 * `output` is always usable: on failure it is the safe fallback (`kind: "NONE"`), which every caller
 * treats as "no action". Check `ok` to tell the two apart.
 */
export type AgentResult<T> =
  { ok: true; output: T; attempts: number } | { ok: false; failure: AgentFailure; output: T };

export type CallOptions = { signal?: AbortSignal };

export interface BuyerAgent {
  readonly name: string;
  /** Interpret the user's request, or ask them to clarify. */
  interpret(
    input: BuyerInterpretInput,
    options?: CallOptions,
  ): Promise<AgentResult<InterpretOutput>>;
  /** Compare offers and recommend, counter, ask, or request human approval. */
  compare(input: BuyerCompareInput, options?: CallOptions): Promise<AgentResult<CompareOutput>>;
}

export interface SellerAgent {
  readonly name: string;
  /** Make an opening offer for the request. */
  open(input: SellerOpenInput, options?: CallOptions): Promise<AgentResult<SellerOfferOutput>>;
  /** Respond to a counter-proposal within the seller's constraints. */
  counter(
    input: SellerCounterInput,
    options?: CallOptions,
  ): Promise<AgentResult<SellerOfferOutput>>;
  /** Answer a buyer's question. */
  answer(input: SellerAnswerInput, options?: CallOptions): Promise<AgentResult<SellerAnswerOutput>>;
}
