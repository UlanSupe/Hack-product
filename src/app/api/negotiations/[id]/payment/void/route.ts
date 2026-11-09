import { json } from "@/server/http";
import { paymentRoute } from "@/server/payment-route";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

/** Releases the hold. Empty body. Only an authorized, uncaptured hold qualifies. Operator only. */
export async function POST(request: Request, { params }: Ctx) {
  const { id } = await params;
  return paymentRoute(request, "write", async ({ actor, service }) => {
    const { view, ...result } = await service.voidHold(actor, id);
    return json({ payment: view, result });
  });
}
