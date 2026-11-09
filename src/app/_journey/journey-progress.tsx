"use client";

import type { StepId } from "@/domain/journey";
import { useJourney } from "./journey-context";
import { StepList } from "./step-list";

/**
 * The progress bar under the header of every page. It shows what the server derived from stored state, says plainly when
 * it cannot know (signed out, error, still loading), and never fills in a step it was not told about.
 */
export function JourneyProgress({ page }: { page: StepId | null }) {
  const j = useJourney();

  if (j.status === "ready" && j.journey) {
    const { journey } = j;
    const next = journey.next;
    const done = journey.steps.slice(0, 8).filter((s) => s.status === "DONE").length;
    return (
      <div className="journey-bar" aria-live="polite">
        <StepList steps={journey.steps} currentId={journey.currentId} currentPage={page} />
        <p className="journey-bar__line small">
          {j.message ? <span className="journey-bar__msg">{j.message} </span> : null}
          <strong>
            {done} of 8 steps done
            {journey.negotiationId ? "" : " (no transaction open yet)"}.
          </strong>{" "}
          {next ? (
            <>
              Next: <a href={next.href}>{next.label}</a>.
            </>
          ) : (
            <>Every step is done. You can replay the attack or open the Cockpit.</>
          )}{" "}
          <span className="muted">Step 9 is a simulation, not part of your transaction.</span>
        </p>
      </div>
    );
  }

  if (j.status === "loading")
    return (
      <div className="journey-bar" role="status" aria-busy="true">
        <StepList currentPage={page} />
        <p className="journey-bar__line small muted">Checking your progress…</p>
      </div>
    );

  return (
    <div className="journey-bar">
      <StepList currentPage={page} />
      <p className="journey-bar__line small muted">
        {j.status === "signed_out" ? (
          <>
            Progress is tracked for the signed-in operator. <a href="/mandate">Sign in</a> on the
            Mandate or Negotiations page; the steps work as links meanwhile.
          </>
        ) : j.status === "not_configured" ? (
          <>
            Operator access is not configured on this server, so progress cannot be tracked. Set{" "}
            <code className="code">OPERATOR_PASSCODE</code> (see the README).
          </>
        ) : (
          <>
            {j.message ?? "Progress could not be loaded."}{" "}
            <button type="button" className="btn btn--quiet btn--inline" onClick={j.refresh}>
              Try again
            </button>
          </>
        )}
      </p>
    </div>
  );
}
