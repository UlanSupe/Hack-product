import {
  AGENT_RUNTIME_LIMITS as LIMITS,
  type MandateView,
  type OfferView,
  type ServiceRequest,
} from "../domain/agent-contract.ts";
import {
  buildOfferView,
  hardFailures,
  type CatalogEntry,
  type HardFailure,
} from "../domain/offer-view.ts";
import type { ApprovalRequirement } from "../domain/mandate.ts";
import { scanInjection, type InjectionSignal } from "../domain/untrusted-text.ts";
import type { AgentFailure, AgentResult, BuyerAgent, SellerAgent } from "../ports/agents.ts";

/**
 * Runs a bounded negotiation between a buyer agent and one to five seller agents and reports what the
 * agents PROPOSED. The outcome is advisory: `authority` is the literal "ADVISORY_ONLY", and nothing in
 * this module can reach a mandate, a payment, the store or the policy engine (the layer rules forbid
 * the imports). Turning a recommendation into an action is the ActionGateway's job, and it will ask
 * the Policy Engine, never the agents.
 *
 * Facts about offers (totals, approval needed, hard failures, risk signals) are computed HERE from the
 * structured offers. A model's reply can neither supply nor override them.
 */

export type SellerParticipant = {
  sellerId: string;
  agent: SellerAgent;
  /** From the mandate's allow-list, decided by the caller. */
  sellerAllowed: boolean;
  /** This seller's rows in the server catalog, or null if the caller has none. */
  catalog: readonly CatalogEntry[] | null;
};

/**
 * Called as things happen, so a caller can persist them. Callbacks must not throw; they are given data only
 * and cannot influence the negotiation.
 */
export type NegotiationObserver = {
  onOffer?(e: {
    offerId: string;
    sellerId: string;
    terms: OfferView["untrusted"];
    message: string;
  }): void;
  onCounter?(e: {
    offerId: string;
    sellerId: string;
    targetTotalMinor: number;
    note: string;
  }): void;
};

export type NegotiationInput = {
  /** Free text to interpret. Ignored when `request` is given. */
  userRequest: string;
  /** An already-structured request (for example one stored in a negotiation): skips interpretation. */
  request?: ServiceRequest;
  observer?: NegotiationObserver;
  mandate: MandateView;
  buyer: BuyerAgent;
  sellers: SellerParticipant[];
  maxRounds?: number;
  signal?: AbortSignal;
};

export type NegotiationStatus =
  | "RECOMMENDED"
  /** The buyer recommended an offer the server's own checks reject; the policy engine would deny it. */
  | "UNSAFE_RECOMMENDATION"
  | "APPROVAL_REQUESTED"
  | "CLARIFICATION_NEEDED"
  | "NO_DEAL"
  | "MAX_ROUNDS"
  | "AGENT_FAILURE";

export type NegotiationStep = {
  n: number;
  actor: "BUYER" | "SELLER";
  sellerId: string | null;
  task: string;
  kind: string;
  ok: boolean;
  failure: AgentFailure["kind"] | null;
  attempts: number;
};

export type NegotiationOutcome = {
  authority: "ADVISORY_ONLY";
  status: NegotiationStatus;
  rounds: number;
  request: ServiceRequest | null;
  /** Every offer made, in order, as the buyer saw it (seller claims under `untrusted`). */
  offers: OfferView[];
  recommendation: {
    kind: "RECOMMEND" | "REQUEST_HUMAN_APPROVAL";
    offerId: string;
    sellerId: string;
    text: string;
  } | null;
  /** For CLARIFICATION_NEEDED: what to ask the user. Written by an agent: display as inert text. */
  question: string | null;
  /** Server-computed facts about the recommended offer. Never from a model. */
  derived: {
    approval: ApprovalRequirement;
    hardFailures: HardFailure[];
    riskSignals: InjectionSignal[];
  } | null;
  warnings: string[];
  failure: (AgentFailure & { actor: "BUYER" | "SELLER" }) | null;
  steps: NegotiationStep[];
};

const MAX_SELLERS = 5;
const int = (v: number | undefined, min: number, max: number, dflt: number) =>
  typeof v === "number" && Number.isFinite(v) ? Math.min(max, Math.max(min, Math.trunc(v))) : dflt;

export async function runNegotiation(input: NegotiationInput): Promise<NegotiationOutcome> {
  const maxRounds = int(
    input.maxRounds,
    LIMITS.maxRounds.min,
    LIMITS.maxRounds.max,
    LIMITS.maxRounds.default,
  );
  const participants = input.sellers.slice(0, MAX_SELLERS);
  const callOptions = input.signal ? { signal: input.signal } : {};

  const steps: NegotiationStep[] = [];
  const warnings: string[] = [];
  const history: OfferView[] = [];
  const current = new Map<string, { view: OfferView; seller: SellerParticipant }>(); // by sellerId
  const answers: { offerId: string; question: string; answer: string }[] = [];
  const extraSignals = new Map<string, Set<InjectionSignal>>(); // from seller answers, by offerId
  let request: ServiceRequest | null = null;
  let rounds = 0;
  let seq = 0;

  const note = (
    actor: "BUYER" | "SELLER",
    sellerId: string | null,
    task: string,
    r: AgentResult<{ kind: string }>,
  ) => {
    steps.push({
      n: steps.length + 1,
      actor,
      sellerId,
      task,
      kind: r.output.kind,
      ok: r.ok,
      failure: r.ok ? null : r.failure.kind,
      attempts: r.ok ? r.attempts : r.failure.attempts,
    });
  };
  const done = (
    status: NegotiationStatus,
    extra: Partial<
      Pick<NegotiationOutcome, "recommendation" | "question" | "derived" | "failure">
    > = {},
  ): NegotiationOutcome => ({
    authority: "ADVISORY_ONLY",
    status,
    rounds,
    request,
    offers: history,
    recommendation: null,
    question: null,
    derived: null,
    warnings,
    failure: null,
    steps,
    ...extra,
  });
  const failed = (actor: "BUYER" | "SELLER", r: { ok: false; failure: AgentFailure }) =>
    done("AGENT_FAILURE", { failure: { ...r.failure, actor } });

  /* 1. Interpret the user's request (unless it is already structured). */
  if (input.request) {
    request = input.request;
  } else {
    const interpreted = await input.buyer.interpret(
      { task: "INTERPRET", userRequest: input.userRequest, mandate: input.mandate },
      callOptions,
    );
    note("BUYER", null, "INTERPRET", interpreted);
    if (!interpreted.ok) return failed("BUYER", interpreted);
    const out = interpreted.output;
    if (out.kind === "ASK_USER") return done("CLARIFICATION_NEEDED", { question: out.question });
    if (out.kind !== "INTERPRETED") {
      return done("CLARIFICATION_NEEDED", {
        question: "I could not understand the request. Please rephrase it.",
      });
    }
    request = out.request;
  }

  const present = (terms: OfferView["untrusted"], p: SellerParticipant): OfferView => {
    const view = buildOfferView({
      offerId: `offer-${++seq}`,
      sellerId: p.sellerId,
      terms,
      mandate: input.mandate,
      sellerAllowed: p.sellerAllowed,
      catalog: p.catalog,
    });
    history.push(view);
    current.set(p.sellerId, { view, seller: p });
    return view;
  };

  /* 2. Each seller opens. */
  for (const p of participants) {
    const opened = await p.agent.open({ task: "OPEN", request }, callOptions);
    note("SELLER", p.sellerId, "OPEN", opened);
    if (!opened.ok) return failed("SELLER", opened);
    if (opened.output.kind === "OFFER") {
      const v = present(opened.output.offer, p);
      input.observer?.onOffer?.({
        offerId: v.offerId,
        sellerId: p.sellerId,
        terms: v.untrusted,
        message: opened.output.message,
      });
    }
  }
  if (current.size === 0) return done("NO_DEAL");

  /* 3. Compare, then recommend, counter, ask, or stop. */
  const viewsNow = (): OfferView[] =>
    [...current.values()].map(({ view }) => {
      const extra = extraSignals.get(view.offerId);
      if (!extra) return view;
      const merged = [...new Set([...view.trusted.riskSignals, ...extra])].sort();
      return { ...view, trusted: { ...view.trusted, riskSignals: merged } };
    });

  while (rounds < maxRounds) {
    rounds++;
    const offers = viewsNow();
    const compared = await input.buyer.compare(
      {
        task: "COMPARE",
        request,
        offers,
        mandate: input.mandate,
        round: rounds,
        maxRounds,
        answers,
      },
      callOptions,
    );
    note("BUYER", null, "COMPARE", compared);
    if (!compared.ok) return failed("BUYER", compared);
    const decision = compared.output;

    const entry =
      "offerId" in decision
        ? [...current.values()].find((c) => c.view.offerId === decision.offerId)
        : undefined;
    const view = entry ? offers.find((o) => o.offerId === entry.view.offerId) : undefined;

    switch (decision.kind) {
      case "RECOMMEND":
      case "REQUEST_HUMAN_APPROVAL": {
        if (!view || !entry) return done("NO_DEAL"); // unreachable: references are validated; fail safe regardless
        const failures = hardFailures(view);
        const derived = {
          approval: view.trusted.approval,
          hardFailures: failures,
          riskSignals: view.trusted.riskSignals,
        };
        const recommendation = {
          kind: decision.kind,
          offerId: view.offerId,
          sellerId: view.sellerId,
          text: decision.kind === "RECOMMEND" ? decision.rationale : decision.note,
        };
        if (decision.kind === "RECOMMEND" && derived.approval !== "NOT_REQUIRED") {
          warnings.push("APPROVAL_REQUIRED_BUT_NOT_REQUESTED");
        }
        if (derived.riskSignals.length > 0) warnings.push("SELLER_TEXT_FLAGGED");
        if (failures.length > 0) warnings.push("OFFER_FAILS_SERVER_CHECKS");
        const status: NegotiationStatus =
          failures.length > 0 && decision.kind === "RECOMMEND"
            ? "UNSAFE_RECOMMENDATION"
            : decision.kind === "RECOMMEND"
              ? "RECOMMENDED"
              : "APPROVAL_REQUESTED";
        return done(status, { recommendation, derived });
      }
      case "ASK_USER":
        return done("CLARIFICATION_NEEDED", { question: decision.question });
      case "REJECT_ALL":
      case "NONE":
        return done("NO_DEAL");
      case "COUNTER": {
        if (!entry) return done("NO_DEAL");
        input.observer?.onCounter?.({
          offerId: entry.view.offerId,
          sellerId: entry.seller.sellerId,
          targetTotalMinor: decision.targetTotalMinor,
          note: decision.note,
        });
        const countered = await entry.seller.agent.counter(
          {
            task: "COUNTER",
            request,
            currentOffer: entry.view.untrusted,
            targetTotalMinor: decision.targetTotalMinor,
            note: decision.note,
            round: rounds,
            maxRounds,
          },
          callOptions,
        );
        note("SELLER", entry.seller.sellerId, "COUNTER", countered);
        if (!countered.ok) return failed("SELLER", countered);
        if (countered.output.kind === "OFFER") {
          const v = present(countered.output.offer, entry.seller);
          input.observer?.onOffer?.({
            offerId: v.offerId,
            sellerId: entry.seller.sellerId,
            terms: v.untrusted,
            message: countered.output.message,
          });
        } else current.delete(entry.seller.sellerId);
        if (current.size === 0) return done("NO_DEAL");
        break;
      }
      case "ASK_SELLER": {
        if (!entry) return done("NO_DEAL");
        const reply = await entry.seller.agent.answer(
          {
            task: "ANSWER",
            request,
            currentOffer: entry.view.untrusted,
            question: decision.question,
          },
          callOptions,
        );
        note("SELLER", entry.seller.sellerId, "ANSWER", reply);
        if (!reply.ok) return failed("SELLER", reply);
        const text = reply.output.kind === "ANSWER" ? reply.output.text : "";
        answers.push({ offerId: entry.view.offerId, question: decision.question, answer: text });
        const flags = scanInjection(text);
        if (flags.length > 0) {
          extraSignals.set(
            entry.view.offerId,
            new Set([...(extraSignals.get(entry.view.offerId) ?? []), ...flags]),
          );
        }
        break;
      }
    }
  }
  return done("MAX_ROUNDS");
}
