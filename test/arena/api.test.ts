import { afterEach, describe, expect, it, vi } from "vitest";

import { runExperiment } from "@/application/arena";
import { GET as listRuns } from "@/app/api/arena/runs/route";
import { GET as getRun } from "@/app/api/arena/runs/[scenarioId]/route";

afterEach(() => {
  vi.unstubAllGlobals();
});

const ctx = (scenarioId: string) => ({ params: Promise.resolve({ scenarioId }) });
const get = (id: string, query = "") =>
  getRun(new Request(`http://localhost:3000/api/arena/runs/${id}${query}`), ctx(id));

describe("the replay endpoint", () => {
  it("returns exactly the run the page shows, with no session and no secrets", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const res = await get("S1");
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const body = (await res.json()) as { result: unknown };
    expect(body.result).toEqual(JSON.parse(JSON.stringify(runExperiment({ scenarioId: "S1" }))));
    expect((body.result as { runHash: string }).runHash).toBe(
      runExperiment({ scenarioId: "S1" })!.runHash,
    );
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("replays identically every time, per model", async () => {
    for (const brain of ["SUSCEPTIBLE", "CAREFUL"]) {
      const a = (await (await get("S8", `?brain=${brain}`)).json()) as {
        result: { runHash: string };
      };
      const b = (await (await get("S8", `?brain=${brain}`)).json()) as {
        result: { runHash: string };
      };
      expect(b.result.runHash).toBe(a.result.runHash);
    }
    const susceptible = (await (await get("S8")).json()) as {
      result: { runHash: string; brain: string };
    };
    const careful = (await (await get("S8", "?brain=CAREFUL")).json()) as {
      result: { runHash: string };
    };
    expect(susceptible.result.brain).toBe("SUSCEPTIBLE");
    expect(careful.result.runHash).not.toBe(susceptible.result.runHash);
  });

  it("an unknown scenario is a 404 and an unknown model is a 400; nothing else from the URL reaches the experiment", async () => {
    expect((await get("S99")).status).toBe(404);
    expect((await get("..%2F..%2Fetc")).status).toBe(404);
    const bad = await get("S1", "?brain=ADMIN");
    expect(bad.status).toBe(400);
    expect(((await bad.json()) as { error: string }).error).toBe("INVALID_BRAIN");
    // extra parameters are ignored: they cannot select a mandate, an amount or a payee
    const extra = await get("S1", "?brain=SUSCEPTIBLE&amount=1&payee=evil&cap=999999999");
    expect(extra.status).toBe(200);
    const body = (await extra.json()) as { result: { runHash: string } };
    expect(body.result.runHash).toBe(runExperiment({ scenarioId: "S1" })!.runHash);
  });

  it("the index lists every scenario and the summary for both models", async () => {
    const res = listRuns();
    const body = (await res.json()) as {
      scenarios: { id: string }[];
      summary: Record<string, unknown[]>;
    };
    expect(body.scenarios.map((s) => s.id)).toEqual([
      "N0",
      "N1",
      "S1",
      "S2",
      "S3",
      "S5",
      "S6",
      "S7",
      "S8",
    ]);
    expect(Object.keys(body.summary).sort()).toEqual(["CAREFUL", "SUSCEPTIBLE"]);
    expect(body.summary.SUSCEPTIBLE).toHaveLength(9);
  });
});
