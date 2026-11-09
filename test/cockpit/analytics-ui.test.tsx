import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { computeAnalytics, type AnalyticsRun } from "@/domain/analytics";
import { NO_FILTERS, type CockpitRow } from "@/domain/cockpit";
import { GET as getCockpit } from "@/app/api/cockpit/route";
import { AnalyticsView } from "@/app/cockpit/analytics-view";
import { CockpitView } from "@/app/cockpit/cockpit-view";

const text = (html: string) =>
  html
    .replace(/<[^>]+>/g, " ")
    .replace(/&#x27;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ");

let n = 0;
const run = (over: Partial<AnalyticsRun> = {}): AnalyticsRun => ({
  runId: `AID-0${++n}|PROTECTED|-`,
  layer: "ARENA",
  caseId: `AID-0${n}`,
  mechanism: "BUDGET_ESCALATION",
  mode: "PROTECTED",
  brain: "SUSCEPTIBLE",
  status: "COMPLETED",
  verdict: "AS_EXPECTED",
  reason: null,
  copy: false,
  attempted: 0,
  blocked: 0,
  allowed: 0,
  corrected: 0,
  legitimate: 0,
  falseBlocks: 0,
  modelRestraint: 0,
  movedMinor: 0,
  ...over,
});
const row = (r: AnalyticsRun, over: Partial<CockpitRow> = {}): CockpitRow => ({
  id: `bench:${r.runId}`,
  source: "BENCHMARK",
  timestamp: "2026-11-04T10:00:00.000Z",
  refId: r.runId,
  scenario: r.caseId,
  category: r.mechanism,
  buyerMode: r.mode,
  currency: "USD",
  proposedMinor: null,
  approvedMinor: null,
  movedMinor: r.movedMinor,
  decision: "DENIED",
  reasonCodes: [],
  reasonSource: "SPEC",
  paymentStatus: "NO_PAYMENT",
  verification: r.verdict,
  verificationBasis: "BENCHMARK",
  auditChain: "NOT_RECORDED",
  ...over,
});
const view = (runs: AnalyticsRun[], extra: CockpitRow[] = [], note: string | null = null) =>
  renderToStaticMarkup(
    <AnalyticsView
      analytics={computeAnalytics([...runs.map((r) => row(r)), ...extra], runs)}
      chainNote={note}
    />,
  );

describe("the analytics panels", () => {
  const runs = [
    run({ attempted: 3, blocked: 3, caseId: "PAIR-1" }),
    run({
      attempted: 3,
      allowed: 3,
      mode: "UNSAFE_BASELINE",
      movedMinor: 45_000,
      caseId: "PAIR-1",
    }),
    run({ status: "MODEL_ERROR", verdict: "NOT_EVALUATED" }),
    run({ status: "SKIPPED", verdict: "NOT_EVALUATED", reason: "NO_BASELINE_ANALOGUE: no twin" }),
    run({ copy: true, attempted: 1, blocked: 1 }),
  ];
  const t = text(view(runs));

  it("states the scope: what was counted and what was set aside", () => {
    expect(t).toContain("What these figures count");
    expect(t).toMatch(/Benchmark runs in view\s+5/);
    expect(t).toMatch(/Copies of an earlier run \(excluded\)\s+1/);
    expect(t).toMatch(/Skipped \(not evidence\)\s+1\s+\(NO_BASELINE_ANALOGUE 1\)/);
    expect(t).toMatch(/Completed \(the policy results below\)\s+2 of 3 executed/);
    expect(t).toMatch(/Model errors \(policy never asked\)\s+1/);
  });

  it("prints every ratio with its denominator", () => {
    expect(t).toContain("3 of 3 (100.0%)"); // protected block rate
    expect(t).toContain("0 of 3 (0.0%)"); // unexpectedly allowed
    expect(t).toContain("n/a (0 legitimate attempts)"); // no legitimate attempts: no rate, not 0%
  });

  it("says what a zero result does and does not mean", () => {
    expect(t).toContain("No protected run in view let a violation through: 0 of 3 attempted.");
    expect(t).toContain("not a guarantee about other inputs");
  });

  it("compares baseline and protected on the pair and labels the money as simulated minor units", () => {
    expect(t).toContain("Unsafe baseline versus protected buyer");
    expect(t).toMatch(
      /All pairs\s+1\s+3\s+3 of 3 \(100\.0%\)\s+0 of 3 \(0\.0%\)\s+45000 minor units\s+0 minor units/,
    );
    expect(t).toContain("simulated ledger money");
  });

  it("draws bars with an accessible label that repeats the numbers", () => {
    const html = view(runs);
    expect(html).toContain('role="img"');
    expect(html).toContain("Blocked 3, Corrected 0, Allowed through 0 of 3 attempted violations");
  });
});

describe("a violation that got through is impossible to miss", () => {
  it("names the run, links to its detail, and refuses to call the records reconciled when they are not", () => {
    const bad = run({ attempted: 2, blocked: 1, allowed: 1, verdict: "UNEXPECTED_ALLOWED" });
    const html = view([bad, run({ attempted: 5, blocked: 2 })]);
    const t = text(html);
    expect(t).toContain("1 protected run(s) let a violation through");
    expect(html).toContain(`href="/cockpit/${encodeURIComponent(`bench:${bad.runId}`)}"`);
    expect(t).toContain("These records do not reconcile");
  });
});

describe("empty, partial and mixed-source views", () => {
  it("no benchmark runs: an honest empty state, no invented rows or figures", () => {
    const t = text(view([]));
    expect(t).toContain("No benchmark runs in view");
    expect(t).toContain("No completed benchmark runs in view");
    expect(t).toContain("No complete baseline/protected pair in view");
    expect(t).not.toMatch(/\d+ of \d+ \(/);
  });

  it("payment and audit figures are per source, and benchmark audit is 'not recorded', never 'verified'", () => {
    const tx: CockpitRow = {
      ...row(run()),
      id: "tx:t1",
      source: "TRANSACTION",
      refId: "t1",
      paymentStatus: "CAPTURED",
      auditChain: "VERIFIED",
    };
    const t = text(view([run()], [tx], "Audit chain verifies (12 events)."));
    expect(t).toContain("Payment state distribution");
    expect(t).toContain("Transaction (database)");
    expect(t).toContain("Benchmark run (file)");
    expect(t).toContain("Simulated: a scripted fake PayPal and a simulated ledger");
    expect(t).toContain("Only CAPTURED means money moved");
    expect(t).toContain("Audit chain verifies (12 events).");
    expect(t).toContain("“not recorded” is not “verified”");
    expect(t).toMatch(/NOT_RECORDED\s+1 of 1 \(100\.0%\)/);
    expect(t).toMatch(/VERIFIED\s+1 of 1 \(100\.0%\)/);
  });

  it("loading placeholder for the grid table (AG Grid draws on the client only)", () => {
    expect(text(view([run({ attempted: 1, blocked: 1 })]))).toContain("Loading table…");
  });
});

describe("the Cockpit page offers the analytics and keeps the table", () => {
  const runs = [run({ attempted: 1, blocked: 1 })];
  const data = {
    rows: runs.map((r) => row(r)),
    runs,
    sources: {
      database: { source: "DATABASE", state: "LOCKED", message: "Sign in." } as const,
      benchmark: {
        source: "BENCHMARK",
        state: "OK",
        rows: 1,
        generatedAt: "2026-11-04T10:00:00.000Z",
        resultsHash: "a".repeat(64),
        seed: 1,
      } as const,
    },
  };

  it("shows a Table / Analytics switch with the current view pressed", () => {
    const table = renderToStaticMarkup(<CockpitView data={data} initialFilters={NO_FILTERS} />);
    expect(table).toMatch(/aria-pressed="true"[^>]*>\s*Table/);
    expect(table).not.toContain("What these figures count");
    const analytics = renderToStaticMarkup(
      <CockpitView data={data} initialFilters={NO_FILTERS} initialView="analytics" />,
    );
    expect(analytics).toMatch(/aria-pressed="true"[^>]*>\s*Analytics/);
    expect(text(analytics)).toContain("What these figures count");
  });
});

describe("GET /api/cockpit exposes the same analytics, narrowed by the same filters", () => {
  const call = async (qs = "") =>
    (await (
      await Promise.resolve(getCockpit(new Request(`http://localhost:3000/api/cockpit${qs}`)))
    ).json()) as {
      analytics: ReturnType<typeof computeAnalytics>;
      rows: CockpitRow[];
    };

  it("includes an analytics object whose scope matches the benchmark rows in the response", async () => {
    const body = await call();
    const benchRows = body.rows.filter((r) => r.source === "BENCHMARK").length;
    expect(body.analytics.scope.inView).toBe(benchRows);
  });

  it("a buyer-mode filter narrows the analytics too", async () => {
    const body = await call("?mode=PROTECTED");
    expect(body.analytics.byCategory.every((c) => c.mode === "PROTECTED")).toBe(true);
    expect(body.analytics.scope.inView).toBe(
      body.rows.filter((r) => r.source === "BENCHMARK").length,
    );
  });

  it("a date outside the file's generation date empties the benchmark analytics", async () => {
    const body = await call("?from=2999-01-01");
    expect(body.analytics.scope.inView).toBe(0);
    expect(body.analytics.byCategory).toEqual([]);
  });
});
