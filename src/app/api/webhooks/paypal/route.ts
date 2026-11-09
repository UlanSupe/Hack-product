import { NextResponse } from "next/server";

import { MAX_WEBHOOK_BODY_BYTES } from "@/application/webhooks";
import { HttpError, readBoundedText } from "@/server/http";
import { getWebhooks } from "@/server/webhook-service";

export const dynamic = "force-dynamic";

/**
 * PayPal's webhook endpoint. There is no operator session here and no CSRF token: a request is trusted only if PayPal's
 * own verification service confirms its signature (done inside the webhook service). The body is read as text so the
 * bytes can be verified exactly as received. Responses carry codes only: no secret, no PayPal text, no stack.
 */
export async function POST(request: Request) {
  const headers = { "Cache-Control": "no-store" };
  try {
    // Bounded while reading: a missing or false Content-Length cannot make the server buffer an unbounded body.
    let rawBody: string;
    try {
      rawBody = await readBoundedText(request, MAX_WEBHOOK_BODY_BYTES);
    } catch (err) {
      if (err instanceof HttpError && err.status === 413)
        return NextResponse.json(
          { status: "REJECTED", reason: "BODY_TOO_LARGE" },
          { status: 413, headers },
        );
      throw err;
    }
    const result = await getWebhooks().handle({
      header: (name) => request.headers.get(name),
      rawBody,
    });
    return NextResponse.json(
      { status: result.status, reason: result.reason },
      { status: result.http, headers },
    );
  } catch {
    return NextResponse.json(
      { status: "RETRY", reason: "INTERNAL_ERROR" },
      { status: 500, headers },
    );
  }
}
