import { buildJourney, recentOf } from "@/application/journey";
import type { NegotiationDetail } from "@/application/negotiation-views";
import type { PaymentView } from "@/application/payment-views";
import { NotFoundError } from "@/domain/errors";
import { loadCockpit } from "@/server/cockpit";
import { HttpError, json } from "@/server/http";
import { negotiationRoute } from "@/server/negotiation-route";
import { getPayments } from "@/server/payment-service";

export const dynamic = "force-dynamic";

/** A negotiation id as the services mint them. Anything else is refused before it reaches a query. */
const ID = /^[A-Za-z0-9_-]{1,64}$/;

/**
 * Where the operator is in the journey, derived from stored state only. Operator-only and read-only, like every other
 * read of the operator's records (agents are refused even with a cookie). No PayPal call, no write, no parameter other
 * than the negotiation id, which is validated and then looked up like any other id.
 */
export function GET(request: Request) {
  return negotiationRoute(request, "read", ({ actor, service }) => {
    const raw = new URL(request.url).searchParams.get("negotiation");
    if (raw !== null && !ID.test(raw))
      throw new HttpError(400, "INVALID_PARAMETER", "The negotiation id is not valid.");

    const overview = service.overview(actor);
    const detail: NegotiationDetail | null = raw === null ? null : service.detail(actor, raw);

    const payments = getPayments();
    let payment: PaymentView | null = null;
    if (detail?.active) {
      try {
        payment = payments.service.view(actor, detail.id);
      } catch (err) {
        if (!(err instanceof NotFoundError)) throw err;
      }
    }

    // The audit state is the Cockpit's own computation for this transaction's row, so the two screens agree.
    let audit = null;
    if (detail?.active) {
      const row = loadCockpit(request.headers).rows.find(
        (r) => r.id === `tx:${detail.active?.transactionId}`,
      );
      audit =
        row?.auditChain === "VERIFIED" ||
        row?.auditChain === "BROKEN" ||
        row?.auditChain === "NO_EVENTS" ||
        row?.auditChain === "UNKNOWN"
          ? row.auditChain
          : null;
    }

    return json({
      recent: recentOf(overview),
      journey: buildJourney({
        overview,
        detail,
        payment,
        paypalConfigured: payments.configured,
        audit,
      }),
    });
  });
}
