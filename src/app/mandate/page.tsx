import type { Metadata } from "next";

import { JourneyHeader } from "../_journey/journey-header";
import { PageHead } from "../_ui/page-head";
import { MandateConsole } from "./console";

export const metadata: Metadata = {
  title: "Mandate - PactPay Arena",
  description: "Configure the financial mandate that every purchase must follow. Operator only.",
};

export default function MandatePage() {
  return (
    <>
      <JourneyHeader current="mandate" />
      <main className="wrap" id="main">
        <PageHead
          title="Financial mandate"
          lead="The budget and rules every purchase must follow. Step 2 of the journey."
        />
        <p className="banner banner--info" role="note">
          <strong>Only you can change this.</strong> AI agents can read nothing here and cannot
          approve, edit or revoke a mandate; the server enforces that, not the interface.
        </p>
        <MandateConsole />
        <footer className="foot muted small">
          Operator access is demo-grade: one shared passcode from the server environment. Sandbox
          only; synthetic data.
        </footer>
      </main>
    </>
  );
}
