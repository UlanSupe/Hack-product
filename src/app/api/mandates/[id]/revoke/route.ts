import { fromResult, operatorRoute, withUrlId } from "@/server/operator-route";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

/** Body: { expectedVersion }. Adds a final REVOKED version. */
export async function POST(request: Request, { params }: Ctx) {
  const { id } = await params;
  return operatorRoute(request, "write", ({ actor, service, body }) =>
    fromResult(service.revoke(actor, withUrlId(body, "mandateId", id)), "mandate"),
  );
}
