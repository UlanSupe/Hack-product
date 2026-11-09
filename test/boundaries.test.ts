import { resolve } from "node:path";

import { ESLint } from "eslint";
import { describe, expect, it } from "vitest";

// Loads only eslint.boundaries.mjs and lints in-memory snippets as if they lived at `file`.
const eslint = new ESLint({ cwd: process.cwd(), overrideConfigFile: "eslint.boundaries.mjs" });

async function messages(file: string, code: string): Promise<string[]> {
  const [result] = await eslint.lintText(code, { filePath: resolve(file) });
  return (result?.messages ?? []).map((m) => m.message);
}

describe("architecture layer boundaries (ARCHITECTURE 3.1)", () => {
  it.each([
    ["src/domain/money.ts", 'import { x } from "@/adapters/paypal";'],
    ["src/domain/money.ts", 'import { x } from "../application/health";'],
    ["src/domain/money.ts", 'import { useState } from "react";'],
    ["src/agents/buyer.ts", 'import { x } from "@/adapters/paypal/client";'],
    ["src/agents/buyer.ts", 'import { x } from "@/application/action-gateway";'],
    ["src/agents/buyer.ts", 'import { getEnv } from "@/server/env";'],
    ["src/agents/buyer.ts", 'import { createMandateService } from "@/application/mandates";'],
    [
      "src/agents/buyer.ts",
      'import { createSqliteMandateStore } from "@/adapters/sqlite/mandate-store";',
    ],
    ["src/agents/buyer.ts", 'import { requireOperator } from "../application/mandates";'],
    ["src/agents/seller.ts", 'import { x } from "@/config/env.schema";'],
    ["src/agents/seller.ts", 'import { x } from "@/application/negotiation";'],
    ["src/agents/seller.ts", 'import { x } from "../adapters/llm/anthropic";'],
    ["src/ports/model-transport.ts", 'import { x } from "@/agents/runtime";'],
    ["src/ports/agents.ts", 'import { x } from "@/adapters/sqlite/store";'],
    ["src/application/tx.ts", 'import { x } from "@/adapters/sqlite";'],
    ["src/adapters/paypal.ts", 'import { x } from "@/application/tx";'],
    ["src/app/page.tsx", 'import { x } from "@/adapters/paypal";'],
  ])("blocks %s importing: %s", async (file, code) => {
    expect((await messages(file, code)).length).toBeGreaterThan(0);
  });

  it.each([
    ["src/domain/money.ts", 'import { x } from "./canonical";'],
    ["src/agents/buyer.ts", 'import { x } from "@/domain/offer";'],
    ["src/agents/buyer.ts", 'import { approvalRequirement } from "@/domain/mandate";'], // may READ the rules, never change them
    ["src/agents/buyer.ts", 'import { x } from "@/ports/agent-model";'],
    ["src/agents/model-agents.ts", 'import { x } from "@/ports/model-transport";'],
    ["src/agents/negotiation.ts", 'import { buildOfferView } from "@/domain/offer-view";'],
    ["src/application/negotiation-service.ts", 'import { runNegotiation } from "@/agents";'],
    ["src/adapters/llm/anthropic.ts", 'import { TransportError } from "@/ports/model-transport";'],
    ["src/application/tx.ts", 'import { x } from "@/ports/payment-provider";'],
    ["src/adapters/paypal.ts", 'import { x } from "@/ports/payment-provider";'],
    ["src/app/api/health/route.ts", 'import { x } from "@/application/health";'],
  ])("allows %s importing: %s", async (file, code) => {
    expect(await messages(file, code)).toEqual([]);
  });
});
