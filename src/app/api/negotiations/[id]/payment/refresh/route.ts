import { json } from "@/server/http";
import { paymentRoute } from "@/server/payment-route";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

/** Asks PayPal what really happened and records it. Also how an unknown outcome is settled. Empty body. */
export async function POST(request: Request, { params }: Ctx) {
  const { id } = await params;
  return paymentRoute(request, "write", async ({ actor, service }) => {
    const { view, ...result } = await service.refresh(actor, id);
    return json({ payment: view, result });
  });
}
