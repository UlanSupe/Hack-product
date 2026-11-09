import { DEFAULT_SCENARIO_ID, SCENARIOS, runExperiment, summarizeAll } from "@/application/arena";
import { BRAIN_PROFILES, type BrainProfile } from "@/domain/experiment";

import type { Metadata } from "next";

import { Arena } from "../_arena/arena";

export const metadata: Metadata = {
  title: "Arena (simulation) - PactPay Arena",
  description:
    "The same scenario and the same scripted model, run by an intentionally unsafe baseline and by the protected buyer. Simulated money only.",
};

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

const first = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);

/**
 * The A/B experiment. `?scenario=S1&brain=CAREFUL` picks what runs. The run is computed here, on the server, from fixed
 * scenario data: nothing from the query string except two known ids reaches the experiment, and no PayPal call is made.
 */
export default async function ArenaPage({ searchParams }: { searchParams: SearchParams }) {
  const q = await searchParams;
  const sc = first(q.scenario);
  const bn = first(q.brain);
  const scenarioId = SCENARIOS.some((s) => s.id === sc) ? (sc as string) : DEFAULT_SCENARIO_ID;
  const brain: BrainProfile = BRAIN_PROFILES.find((b) => b === bn) ?? "SUSCEPTIBLE";
  const result = runExperiment({ scenarioId, brain });
  if (!result) throw new Error("the default scenario is missing");
  return (
    <Arena
      result={result}
      rows={summarizeAll(brain)}
      scenarios={SCENARIOS.map((s) => ({ id: s.id, title: s.title }))}
    />
  );
}
