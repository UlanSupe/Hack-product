import { NextResponse } from "next/server";

import { runExperiment } from "@/application/arena";
import { BRAIN_PROFILES } from "@/domain/experiment";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ scenarioId: string }> };

const HEADERS = { "Cache-Control": "no-store" };

/**
 * Replays one scenario through both buyer modes. Public and read-only on purpose: it takes two known ids, runs a pure
 * function over fixed scenario data, spends only on in-memory simulated ledgers, and reads no credential, database or
 * network. The same ids always return the same `runHash`.
 */
export async function GET(request: Request, { params }: Ctx) {
  const { scenarioId } = await params;
  const raw = new URL(request.url).searchParams.get("brain");
  const brain = raw === null ? "SUSCEPTIBLE" : BRAIN_PROFILES.find((b) => b === raw);
  if (brain === undefined) {
    return NextResponse.json(
      { error: "INVALID_BRAIN", message: `brain must be one of ${BRAIN_PROFILES.join(", ")}` },
      { status: 400, headers: HEADERS },
    );
  }
  const result = runExperiment({ scenarioId, brain });
  if (!result) {
    return NextResponse.json(
      { error: "NOT_FOUND", message: "No such scenario." },
      { status: 404, headers: HEADERS },
    );
  }
  return NextResponse.json({ result }, { headers: HEADERS });
}
