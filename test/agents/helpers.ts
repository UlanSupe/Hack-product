import type {
  BuyerCompareInput,
  MandateView,
  OfferTerms,
  OfferView,
  ServiceRequest,
} from "@/domain/agent-contract";
import { buildOfferView } from "@/domain/offer-view";
import type { Clock } from "@/agents/runtime";
import type { ModelReply, ModelRequest, ModelTransport } from "@/ports/model-transport";

export const MANDATE: MandateView = {
  currency: "USD",
  maxTransactionMinor: 10_000,
  remainingBudgetMinor: 15_000,
  approvalThresholdMinor: 5_000,
  requireReviewBeforeExecution: false,
  allowedCategories: ["COMPUTE", "STORAGE"],
};

export const REQUEST: ServiceRequest = {
  category: "COMPUTE",
  quantity: 1,
  summary: "One GPU pack for model training",
  maxTotalMinor: null,
  neededWithinDays: null,
  requiredDeliverables: [],
};

/** Default offer: 45.00, below the approval threshold, so a clean recommendation is possible. */
export function terms(over: Partial<OfferTerms> = {}): OfferTerms {
  return {
    currency: "USD",
    lines: [{ sku: "GPU-PACK", qty: 1, unitPriceMinor: 4_500 }],
    shippingMinor: 0,
    feesMinor: 0,
    claimedTotalMinor: 4_500,
    category: "COMPUTE",
    deliveryDays: 1,
    deliverables: ["80 GPU-hours", "Usage report (CSV)"],
    termsText: "Fixed price.",
    validForMinutes: 60,
    ...over,
  };
}

export function view(
  offerId: string,
  over: Partial<OfferTerms> = {},
  mandate = MANDATE,
): OfferView {
  return buildOfferView({
    offerId,
    sellerId: `seller_${offerId}`,
    terms: terms(over),
    mandate,
    sellerAllowed: true,
    catalog: null,
  });
}

export function compareInput(
  offers: OfferView[],
  over: Partial<BuyerCompareInput> = {},
): BuyerCompareInput {
  return {
    task: "COMPARE",
    request: REQUEST,
    offers,
    mandate: MANDATE,
    round: 1,
    maxRounds: 3,
    answers: [],
    ...over,
  };
}

/* ------------------------------------------------------------------ scripted fake model */

export type Step =
  | ModelReply
  | Error
  | "hang" // never answers, never looks at the abort signal
  | "hang-until-abort" // answers only by rejecting when aborted
  | ((request: ModelRequest) => ModelReply | Promise<ModelReply>)
  | { slowMs: number; reply: ModelReply }; // ignores the signal, answers late

export const text = (value: unknown): ModelReply => ({
  kind: "text",
  text: typeof value === "string" ? value : JSON.stringify(value),
});
export const refusal: ModelReply = { kind: "refusal", message: "I can't help with that." };

/** Replies from `steps` in order; the last step repeats. Records every request it receives. */
export function scripted(...steps: Step[]): ModelTransport & { calls: ModelRequest[] } {
  const calls: ModelRequest[] = [];
  return {
    name: "scripted-fake",
    calls,
    async complete(request, { signal }) {
      calls.push(request);
      const step = steps[Math.min(calls.length - 1, steps.length - 1)];
      if (step === undefined) throw new Error("no step");
      if (step instanceof Error) throw step;
      if (step === "hang") return new Promise<ModelReply>(() => {});
      if (step === "hang-until-abort") {
        return new Promise<ModelReply>((_resolve, reject) => {
          signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
        });
      }
      if (typeof step === "function") return step(request);
      if ("slowMs" in step) {
        await new Promise((r) => setTimeout(r, step.slowMs));
        return step.reply;
      }
      return step;
    },
  };
}

/** A clock that only moves when told to; `sleep` advances it instead of waiting. */
export function manualClock(start = 0): Clock & { slept: number[]; advance(ms: number): void } {
  let t = start;
  const slept: number[] = [];
  return {
    slept,
    now: () => t,
    advance: (ms) => {
      t += ms;
    },
    sleep: (ms) => {
      slept.push(ms);
      t += ms;
      return Promise.resolve();
    },
  };
}

/** Fast, bounded runtime for tests that really wait (timeouts use real timers). */
export const FAST = {
  timeoutMs: 100,
  maxAttempts: 3,
  backoffBaseMs: 0,
  backoffMaxMs: 0,
  totalDeadlineMs: 60_000,
};

export const cp = (...codes: number[]): string => String.fromCodePoint(...codes);
