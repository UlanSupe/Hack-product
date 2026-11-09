import { fromResult, operatorRoute } from "@/server/operator-route";

export const dynamic = "force-dynamic";

/** Body: { fields, basedOn?: { mandateId, version } }. Creates a draft; changes no approved mandate. */
export function POST(request: Request) {
  return operatorRoute(request, "write", ({ actor, service, body }) =>
    fromResult(service.createDraft(actor, body), "draft", 201),
  );
}
