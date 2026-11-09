import { fromResult, operatorRoute, withUrlId } from "@/server/operator-route";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

/** Body: { revision }. Creates the next immutable mandate version from the draft. */
export async function POST(request: Request, { params }: Ctx) {
  const { id } = await params;
  return operatorRoute(request, "write", ({ actor, service, body }) =>
    fromResult(service.approveDraft(actor, withUrlId(body, "draftId", id)), "mandate"),
  );
}
