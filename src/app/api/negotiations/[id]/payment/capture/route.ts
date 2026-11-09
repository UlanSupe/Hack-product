import { json } from "@/server/http";
import { paymentRoute } from "@/server/payment-route";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

/**
 * Collects the held funds (the charge). Empty body: the amount is the agreement's total from the server's records and
 * the authorization is the one the server stored. A browser cannot name either. Operator only.
 */
export async function POST(request: Request, { params }: Ctx) {
  const { id } = await params;
  return paymentRoute(request, "write", async ({ actor, service }) => {
    const { view, ...result } = await service.capture(actor, id);
    return json({ payment: view, result });
  });
}
