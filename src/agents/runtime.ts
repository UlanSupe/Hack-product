import { AGENT_RUNTIME_LIMITS as LIMITS } from "../domain/agent-contract.ts";
import { sanitizeUntrusted } from "../domain/untrusted-text.ts";
import type { AgentFailure, AgentFailureKind } from "../ports/agents.ts";
import { TransportError } from "../ports/model-transport.ts";

/**
 * Timeouts, bounded retries and graceful failure for every model call. Nothing here knows about buyers,
 * sellers or prompts, so it is tested on its own.
 *
 *  - Each attempt has a timeout, enforced here: an adapter that ignores its AbortSignal cannot hang us.
 *  - The whole call has a deadline; no attempt starts that cannot finish inside it.
 *  - Attempts are capped (hard maximum 5, whatever the configuration says).
 *  - Retryable transport trouble backs off exponentially (deterministic, no jitter).
 *  - An invalid reply gets exactly ONE corrective re-ask, then fails: a model that cannot follow the
 *    format twice is not retried into compliance.
 *  - A refusal, an auth failure, a bad request and a cancellation are never retried.
 *  - Errors become `AgentFailure` values; nothing a model or provider said is copied into them.
 */

export type RuntimeOptions = {
  /** Per attempt. */
  timeoutMs: number;
  maxAttempts: number;
  /** For the whole call, all attempts and waits included. */
  totalDeadlineMs: number;
  backoffBaseMs: number;
  backoffMaxMs: number;
};

type Limit = { min: number; max: number; default: number };
const clamp = (v: unknown, l: Limit): number =>
  typeof v === "number" && Number.isFinite(v)
    ? Math.min(l.max, Math.max(l.min, Math.trunc(v)))
    : l.default;

/** Fills defaults and clamps every value into its hard limits. Garbage in (NaN, strings, negatives) gives defaults or limits. */
export function resolveRuntime(partial: Partial<RuntimeOptions> = {}): RuntimeOptions {
  return {
    timeoutMs: clamp(partial.timeoutMs, LIMITS.timeoutMs),
    maxAttempts: clamp(partial.maxAttempts, LIMITS.maxAttempts),
    totalDeadlineMs: clamp(partial.totalDeadlineMs, LIMITS.totalDeadlineMs),
    backoffBaseMs: clamp(partial.backoffBaseMs, LIMITS.backoffBaseMs),
    backoffMaxMs: clamp(partial.backoffMaxMs, LIMITS.backoffMaxMs),
  };
}

export type Clock = { now(): number; sleep(ms: number): Promise<void> };
export const systemClock: Clock = {
  now: () => Date.now(),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
};

export const MAX_CORRECTIVE_RETRIES = 1;

export type AttemptContext = {
  attempt: number;
  signal: AbortSignal;
  /** Set on the single re-ask after an invalid reply; describes what was wrong, in our words. */
  corrective: string | null;
};

export type AttemptResult<T> =
  | { ok: true; value: T }
  | {
      ok: false;
      kind: AgentFailureKind;
      /** NO: stop. BACKOFF: try again after waiting. CORRECTIVE: re-ask at once, once. */
      retry: "NO" | "BACKOFF" | "CORRECTIVE";
      message: string;
      issues: string[];
      /** The provider asked for at least this long before the next attempt (a rate limit's Retry-After). */
      waitMs?: number;
      /** The provider's request id, if it gave one. */
      reference?: string;
    };

export type RuntimeEvent = { attempt: number; outcome: "OK" | AgentFailureKind; ms: number };

export type Executed<T> =
  { ok: true; value: T; attempts: number } | { ok: false; failure: AgentFailure };

export const safeIssues = (issues: readonly string[]): string[] =>
  issues.slice(0, 8).map((i) => sanitizeUntrusted(i, 160));

export const correctiveText = (issues: readonly string[]): string =>
  `Your previous reply was rejected: ${safeIssues(issues).join("; ") || "it did not match the required shape"}. ` +
  "Reply again with exactly one JSON object in the required shape.";

function classifyThrown<T>(error: unknown): AttemptResult<T> {
  if (error instanceof TransportError) {
    return {
      ok: false,
      kind: "TRANSPORT",
      retry: error.retryable ? "BACKOFF" : "NO",
      message: `The model provider reported ${error.kind}.`,
      issues: [],
      ...(error.retryAfterMs === null ? {} : { waitMs: error.retryAfterMs }),
      ...(error.reference === null ? {} : { reference: error.reference }),
    };
  }
  // Anything else (a network library error, a bug in an adapter). Its text is not copied anywhere.
  return {
    ok: false,
    kind: "TRANSPORT",
    retry: "BACKOFF",
    message: "The model call failed unexpectedly.",
    issues: [],
  };
}

async function runOnce<T>(
  run: (ctx: AttemptContext) => Promise<AttemptResult<T>>,
  base: { attempt: number; corrective: string | null },
  timeoutMs: number,
  parent: AbortSignal | undefined,
): Promise<AttemptResult<T>> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let detach: () => void = () => {};

  const timeout = new Promise<AttemptResult<T>>((resolve) => {
    timer = setTimeout(() => {
      controller.abort();
      resolve({
        ok: false,
        kind: "TIMEOUT",
        retry: "BACKOFF",
        message: `The model did not answer within ${timeoutMs} ms.`,
        issues: [],
      });
    }, timeoutMs);
  });
  const cancelled = new Promise<AttemptResult<T>>((resolve) => {
    const onAbort = () => {
      controller.abort();
      resolve({
        ok: false,
        kind: "ABORTED",
        retry: "NO",
        message: "The call was cancelled.",
        issues: [],
      });
    };
    if (parent?.aborted) onAbort();
    else {
      parent?.addEventListener("abort", onAbort, { once: true });
      detach = () => parent?.removeEventListener("abort", onAbort);
    }
  });
  // Never rejects, so a call that loses the race cannot surface as an unhandled rejection later.
  const attempt = (async (): Promise<AttemptResult<T>> => {
    try {
      return await run({ ...base, signal: controller.signal });
    } catch (error) {
      return classifyThrown<T>(error);
    }
  })();

  try {
    return await Promise.race([attempt, timeout, cancelled]);
  } finally {
    clearTimeout(timer);
    detach();
  }
}

export async function execute<T>(
  run: (ctx: AttemptContext) => Promise<AttemptResult<T>>,
  options: RuntimeOptions,
  deps: { clock?: Clock; signal?: AbortSignal; onEvent?: (e: RuntimeEvent) => void } = {},
): Promise<Executed<T>> {
  const clock = deps.clock ?? systemClock;
  const startedAt = clock.now();
  const fail = (
    kind: AgentFailureKind,
    message: string,
    attempts: number,
    issues: string[] = [],
  ): Executed<T> => ({
    ok: false,
    failure: { kind, message, attempts, issues: safeIssues(issues) },
  });

  let corrective: string | null = null;
  let correctives = 0;
  let last: AgentFailure | null = null;

  for (let attempt = 1; attempt <= options.maxAttempts; attempt++) {
    if (deps.signal?.aborted) return fail("ABORTED", "The call was cancelled.", attempt - 1);
    const remaining = options.totalDeadlineMs - (clock.now() - startedAt);
    if (remaining <= 0) {
      return last
        ? { ok: false, failure: last }
        : fail("TIMEOUT", "The overall deadline passed before the first attempt.", 0);
    }

    const t0 = clock.now();
    const out = await runOnce(
      run,
      { attempt, corrective },
      Math.min(options.timeoutMs, remaining),
      deps.signal,
    );
    deps.onEvent?.({ attempt, outcome: out.ok ? "OK" : out.kind, ms: clock.now() - t0 });
    if (out.ok) return { ok: true, value: out.value, attempts: attempt };

    last = {
      kind: out.kind,
      message: out.message,
      attempts: attempt,
      issues: safeIssues(out.issues),
      ...(out.reference === undefined ? {} : { reference: out.reference }),
    };
    if (out.retry === "NO" || attempt === options.maxAttempts) return { ok: false, failure: last };

    if (out.retry === "CORRECTIVE") {
      if (correctives >= MAX_CORRECTIVE_RETRIES) return { ok: false, failure: last };
      correctives++;
      corrective = correctiveText(out.issues);
      continue; // re-ask at once: the model answered, it just answered badly
    }
    corrective = null;
    // Our own backoff, but never sooner than the provider asked (bounded: a huge Retry-After just ends the call).
    const backoff = Math.min(options.backoffMaxMs, options.backoffBaseMs * 2 ** (attempt - 1));
    const wait = Math.min(LIMITS.backoffMaxMs.max, Math.max(backoff, out.waitMs ?? 0));
    if (wait > 0) {
      if (wait >= options.totalDeadlineMs - (clock.now() - startedAt))
        return { ok: false, failure: last };
      await clock.sleep(wait);
    }
  }
  return {
    ok: false,
    failure: last ?? { kind: "TIMEOUT", message: "No attempt was made.", attempts: 0, issues: [] },
  };
}
