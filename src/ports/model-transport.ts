/**
 * The one door through which text reaches a language model and comes back. A real provider (see
 * docs/AGENTS.md) and the deterministic mocks both implement it, so they share the exact same parsing,
 * validation, timeout and retry path. Whatever comes back is UNTRUSTED text.
 *
 * Adapter rules: send only `system` and `prompt`; honour `signal` (the runtime also enforces the timeout
 * itself, so an adapter that ignores it cannot hang a negotiation); never log `prompt` or credentials.
 */

export type ModelRequest = {
  agent: "buyer" | "seller";
  task: string;
  /** Fixed, trusted instructions. */
  system: string;
  /**
   * The user turn: one JSON document with `trusted` facts and `untrusted` seller text kept apart. It is
   * data to be analysed, never instructions to be followed.
   */
  prompt: string;
  /** 1-based attempt number (retries re-send the same prompt, plus `corrective` when the last reply was invalid). */
  attempt: number;
  /** Our own description (paths only, never the model's text) of what was wrong with the previous reply. */
  corrective: string | null;
  /** The runtime rejects longer replies unread; adapters should pass this as the output limit. */
  maxOutputChars: number;
};

export type ModelReply =
  | { kind: "text"; text: string }
  /** The model declined to answer. A final answer, not an error: it is never retried. */
  | { kind: "refusal"; message?: string };

export type TransportErrorKind =
  | "RATE_LIMITED"
  | "UNAVAILABLE"
  | "NETWORK"
  | "UNAUTHORIZED"
  /** The provider account has a billing problem. Retrying cannot help. */
  | "BILLING"
  | "BAD_REQUEST"
  /** The reply was cut off (it hit the token or context limit), so it cannot be trusted as complete. */
  | "TRUNCATED";

/** Facts about a failure that are safe to keep: numbers and a short token, never text the provider wrote. */
export type TransportErrorDetails = {
  status?: number;
  /** How long the provider asked us to wait before retrying (Retry-After), in milliseconds. */
  retryAfterMs?: number;
  /** The provider's request id, a short token a support ticket can quote. */
  reference?: string;
};

/** Thrown by a transport. Retryable kinds are retried within the attempt budget; the others fail at once. */
export class TransportError extends Error {
  readonly kind: TransportErrorKind;
  readonly retryable: boolean;
  readonly status: number | null;
  readonly retryAfterMs: number | null;
  readonly reference: string | null;

  constructor(kind: TransportErrorKind, message: string, details: TransportErrorDetails = {}) {
    super(message);
    this.name = "TransportError";
    this.kind = kind;
    this.status = details.status ?? null;
    this.retryAfterMs = details.retryAfterMs ?? null;
    this.reference = details.reference ?? null;
    this.retryable = kind === "RATE_LIMITED" || kind === "UNAVAILABLE" || kind === "NETWORK";
  }
}

export interface ModelTransport {
  /** A short, non-secret label ("mock-buyer", "anthropic:<model>") used in audit and diagnostics. */
  readonly name: string;
  complete(request: ModelRequest, context: { signal: AbortSignal }): Promise<ModelReply>;
}
