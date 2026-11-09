import { json } from "@/server/http";
import { negotiationRoute } from "@/server/negotiation-route";
import { fromResult } from "@/server/operator-route";

export const dynamic = "force-dynamic";

/** Every negotiation (newest first), plus the sellers and mandates the "open" form needs. */
export function GET(request: Request) {
  return negotiationRoute(request, "read", ({ actor, service, demo }) =>
    json({ ...service.overview(actor), agents: { modelAvailable: demo.modelAvailable } }),
  );
}

/** Body: the buyer's request and constraints. */
export function POST(request: Request) {
  return negotiationRoute(request, "write", ({ actor, service, body }) =>
    fromResult(service.open(actor, body), "negotiation", 201),
  );
}
