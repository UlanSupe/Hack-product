import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { CockpitView } from "@/app/cockpit/cockpit-view";
import {
  AUDIT_LABEL,
  DECISION_LABEL,
  amountText,
  auditTone,
  buildColumnDefs,
  decisionTone,
  formatTimestamp,
  verificationTone,
} from "@/app/cockpit/columns";
import { STUDIO, studioData, studioStatus } from "@/app/cockpit/studio";
import {
  AUDIT_STATES,
  DECISIONS,
  NO_FILTERS,
  mapTransaction,
  type CockpitRow,
} from "@/domain/cockpit";
import type { CockpitData } from "@/application/cockpit";

import { CHAIN_OK, tx } from "./facts";

const ROW: CockpitRow = mapTransaction(tx(), CHAIN_OK);

describe("the columns", () => {
  const cols = buildColumnDefs();

  it("are the ones the Cockpit promises, in reading order", () => {
    expect(cols.map((c) => c.headerName)).toEqual([
      "Source",
      "Timestamp",
      "Transaction / attack ID",
      "Scenario",
      "Attack category / service",
      "Buyer mode",
      "Proposed amount",
      "Approved amount",
      "Money moved",
      "Decision",
      "Reason code",
      "Payment status",
      "Verification",
      "Audit chain",
    ]);
    expect(new Set(cols.map((c) => c.colId)).size).toBe(cols.length);
  });

  it("read real fields of a row (no column invents a value)", () => {
    const keys = new Set(Object.keys(ROW));
    for (const c of cols) expect(keys.has(c.field as string), String(c.field)).toBe(true);
  });

  it("sort newest first by default and pin the ID so it stays visible", () => {
    expect(cols.find((c) => c.colId === "timestamp")?.sort).toBe("desc");
    expect(cols.find((c) => c.colId === "refId")?.pinned).toBe("left");
  });

  it("sort amounts as the integer behind them, with 'not recorded' before every real amount", () => {
    for (const id of ["proposedMinor", "approvedMinor"]) {
      const cmp = cols.find((c) => c.colId === id)?.comparator as (
        a: number | null,
        b: number | null,
      ) => number;
      expect([9_000, null, 100, 0].sort(cmp)).toEqual([null, 0, 100, 9_000]);
      expect([80_000, 8_000, 800].sort(cmp)).toEqual([800, 8_000, 80_000]);
    }
  });

  it("display exact amounts, and a dash instead of a number that is not there", () => {
    expect(amountText(ROW, 8_000)).toBe("80.00 USD");
    expect(amountText(ROW, 0)).toBe("0.00 USD");
    expect(amountText(ROW, null)).toBe("-");
    expect(formatTimestamp("2026-10-12T09:05:00.000Z")).toBe("2026-10-12 09:05:00Z");
    expect(formatTimestamp(null)).toBe("not recorded");
  });

  it("have a label and a tone with an icon for every decision and audit state (colour is never the only signal)", () => {
    for (const d of DECISIONS) {
      expect(DECISION_LABEL[d].length).toBeGreaterThan(0);
      expect(decisionTone(d).icon.length).toBeGreaterThan(0);
    }
    for (const a of AUDIT_STATES) {
      expect(AUDIT_LABEL[a].length).toBeGreaterThan(0);
      expect(auditTone(a).icon.length).toBeGreaterThan(0);
    }
    expect(decisionTone("EXECUTED_UNCHECKED").tone).toBe("danger");
    expect(decisionTone("DENIED").tone).toBe("info");
    expect(auditTone("BROKEN").tone).toBe("danger");
    expect(verificationTone("UNEXPECTED_ALLOWED").tone).toBe("danger");
    expect(verificationTone("WEBHOOK_VERIFIED").tone).toBe("success");
    expect(verificationTone("UNVERIFIED").tone).toBe("warning");
    expect(verificationTone("NOT_APPLICABLE").tone).toBe("neutral");
  });

  it("use only Community-edition column features", () => {
    const enterpriseKeys = [
      "rowGroup",
      "pivot",
      "enableRowGroup",
      "enablePivot",
      "aggFunc",
      "enableValue",
      "chartDataType",
      "menuTabs",
    ];
    const enterpriseFilters = ["agSetColumnFilter", "agMultiColumnFilter"];
    for (const c of cols) {
      for (const k of enterpriseKeys) expect(c, `${c.colId} uses ${k}`).not.toHaveProperty(k);
      if (typeof c.filter === "string") expect(enterpriseFilters).not.toContain(c.filter);
    }
  });
});

/* ------------------------------------------------------------------ licence discipline */

const walk = (dir: string): string[] =>
  readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    return statSync(p).isDirectory() ? walk(p) : [p];
  });

describe("licence discipline", () => {
  const pkg = JSON.parse(readFileSync("package.json", "utf8")) as {
    dependencies: Record<string, string>;
    devDependencies?: Record<string, string>;
  };
  const all = { ...pkg.dependencies, ...pkg.devDependencies };

  it("depends on AG Grid Community and its React wrapper only, never Enterprise or Studio", () => {
    expect(all["ag-grid-community"]).toBeDefined();
    expect(all["ag-grid-react"]).toBeDefined();
    for (const name of Object.keys(all)) {
      expect(name, name).not.toMatch(
        /^ag-grid-enterprise$|^ag-studio|^ag-charts-enterprise$|^@ag-grid-enterprise/,
      );
    }
  });

  it("the installed AG Grid packages are MIT licensed", () => {
    for (const name of ["ag-grid-community", "ag-grid-react"]) {
      const p = JSON.parse(readFileSync(join("node_modules", name, "package.json"), "utf8")) as {
        license: string;
      };
      expect(p.license, name).toBe("MIT");
    }
  });

  it("no source file imports an Enterprise or Studio package, or sets a licence key", () => {
    const files = [...walk("src"), ...walk("test/cockpit")].filter(
      (f) => /\.(tsx?|css)$/.test(f) && !f.endsWith("grid-and-license.test.tsx"),
    );
    expect(files.length).toBeGreaterThan(20);
    for (const f of files) {
      const code = readFileSync(f, "utf8")
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/^\s*\/\/.*$/gm, "");
      expect(code, f).not.toMatch(
        /from\s+["'](ag-grid-enterprise|ag-studio|ag-studio-react|ag-charts-enterprise)/,
      );
      expect(code, f).not.toMatch(
        /LicenseManager|setLicenseKey|licenseKey|AG_GRID_LICENSE|Using_this_\{AG_Grid\}/i,
      );
    }
  });

  it("the Cockpit does not depend on the Studio module in any way", () => {
    const studioImporters = walk("src")
      .filter((f) => /\.(tsx?)$/.test(f) && f.replaceAll("\\", "/") !== "src/app/cockpit/studio.ts")
      .filter((f) =>
        /from\s+["'][^"']*\/studio["']|from\s+["']\.\/studio["']/.test(readFileSync(f, "utf8")),
      );
    // the only importer is the footer note, which asks "is it enabled?"
    expect(studioImporters.map((f) => f.replaceAll("\\", "/"))).toEqual([
      "src/app/cockpit/cockpit-view.tsx",
    ]);
  });

  it("contains no key-shaped string anywhere in the repository sources", () => {
    for (const f of [...walk("src"), ...walk("test"), "package.json", ".env.example"]) {
      if (!/\.(tsx?|json|example|md)$/.test(f)) continue;
      const text = readFileSync(f, "utf8");
      expect(text, f).not.toMatch(
        /\bag-grid-license\b|\bAG_GRID_LICENSE_KEY\b|Using_this_\{AG_Grid\}_Enterprise_key/i,
      );
    }
  });
});

/* ------------------------------------------------------------------ studio */

describe("AG Studio (separate, optional)", () => {
  it("is reported as not enabled, with the reason and the steps for someone who holds a licence", () => {
    const s = studioStatus();
    expect(s.enabled).toBe(false);
    expect(s.reason).toMatch(/commercial/);
    expect(s.steps.join(" ")).toMatch(/never commit the key/);
    expect(STUDIO.license).toMatch(/Commercial/);
    expect(STUDIO.packages).toEqual(["ag-studio-react", "ag-studio"]);
  });

  it("maps rows to the documented data-source shape: one source of flat, scalar records", () => {
    const rows = [ROW, { ...ROW, id: "tx:2", reasonCodes: ["A", "B"], proposedMinor: null }];
    const d = studioData(rows);
    expect(d.sources).toHaveLength(1);
    expect(d.sources[0]?.id).toBe("cockpit");
    expect(d.sources[0]?.data).toHaveLength(2);
    for (const rec of d.sources[0]?.data ?? []) {
      for (const v of Object.values(rec))
        expect(["string", "number", "boolean"].includes(typeof v) || v === null).toBe(true);
    }
    expect(d.sources[0]?.data[1]).toMatchObject({
      reasonCodes: "A,B",
      proposedMinor: null,
      id: "tx:2",
    });
    expect(studioData([]).sources[0]?.data).toEqual([]);
  });
});

/* ------------------------------------------------------------------ the page body */

const ok = {
  source: "DATABASE",
  state: "OK",
  rows: 1,
  note: "Audit chain verifies (4 events).",
} as const;
const bench = {
  source: "BENCHMARK",
  state: "OK",
  rows: 3,
  generatedAt: "2026-11-04T10:00:00.000Z",
  resultsHash: "a".repeat(64),
  seed: 7,
} as const;

const view = (data: CockpitData) =>
  renderToStaticMarkup(<CockpitView data={data} initialFilters={NO_FILTERS} />);

describe("the page body", () => {
  it("with rows: shows both sources' status, counts of what is there, the filters and the grid placeholder", () => {
    const html = view({ rows: [ROW], runs: [], sources: { database: ok, benchmark: bench } });
    expect(html).toContain("Integrity check passed");
    expect(html).toContain("a".repeat(64));
    expect(html).toContain("Audit chain verifies (4 events).");
    expect(html).toContain(
      "1 rows in total: 1 transactions, 0 refused offers, 0 attack runs, 0 benchmark runs",
    );
    expect(html).toContain('aria-label="Filters"');
    expect(html).toContain("Loading grid");
    expect(html).toContain("1 of 1 rows");
    expect(html).toContain('href="/cockpit"');
    expect(html).toContain("AG Studio");
    expect(html).toContain("does not need it");
  });

  it("with nothing: says so and how to get data, instead of an empty grid", () => {
    const html = view({
      rows: [],
      runs: [],
      sources: {
        database: {
          source: "DATABASE",
          state: "UNAVAILABLE",
          message: "The database does not exist yet.",
        },
        benchmark: {
          source: "BENCHMARK",
          state: "MISSING",
          message: "No benchmark has been run yet.",
        },
      },
    });
    expect(html).toContain("Nothing to show yet");
    expect(html).toContain("The database does not exist yet.");
    expect(html).toContain("No benchmark has been run yet.");
    expect(html).not.toContain("Loading grid");
    expect(html).not.toContain('aria-label="Filters"');
  });

  it("an errored source is flagged as an error while the other source's rows still show", () => {
    const html = view({
      rows: [ROW],
      runs: [],
      sources: {
        database: ok,
        benchmark: {
          source: "BENCHMARK",
          state: "ERROR",
          message: "benchmark.json was edited after it was written.",
        },
      },
    });
    expect(html).toContain("chip--danger");
    expect(html).toContain("benchmark.json was edited after it was written.");
    expect(html).toContain("Loading grid");
  });

  it("a locked database is explained as locked, not as empty or broken", () => {
    const html = view({
      rows: [],
      runs: [],
      sources: {
        database: {
          source: "DATABASE",
          state: "LOCKED",
          message: "Sign in as the operator (on the Negotiations page) to include database rows.",
        },
        benchmark: bench,
      },
    });
    expect(html).toContain("Locked");
    expect(html).toContain("Sign in as the operator");
  });

  it("carries the starting filters into the form (a shared link keeps its filters)", () => {
    const html = renderToStaticMarkup(
      <CockpitView
        data={{ rows: [ROW], runs: [], sources: { database: ok, benchmark: bench } }}
        initialFilters={{ ...NO_FILTERS, q: "neg_1", decision: "ALLOWED" }}
      />,
    );
    expect(html).toContain('value="neg_1"');
    expect(html).toContain("(filtered)");
  });

  it("a filter that matches nothing shows a clear empty state and a way back, not a blank grid", () => {
    const html = renderToStaticMarkup(
      <CockpitView
        data={{ rows: [ROW], runs: [], sources: { database: ok, benchmark: bench } }}
        initialFilters={{ ...NO_FILTERS, q: "no-such-thing" }}
      />,
    );
    expect(html).toContain("0 of 1 rows");
    expect(html).toContain("No rows match these filters");
    expect(html).toContain("Reset filters");
    expect(html).toContain("In view: 0 rows");
  });

  it("escapes anything it echoes from a source", () => {
    const html = view({
      rows: [],
      runs: [],
      sources: {
        database: { source: "DATABASE", state: "ERROR", message: "<img src=x onerror=alert(1)>" },
        benchmark: bench,
      },
    });
    expect(html).not.toContain("<img src=x");
  });
});
