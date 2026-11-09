import "server-only";

import type { NextResponse } from "next/server";

import type { OperatorActor } from "@/application/mandates";
import type { NegotiationDemo } from "@/application/negotiation-demo";
import type { NegotiationService } from "@/application/negotiations";
import { authenticateOperator } from "./operator-guard";
import { errorResponse, readJsonBody } from "./http";
import { getNegotiation } from "./negotiation-service";

type Context = {
  actor: OperatorActor;
  service: NegotiationService;
  demo: NegotiationDemo;
  body: unknown;
};

/**
 * Wraps a negotiation route exactly like the mandate routes: the human operator is authenticated FIRST
 * (agents are refused outright, even with a cookie), then the bounded JSON body for writes, then the service.
 * Agents act inside the server through the service; they have no HTTP path to any of this.
 */
export async function negotiationRoute(
  request: Request,
  kind: "read" | "write",
  handler: (ctx: Context) => NextResponse | Promise<NextResponse>,
): Promise<NextResponse> {
  try {
    const { actor } = authenticateOperator(request, { mutating: kind === "write" });
    const body = kind === "write" ? await readJsonBody(request) : undefined;
    return await handler({ actor, ...getNegotiation(), body });
  } catch (err) {
    return errorResponse(err);
  }
}

/** Merges ids taken from the URL over the body, so a body can never retarget another resource. */
export function withIds(body: unknown, ids: Record<string, string>): unknown {
  return body !== null && typeof body === "object" && !Array.isArray(body)
    ? { ...body, ...ids }
    : body;
}
