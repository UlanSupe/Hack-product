import { NextResponse } from "next/server";

import { BRAIN_PROFILES } from "@/domain/experiment";
import { FLAGSHIP_VARIANTS, runFlagship } from "@/server/flagship";
import { errorResponse } from "@/server/http";
import { takePublicCompute } from "@/server/public-limit";

export const dynamic = "force-dynamic";

const HEADERS = { "Cache-Control": "no-store" };

/**
 * Runs the flagship budget-escalation attack and returns every record it produced (decisions, reason codes, the audit
 * trail). Public and read-only: it takes two known names, uses a throwaway in-memory database and simulated money, and
 * reads no credential or network. Anything else in the URL is ignored.
 */
export function GET(request: Request) {
  try {
    takePublicCompute();
  } catch (err) {
    return errorResponse(err);
  }
  const params = new URL(request.url).searchParams;
  const rawVariant = params.get("variant");
  const rawBrain = params.get("brain");
  const variant =
    rawVariant === null ? "ESCALATE_36" : FLAGSHIP_VARIANTS.find((v) => v === rawVariant);
  const brain = rawBrain === null ? "SUSCEPTIBLE" : BRAIN_PROFILES.find((b) => b === rawBrain);
  if (variant === undefined || brain === undefined) {
    return NextResponse.json(
      {
        error: "INVALID_PARAMETER",
        message: `variant must be one of ${FLAGSHIP_VARIANTS.join(", ")}; brain one of ${BRAIN_PROFILES.join(", ")}`,
      },
      { status: 400, headers: HEADERS },
    );
  }
  return NextResponse.json({ result: runFlagship({ variant, brain }) }, { headers: HEADERS });
}
