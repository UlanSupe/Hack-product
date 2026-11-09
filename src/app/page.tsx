import type { Metadata } from "next";

import { SCENARIOS, STEP_IDS, STEP_LABELS } from "@/domain/journey";

import { Chip } from "./_arena/panels";
import { Explainer, PageHead } from "./_ui/page-head";
import { JourneyHeader } from "./_journey/journey-header";
import { StartPanel } from "./_journey/start-panel";

export const metadata: Metadata = {
  title: "Start - PactPay Arena",
  description:
    "Agents negotiate. Code enforces. PayPal settles. One guided journey from a task to a policy-checked, audited sandbox payment.",
};

/**
 * The start of the journey. Static: it shows the fixture scenarios and the nine steps. What the visitor has already done
 * (mandate, open transactions) is shown by <StartPanel>, from the server's records, only to a signed-in operator.
 */
export default function StartPage() {
  return (
    <>
      <JourneyHeader current="start" />
      <main className="wrap" id="main">
        <PageHead
          title="Start a transaction scenario"
          lead="Set a spending mandate, describe a task, and let the server's policy engine decide what may be paid."
        />
        <Explainer summary="What happens, step by step">
          <p>
            <strong>Agents negotiate. Code enforces. PayPal settles.</strong> You will set a
            spending mandate, describe a task, compare seller offers, watch agents negotiate, and
            see the server&rsquo;s policy engine decide whether an agreement may be paid. Then you
            pay it through the PayPal sandbox, check the result against PayPal and the
            tamper-evident audit trail, and replay an attack that tries to talk the agent into
            overspending.
          </p>
          <ol className="plain steps">
            {STEP_IDS.map((id, i) => (
              <li key={id}>
                <strong>
                  {i + 1}. {STEP_LABELS[id].title}
                </strong>
                {id === "replay" ? (
                  <span className="muted"> (simulation, not your transaction)</span>
                ) : null}
              </li>
            ))}
          </ol>
        </Explainer>

        <StartPanel />

        <section className="card" aria-labelledby="scen-h">
          <div className="card__head">
            <h2 id="scen-h">Choose a scenario</h2>
          </div>
          <ul className="plain scenarios">
            {SCENARIOS.map((s) => (
              <li key={s.id} className="scenario">
                <div className="row row--between">
                  <h3>{s.title}</h3>
                  {s.kind === "OPERATOR_TRANSACTION" ? (
                    <Chip tone="info">Fixture task · real records</Chip>
                  ) : (
                    <Chip tone="warning">Simulation · throwaway data</Chip>
                  )}
                </div>
                <p>{s.blurb}</p>
                <p>
                  <a
                    className="btn btn--primary"
                    href={
                      s.kind === "OPERATOR_TRANSACTION"
                        ? `/negotiations?scenario=${encodeURIComponent(s.id)}`
                        : "/flagship"
                    }
                  >
                    {s.kind === "OPERATOR_TRANSACTION"
                      ? "Start this scenario"
                      : "Replay the attack"}
                  </a>
                </p>
              </li>
            ))}
          </ul>
          <p className="muted small">
            A scenario only pre-fills the task form with made-up values. You still submit it, and
            every later step is decided by the server: the policy engine, your approval and PayPal.
            The payment step needs PayPal sandbox credentials on the server; without them it says so
            and nothing is simulated in its place.
          </p>
        </section>

        <footer className="foot muted small">
          Operator access is demo-grade: one shared passcode from the server environment. Sandbox
          only; synthetic data. <a href="/api/health">Diagnostics</a>
        </footer>
      </main>
    </>
  );
}
