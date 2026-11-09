import { describe, expect, it } from "vitest";

import { buildHealth } from "./health";

const base = {
  version: "1.2.3",
  now: new Date("2026-10-11T12:00:00.000Z"),
  paypalEnv: "sandbox",
  deployMode: "local",
  agentMode: "scripted",
  database: { state: "uninitialized" },
} as const;

describe("buildHealth", () => {
  it("reports credential presence as a flag only; PayPal calls are possible only with credentials", () => {
    const r = buildHealth({ ...base, paypalCredentialsPresent: true });
    expect(r).toMatchObject({
      status: "ok",
      version: "1.2.3",
      time: "2026-10-11T12:00:00.000Z",
      paypal: { env: "sandbox", credentials: "present", callsEnabled: true },
      agents: { mode: "scripted", llmCallsEnabled: false },
    });
    expect(buildHealth({ ...base, paypalCredentialsPresent: false }).paypal.credentials).toBe(
      "absent",
    );
  });

  it("passes the database state through unchanged", () => {
    const ready = { state: "ready", migrations: 4, latest: "0004_attack_runs" } as const;
    expect(
      buildHealth({ ...base, paypalCredentialsPresent: false, database: ready }).database,
    ).toEqual(ready);
  });
});
