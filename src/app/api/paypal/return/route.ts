import { NextResponse } from "next/server";

import { UnauthorizedError, UpstreamError } from "@/domain/errors";
import { errorResponse } from "@/server/http";
import { authenticateOperator, publicOrigin } from "@/server/operator-guard";
import { getPayments } from "@/server/payment-service";

export const dynamic = "force-dynamic";

/** PayPal order ids are upper-case letters and digits (at most 36), in the `token` query parameter. */
const ORDER_ID = /^[A-Z0-9]{1,36}$/;

/**
 * Where the buyer lands after approving (or cancelling) at PayPal. This is an UNTRUSTED redirect: nothing in the
 * query string says the order was approved or paid, and none of it is used as evidence. The id is only a lookup key
 * into our own records (an unknown id is refused before any PayPal call), and the server then ASKS PayPal what
 * happened. Only the signed-in operator's browser may trigger it; without a session the buyer is redirected to the console
 * to sign in (the session cookie is SameSite=Lax so that a normal return from PayPal does carry it).
 */
export async function GET(request: Request) {
  const url = new URL(request.url);
  const origin = publicOrigin(); // behind a proxy request.url may be an internal address
  try {
    const { actor } = authenticateOperator(request, { mutating: false });
    const token = url.searchParams.get("token");
    if (token === null || !ORDER_ID.test(token)) {
      return NextResponse.redirect(new URL("/negotiations?payment=unknown", origin), 303);
    }
    const result = await getPayments().service.confirmReturn(actor, token);
    // The negotiation id comes from our own record of the order, so the console reopens the same transaction.
    const back = `/negotiations?payment=checked&n=${encodeURIComponent(result.view.negotiationId)}`;
    return NextResponse.redirect(new URL(back, origin), 303);
  } catch (err) {
    // No (or an expired) operator session: the buyer is sent back to the console, which asks them to sign in and then check
    // the status. Nothing was read from PayPal and nothing from the query string is echoed.
    if (err instanceof UnauthorizedError) {
      return NextResponse.redirect(new URL("/negotiations?payment=signin", origin), 303);
    }
    if (err instanceof UpstreamError) {
      return NextResponse.redirect(new URL("/negotiations?payment=unavailable", origin), 303);
    }
    return errorResponse(err);
  }
}
