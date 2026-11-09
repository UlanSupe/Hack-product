import { json } from "@/server/http";
import { paymentRoute } from "@/server/payment-route";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

/** The payment for the negotiation's active agreement, from stored state only (no PayPal call). */
export async function GET(request: Request, { params }: Ctx) {
  const { id } = await params;
  return paymentRoute(request, "read", ({ actor, service }) =>
    json({ payment: service.view(actor, id) }),
  );
}

/** Starts the PayPal sandbox payment. The body must be empty: everything is taken from the server's records. */
export async function POST(request: Request, { params }: Ctx) {
  const { id } = await params;
  return paymentRoute(request, "write", async ({ actor, service }) => {
    const { view, ...result } = await service.start(actor, id);
    return json({ payment: view, result });
  });
}
