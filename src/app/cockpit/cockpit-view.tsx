import type { ReactNode } from "react";

import type { CockpitData } from "@/application/cockpit";
import { tally, type CockpitFilters, type SourceStatus } from "@/domain/cockpit";
import { Chip } from "../_arena/panels";
import { PageHead } from "../_ui/page-head";
import { StateNote } from "../_ui/state-note";
import { JourneyHeader } from "../_journey/journey-header";
import { CockpitGrid, type CockpitViewMode } from "./cockpit-grid";
import { studioStatus } from "./studio";

/**
 * The Cockpit page body: what each source can and cannot show, the grid, and honest empty and error states. It has no
 * "use client" itself, so it renders on the server; only the grid is interactive.
 */

type CardTone = "success" | "warning" | "danger" | "info";

const STATE_LABEL = {
  LOCKED: "Locked",
  UNAVAILABLE: "Nothing to read yet",
  MISSING: "No results yet",
  ERROR: "Error",
} as const;
const STATE_TONE = {
  LOCKED: "info",
  UNAVAILABLE: "warning",
  MISSING: "warning",
  ERROR: "danger",
} as const;

function describe(status: SourceStatus): { tone: CardTone; head: string; body: ReactNode } {
  if (status.state !== "OK")
    return {
      tone: STATE_TONE[status.state],
      head: STATE_LABEL[status.state],
      body: <p className="small">{status.message}</p>,
    };
  if (status.source === "BENCHMARK")
    return {
      tone: "success",
      head: `${status.rows} rows`,
      body: (
        <p className="muted small">
          Integrity check passed (results hash matches the runs). Generated {status.generatedAt},
          seed {status.seed}.
          <br />
          <span className="mono small">{status.resultsHash}</span>
        </p>
      ),
    };
  return {
    tone: "success",
    head: `${status.rows} rows`,
    body: <p className="muted small">{status.note}</p>,
  };
}

function SourceCard({ title, status }: { title: string; status: SourceStatus }) {
  const { tone, head, body } = describe(status);
  return (
    <div className="card">
      <div className="card__head">
        <h3>{title}</h3>
        <Chip tone={tone}>{head}</Chip>
      </div>
      {body}
    </div>
  );
}

export function CockpitView({
  data,
  initialFilters,
  initialView = "table",
}: {
  data: CockpitData;
  initialFilters: CockpitFilters;
  initialView?: CockpitViewMode;
}) {
  const t = tally(data.rows);
  const studio = studioStatus();
  const nothing = data.rows.length === 0;
  const db = data.sources.database;
  const chainNote = db.source === "DATABASE" && db.state === "OK" ? db.note : null;
  return (
    <>
      <JourneyHeader current="cockpit" />
      <main className="wrap" id="main">
        <PageHead
          title="Arena Cockpit"
          lead="Every stored decision, transaction and benchmark run in one filterable grid. Values a source does not hold are shown as not recorded, never guessed."
        />
        <p className="banner banner--info" role="note">
          <strong>Every row is a stored record.</strong> Database rows come from the project&apos;s
          own tables (transactions, policy checks, attack runs, audit events) and need the operator
          session; benchmark rows come from the persisted
          <span className="mono"> benchmark-results/benchmark.json</span> after its integrity check.
          Nothing is estimated: a value a source does not hold shows as “not recorded”. Benchmark
          runs use a simulated ledger and a scripted fake PayPal.
        </p>

        <section aria-labelledby="src-h" className="grid2">
          <h2 id="src-h" className="sr-only">
            Data sources
          </h2>
          <SourceCard title="Database (sandbox / synthetic data)" status={data.sources.database} />
          <SourceCard title="Persisted benchmark results" status={data.sources.benchmark} />
        </section>

        {nothing ? (
          <section className="card" aria-labelledby="empty-h">
            <h2 id="empty-h">Nothing to show yet</h2>
            <StateNote kind="empty" title="Neither source has rows">
              To get some: sign in as the operator and use the Negotiations page (database rows),
              and/or run <span className="mono">npm run benchmark</span> (benchmark rows), then
              reload.
            </StateNote>
          </section>
        ) : (
          <>
            <p className="muted small" data-testid="source-tallies">
              {t.total} rows in total: {t.bySource.TRANSACTION} transactions,{" "}
              {t.bySource.REFUSED_OFFER} refused offers, {t.bySource.ATTACK_RUN} attack runs,{" "}
              {t.bySource.BENCHMARK} benchmark runs. Audit chain: {t.byAudit.VERIFIED} verified,{" "}
              {t.byAudit.BROKEN} broken.
            </p>
            <CockpitGrid
              rows={data.rows}
              runs={data.runs}
              chainNote={chainNote}
              initialFilters={initialFilters}
              initialView={initialView}
            />
          </>
        )}

        <footer className="foot muted small">
          AG Grid Community (MIT) renders the grid; no Enterprise feature or licence key is used.{" "}
          {studio.enabled
            ? "AG Studio is enabled."
            : "AG Studio (a separate commercial product) is not installed or enabled; the Cockpit does not need it."}
        </footer>
      </main>
    </>
  );
}
