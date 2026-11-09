import type { Metadata } from "next";

import { JourneyHeader } from "../_journey/journey-header";
import { Explainer, PageHead } from "../_ui/page-head";
import { NegotiationConsole } from "./console";

export const metadata: Metadata = {
  title: "Negotiations - PactPay Arena",
  description:
    "Request, compare and agree offers from sellers. Every agreement passes the policy engine. Operator only.",
};

export default function NegotiationsPage() {
  return (
    <>
      <JourneyHeader current="negotiations" />
      <main className="wrap" id="main">
        <PageHead
          title="Negotiations"
          lead="Submit a task, compare offers, see the policy decision, then pay. Steps 3 to 7."
        />
        <Explainer summary="How an offer becomes an agreement, and who decides">
          <p>
            <strong>Agents negotiate. Code enforces.</strong> Sellers and agents can only propose
            terms. An offer becomes an agreement only if the deterministic policy engine allows it,
            and a change to the price, payee, scope, currency or deliverables retires the old
            agreement and its approval. Paying happens only in the PayPal sandbox payment panel,
            after an agreement passes.
          </p>
        </Explainer>
        <NegotiationConsole />
        <footer className="foot muted small">
          Operator access is demo-grade: one shared passcode from the server environment. Sandbox
          only; synthetic data.
        </footer>
      </main>
    </>
  );
}
