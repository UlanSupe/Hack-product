import { json } from "@/server/http";
import { operatorRoute } from "@/server/operator-route";

export const dynamic = "force-dynamic";

/** Everything the operator console shows: mandates with versions, open drafts, sellers, option lists. */
export function GET(request: Request) {
  return operatorRoute(request, "read", ({ actor, service }) => json(service.overview(actor)));
}
