"use client";

import { Chip, Skeleton } from "../_arena/panels";
import { StateNote } from "../_ui/state-note";
import { useJourney } from "./journey-context";

/**
 * "Where am I?" for the start page: the mandate's state and the transactions the operator can come back to. Everything
 * is read from the server through the shared journey state; nothing is remembered in the browser.
 */
export function StartPanel() {
  const j = useJourney();

  return (
    <section className="card" aria-labelledby="where-h">
      <div className="card__head">
        <h2 id="where-h">Your place in the journey</h2>
      </div>
      {j.status === "loading" ? (
        <Skeleton lines={3} />
      ) : j.status === "signed_out" ? (
        <p>
          You are not signed in as the operator. Sign in on the <a href="/mandate">Mandate page</a>{" "}
          (one shared passcode from the server environment), then come back here or go straight to
          step 2.
        </p>
      ) : j.status === "not_configured" ? (
        <p>
          Operator access is not configured on this server. Set{" "}
          <code className="code">OPERATOR_PASSCODE</code> (at least 16 characters) in the server
          environment and restart; the README explains how.
        </p>
      ) : j.status === "error" || !j.journey ? (
        <StateNote
          kind="failed"
          title={j.message ?? "Your progress could not be loaded."}
          actions={
            <button type="button" className="btn" onClick={j.refresh}>
              Try again
            </button>
          }
        />
      ) : (
        <>
          {j.message ? <p className="notice notice--info">{j.message}</p> : null}
          <p>
            {j.journey.steps.find((s) => s.id === "mandate")?.status === "DONE" ? (
              <>
                <Chip tone="success" icon="✓">
                  Mandate approved
                </Chip>{" "}
                A mandate is in force. <a href="/mandate">Review it</a> before you start if you
                like.
              </>
            ) : (
              <>
                <Chip tone="warning" icon="!">
                  No approved mandate
                </Chip>{" "}
                Every purchase must follow one. <a href="/mandate">Create and approve a mandate</a>{" "}
                (or run <code className="code">npm run db:seed</code> for the demo mandate), then
                start a scenario.
              </>
            )}
          </p>
          {j.recent.length > 0 ? (
            <>
              <h3 className="small">Your transactions</h3>
              <ul className="plain">
                {j.recent.map((n) => (
                  <li key={n.id} className="row row--between">
                    <span>
                      {n.summary} <span className="muted small">· {n.status.toLowerCase()}</span>
                      {n.agreement ? (
                        <span className="muted small"> · agreed {n.agreement}</span>
                      ) : null}
                    </span>
                    <a
                      className="btn btn--quiet"
                      href={`/negotiations?n=${encodeURIComponent(n.id)}`}
                    >
                      Continue
                    </a>
                  </li>
                ))}
              </ul>
            </>
          ) : (
            <StateNote kind="empty" title="No transactions yet">
              Start one with a scenario below. Nothing is shown here until a real transaction
              exists.
            </StateNote>
          )}
        </>
      )}
    </section>
  );
}
