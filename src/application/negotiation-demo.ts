import {
  createBuyerAgent,
  createSellerAgent,
  runNegotiation,
  type NegotiationOutcome,
} from "../agents/index.ts";
import { createMockBuyerModel, createMockSellerModel } from "../agents/mock-models.ts";
import type { RuntimeOptions } from "../agents/runtime.ts";
import type { SellerConfig } from "../domain/agent-contract.ts";
import { ConflictError, ForbiddenError, NotFoundError } from "../domain/errors.ts";
import { SERVICE_CATEGORIES } from "../domain/mandate.ts";
import type { NegotiationActor } from "../domain/negotiation.ts";
import { mandateViewOf, type CatalogEntry } from "../domain/offer-view.ts";
import type { ModelTransport } from "../ports/model-transport.ts";
import type { NegotiationStore } from "../ports/negotiation-store.ts";
import type { NegotiationService } from "./negotiations.ts";

/**
 * Runs the agents over a stored negotiation and records what they say as ordinary proposals, through the same
 * validated service methods anyone else would use. By default these are the deterministic MOCK agents (no model
 * provider, no credentials). When the server was configured with a real model (`live`), the operator can ask for a
 * model run instead; it goes through exactly the same validation, bounds and recording, and a model is never
 * used unless asked for. The agents only propose: nothing here accepts, approves or pays.
 *
 * Mock sellers get their constraints from the seller's catalog: the list price is the catalog price, and the
 * floor (the least the seller will take) is a synthetic 80% of it. That is demo data, not a market model.
 */

export type AgentSource = "mock" | "model";

/** A configured real model, as handed in by the server's composition root. */
export type LiveModel = {
  transport: ModelTransport;
  runtime: Partial<RuntimeOptions>;
  /** Cost and abuse guard: at most this many model runs per window, one at a time. */
  maxRuns?: number;
  windowMs?: number;
  now?: () => number;
};

export type DemoOutcome = {
  source: AgentSource;
  status: NegotiationOutcome["status"];
  headline: string;
  /** The stored offer the buyer agent recommended or asked the operator to approve, if any. */
  recommendedProposalId: string | null;
  recorded: { offers: number; counters: number };
  warnings: string[];
  steps: number;
  /** Anything the service refused while recording (for example a validation error). Empty when all went through. */
  problems: string[];
};

const FLOOR_PERCENT = 80;

function configFor(
  sellerId: string,
  rows: readonly {
    sku: string;
    category: string | null;
    unitPriceMinor: number;
    currency: string;
  }[],
  currency: string,
): SellerConfig | null {
  const items = rows.filter(
    (r) => r.category !== null && r.currency === currency && r.category in SERVICE_CATEGORIES,
  );
  if (items.length === 0) return null;
  return {
    sellerId,
    currency,
    shippingMinor: 0,
    feesMinor: 0,
    minLeadTimeDays: 1,
    maxValidForMinutes: 120,
    maxRounds: 4,
    catalog: items.slice(0, 20).map((r) => ({
      sku: r.sku,
      name: r.sku,
      category: r.category as keyof typeof SERVICE_CATEGORIES,
      listPriceMinor: r.unitPriceMinor,
      floorPriceMinor: Math.ceil((r.unitPriceMinor * FLOOR_PERCENT) / 100),
      deliverables: [
        `${SERVICE_CATEGORIES[r.category as keyof typeof SERVICE_CATEGORIES]} service as described`,
        "Written confirmation of delivery",
      ],
    })),
  };
}

const HEADLINE: Record<NegotiationOutcome["status"], string> = {
  RECOMMENDED: "The buyer agent recommends an offer. Review it, then accept it if you agree.",
  UNSAFE_RECOMMENDATION:
    "The buyer agent recommended an offer that the server's own checks reject. It will not pass the policy check.",
  APPROVAL_REQUESTED:
    "The buyer agent asks you to decide. See the offer it points to and the reasons.",
  CLARIFICATION_NEEDED: "The buyer agent needs more information from you.",
  NO_DEAL: "The agents found no acceptable deal.",
  MAX_ROUNDS: "The agents ran out of rounds without settling.",
  AGENT_FAILURE: "An agent failed to answer. Nothing was approved or paid.",
};

export function createNegotiationDemo(deps: {
  service: NegotiationService;
  store: NegotiationStore;
  live?: LiveModel | undefined;
}) {
  const { service, store, live } = deps;
  const runStarts: number[] = [];
  let modelRunning = false;

  return {
    /** Whether a real model run can be requested (a model is configured). Says nothing about the provider's health. */
    modelAvailable: live !== undefined,

    async run(
      actor: NegotiationActor,
      negotiationId: string,
      source: AgentSource = "mock",
    ): Promise<DemoOutcome> {
      if (actor.kind !== "OPERATOR" || actor.id === "") {
        throw new ForbiddenError("only the human operator may start the demo agents");
      }
      if (source === "model") {
        if (!live) {
          throw new ConflictError(
            "No model provider is configured. Set AGENT_MODE=llm with a key and a model (docs/AGENTS.md section 9), or use the demo agents.",
          );
        }
        const now = (live.now ?? Date.now)();
        const windowMs = live.windowMs ?? 600_000;
        while (runStarts.length > 0 && now - (runStarts[0] ?? now) >= windowMs) runStarts.shift();
        if (modelRunning)
          throw new ConflictError("A model run is already in progress. Wait for it to finish.");
        if (runStarts.length >= (live.maxRuns ?? 6)) {
          throw new ConflictError(
            "Too many model runs recently. Wait a few minutes, or use the demo agents.",
          );
        }
        runStarts.push(now);
        modelRunning = true;
      }
      try {
        return await runAgents(negotiationId, source);
      } finally {
        if (source === "model") modelRunning = false;
      }
    },
  };

  async function runAgents(negotiationId: string, source: AgentSource): Promise<DemoOutcome> {
    const label = source === "model" ? "model" : "mock";
    const buyerActor: NegotiationActor = { kind: "AGENT", id: `${label}-buyer` };
    // 1. Read what the agents need, in one consistent snapshot.
    const plan = store.transaction((ops) => {
      const n = ops.getNegotiation(negotiationId);
      if (!n) throw new NotFoundError(`negotiation ${negotiationId}`);
      if (n.status !== "OPEN")
        throw new ConflictError(
          `The demo agents only work on an open negotiation (this one is ${n.status.toLowerCase()}).`,
        );
      const mandate = ops.latestMandate(n.mandateId);
      if (!mandate) throw new NotFoundError(`mandate ${n.mandateId}`);
      const remaining = mandate.terms.totalBudgetMinor - ops.committedMinor(mandate.id, []);
      const sellers = n.invitedSellerIds.flatMap((id) => {
        const rows = ops.catalogFor(id);
        const config = configFor(id, rows, n.currency);
        return config
          ? [
              {
                config,
                allowed: mandate.terms.allowedSellerIds.includes(id),
                catalog: rows.flatMap((r): CatalogEntry[] =>
                  r.category === null
                    ? []
                    : [{ sku: r.sku, category: r.category, unitPriceMinor: r.unitPriceMinor }],
                ),
              },
            ]
          : [];
      });
      return { n, mandateView: mandateViewOf(mandate.terms, remaining), sellers };
    });

    // 2. Run the agents, recording each proposal as it appears.
    const problems: string[] = [];
    const stored = new Map<string, string>(); // orchestrator offer id -> stored proposal id
    const termsOf = new Map<string, { deliverables: string[]; deliveryDays: number }>();
    const lastCounter = new Map<string, string>(); // seller id -> latest stored counter id
    let offers = 0;
    let counters = 0;

    const outcome = await runNegotiation({
      userRequest: plan.n.request.summary,
      request: {
        category: plan.n.request.category,
        quantity: plan.n.request.quantity,
        summary: plan.n.request.summary,
        maxTotalMinor: plan.n.request.maxTotalMinor,
        neededWithinDays: plan.n.request.neededWithinDays,
        requiredDeliverables: plan.n.request.requiredDeliverables,
      },
      mandate: plan.mandateView,
      buyer:
        live && source === "model"
          ? createBuyerAgent({ model: live.transport, runtime: live.runtime })
          : createBuyerAgent({ model: createMockBuyerModel() }),
      sellers: plan.sellers.map((s) => ({
        sellerId: s.config.sellerId,
        sellerAllowed: s.allowed,
        catalog: s.catalog,
        agent:
          live && source === "model"
            ? createSellerAgent({
                model: live.transport,
                config: s.config,
                runtime: live.runtime,
              })
            : createSellerAgent({ model: createMockSellerModel(s.config), config: s.config }),
      })),
      maxRounds: 4,
      observer: {
        onOffer: (e) => {
          termsOf.set(e.offerId, {
            deliverables: e.terms.deliverables,
            deliveryDays: e.terms.deliveryDays,
          });
          const r = service.submitOffer(
            { kind: "AGENT", id: `${label}-seller:${e.sellerId}` },
            {
              negotiationId,
              sellerId: e.sellerId,
              respondsToId: lastCounter.get(e.sellerId) ?? null,
              offer: e.terms,
            },
          );
          if (r.ok) {
            stored.set(e.offerId, r.value.id);
            offers++;
          } else problems.push(...r.errors.map((x) => `offer ${x.field}: ${x.message}`));
        },
        onCounter: (e) => {
          const seen = termsOf.get(e.offerId);
          const r = service.submitCounter(buyerActor, {
            negotiationId,
            sellerId: e.sellerId,
            currency: plan.n.currency,
            category: plan.n.request.category,
            targetTotalMinor: e.targetTotalMinor,
            deliverables:
              plan.n.request.requiredDeliverables.length > 0
                ? plan.n.request.requiredDeliverables
                : (seen?.deliverables ?? ["As offered"]),
            deliveryDays: plan.n.request.neededWithinDays ?? seen?.deliveryDays ?? 7,
            note: e.note,
            validForMinutes: 60,
          });
          if (r.ok) {
            lastCounter.set(e.sellerId, r.value.id);
            counters++;
          } else problems.push(...r.errors.map((x) => `counter ${x.field}: ${x.message}`));
        },
      },
    });

    return {
      source,
      status: outcome.status,
      headline: HEADLINE[outcome.status],
      recommendedProposalId: outcome.recommendation
        ? (stored.get(outcome.recommendation.offerId) ?? null)
        : null,
      recorded: { offers, counters },
      warnings: outcome.warnings,
      steps: outcome.steps.length,
      problems,
    };
  }
}

export type NegotiationDemo = ReturnType<typeof createNegotiationDemo>;
