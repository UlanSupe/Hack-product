// Controlled live smoke test of the model provider: node scripts/agents-smoke.ts [--require]
// Makes ONE buyer "compare" call on a synthetic offer (no database, no payment, no PayPal) and reports what
// really happened. Without AGENT_MODE=llm, ANTHROPIC_API_KEY and AGENT_MODEL it makes no network call and
// says SKIPPED; that is NOT a pass. With --require, a skip exits 3 so a pipeline cannot mistake it for success.
// Prints statuses and counts only: never the key, the request, or any text the model returned.
import { existsSync } from "node:fs";

import { createLlmTransport } from "../src/adapters/llm/select.ts";
import { createBuyerAgent } from "../src/agents/index.ts";
import { parseEnv } from "../src/config/env.schema.ts";
import { AGENT_RUNTIME_LIMITS } from "../src/domain/agent-contract.ts";
import { buildOfferView } from "../src/domain/offer-view.ts";

for (const file of [".env.local", ".env"]) {
  if (existsSync(file)) process.loadEnvFile(file); // never overrides variables that are already set
}
const require = process.argv.includes("--require");
function skip(why: string): never {
  console.log(`SKIPPED (no model call was made): ${why}`);
  console.log("RESULT: live provider integration NOT VERIFIED.");
  process.exit(require ? 3 : 0);
}

const parsed = parseEnv(process.env);
if (!parsed.ok) {
  console.error("Invalid environment:");
  for (const i of parsed.issues) console.error(`  ${i.path}: ${i.message}`);
  process.exit(1);
}
const env = parsed.env;
if (env.AGENT_MODE !== "llm") skip("AGENT_MODE is not 'llm'.");
const apiKey = env.AGENT_PROVIDER === "groq" ? env.GROQ_API_KEY : env.ANTHROPIC_API_KEY;
if (apiKey === undefined || env.AGENT_MODEL === undefined)
  skip("the provider's API key or AGENT_MODEL is not set.");

const mandate = {
  currency: "USD",
  maxTransactionMinor: 10_000,
  remainingBudgetMinor: 15_000,
  approvalThresholdMinor: 5_000,
  requireReviewBeforeExecution: false,
  allowedCategories: ["COMPUTE", "STORAGE"],
} as const;
const offer = buildOfferView({
  offerId: "smoke-offer-1",
  sellerId: "seller_smoke",
  terms: {
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
  },
  mandate: { ...mandate, allowedCategories: [...mandate.allowedCategories] },
  sellerAllowed: true,
  catalog: null,
});

const timeoutMs = env.AGENT_TIMEOUT_MS ?? AGENT_RUNTIME_LIMITS.llmDefaultTimeoutMs;
const buyer = createBuyerAgent({
  model: createLlmTransport({
    provider: env.AGENT_PROVIDER,
    apiKey,
    model: env.AGENT_MODEL,
    maxOutputTokens: env.AGENT_MAX_OUTPUT_TOKENS,
  }),
  runtime: {
    timeoutMs,
    maxAttempts: env.AGENT_MAX_ATTEMPTS,
    totalDeadlineMs: timeoutMs * env.AGENT_MAX_ATTEMPTS,
  },
});

const started = Date.now();
const result = await buyer.compare({
  task: "COMPARE",
  request: {
    category: "COMPUTE",
    quantity: 1,
    summary: "One GPU pack for model training",
    maxTotalMinor: null,
    neededWithinDays: null,
    requiredDeliverables: [],
  },
  offers: [offer],
  mandate: { ...mandate, allowedCategories: [...mandate.allowedCategories] },
  round: 1,
  maxRounds: 3,
  answers: [],
});
const ms = Date.now() - started;

if (result.ok) {
  console.log(
    `OK: the provider answered and the reply passed the same validation as the mock agents.`,
  );
  console.log(
    `    output kind=${result.output.kind} attempts=${result.attempts} elapsed=${ms}ms model=${env.AGENT_MODEL}`,
  );
  console.log("RESULT: live provider integration VERIFIED by this run (one call, synthetic data).");
} else {
  const f = result.failure;
  console.log(
    `FAILED: kind=${f.kind} attempts=${f.attempts} elapsed=${ms}ms${f.reference ? ` request-id=${f.reference}` : ""}`,
  );
  console.log(`    ${f.message}`);
  console.log("RESULT: live provider integration NOT verified.");
  process.exit(1);
}
