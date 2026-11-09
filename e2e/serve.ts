// Test server for the Playwright suite: node e2e/serve.ts
// A fresh throwaway database (OS temp directory) with the synthetic demo data, then `next start` on the production build.
// Reads only the variables below; sets no PayPal credential, no model key and no .env file.
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { prepareDatabase } from "../src/adapters/sqlite/bootstrap.ts";
import { openDatabase } from "../src/adapters/sqlite/database.ts";
import {
  createSeller,
  insertMandateVersion,
  upsertCatalogItem,
} from "../src/adapters/sqlite/store.ts";

const port = process.env.E2E_PORT ?? "3140";
const passcode = process.env.E2E_PASSCODE;
if (passcode === undefined || passcode.length < 16) {
  console.error("[e2e] E2E_PASSCODE is required (set by playwright.config.ts)");
  process.exit(1);
}

// The Cockpit analytics test reads the persisted benchmark results, which are generated and git-ignored, so a clean checkout
// has none. Produce them (seeded and deterministic, a few seconds, no network) instead of making `npm run e2e` depend on an
// undocumented earlier step. An existing file is left alone.
if (!existsSync(join("benchmark-results", "benchmark.json"))) {
  console.log(
    "[e2e] benchmark-results/benchmark.json is missing; running `npm run benchmark` once",
  );
  const r = spawnSync("npm", ["run", "benchmark"], { stdio: "inherit", shell: true });
  if (r.status !== 0) {
    console.error("[e2e] the benchmark did not complete; the Cockpit analytics test cannot run");
    process.exit(1);
  }
}

const path = join(mkdtempSync(join(tmpdir(), "pactpay-e2e-")), "e2e.db");
// Same synthetic data as `npm run db:seed` (two made-up sellers, a catalog, mandate M1: 100.00 per purchase, approval above
// 90.00, COMPUTE, seller_acme only), except for a total budget of 5,000.00 instead of 150.00, so that dozens of agreements in one
// run do not exhaust it. Every other rule is the product's own.
const now = new Date().toISOString();
prepareDatabase(path, { seed: false, now });
const db = openDatabase(path);
createSeller(db, {
  id: "seller_acme",
  displayName: "Acme Compute (synthetic)",
  payeeRef: "payee_acme",
  now,
});
createSeller(db, {
  id: "seller_backup_demo",
  displayName: "Backup Reseller (synthetic, not allowed)",
  payeeRef: "payee_backup_demo",
  now,
});
for (const [sku, unitPriceMinor] of [
  ["GPU-PACK", 8_000],
  ["GPU-PACK-S", 6_000],
  ["GPU-PACK-XL", 45_000],
] as const)
  upsertCatalogItem(db, {
    sellerId: "seller_acme",
    sku,
    unitPriceMinor,
    currency: "USD",
    category: "COMPUTE",
  });
insertMandateVersion(db, {
  id: "M1",
  ownerId: "demo_operator",
  perTxCapMinor: 10_000,
  totalBudgetMinor: 500_000,
  approvalThresholdMinor: 9_000,
  requireReview: false,
  currency: "USD",
  allowedCategories: ["COMPUTE"],
  allowedSellerIds: ["seller_acme"],
  expiresAt: new Date(Date.now() + 365 * 24 * 3600 * 1000).toISOString(),
  status: "ACTIVE",
  now,
});
db.close();

const env: NodeJS.ProcessEnv = {
  NODE_ENV: "production",
  PATH: process.env.PATH ?? "",
  SystemRoot: process.env.SystemRoot ?? "",
  DATABASE_PATH: path,
  OPERATOR_PASSCODE: passcode,
  APP_BASE_URL: `http://localhost:${port}`,
  AGENT_MODE: "scripted",
  PORT: port,
};
const nextBin = createRequire(import.meta.url).resolve("next/dist/bin/next");
const child = spawn(process.execPath, [nextBin, "start", "-p", port], { stdio: "inherit", env });
for (const sig of ["SIGTERM", "SIGINT"] as const) process.on(sig, () => child.kill(sig));
child.on("exit", (code) => process.exit(code ?? 0));
