"use client";

import { AllCommunityModule, colorSchemeDark, themeQuartz } from "ag-grid-community";
import type { ColDef, GridOptions } from "ag-grid-community";
import { AgGridProvider, AgGridReact } from "ag-grid-react";
import { useMemo, type ReactNode } from "react";

import {
  share,
  shareText,
  type Analytics,
  type CategoryRow,
  type Distribution,
  type LayerOutcome,
  type PairStats,
  type Share,
} from "@/domain/analytics";
import { detailHref } from "@/domain/cockpit";
import { Chip } from "../_arena/panels";
import { StateNote } from "../_ui/state-note";
import { MODE_LABEL } from "./columns";
import { useIsClient } from "./use-is-client";

/**
 * Benchmark analytics. Every number here comes from `computeAnalytics` over the rows currently in view, so the filters
 * above narrow it, and every ratio is printed as "n of d" so the denominator is always on screen. Nothing is
 * estimated, and runs that failed, were skipped or are copies are counted in the scope line, never in the results.
 */

const MODULES = [AllCommunityModule];
const THEME = themeQuartz.withPart(colorSchemeDark);

const LAYER_LABEL = { ARENA: "Arena simulation", SYSTEM: "System services (fake PayPal)" } as const;

const ratioValue = (s: Share) => (s.d === 0 ? -1 : s.n / s.d);

/* ------------------------------------------------------------------ small building blocks */

function Panel({
  id,
  title,
  note,
  children,
}: {
  id: string;
  title: string;
  note?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="card" aria-labelledby={id}>
      <h3 id={id}>{title}</h3>
      {note ? <p className="muted small">{note}</p> : null}
      {children}
    </section>
  );
}

type Segment = {
  label: string;
  n: number;
  tone: "success" | "danger" | "info" | "warning" | "neutral";
};

/** A stacked bar whose segments add up to the denominator, with the same numbers in words underneath. */
function StackBar({ segments, total, what }: { segments: Segment[]; total: number; what: string }) {
  const text = segments.map((s) => `${s.label} ${s.n}`).join(", ");
  if (total === 0)
    return <p className="muted small">No {what} in view, so there is nothing to draw.</p>;
  return (
    <div>
      <div className="stackbar" role="img" aria-label={`${text} of ${total} ${what}`}>
        {segments
          .filter((s) => s.n > 0)
          .map((s) => (
            <span
              key={s.label}
              className={`stackbar__seg stackbar__seg--${s.tone}`}
              style={{ flexGrow: s.n }}
            />
          ))}
      </div>
      <ul className="plain legend-inline">
        {segments.map((s) => (
          <li key={s.label}>
            <Chip tone={s.tone}>{s.label}</Chip> {s.n}
          </li>
        ))}
        <li className="muted">
          of {total} {what}
        </li>
      </ul>
    </div>
  );
}

function DistributionBars({ d, note }: { d: Distribution; note: string }) {
  return (
    <div className="dist">
      <div className="row row--between">
        <h4>{d.label}</h4>
        <span className="muted small">{d.rows} rows in view</span>
      </div>
      <p className="muted small">{note}</p>
      <ul className="distbars">
        {d.counts.map((c) => (
          <li key={c.value}>
            <span className="distbars__label">{c.value}</span>
            <span className="distbars__track" aria-hidden="true">
              <span
                className="distbars__fill"
                style={{ width: `${Math.max(2, Math.round((c.n * 100) / d.rows))}%` }}
              />
            </span>
            <span className="distbars__n">{shareText(share(c.n, d.rows), "rows")}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

/* ------------------------------------------------------------------ outcomes by category (AG Grid Community) */

const CATEGORY_COLUMNS: ColDef<CategoryRow>[] = [
  {
    headerName: "Layer",
    field: "layer",
    width: 110,
    valueFormatter: (p) => (p.value === "ARENA" ? "Arena" : "System"),
  },
  { headerName: "Attack category", field: "mechanism", minWidth: 190, flex: 1 },
  {
    headerName: "Buyer mode",
    field: "mode",
    width: 150,
    valueFormatter: (p) => MODE_LABEL[p.value as keyof typeof MODE_LABEL] ?? String(p.value),
  },
  { headerName: "Completed runs", field: "completedRuns", width: 120, type: "numericColumn" },
  { headerName: "Violations attempted", field: "attempted", width: 130, type: "numericColumn" },
  { headerName: "Blocked", field: "blocked", width: 95, type: "numericColumn" },
  { headerName: "Allowed through", field: "allowed", width: 120, type: "numericColumn" },
  {
    headerName: "Block rate (blocked of attempted)",
    colId: "blockRate",
    minWidth: 220,
    valueGetter: (p) => (p.data ? shareText(p.data.blockRate) : ""),
    comparator: (_a, _b, na, nb) => ratioValue(na.data!.blockRate) - ratioValue(nb.data!.blockRate),
  },
  { headerName: "As expected", field: "asExpected", width: 110, type: "numericColumn" },
  {
    headerName: "Unexpected allowed",
    field: "unexpectedAllowedRuns",
    width: 135,
    type: "numericColumn",
  },
  { headerName: "False blocks", field: "falseBlocks", width: 110, type: "numericColumn" },
];

function CategoryTable({ rows }: { rows: CategoryRow[] }) {
  const client = useIsClient();
  const options = useMemo<GridOptions<CategoryRow>>(
    () => ({
      getRowId: (p) => `${p.data.layer}|${p.data.mechanism}|${p.data.mode}`,
      defaultColDef: { sortable: true, resizable: true },
      domLayout: "autoHeight",
      animateRows: false,
    }),
    [],
  );
  if (rows.length === 0)
    return (
      <StateNote kind="empty" title="No completed benchmark runs in view">
        Widen the filters, or run <span className="mono">npm run benchmark</span> to create results.
      </StateNote>
    );
  return (
    <div className="grid-host" aria-label="Outcomes by attack category">
      {client ? (
        <AgGridProvider modules={MODULES}>
          <AgGridReact<CategoryRow>
            theme={THEME}
            rowData={rows}
            columnDefs={CATEGORY_COLUMNS}
            gridOptions={options}
          />
        </AgGridProvider>
      ) : (
        <p className="muted small" role="status">
          Loading table…
        </p>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ protected: blocked versus unexpectedly allowed */

function ProtectedCard({ o }: { o: LayerOutcome }) {
  if (o.completedRuns === 0)
    return (
      <div className="dist">
        <h4>{LAYER_LABEL[o.layer]}</h4>
        <p className="muted small">No completed protected run in view.</p>
      </div>
    );
  return (
    <div className="dist">
      <div className="row row--between">
        <h4>{LAYER_LABEL[o.layer]}</h4>
        <span className="muted small">{o.completedRuns} completed protected runs</span>
      </div>
      <StackBar
        what="attempted violations"
        total={o.attempted}
        segments={[
          { label: "Blocked", n: o.blocked, tone: "info" },
          { label: "Corrected", n: o.corrected, tone: "neutral" },
          { label: "Allowed through", n: o.allowed, tone: "danger" },
        ]}
      />
      <dl className="facts">
        <div>
          <dt>Blocked, of violations attempted</dt>
          <dd>{shareText(o.blockRate)}</dd>
        </div>
        <div>
          <dt>Unexpectedly allowed, of violations attempted</dt>
          <dd>{shareText(share(o.allowed, o.attempted))}</dd>
        </div>
        <div>
          <dt>False blocks, of legitimate attempts</dt>
          <dd>{shareText(share(o.falseBlocks, o.legitimate), "legitimate attempts")}</dd>
        </div>
        <div>
          <dt>Violations never attempted (model declined)</dt>
          <dd>{o.modelRestraint} (not counted as blocked)</dd>
        </div>
      </dl>
      {!o.reconciles ? (
        <StateNote kind="failed" title="These records do not reconcile">
          Attempted ({o.attempted}) is not blocked + corrected + allowed (
          {o.blocked + o.corrected + o.allowed}). Treat these figures as unreliable until explained.
        </StateNote>
      ) : null}
      {o.unexpectedAllowed.length > 0 ? (
        <StateNote
          kind="failed"
          title={`${o.unexpectedAllowed.length} protected run(s) let a violation through`}
        >
          <ul className="plain">
            {o.unexpectedAllowed.map((r) => (
              <li key={r.runId}>
                <a href={detailHref(`bench:${r.runId}`)}>{r.runId}</a>{" "}
                <span className="muted">({r.mechanism})</span>
              </li>
            ))}
          </ul>
        </StateNote>
      ) : o.attempted > 0 ? (
        <p className="muted small">
          No protected run in view let a violation through: 0 of {o.attempted} attempted. This is a
          count over these runs, not a guarantee about other inputs.
        </p>
      ) : null}
    </div>
  );
}

/* ------------------------------------------------------------------ baseline versus protected */

const money = (n: number) => `${n} minor units`;

function PairRow({ label, s }: { label: string; s: PairStats }) {
  return (
    <tr>
      <th scope="row">{label}</th>
      <td className="num">{s.pairs}</td>
      <td className="num">{s.attempted}</td>
      <td className="num">{shareText(share(s.baselineAllowed, s.attempted))}</td>
      <td className="num">{shareText(share(s.protectedAllowed, s.attempted))}</td>
      <td className="num">{money(s.baselineMovedMinor)}</td>
      <td className="num">{money(s.protectedMovedMinor)}</td>
    </tr>
  );
}

/* ------------------------------------------------------------------ the view */

export function AnalyticsView({
  analytics: a,
  chainNote,
}: {
  analytics: Analytics;
  chainNote: string | null;
}) {
  const s = a.scope;
  const c = a.comparison;
  return (
    <div className="stack" aria-label="Benchmark analytics">
      <Panel
        id="an-scope-h"
        title="What these figures count"
        note="Figures follow the filters above. Only completed runs are policy results; everything else is counted here and kept out of them."
      >
        {s.inView === 0 ? (
          <StateNote kind="empty" title="No benchmark runs in view">
            Either the benchmark has not been run (<span className="mono">npm run benchmark</span>)
            or the filters exclude every run. Payment and audit figures below use database rows when
            you are signed in.
          </StateNote>
        ) : (
          <dl className="facts">
            <div>
              <dt>Benchmark runs in view</dt>
              <dd>{s.inView}</dd>
            </div>
            <div>
              <dt>Copies of an earlier run (excluded)</dt>
              <dd>{s.copies}</dd>
            </div>
            <div>
              <dt>Skipped (not evidence)</dt>
              <dd>
                {s.skipped}
                {s.skipReasons.length > 0 ? (
                  <span className="muted small">
                    {" "}
                    ({s.skipReasons.map((r) => `${r.reason} ${r.n}`).join(", ")})
                  </span>
                ) : null}
              </dd>
            </div>
            <div>
              <dt>Executed</dt>
              <dd>{s.executed}</dd>
            </div>
            <div>
              <dt>Completed (the policy results below)</dt>
              <dd>
                {s.completed} of {s.executed} executed
              </dd>
            </div>
            <div>
              <dt>Model errors (policy never asked)</dt>
              <dd>{s.modelErrors}</dd>
            </div>
            <div>
              <dt>Infrastructure errors</dt>
              <dd>{s.infrastructureErrors}</dd>
            </div>
          </dl>
        )}
      </Panel>

      <Panel
        id="an-cat-h"
        title="Attack outcomes by category"
        note="One row per layer, category and buyer mode. Block rate is blocked of violations attempted in that row; where nothing was attempted it is n/a, not 0% or 100%."
      >
        <CategoryTable rows={a.byCategory} />
      </Panel>

      <Panel
        id="an-prot-h"
        title="Protected buyer: blocked versus unexpectedly allowed"
        note="Per layer, completed protected runs only. “Unexpectedly allowed” is a violation that went through; a protected buyer should have none."
      >
        <div className="grid2">
          {a.protectedOutcomes.map((o) => (
            <ProtectedCard key={o.layer} o={o} />
          ))}
        </div>
      </Panel>

      <Panel
        id="an-cmp-h"
        title="Unsafe baseline versus protected buyer"
        note="Arena runs only, on identical (scenario, simulated model) pairs where both sides completed. Money is simulated ledger money, in the scenario's own minor units."
      >
        {c.paired.pairs === 0 ? (
          <StateNote kind="empty" title="No complete baseline/protected pair in view">
            Pairs need a completed run in each mode for the same scenario and model.
          </StateNote>
        ) : (
          <div className="tablewrap">
            <table className="table results">
              <thead>
                <tr>
                  <th scope="col">Group</th>
                  <th scope="col">Pairs</th>
                  <th scope="col">Violations attempted</th>
                  <th scope="col">Baseline allowed</th>
                  <th scope="col">Protected allowed</th>
                  <th scope="col">Baseline money moved</th>
                  <th scope="col">Protected money moved</th>
                </tr>
              </thead>
              <tbody>
                <PairRow label="All pairs" s={c.paired} />
                {c.byBrain.map((b) => (
                  <PairRow key={b.brain} label={`Model: ${b.brain.toLowerCase()}`} s={b.stats} />
                ))}
              </tbody>
            </table>
          </div>
        )}
        <p className="muted small">
          Not paired: {c.unpaired.baselineOnly} baseline-only and {c.unpaired.protectedOnly}{" "}
          protected-only completed runs. The system layer ({c.systemProtectedRuns} protected runs)
          has no unprotected counterpart, so it is never compared.
        </p>
      </Panel>

      <Panel
        id="an-pay-h"
        title="Payment state distribution"
        note="Counted per source and never blended: your database's transactions are separate from simulated benchmark rows."
      >
        {a.paymentStates.length === 0 ? (
          <StateNote kind="empty" title="No rows in view" />
        ) : (
          <div className="grid2">
            {a.paymentStates.map((d) => (
              <DistributionBars
                key={d.source}
                d={d}
                note={
                  d.source === "BENCHMARK"
                    ? "Simulated: a scripted fake PayPal and a simulated ledger, not PayPal sandbox payments."
                    : "Stored state in your database. Only CAPTURED means money moved."
                }
              />
            ))}
          </div>
        )}
      </Panel>

      <Panel
        id="an-aud-h"
        title="Audit-chain verification"
        note={chainNote ?? "The audit chain verdict is shown when database rows are readable."}
      >
        {a.auditChain.length === 0 ? (
          <StateNote kind="empty" title="No rows in view" />
        ) : (
          <div className="grid2">
            {a.auditChain.map((d) => (
              <DistributionBars
                key={d.source}
                d={d}
                note={
                  d.source === "BENCHMARK"
                    ? "Benchmark runs keep no audit events: “not recorded” is not “verified”."
                    : "VERIFIED: the whole chain verifies and this row has events. BROKEN: the chain's first bad event is at or before this row's."
                }
              />
            ))}
          </div>
        )}
      </Panel>
    </div>
  );
}
