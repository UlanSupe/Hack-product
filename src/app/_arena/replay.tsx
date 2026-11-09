"use client";

import { useState } from "react";

type State =
  | { kind: "idle" }
  | { kind: "running" }
  | { kind: "same"; hash: string }
  | { kind: "different"; hash: string }
  | { kind: "failed" };

/**
 * Replays the scenario on the server and compares the run's hash with the one on screen. The run is a pure function of
 * (scenario, simulated model), so a replay must give the same hash. Nothing is sent but the two ids in the URL.
 */
export function ReplayControl({
  scenarioId,
  brain,
  runHash,
}: {
  scenarioId: string;
  brain: string;
  runHash: string;
}) {
  const [state, setState] = useState<State>({ kind: "idle" });
  const replay = async () => {
    setState({ kind: "running" });
    try {
      const res = await fetch(
        `/api/arena/runs/${encodeURIComponent(scenarioId)}?brain=${encodeURIComponent(brain)}`,
        { cache: "no-store" },
      );
      const body = (await res.json()) as { result?: { runHash?: string } };
      const hash = body.result?.runHash;
      if (!res.ok || typeof hash !== "string") return setState({ kind: "failed" });
      setState(hash === runHash ? { kind: "same", hash } : { kind: "different", hash });
    } catch {
      setState({ kind: "failed" });
    }
  };
  return (
    <div className="field field--run">
      <button
        type="button"
        className="btn"
        onClick={() => void replay()}
        disabled={state.kind === "running"}
      >
        {state.kind === "running" ? "Replaying…" : "Replay this run"}
      </button>
      <p className="muted small" role="status">
        Run hash <code className="code">{runHash.slice(0, 16)}</code>
        {state.kind === "same" ? " · replay produced the identical run ✓" : null}
        {state.kind === "different" ? ` · replay DIFFERED (${state.hash.slice(0, 16)})` : null}
        {state.kind === "failed" ? " · the replay could not be fetched" : null}
      </p>
    </div>
  );
}
