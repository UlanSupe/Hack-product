import "server-only";

import {
  CSRF_HEADER,
  LoginThrottle,
  SESSION_COOKIE,
  csrfMatches,
  readCookie,
  verifySession,
  type VerifiedSession,
} from "@/application/operator-session";
import type { OperatorActor } from "@/application/mandates";
import { ForbiddenError, UnauthorizedError } from "@/domain/errors";
import { getEnv } from "./env";
import { HttpError } from "./http";

/** The single operator of this demo. */
export const OPERATOR_ACTOR: OperatorActor = { kind: "OPERATOR", id: "demo_operator" };

/** Shared by the login route; one process, one operator. */
export const loginThrottle = new LoginThrottle();

export function operatorPasscode(): string | undefined {
  return getEnv().OPERATOR_PASSCODE;
}

/** The deployment's own public origin (APP_BASE_URL). Behind a proxy this is what the browser actually sees. */
export function publicOrigin(): string {
  return new URL(getEnv().APP_BASE_URL).origin;
}

/** Same-origin check for state-changing requests (on top of the SameSite=Lax cookie and the CSRF token). */
export function assertSameOrigin(request: Request): void {
  const origin = request.headers.get("origin");
  if (origin !== null && origin !== new URL(request.url).origin && origin !== publicOrigin()) {
    throw new ForbiddenError("cross-origin requests are not allowed");
  }
  if (request.headers.get("sec-fetch-site") === "cross-site") {
    throw new ForbiddenError("cross-site requests are not allowed");
  }
}

export type Authenticated = { actor: OperatorActor; session: VerifiedSession };

/**
 * Authenticates the human operator. Order matters: configuration, then agent refusal, then session, then
 * (for changes) origin and CSRF. Anything that declares itself an agent is refused outright, even if it
 * somehow also carries a valid operator cookie.
 */
export function authenticateOperator(
  request: Request,
  options: { mutating: boolean; nowMs?: number },
): Authenticated {
  const passcode = operatorPasscode();
  if (passcode === undefined) {
    throw new HttpError(
      503,
      "OPERATOR_NOT_CONFIGURED",
      "Operator access is not configured on this server. Set OPERATOR_PASSCODE (at least 16 characters).",
    );
  }
  if (request.headers.has("x-agent-id") || request.headers.has("authorization")) {
    throw new ForbiddenError(
      "AI agents cannot view or change mandates; this requires the human operator's browser session",
    );
  }
  const session = verifySession(
    passcode,
    readCookie(request.headers.get("cookie"), SESSION_COOKIE),
    options.nowMs ?? Date.now(),
  );
  if (!session) throw new UnauthorizedError("sign in as the operator first");
  if (options.mutating) {
    assertSameOrigin(request);
    if (!csrfMatches(session, request.headers.get(CSRF_HEADER)))
      throw new ForbiddenError("missing or invalid CSRF token");
  }
  return { actor: OPERATOR_ACTOR, session };
}
