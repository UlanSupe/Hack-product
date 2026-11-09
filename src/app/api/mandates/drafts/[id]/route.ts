import { fromResult, operatorRoute, withUrlId } from "@/server/operator-route";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

/** Body: { revision, fields }. Edits an OPEN draft only. */
export async function PUT(request: Request, { params }: Ctx) {
  const { id } = await params;
  return operatorRoute(request, "write", ({ actor, service, body }) =>
    fromResult(service.updateDraft(actor, withUrlId(body, "draftId", id)), "draft"),
  );
}
