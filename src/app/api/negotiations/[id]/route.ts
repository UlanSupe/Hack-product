import { json } from "@/server/http";
import { negotiationRoute } from "@/server/negotiation-route";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

export async function GET(request: Request, { params }: Ctx) {
  const { id } = await params;
  return negotiationRoute(request, "read", ({ actor, service }) =>
    json({ negotiation: service.detail(actor, id) }),
  );
}
