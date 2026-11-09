import type { ExperimentResult, SummaryRow } from "@/application/arena";
import { BRAIN_PROFILES, type BrainProfile } from "@/domain/experiment";

import { ModePane, SharedInputPanel, SummaryPanel } from "./experiment-panels";
import { JourneyHeader } from "../_journey/journey-header";
import { PageHead } from "../_ui/page-head";
import { ReplayControl } from "./replay";

export const BRAIN_LABEL: Record<BrainProfile, string> = {
  SUSCEPTIBLE: "Susceptible model (follows instructions in seller text)",
  CAREFUL: "Careful model (checks everything itself)",
};

export function Arena({
  result,
  rows,
  scenarios,
}: {
  result: ExperimentResult;
  rows: SummaryRow[];
  scenarios: { id: string; title: string }[];
}) {
  const brain = result.brain === "CUSTOM" ? "SUSCEPTIBLE" : result.brain;
  return (
    <>
      <JourneyHeader current="arena" />

      <main className="wrap" id="main">
        <PageHead
          title="PactPay Arena: intentionally unsafe baseline versus protected buyer"
          lead="Same scenario, same scripted model, two buyers. Only one of them has a policy engine."
        />
        <p className="banner" role="note">
          <strong>An experiment, not a payment.</strong> Both buyers receive the same scenario and
          the same scripted model; both can spend only on in-memory simulated ledgers. This page
          makes no PayPal call. Real sandbox settlement is in the{" "}
          <a href="/negotiations">negotiation console</a>. The flagship budget-escalation attack,
          with the server&rsquo;s real audit trail, is on the <a href="/flagship">Flagship</a> page.
        </p>

        <section className="card controls" aria-labelledby="controls-h">
          <h2 id="controls-h" className="sr-only">
            Scenario controls
          </h2>
          <form method="get" action="/arena" className="controls__form">
            <div className="field">
              <label htmlFor="scenario">Scenario</label>
              <select id="scenario" name="scenario" defaultValue={result.scenario.id}>
                {scenarios.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.title}
                  </option>
                ))}
              </select>
            </div>
            <div className="field">
              <label htmlFor="brain">Simulated model</label>
              <select id="brain" name="brain" defaultValue={brain}>
                {BRAIN_PROFILES.map((b) => (
                  <option key={b} value={b}>
                    {BRAIN_LABEL[b]}
                  </option>
                ))}
              </select>
            </div>
            <div className="field field--run">
              <button type="submit" className="btn btn--primary">
                Run both buyers
              </button>
            </div>
          </form>
          <ReplayControl scenarioId={result.scenario.id} brain={brain} runHash={result.runHash} />
        </section>

        <SharedInputPanel result={result} />

        <div className="compare">
          <ModePane result={result} mode="UNSAFE_BASELINE" />
          <ModePane result={result} mode="PROTECTED" />
        </div>

        <SummaryPanel rows={rows} selectedId={result.scenario.id} brain={brain} />

        <footer className="foot muted small">
          Experiment {result.experimentVersion}. Deterministic: the same scenario and model always
          give run hash <code className="code">{result.runHash.slice(0, 16)}</code>. Synthetic data;
          no real money, no PayPal. <a href="/api/health">Diagnostics</a>
        </footer>
      </main>
    </>
  );
}
