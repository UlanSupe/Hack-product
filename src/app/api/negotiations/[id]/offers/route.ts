import { negotiationRoute, withIds } from "@/server/negotiation-route";
import { fromResult } from "@/server/operator-route";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

/** Records one more VERSION. The negotiation comes from the URL; a payee can never be supplied. */
export async function POST(request: Request, { params }: Ctx) {
  const { id } = await params;
  return negotiationRoute(request, "write", ({ actor, service, body }) =>
    fromResult(service.submitOffer(actor, withIds(body, { negotiationId: id })), "proposal", 201),
  );
}
