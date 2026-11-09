import { negotiationRoute, withIds } from "@/server/negotiation-route";
import { fromResult } from "@/server/operator-route";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string; pid: string }> };

/** Body: optional { reason }. The ids come from the URL only. */
export async function POST(request: Request, { params }: Ctx) {
  const { id, pid } = await params;
  return negotiationRoute(request, "write", ({ actor, service, body }) =>
    fromResult(
      service.accept(actor, withIds(body, { negotiationId: id, proposalId: pid })),
      "outcome",
    ),
  );
}
