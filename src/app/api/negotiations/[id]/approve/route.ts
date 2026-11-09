import { negotiationRoute, withIds } from "@/server/negotiation-route";
import { fromResult } from "@/server/operator-route";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

/** Body: optional { reason }. */
export async function POST(request: Request, { params }: Ctx) {
  const { id } = await params;
  return negotiationRoute(request, "write", ({ actor, service, body }) =>
    fromResult(service.approve(actor, withIds(body, { negotiationId: id })), "eligibility"),
  );
}
