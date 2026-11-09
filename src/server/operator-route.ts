import "server-only";

import type { NextResponse } from "next/server";

import type { MandateService, OperatorActor, Result } from "@/application/mandates";
import { authenticateOperator } from "./operator-guard";
import { errorResponse, json, readJsonBody, validationFailed } from "./http";
import { getMandateService } from "./mandate-service";

type Context = { actor: OperatorActor; service: MandateService; body: unknown };

/**
 * Wraps a mandate route. Authentication happens FIRST (so an unauthenticated caller makes the server parse
 * nothing and open nothing), then the bounded JSON body for writes, then the service.
 */
export async function operatorRoute(
  request: Request,
  kind: "read" | "write",
  handler: (ctx: Context) => NextResponse | Promise<NextResponse>,
): Promise<NextResponse> {
  try {
    const { actor } = authenticateOperator(request, { mutating: kind === "write" });
    const body = kind === "write" ? await readJsonBody(request) : undefined;
    return await handler({ actor, service: getMandateService(), body });
  } catch (err) {
    return errorResponse(err);
  }
}

/** 200/201 with `{ [key]: value }`, or 422 with per-field errors. */
export function fromResult<T>(result: Result<T>, key: string, status = 200): NextResponse {
  return result.ok ? json({ [key]: result.value }, status) : validationFailed(result.errors);
}

/** Merges the id taken from the URL over the body, so a body can never retarget another resource. */
export function withUrlId(body: unknown, field: string, id: string): unknown {
  return body !== null && typeof body === "object" && !Array.isArray(body)
    ? { ...body, [field]: id }
    : body;
}
