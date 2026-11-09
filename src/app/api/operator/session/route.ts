import { z } from "zod";

import {
  SESSION_COOKIE,
  SESSION_TTL_MS,
  issueSession,
  passcodeMatches,
  readCookie,
  verifySession,
} from "@/application/operator-session";
import { getEnv } from "@/server/env";
import { HttpError, errorResponse, json, readJsonBody } from "@/server/http";
import {
  assertSameOrigin,
  authenticateOperator,
  loginThrottle,
  operatorPasscode,
} from "@/server/operator-guard";

export const dynamic = "force-dynamic";

const LoginBody = z.strictObject({ passcode: z.string().min(1).max(256) });

const NOT_CONFIGURED = new HttpError(
  503,
  "OPERATOR_NOT_CONFIGURED",
  "Operator access is not configured on this server. Set OPERATOR_PASSCODE (at least 16 characters).",
);

function cookie(request: Request, value: string, maxAgeSeconds: number): string {
  const secure =
    new URL(request.url).protocol === "https:" ||
    new URL(getEnv().APP_BASE_URL).protocol === "https:";
  return `${SESSION_COOKIE}=${value}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${maxAgeSeconds}${secure ? "; Secure" : ""}`;
}

/** Session status: only whether you are signed in, never anything about the passcode. */
export function GET(request: Request) {
  try {
    const passcode = operatorPasscode();
    if (passcode === undefined) return json({ configured: false, authenticated: false });
    const session = verifySession(
      passcode,
      readCookie(request.headers.get("cookie"), SESSION_COOKIE),
      Date.now(),
    );
    return json(
      session
        ? {
            configured: true,
            authenticated: true,
            csrfToken: session.csrfToken,
            expiresAt: session.expiresAt,
          }
        : { configured: true, authenticated: false },
    );
  } catch (err) {
    return errorResponse(err);
  }
}

export async function POST(request: Request) {
  try {
    const passcode = operatorPasscode();
    if (passcode === undefined) throw NOT_CONFIGURED;
    assertSameOrigin(request);
    const now = Date.now();
    if (!loginThrottle.allowed(now)) {
      throw new HttpError(
        429,
        "TOO_MANY_ATTEMPTS",
        "Too many failed attempts. Wait a minute and try again.",
        { "Retry-After": "60" },
      );
    }
    const body = LoginBody.safeParse(await readJsonBody(request));
    if (!body.success) throw new HttpError(400, "INVALID_REQUEST", 'Send {"passcode": "..."}.');
    if (!passcodeMatches(passcode, body.data.passcode)) {
      loginThrottle.recordFailure(now);
      throw new HttpError(401, "INVALID_PASSCODE", "Incorrect passcode.");
    }
    loginThrottle.reset();
    const session = issueSession(passcode, now);
    return json(
      {
        configured: true,
        authenticated: true,
        csrfToken: session.csrfToken,
        expiresAt: session.expiresAt,
      },
      200,
      { "Set-Cookie": cookie(request, session.token, Math.floor(SESSION_TTL_MS / 1000)) },
    );
  } catch (err) {
    return errorResponse(err);
  }
}

/** Sign out. Needs a valid session and CSRF token like any other change. */
export function DELETE(request: Request) {
  try {
    authenticateOperator(request, { mutating: true });
    return json({ configured: true, authenticated: false }, 200, {
      "Set-Cookie": cookie(request, "", 0),
    });
  } catch (err) {
    return errorResponse(err);
  }
}
