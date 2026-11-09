import { json } from "@/server/http";
import { paymentRoute } from "@/server/payment-route";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

/** Places the hold after PayPal itself reports the buyer approved. Empty body. It never captures. */
export async function POST(request: Request, { params }: Ctx) {
  const { id } = await params;
  return paymentRoute(request, "write", async ({ actor, service }) => {
    const { view, ...result } = await service.authorize(actor, id);
    return json({ payment: view, result });
  });
}
