import type { SellerConfig } from "../domain/agent-contract.ts";
import type { BuyerAgent, SellerAgent } from "../ports/agents.ts";
import { createBuyerAgent, createSellerAgent, type AgentDeps } from "./model-agents.ts";
import { createMockBuyerModel, createMockSellerModel } from "./mock-models.ts";

export { runNegotiation } from "./negotiation.ts";
export type {
  NegotiationInput,
  NegotiationObserver,
  NegotiationOutcome,
  SellerParticipant,
} from "./negotiation.ts";
export { createBuyerAgent, createSellerAgent } from "./model-agents.ts";
export { resolveRuntime } from "./runtime.ts";
export type { RuntimeOptions } from "./runtime.ts";

/**
 * A synthetic seller used by tests and the demo: one compute item and one storage item.
 * Prices are in minor units (cents). Floors are the seller's private minimum.
 */
export const DEMO_SELLER_CONFIG: SellerConfig = {
  sellerId: "seller_acme",
  currency: "USD",
  shippingMinor: 0,
  feesMinor: 0,
  minLeadTimeDays: 1,
  maxValidForMinutes: 120,
  maxRounds: 4,
  catalog: [
    {
      sku: "GPU-PACK",
      name: "GPU pack (80 GPU-hours)",
      category: "COMPUTE",
      listPriceMinor: 8000,
      floorPriceMinor: 6500,
      deliverables: [
        "80 GPU-hours on a shared A100 pool",
        "Access within 1 business day",
        "Usage report (CSV)",
      ],
    },
    {
      sku: "BACKUP-100",
      name: "Backup storage (100 GB, 1 year)",
      category: "STORAGE",
      listPriceMinor: 2000,
      floorPriceMinor: 1500,
      deliverables: ["100 GB encrypted backup storage for 12 months", "Restore test report"],
    },
  ],
};

/**
 * The default agents: deterministic, offline, credential-free. They go through the same validation,
 * timeout and retry road as a real model provider will.
 */
export function createMockAgents(
  config: SellerConfig = DEMO_SELLER_CONFIG,
  options: Pick<AgentDeps, "runtime" | "clock" | "onEvent"> = {},
): { buyer: BuyerAgent; seller: SellerAgent } {
  return {
    buyer: createBuyerAgent({ model: createMockBuyerModel(), ...options }),
    seller: createSellerAgent({ model: createMockSellerModel(config), config, ...options }),
  };
}
