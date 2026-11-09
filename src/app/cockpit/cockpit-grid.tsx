"use client";

import { AllCommunityModule, colorSchemeDark, themeQuartz } from "ag-grid-community";
import type { GridOptions, RowDoubleClickedEvent } from "ag-grid-community";
import { AgGridProvider, AgGridReact } from "ag-grid-react";
import { useCallback, useMemo, useState } from "react";

import { computeAnalytics, type AnalyticsRun } from "@/domain/analytics";
import {
  ALL,
  AUDIT_STATES,
  BUYER_MODES,
  DECISIONS,
  NO_FILTERS,
  SOURCES,
  SOURCE_LABEL,
  applyFilters,
  detailHref,
  filterOptions,
  isFiltered,
  serializeFilters,
  tally,
  type CockpitFilters,
  type CockpitRow,
} from "@/domain/cockpit";
import { AnalyticsView } from "./analytics-view";
import { AUDIT_LABEL, DECISION_LABEL, MODE_LABEL, buildColumnDefs } from "./columns";
import { useIsClient } from "./use-is-client";

/**
 * The grid and its filters. AG Grid Community only (MIT licensed, no key): the modules are registered through
 * AgGridProvider, the theme is the built-in Quartz with its dark colour scheme, and there is no Enterprise import.
 * Filtering by the menus and the search box is done on plain rows by `applyFilters` (the same function the tests
 * exercise and the API uses); the column filters AG Grid provides apply on top.
 */

const MODULES = [AllCommunityModule];
const THEME = themeQuartz.withPart(colorSchemeDark);
const PAGE_SIZES = [25, 50, 100];

function Select(props: {
  id: string;
  label: string;
  value: string;
  onChange: (v: string) => void;
  options: { value: string; label: string }[];
}) {
  return (
    <div className="field">
      <label htmlFor={props.id}>{props.label}</label>
      <select id={props.id} value={props.value} onChange={(e) => props.onChange(e.target.value)}>
        <option value={ALL}>All</option>
        {props.options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </div>
  );
}

export type CockpitViewMode = "table" | "analytics";

export function CockpitGrid({
  rows,
  runs,
  chainNote,
  initialFilters,
  initialView,
}: {
  rows: CockpitRow[];
  runs: AnalyticsRun[];
  chainNote: string | null;
  initialFilters: CockpitFilters;
  initialView: CockpitViewMode;
}) {
  const [view, setView] = useState<CockpitViewMode>(initialView);
  const [filters, setFilters] = useState<CockpitFilters>(initialFilters);
  const client = useIsClient();
  const options = useMemo(() => filterOptions(rows), [rows]);
  const shown = useMemo(() => applyFilters(rows, filters), [rows, filters]);
  const counts = useMemo(() => tally(shown), [shown]);
  const columnDefs = useMemo(() => buildColumnDefs(), []);

  const analytics = useMemo(
    () => (view === "analytics" ? computeAnalytics(shown, runs) : null),
    [view, shown, runs],
  );

  /** Keeps the address bar in step so a filtered view (and which view) can be shared or reloaded. */
  const syncUrl = useCallback((f: CockpitFilters, v: CockpitViewMode) => {
    const parts = [serializeFilters(f), v === "analytics" ? "view=analytics" : ""].filter(Boolean);
    window.history.replaceState(
      null,
      "",
      parts.length ? `?${parts.join("&")}` : window.location.pathname,
    );
  }, []);

  const update = useCallback(
    (patch: Partial<CockpitFilters>) => {
      setFilters((prev) => {
        const next = { ...prev, ...patch };
        syncUrl(next, view);
        return next;
      });
    },
    [syncUrl, view],
  );

  const choose = (v: CockpitViewMode) => {
    setView(v);
    syncUrl(filters, v);
  };

  const gridOptions = useMemo<GridOptions<CockpitRow>>(
    () => ({
      getRowId: (p) => p.data.id,
      pagination: true,
      paginationPageSize: 25,
      paginationPageSizeSelector: PAGE_SIZES,
      tooltipShowDelay: 400,
      animateRows: false,
      defaultColDef: { sortable: true, resizable: true, filter: false, suppressMovable: false },
      overlayNoRowsTemplate:
        rows.length === 0 ? "No records to show." : "No rows match these filters.",
    }),
    [rows.length],
  );

  const onOpen = useCallback((e: RowDoubleClickedEvent<CockpitRow>) => {
    if (e.data) window.location.assign(detailHref(e.data.id));
  }, []);

  const filtered = isFiltered(filters);
  // a handful of rows fits its content; many rows scroll inside a fixed-height grid
  const small = shown.length <= 8;

  return (
    <section aria-labelledby="grid-h" className="card">
      <div className="card__head">
        <h2 id="grid-h">Runs and transactions</h2>
        <div className="seg" role="group" aria-label="Show as">
          <button
            type="button"
            className="btn btn--quiet"
            aria-pressed={view === "table"}
            onClick={() => choose("table")}
          >
            Table
          </button>
          <button
            type="button"
            className="btn btn--quiet"
            aria-pressed={view === "analytics"}
            onClick={() => choose("analytics")}
          >
            Analytics
          </button>
        </div>
        <p className="muted small" role="status" aria-live="polite">
          {shown.length} of {rows.length} rows
          {filtered ? " (filtered)" : ""}
        </p>
      </div>

      <form className="filters" aria-label="Filters" onSubmit={(e) => e.preventDefault()}>
        <div className="field field--wide">
          <label htmlFor="f-q">Search</label>
          <input
            id="f-q"
            type="search"
            maxLength={100}
            value={filters.q}
            placeholder="id, scenario, reason code…"
            onChange={(e) => update({ q: e.target.value })}
          />
        </div>
        <Select
          id="f-source"
          label="Source"
          value={filters.source}
          onChange={(v) => update({ source: v as CockpitFilters["source"] })}
          options={SOURCES.filter((s) => options.sources.includes(s)).map((s) => ({
            value: s,
            label: SOURCE_LABEL[s],
          }))}
        />
        <Select
          id="f-mode"
          label="Buyer mode"
          value={filters.mode}
          onChange={(v) => update({ mode: v as CockpitFilters["mode"] })}
          options={BUYER_MODES.filter((m) => options.modes.includes(m)).map((m) => ({
            value: m,
            label: MODE_LABEL[m],
          }))}
        />
        <Select
          id="f-category"
          label="Category"
          value={filters.category}
          onChange={(v) => update({ category: v })}
          options={options.categories.map((c) => ({ value: c, label: c }))}
        />
        <Select
          id="f-decision"
          label="Decision"
          value={filters.decision}
          onChange={(v) => update({ decision: v as CockpitFilters["decision"] })}
          options={DECISIONS.filter((d) => options.decisions.includes(d)).map((d) => ({
            value: d,
            label: DECISION_LABEL[d],
          }))}
        />
        <Select
          id="f-payment"
          label="Payment status"
          value={filters.payment}
          onChange={(v) => update({ payment: v })}
          options={options.payments.map((p) => ({ value: p, label: p }))}
        />
        <Select
          id="f-verification"
          label="Verification"
          value={filters.verification}
          onChange={(v) => update({ verification: v })}
          options={options.verifications.map((p) => ({ value: p, label: p }))}
        />
        <Select
          id="f-audit"
          label="Audit chain"
          value={filters.audit}
          onChange={(v) => update({ audit: v as CockpitFilters["audit"] })}
          options={AUDIT_STATES.filter((a) => options.audits.includes(a)).map((a) => ({
            value: a,
            label: AUDIT_LABEL[a],
          }))}
        />
        <div className="field">
          <label htmlFor="f-from">From (date)</label>
          <input
            id="f-from"
            type="date"
            value={filters.from ?? ""}
            onChange={(e) => update({ from: e.target.value || null })}
          />
        </div>
        <div className="field">
          <label htmlFor="f-to">To (date)</label>
          <input
            id="f-to"
            type="date"
            value={filters.to ?? ""}
            onChange={(e) => update({ to: e.target.value || null })}
          />
        </div>
        <div className="field">
          <button
            type="button"
            className="btn btn--quiet"
            disabled={!filtered}
            onClick={() => update({ ...NO_FILTERS })}
          >
            Reset filters
          </button>
        </div>
      </form>

      <p className="muted small" data-testid="tallies">
        In view: {counts.total} rows. Allowed {counts.byDecision.ALLOWED}, denied{" "}
        {counts.byDecision.DENIED}, held for a human {counts.byDecision.HELD_FOR_HUMAN}, executed
        unchecked {counts.byDecision.EXECUTED_UNCHECKED}. These are counts of the rows shown,
        nothing more.
      </p>

      {view === "analytics" && analytics ? (
        <AnalyticsView analytics={analytics} chainNote={chainNote} />
      ) : (
        <>
          {shown.length === 0 ? (
            <p className="banner banner--info" role="status">
              {rows.length === 0
                ? "There are no records to show yet."
                : "No rows match these filters. Use “Reset filters” to see all rows."}
            </p>
          ) : null}

          <div
            className="grid-host"
            style={small ? undefined : { height: 640 }}
            aria-label="Cockpit data grid"
          >
            {client ? (
              <AgGridProvider modules={MODULES}>
                <AgGridReact<CockpitRow>
                  theme={THEME}
                  domLayout={small ? "autoHeight" : "normal"}
                  rowData={shown}
                  columnDefs={columnDefs}
                  gridOptions={gridOptions}
                  onRowDoubleClicked={onOpen}
                />
              </AgGridProvider>
            ) : (
              <p className="muted small" role="status">
                Loading grid…
              </p>
            )}
          </div>
          <p className="muted small">
            Click a transaction or run ID, or double-click a row, to open its details.
          </p>
        </>
      )}
    </section>
  );
}
