import { z } from "zod";

import { HttpError, json } from "@/server/http";
import { negotiationRoute } from "@/server/negotiation-route";

export const dynamic = "force-dynamic";

/** Which agents to run. Absent means the deterministic mocks: a model is used only when asked for. */
const Body = z.object({ agents: z.enum(["mock", "model"]).default("mock") }).strict();

type Ctx = { params: Promise<{ id: string }> };

/** Runs the mock agents (default) or, if configured and asked for, the model agents. They only propose. */
export async function POST(request: Request, { params }: Ctx) {
  const { id } = await params;
  return negotiationRoute(request, "write", async ({ actor, demo, service, body }) => {
    const parsed = Body.safeParse(body ?? {});
    if (!parsed.success)
      throw new HttpError(400, "INVALID_BODY", 'Expected { agents: "mock" | "model" }.');
    const outcome = await demo.run(actor, id, parsed.data.agents);
    return json({ demo: outcome, negotiation: service.detail(actor, id) });
  });
}
