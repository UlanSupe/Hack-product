import { NextResponse } from "next/server";

import { SCENARIOS, summarizeAll } from "@/application/arena";
import { BRAIN_PROFILES } from "@/domain/experiment";

export const dynamic = "force-dynamic";

/** The scenario list and, for each simulated model, what both buyers did in each scenario. Pure and read-only. */
export function GET() {
  return NextResponse.json(
    {
      scenarios: SCENARIOS.map((s) => ({
        id: s.id,
        title: s.title,
        kind: s.kind,
        threat: s.threat,
      })),
      summary: Object.fromEntries(BRAIN_PROFILES.map((b) => [b, summarizeAll(b)])),
    },
    { headers: { "Cache-Control": "no-store" } },
  );
}
