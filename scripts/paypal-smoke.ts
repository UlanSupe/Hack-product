// Controlled PayPal SANDBOX connectivity check: node scripts/paypal-smoke.ts [--create-order] [--require]
//
//   (default)        Requests an OAuth token and prints ONLY its metadata (HTTP outcome, lifetime, permission names).
//   --create-order   Additionally creates ONE unapproved AUTHORIZE order of 1.00 USD with a fresh request id, reads it
//                    back, and prints ids, statuses and the payee merchant id (so you can set PAYPAL_MERCHANT_ID).
//   --require        Exit 3 instead of 0 when nothing could be checked (no credentials), for pipelines.
//
// It never authorizes, captures, voids or pays out: an order nobody has approved cannot move money. It never prints
// the client id, the client secret, the access token, request bodies or any text PayPal sent; failures are reduced to
// an HTTP status, a kind, issue codes and PayPal's debug id. Without credentials it makes no network call and says so.
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";

import { createPayPalClient } from "../src/adapters/paypal/client.ts";
import { createPayPalProvider } from "../src/adapters/paypal/provider.ts";
import { parseEnv } from "../src/config/env.schema.ts";
import { checkOrder } from "../src/domain/payment.ts";
import { ProviderError } from "../src/ports/payment-provider.ts";

for (const file of [".env.local", ".env"]) {
  if (existsSync(file)) process.loadEnvFile(file); // never overrides variables that are already set
}
const require = process.argv.includes("--require");
const createOrder = process.argv.includes("--create-order");

function skip(why: string): never {
  console.log(`SKIPPED (no PayPal call was made): ${why}`);
  console.log("RESULT: PayPal sandbox connectivity NOT VERIFIED.");
  process.exit(require ? 3 : 0);
}

function describe(err: unknown): string {
  if (err instanceof ProviderError) {
    return `kind=${err.kind} http=${err.httpStatus ?? "none"} outcome=${err.outcome}${err.issues.length > 0 ? ` issues=${err.issues.join(",")}` : ""}${err.debugId ? ` debug-id=${err.debugId}` : ""}`;
  }
  return "an unexpected error (details withheld)";
}

const parsed = parseEnv(process.env);
if (!parsed.ok) {
  console.error("Invalid environment:");
  for (const i of parsed.issues) console.error(`  ${i.path}: ${i.message}`);
  process.exit(1);
}
const env = parsed.env;
if (env.PAYPAL_CLIENT_ID === undefined || env.PAYPAL_CLIENT_SECRET === undefined)
  skip("PAYPAL_CLIENT_ID / PAYPAL_CLIENT_SECRET are not set.");

const options = {
  clientId: env.PAYPAL_CLIENT_ID,
  clientSecret: env.PAYPAL_CLIENT_SECRET,
  timeoutMs: env.PAYPAL_TIMEOUT_MS,
};

// 1. Token.
try {
  const meta = await createPayPalClient(options).probe();
  console.log(`OK: PayPal sandbox issued an access token (lifetime ${meta.expiresInSeconds}s).`);
  console.log(
    `    permissions: ${meta.scopes.length === 0 ? "(none reported)" : meta.scopes.join(" ")}`,
  );
  const need = [
    "https://uri.paypal.com/services/payments/payment",
    "https://uri.paypal.com/services/payments/payment/authcapture",
  ];
  const missing = need.filter((n) => !meta.scopes.includes(n));
  if (missing.length > 0)
    console.log(`    NOTE: not reported: ${missing.join(" ")} (docs/PAYPAL_INTEGRATION.md Q1)`);
} catch (err) {
  console.log(`FAILED: could not get an access token: ${describe(err)}`);
  console.log("RESULT: PayPal sandbox connectivity NOT verified.");
  process.exit(1);
}

if (!createOrder) {
  console.log(
    "RESULT: token acquisition VERIFIED by this run. No order was created (use --create-order).",
  );
  process.exit(0);
}

// 2. One unapproved order, read back.
const provider = createPayPalProvider({
  ...options,
  experienceContext: env.PAYPAL_EXPERIENCE_CONTEXT,
});
const run = randomUUID().replaceAll("-", "").slice(0, 16);
const customId = `smoke-${run}`;
const invoiceId = `SMOKE-${run}`;
const base = env.APP_BASE_URL.replace(/\/+$/, "");
try {
  const created = await provider.createOrder({
    requestId: `smoke:${run}:CREATE_ORDER:1`,
    amountMinor: 100,
    currency: "USD",
    customId,
    invoiceId,
    description: "PactPay Arena sandbox connectivity check",
    returnUrl: `${base}/api/paypal/return`,
    cancelUrl: `${base}/negotiations`,
  });
  console.log(
    `OK: created order ${created.orderId} (HTTP ${created.httpStatus}, status ${created.status}).`,
  );
  const order = await provider.getOrder(created.orderId);
  const expectation = {
    amountMinor: 100,
    currency: "USD",
    customId,
    invoiceId,
    merchantId: env.PAYPAL_MERCHANT_ID ?? null,
  };
  const { findings, payee } = checkOrder(order, expectation);
  console.log(
    `    read back: status=${order.status} intent=${order.intent ?? "none"} units=${order.purchaseUnitCount}`,
  );
  console.log(
    `    amount=${order.amount ? `${order.amount.minor} minor ${order.amount.currency}` : "missing"} approve-link=${order.approveUrl ? new URL(order.approveUrl).host : "none"}`,
  );
  console.log(
    `    payee merchant id reported by PayPal: ${order.payeeMerchantId ?? "(not reported)"}`,
  );
  console.log(
    `    payee check: ${payee}${payee === "NOT_PINNED" ? " (set PAYPAL_MERCHANT_ID to the id above to pin it)" : ""}`,
  );
  console.log(`    findings: ${findings.length === 0 ? "none" : findings.join(", ")}`);
  const ok = findings.length === 0;
  console.log(
    ok
      ? "RESULT: order creation and read-back VERIFIED by this run (one unapproved sandbox order; nothing authorized or charged)."
      : "RESULT: order created, but PayPal's answer did NOT match what was sent. NOT verified.",
  );
  process.exit(ok ? 0 : 1);
} catch (err) {
  console.log(`FAILED: ${describe(err)}`);
  console.log("RESULT: order creation NOT verified.");
  process.exit(1);
}
