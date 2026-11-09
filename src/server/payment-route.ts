import "server-only";

import type { NextResponse } from "next/server";
import { z } from "zod";

import type { OperatorActor } from "@/application/mandates";
import type { PaymentService } from "@/application/payments";
import { authenticateOperator } from "./operator-guard";
import { errorResponse, HttpError, readJsonBody } from "./http";
import { getPayments } from "./payment-service";

type Context = { actor: OperatorActor; service: PaymentService };

/** A payment request carries NO parameters: the amount, currency, payee, agreement and transaction come from the server's records. */
const NoParameters = z.strictObject({});

/**
 * Operator-only wrapper for the payment routes, in the same order as the other operator routes: authenticate the
 * human first (agents are refused even with a cookie), then, for a change, the bounded JSON body, which must be empty.
 * A browser therefore cannot propose an amount, a currency, a payee or an id; if it tries, the request is refused.
 */
export async function paymentRoute(
  request: Request,
  kind: "read" | "write",
  handler: (ctx: Context) => NextResponse | Promise<NextResponse>,
): Promise<NextResponse> {
  try {
    const { actor } = authenticateOperator(request, { mutating: kind === "write" });
    if (kind === "write") {
      const body = await readJsonBody(request);
      if (!NoParameters.safeParse(body).success) {
        throw new HttpError(
          400,
          "NO_PARAMETERS_ALLOWED",
          "This request takes no parameters: amounts, currencies, payees and ids come from the server's records.",
        );
      }
    }
    return await handler({ actor, service: getPayments().service });
  } catch (err) {
    return errorResponse(err);
  }
}
