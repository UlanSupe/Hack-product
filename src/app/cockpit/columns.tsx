import type { ColDef, ICellRendererParams, ValueFormatterParams } from "ag-grid-community";
import type { ReactElement } from "react";

import {
  SOURCE_LABEL,
  detailHref,
  formatAmount,
  type AuditState,
  type CockpitRow,
  type Decision,
} from "@/domain/cockpit";
import { Chip, type Tone } from "../_arena/panels";

/**
 * The grid's columns. Only AG Grid Community features are used: sorting, resizing, pinning, text filters and
 * pagination. (Set filters, row grouping, master/detail, the side bar and the status bar are Enterprise features and are
 * deliberately not used; row details are a page, see detail-view.tsx.) Amounts are sorted as integer minor units and only
 * formatted for display.
 */

export const DECISION_LABEL: Record<Decision, string> = {
  ALLOWED: "Allowed",
  DENIED: "Denied",
  HELD_FOR_HUMAN: "Held for a human",
  EXECUTED_UNCHECKED: "Executed, unchecked",
  MIXED: "Mixed",
  NO_ACTION: "No action",
  NOT_EVALUATED: "Not evaluated",
};

export const AUDIT_LABEL: Record<AuditState, string> = {
  VERIFIED: "Verified",
  BROKEN: "Broken",
  NO_EVENTS: "No events",
  NOT_RECORDED: "Not recorded",
  UNKNOWN: "Unknown",
};

export const MODE_LABEL = { PROTECTED: "Protected", UNSAFE_BASELINE: "Unsafe baseline" } as const;

/** Status vocabulary shared with the Arena: success = completed, info = blocked, warning = pending, danger = violation or error. */
export const decisionTone = (d: Decision): { tone: Tone; icon: string } =>
  ({
    ALLOWED: { tone: "success", icon: "✓" },
    DENIED: { tone: "info", icon: "■" },
    HELD_FOR_HUMAN: { tone: "warning", icon: "…" },
    EXECUTED_UNCHECKED: { tone: "danger", icon: "!" },
    MIXED: { tone: "warning", icon: "±" },
    NO_ACTION: { tone: "neutral", icon: "–" },
    NOT_EVALUATED: { tone: "neutral", icon: "?" },
  })[d] as { tone: Tone; icon: string };

export const auditTone = (a: AuditState): { tone: Tone; icon: string } =>
  ({
    VERIFIED: { tone: "success", icon: "✓" },
    BROKEN: { tone: "danger", icon: "!" },
    NO_EVENTS: { tone: "neutral", icon: "–" },
    NOT_RECORDED: { tone: "neutral", icon: "–" },
    UNKNOWN: { tone: "warning", icon: "?" },
  })[a] as { tone: Tone; icon: string };

const GOOD = new Set(["WEBHOOK_VERIFIED", "OBSERVED", "AS_EXPECTED", "NO_INVARIANT_VIOLATED"]);
const PENDING = new Set(["UNVERIFIED", "NEEDS_RECONCILIATION", "NOT_FINISHED", "MODEL_ERROR"]);
const BAD = new Set([
  "UNEXPECTED_ALLOWED",
  "FALSE_BLOCK",
  "UNEXPECTED_OTHER",
  "INVARIANTS_VIOLATED",
  "INFRASTRUCTURE_ERROR",
]);

export const verificationTone = (v: string): { tone: Tone; icon: string } =>
  GOOD.has(v)
    ? { tone: "success", icon: "✓" }
    : BAD.has(v)
      ? { tone: "danger", icon: "!" }
      : PENDING.has(v)
        ? { tone: "warning", icon: "…" }
        : { tone: "neutral", icon: "–" };

export const NOT_RECORDED = "not recorded";

const text = (v: unknown): string => (typeof v === "string" && v.length > 0 ? v : NOT_RECORDED);

export const formatTimestamp = (iso: string | null): string =>
  iso === null ? NOT_RECORDED : iso.replace("T", " ").replace(/\.\d+Z$/, "Z");

/** The amount cell: formatted for people, sorted as the integer behind it. */
export const amountText = (row: CockpitRow, minor: number | null): string =>
  minor === null ? "-" : formatAmount(minor, row.currency);

function ChipCell<T extends string>(
  p: ICellRendererParams<CockpitRow, T>,
  label: (v: T) => string,
  tone: (v: T) => { tone: Tone; icon: string },
): ReactElement | null {
  const v = p.value;
  if (v === undefined || v === null) return null;
  const t = tone(v);
  return (
    <Chip tone={t.tone} icon={t.icon}>
      {label(v)}
    </Chip>
  );
}

export function IdLink(p: ICellRendererParams<CockpitRow, string>): ReactElement | null {
  const row = p.data;
  if (!row) return null;
  return (
    <a href={detailHref(row.id)} className="mono" aria-label={`Open details for ${row.refId}`}>
      {row.refId}
    </a>
  );
}

export function buildColumnDefs(): ColDef<CockpitRow>[] {
  return [
    {
      colId: "source",
      headerName: "Source",
      field: "source",
      width: 215,
      valueFormatter: (p: ValueFormatterParams<CockpitRow, CockpitRow["source"]>) =>
        p.value ? SOURCE_LABEL[p.value] : NOT_RECORDED,
      filter: "agTextColumnFilter",
    },
    {
      colId: "timestamp",
      headerName: "Timestamp",
      field: "timestamp",
      width: 190,
      sort: "desc",
      valueFormatter: (p: ValueFormatterParams<CockpitRow, string | null>) =>
        formatTimestamp(p.value ?? null),
      filter: "agTextColumnFilter",
    },
    {
      colId: "refId",
      headerName: "Transaction / attack ID",
      field: "refId",
      width: 250,
      pinned: "left",
      cellRenderer: IdLink,
      filter: "agTextColumnFilter",
    },
    {
      colId: "scenario",
      headerName: "Scenario",
      field: "scenario",
      width: 190,
      valueFormatter: (p) => text(p.value),
      filter: "agTextColumnFilter",
    },
    {
      colId: "category",
      headerName: "Attack category / service",
      field: "category",
      width: 210,
      valueFormatter: (p) => text(p.value),
      filter: "agTextColumnFilter",
    },
    {
      colId: "buyerMode",
      headerName: "Buyer mode",
      field: "buyerMode",
      width: 150,
      valueFormatter: (p: ValueFormatterParams<CockpitRow, CockpitRow["buyerMode"]>) =>
        p.value ? MODE_LABEL[p.value] : NOT_RECORDED,
    },
    {
      colId: "proposedMinor",
      headerName: "Proposed amount",
      field: "proposedMinor",
      width: 160,
      type: "rightAligned",
      valueFormatter: (p) => (p.data ? amountText(p.data, p.value as number | null) : "-"),
      tooltipValueGetter: () =>
        "What was asked: the seller's offer total, or the model's proposal. Not recorded for some sources.",
      comparator: (a: number | null, b: number | null) => (a ?? -1) - (b ?? -1),
    },
    {
      colId: "approvedMinor",
      headerName: "Approved amount",
      field: "approvedMinor",
      width: 160,
      type: "rightAligned",
      valueFormatter: (p) => (p.data ? amountText(p.data, p.value as number | null) : "-"),
      tooltipValueGetter: () =>
        "What a decision approved: the agreement total, or what a protected run paid. The unsafe baseline has no approval, so it is blank here; see Money moved.",
      comparator: (a: number | null, b: number | null) => (a ?? -1) - (b ?? -1),
    },
    {
      colId: "movedMinor",
      headerName: "Money moved",
      field: "movedMinor",
      width: 150,
      type: "rightAligned",
      valueFormatter: (p) => (p.data ? amountText(p.data, p.value as number | null) : "-"),
      tooltipValueGetter: (p) =>
        p.data?.source === "BENCHMARK" || p.data?.paymentStatus === "SIMULATED_PAID"
          ? "Simulated ledger or scripted fake PayPal: no real money."
          : "Captured at PayPal (sandbox). 0 when nothing was captured.",
      comparator: (a: number | null, b: number | null) => (a ?? -1) - (b ?? -1),
    },
    {
      colId: "decision",
      headerName: "Decision",
      field: "decision",
      width: 190,
      cellRenderer: (p: ICellRendererParams<CockpitRow, Decision>) =>
        ChipCell(p, (v) => DECISION_LABEL[v], decisionTone),
      valueFormatter: (p: ValueFormatterParams<CockpitRow, Decision>) =>
        p.value ? DECISION_LABEL[p.value] : NOT_RECORDED,
    },
    {
      colId: "reasonCodes",
      headerName: "Reason code",
      field: "reasonCodes",
      width: 270,
      valueFormatter: (p: ValueFormatterParams<CockpitRow, string[]>) =>
        p.value && p.value.length > 0 ? p.value.join(", ") : "-",
      tooltipValueGetter: (p) =>
        p.data?.reasonSource === "POLICY"
          ? "Reason codes from the policy engine."
          : p.data?.reasonSource === "SPEC"
            ? "Benchmark only: the rules the offer breaks according to the benchmark's independent specification, not the policy engine's codes."
            : p.data?.reasonSource === "INVARIANT"
              ? "Invariants the run recorded as violated."
              : p.data?.reasonSource === "OUTCOME"
                ? "The outcome code the scenario reported."
                : "No reason recorded.",
      filter: "agTextColumnFilter",
      filterValueGetter: (p) => p.data?.reasonCodes.join(" ") ?? "",
    },
    {
      colId: "paymentStatus",
      headerName: "Payment status",
      field: "paymentStatus",
      width: 200,
      filter: "agTextColumnFilter",
    },
    {
      colId: "verification",
      headerName: "Verification",
      field: "verification",
      width: 220,
      cellRenderer: (p: ICellRendererParams<CockpitRow, string>) =>
        ChipCell(p, (v) => v.replaceAll("_", " ").toLowerCase(), verificationTone),
      tooltipValueGetter: (p) =>
        p.data?.verificationBasis === "PAYPAL"
          ? "PayPal side: OBSERVED = our server read the order from PayPal; WEBHOOK_VERIFIED = also a webhook that PayPal's service verified. Neither proves PayPal is truthful."
          : p.data?.verificationBasis === "BENCHMARK"
            ? "Benchmark side: whether the run ended as its specification says."
            : "Nothing to verify (no PayPal payment started).",
    },
    {
      colId: "auditChain",
      headerName: "Audit chain",
      field: "auditChain",
      width: 160,
      cellRenderer: (p: ICellRendererParams<CockpitRow, AuditState>) =>
        ChipCell(p, (v) => AUDIT_LABEL[v], auditTone),
      tooltipValueGetter: () =>
        "Local tamper-evidence of the audit log (a hash chain), not a signature. 'Broken' = the row's events sit at or after the chain's first invalid event.",
    },
  ];
}
