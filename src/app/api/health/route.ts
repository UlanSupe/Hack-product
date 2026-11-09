import { NextResponse } from "next/server";

import pkg from "../../../../package.json";
import { buildHealth } from "@/application/health";
import { getDatabaseStatus } from "@/server/db";
import { EnvError, getEnv } from "@/server/env";

export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store" } as const;

export function GET(): NextResponse {
  try {
    const env = getEnv();
    const report = buildHealth({
      version: pkg.version,
      now: new Date(),
      paypalEnv: env.PAYPAL_ENV,
      paypalCredentialsPresent: env.PAYPAL_CLIENT_ID !== undefined,
      deployMode: env.DEPLOY_MODE,
      agentMode: env.AGENT_MODE,
      database: getDatabaseStatus(env),
    });
    return NextResponse.json(report, {
      status: report.status === "ok" ? 200 : 503,
      headers: NO_STORE,
    });
  } catch (err) {
    if (err instanceof EnvError) {
      // Variable names and messages only; EnvError never carries values.
      return NextResponse.json(
        { status: "error", issues: err.issues },
        { status: 503, headers: NO_STORE },
      );
    }
    return NextResponse.json({ status: "error" }, { status: 500, headers: NO_STORE });
  }
}
