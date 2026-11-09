// Hosted start: node scripts/start.ts  (npm run start:demo)
// Validates the configuration, prepares the database, then runs `next start`. Runs on Node's native TypeScript support.
//
// It reads ONLY the process environment: no .env file is loaded, so a hosted instance can never silently pick up local
// settings. It prints variable NAMES and yes/no flags, never a value, a path or a secret.
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { resolve } from "node:path";

import { prepareDatabase } from "../src/adapters/sqlite/bootstrap.ts";
import { parseEnv } from "../src/config/env.schema.ts";

const say = (line: string) => console.log(`[startup] ${line}`);
const refuse = (lines: string[]): never => {
  console.error("[startup] refusing to start:");
  for (const l of lines) console.error(`[startup]   ${l}`);
  process.exit(1);
};

const parsed = parseEnv(process.env);
if (!parsed.ok) refuse(parsed.issues.map((i) => `${i.path}: ${i.message}`));
const env = parsed.ok ? parsed.env : (undefined as never);
const demo = env.DEPLOY_MODE === "demo";

const problems: string[] = [];
const port = process.env.PORT === undefined || process.env.PORT === "" ? "3000" : process.env.PORT;
if (!/^[0-9]{1,5}$/.test(port) || Number(port) < 1 || Number(port) > 65535)
  problems.push("PORT: must be a whole number from 1 to 65535");
if (demo && process.env.NODE_ENV !== "production")
  problems.push("NODE_ENV: must be 'production' in demo mode");
if (problems.length > 0) refuse(problems);

let dbSummary: string;
try {
  const r = prepareDatabase(resolve(env.DATABASE_PATH), {
    seed: demo,
    now: new Date().toISOString(),
  });
  if (r.chain === "FAILED") refuse(["database: the audit chain does not verify; not serving it"]);
  dbSummary = `migrations_applied=${r.applied.length} seeded=${r.seeded} audit_chain=${r.chain.toLowerCase()} audit_events=${r.auditEvents}`;
} catch {
  // The cause can contain a file path; the platform's disk settings are the place to look (docs/DEPLOYMENT.md).
  refuse([
    "database: could not be created or migrated (check DATABASE_PATH and that its directory is writable)",
  ]);
  process.exit(1);
}

say(
  [
    `mode=${env.DEPLOY_MODE}`,
    `port=${port}`,
    `base_url_host=${new URL(env.APP_BASE_URL).host}`,
    dbSummary,
    `operator=${env.OPERATOR_PASSCODE === undefined ? "not-configured" : "configured"}`,
    `paypal=sandbox,credentials-${env.PAYPAL_CLIENT_ID === undefined ? "absent" : "present"}`,
    `webhook=${env.PAYPAL_WEBHOOK_ID === undefined ? "not-configured" : "configured"}`,
    `agents=${env.AGENT_MODE}`,
  ].join(" "),
);

const nextBin = createRequire(import.meta.url).resolve("next/dist/bin/next");
const child = spawn(process.execPath, [nextBin, "start", "-H", "0.0.0.0", "-p", port], {
  stdio: "inherit",
  env: process.env,
});
for (const sig of ["SIGTERM", "SIGINT"] as const) process.on(sig, () => child.kill(sig));
child.on("exit", (code, signal) => process.exit(code ?? (signal === null ? 0 : 1)));
