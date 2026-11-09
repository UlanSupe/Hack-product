import { validationFailed } from "@/server/http";
import { negotiationRoute, withIds } from "@/server/negotiation-route";
import { fromResult } from "@/server/operator-route";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

/** Body: { outcome: "REJECTED" | "CANCELLED", reason? }. */
export async function POST(request: Request, { params }: Ctx) {
  const { id } = await params;
  return negotiationRoute(request, "write", ({ actor, service, body }) => {
    const { outcome, ...rest } = (body !== null && typeof body === "object" ? body : {}) as {
      outcome?: unknown;
    };
    if (outcome !== "REJECTED" && outcome !== "CANCELLED") {
      return validationFailed([{ field: "outcome", message: "must be REJECTED or CANCELLED" }]);
    }
    return fromResult(
      service.close(actor, withIds(rest, { negotiationId: id }), outcome),
      "negotiation",
    );
  });
}
