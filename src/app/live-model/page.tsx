import type { Metadata } from "next";

import { readLiveModel } from "@/server/live-model";

import { JourneyHeader } from "../_journey/journey-header";
import { PageHead } from "../_ui/page-head";

export const metadata: Metadata = {
  title: "Live model - PactPay Arena",
  description:
    "A real model as the buyer against ten hostile-seller scripts: what it did, and what the server did with it.",
};

export const dynamic = "force-dynamic";

const SCRIPT_LABEL: Record<string, string> = {
  FAKE_AUTHORITY: "Fake authority",
  INFLATED_CLAIM: "Inflated total",
  OVER_CAP: "Over the cap",
  PAYEE_REDIRECT: "Payee redirection",
  WRONG_CURRENCY: "Wrong currency",
  DELIVERABLE_INJECTION: "Injection in deliverables",
  UNICODE_TRICKS: "Unicode tricks",
  ENCODED_PAYLOAD: "Encoded payload",
  URGENCY_PRESSURE: "Urgency pressure",
  CATEGORY_SWAP: "Category swap",
};

/**
 * Shows docs/live-model-attack.json (written by `npm run agents:attack`): a real model as the buyer against the
 * hostile-seller fixture. Read-only; nothing here calls a model, PayPal or the database.
 */
export default function LiveModelPage() {
  const read = readLiveModel();
  return (
    <>
      <JourneyHeader current="livemodel" />
      <main className="wrap" id="main">
        <PageHead
          title="Live model against hostile sellers"
          lead="A real model played the buyer against ten attack scripts. This page shows what it did and what the server did with it."
        />
        <p className="banner" role="note">
          <strong>One measurement, not a guarantee.</strong> One model, one day, a small number of
          runs per attack and a scripted seller. Nothing was paid and PayPal was never called. The
          server rejects an offer whatever the model says.
        </p>
        {read.kind === "OK" ? (
          <>
            <section className="card" aria-labelledby="lm-h">
              <h2 id="lm-h">{read.view.summary.negotiations} negotiations</h2>
              <p className="muted small">
                Model <code>{read.view.summary.model}</code>, {read.view.summary.trialsPerScript}{" "}
                runs per attack script.
              </p>
              <table className="table">
                <caption className="sr-only">What the model did</caption>
                <thead>
                  <tr>
                    <th scope="col">What the model did</th>
                    <th scope="col">Count</th>
                  </tr>
                </thead>
                <tbody>
                  <tr>
                    <td>Recommended paying an offer the server rejects</td>
                    <td>{read.view.summary.recommendedAnOfferTheServerRejects}</td>
                  </tr>
                  <tr>
                    <td>Asked a human to approve an offer the server would still deny</td>
                    <td>{read.view.summary.askedHumanToApproveAnOfferTheServerRejects}</td>
                  </tr>
                  <tr>
                    <td>Asked a human to approve an offer that passed the hard checks</td>
                    <td>{read.view.summary.askedHumanToApproveAnOfferThatPassedHardChecks}</td>
                  </tr>
                  <tr>
                    <td>Recommended an offer that passed the hard checks, without asking</td>
                    <td>{read.view.summary.recommendedAnOfferThatPassedHardChecks}</td>
                  </tr>
                  <tr>
                    <td>Declined or asked for clarification</td>
                    <td>{read.view.summary.declinedOrAskedForClarification}</td>
                  </tr>
                  <tr>
                    <td>No usable reply</td>
                    <td>{read.view.summary.agentFailure}</td>
                  </tr>
                </tbody>
              </table>
            </section>
            <section className="card" aria-labelledby="lm-s-h">
              <h2 id="lm-s-h">By attack script</h2>
              <table className="table">
                <caption className="sr-only">Outcomes by attack script</caption>
                <thead>
                  <tr>
                    <th scope="col">Attack</th>
                    <th scope="col">Runs</th>
                    <th scope="col">Server would reject the offer</th>
                    <th scope="col">Asked a human</th>
                    <th scope="col">Declined or clarified</th>
                  </tr>
                </thead>
                <tbody>
                  {read.view.perScript.map((r) => (
                    <tr key={r.script}>
                      <th scope="row">{SCRIPT_LABEL[r.script] ?? r.script}</th>
                      <td>{r.runs}</td>
                      <td>{r.serverRejected}</td>
                      <td>{r.askedHuman}</td>
                      <td>{r.declinedOrClarified}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <p className="muted small">
                Method, limits and how to rerun it: <code>docs/LIVE_MODEL_ATTACK.md</code> and{" "}
                <code>npm run agents:attack</code>.
              </p>
            </section>
          </>
        ) : (
          <section className="card" aria-labelledby="lm-none-h">
            <h2 id="lm-none-h">No measurement available</h2>
            <p>
              {read.kind === "MISSING"
                ? "docs/live-model-attack.json is not part of this build. Run npm run agents:attack with a model key to create it."
                : read.message}
            </p>
          </section>
        )}
      </main>
    </>
  );
}
