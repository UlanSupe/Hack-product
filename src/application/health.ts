/** Pure diagnostic report. Contains presence flags only, never secret values or file paths. */
export type DatabaseHealth =
  | { state: "uninitialized" }
  | { state: "ready"; migrations: number; latest: string }
  | { state: "error" };

export type HealthInput = {
  version: string;
  now: Date;
  paypalEnv: "sandbox";
  paypalCredentialsPresent: boolean;
  deployMode: "local" | "demo";
  agentMode: "scripted" | "llm";
  database: DatabaseHealth;
};

export type HealthReport = {
  /** "degraded" means the service cannot serve requests (the route answers 503 so a platform can restart or hold traffic). */
  status: "ok" | "degraded";
  service: "pactpay-arena";
  version: string;
  time: string;
  deployMode: "local" | "demo";
  paypal: { env: "sandbox"; credentials: "present" | "absent"; callsEnabled: boolean };
  agents: { mode: "scripted" | "llm"; llmCallsEnabled: boolean };
  database: DatabaseHealth;
};

/**
 * Ready to serve: the database is not broken, and in demo mode it must also be migrated (startup guarantees that, so
 * anything else means the process was started some other way). A local run without a database stays "ok" so a
 * fresh checkout can still show the Arena.
 */
function readyToServe(input: HealthInput): boolean {
  if (input.database.state === "error") return false;
  return input.deployMode !== "demo" || input.database.state === "ready";
}

export function buildHealth(input: HealthInput): HealthReport {
  return {
    status: readyToServe(input) ? "ok" : "degraded",
    service: "pactpay-arena",
    version: input.version,
    time: input.now.toISOString(),
    deployMode: input.deployMode,
    // PayPal and model calls happen only when the signed-in operator starts a step, and PayPal only with credentials.
    paypal: {
      env: input.paypalEnv,
      credentials: input.paypalCredentialsPresent ? "present" : "absent",
      callsEnabled: input.paypalCredentialsPresent,
    },
    agents: { mode: input.agentMode, llmCallsEnabled: input.agentMode === "llm" },
    database: input.database,
  };
}
