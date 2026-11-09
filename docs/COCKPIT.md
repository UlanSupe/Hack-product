# Arena Cockpit

One filterable data grid (`/cockpit`) over everything the project has stored about decisions, payments and benchmark runs, with a details page for every row. It uses **AG Grid Community** (MIT) only. It shows nothing that was not recorded: a value a source does not hold is shown as "not recorded", never guessed.

## 1. Use it

1. `npm run dev` (or `npm run build && npm start`) and open `/cockpit`.
2. **Benchmark rows** appear as soon as `benchmark-results/benchmark.json` exists (`npm run benchmark`). They are public: they are simulated results.
3. **Database rows** (transactions, refused offers, attack runs) appear for a signed-in operator only. Sign in on the Negotiations page; the session cookie is shared. The database must exist and be migrated to 0008 (`npm run db:migrate`).
4. Click a transaction or run ID, or double-click a row, to open `/cockpit/<row id>`. `GET /api/cockpit` returns the same rows as JSON and takes the same filters as query parameters.

The page shows the status of each source above the grid: **OK** (with a row count, and for the benchmark its generation time, seed and results hash), **Locked** (database rows need the operator), **Nothing to read yet** / **No results yet** (with the command to create them), or **Error** (with a generic message, never a path or file contents). One source failing never hides the other's rows. If neither has rows, the page says "Nothing to show yet" instead of drawing an empty grid.

## 2. Where each column comes from

Four kinds of row, each built only from stored records (`src/domain/cockpit.ts` maps, `src/adapters/sqlite/cockpit-store.ts` reads):

| Source                   | One row per                                              | Read from                                                                                         |
| ------------------------ | -------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| Transaction (database)   | transaction                                              | `transactions`, agreement, proposals, policy decisions, audit events, attempts, verified webhooks |
| Refused offer (database) | policy `DENY` of an offer (no transaction exists for it) | `negotiation_policy_checks`, proposal, audit event `POLICY_DENIED`                                |
| Attack run (database)    | `attack_runs` row                                        | `attack_runs`, `attack_run_steps`, policy decisions                                               |
| Benchmark run (file)     | run record in `benchmark.json`                           | the persisted benchmark file, after its integrity check                                           |

| Column                     | Meaning                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Timestamp                  | Transaction: last update. Refused offer: decision time. Attack run: start. **Benchmark: the file's generation time for every row** (runs have no time of their own).                                                                                                                                                                                                                                                                                                                                                                                    |
| Transaction / attack ID    | Transaction id, proposal id, attack-run id, or benchmark run id (`case\|mode\|model`). Links to the details page.                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| Scenario / Attack category | Database rows: negotiation id and service category. Benchmark rows: case id and attack mechanism (the 14 attack categories, plus `CONTROL`).                                                                                                                                                                                                                                                                                                                                                                                                            |
| Buyer mode                 | `PROTECTED` for everything that went through the policy engine; `UNSAFE_BASELINE` for the intentionally unsafe baseline (benchmark and attack runs only).                                                                                                                                                                                                                                                                                                                                                                                               |
| Proposed amount            | What was asked: the seller's stated total, or the model's proposal.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| Approved amount            | What a decision approved: the agreement total, or what a protected run paid. **Blank for the unsafe baseline: nothing approved it.**                                                                                                                                                                                                                                                                                                                                                                                                                    |
| Money moved                | What actually moved: captured at PayPal (sandbox), or debited from a simulated ledger / the scripted fake PayPal. 0 when nothing moved.                                                                                                                                                                                                                                                                                                                                                                                                                 |
| Decision                   | `ALLOWED`, `DENIED`, `HELD_FOR_HUMAN` (only a human's approval is missing), `EXECUTED_UNCHECKED` (baseline paid with no check), `MIXED`, `NO_ACTION`, `NOT_EVALUATED`.                                                                                                                                                                                                                                                                                                                                                                                  |
| Reason code                | Policy engine codes (`OVER_PER_TX_CAP`...). **Benchmark arena rows show the benchmark's own specification codes (`OVER_CAP`...), marked "spec"**, not the engine's. Tooltips say which.                                                                                                                                                                                                                                                                                                                                                                 |
| Payment status             | The transaction's state (`AGREED`, `AUTHORIZED`, `CAPTURED`, `NEEDS_RECONCILIATION`...), or `NO_TRANSACTION`, `SIMULATED_PAID`, `NO_PAYMENT`, `NOT_EXECUTED`.                                                                                                                                                                                                                                                                                                                                                                                           |
| Verification               | Database: the PayPal side. `NOT_APPLICABLE`, `UNVERIFIED` (payment started, nothing observed), `OBSERVED` (our server read the order back from PayPal and recorded it as an observed external fact), `WEBHOOK_VERIFIED` (also a webhook that PayPal's own service verified), `NEEDS_RECONCILIATION`. Benchmark: whether the run ended as its specification says (`AS_EXPECTED`, `UNEXPECTED_ALLOWED`, `FALSE_BLOCK`...) or its status (`MODEL_ERROR`, `SKIPPED`). These are different things in one column: the tooltip and the details page say which. |
| Audit chain                | `VERIFIED`, `BROKEN`, `NO_EVENTS`, `NOT_RECORDED` (benchmark rows: a benchmark file keeps no audit events), `UNKNOWN`. See below.                                                                                                                                                                                                                                                                                                                                                                                                                       |

**The audit-chain column is a property of the log.** The hash chain is one log. `VERIFIED` means the whole chain verifies and the row has events. `BROKEN` means the chain's first invalid event is at or before one of the row's events, so those events cannot be vouched for; a row whose events precede the break stays `VERIFIED`. A transaction or refusal whose events cannot be found while the chain is broken is also `BROKEN` (the missing link is the likely damage), not "no events". It is local tamper-evidence, not a signature (see [AUDIT_CHAIN.md](AUDIT_CHAIN.md)).

## 3. Filtering, sorting, pagination, details

- **Filters** (toolbar): free-text search (ids, scenario, category, decision, reason codes, statuses), source, buyer mode, category, decision, payment status, verification, audit chain, and an inclusive date range. A menu offers only values that occur in the rows. They combine with AND, are mirrored in the address bar (`?decision=DENIED&source=BENCHMARK`) so a view can be shared or reloaded, and unknown or malformed query values are ignored. AG Grid's own text filters on the ID, source, timestamp, scenario, category, reason and payment columns apply on top.
- **Sorting**: every column; the default is timestamp, newest first. Amounts sort as the integer minor units behind them, with "not recorded" before any real amount.
- **Pagination**: 25, 50 or 100 rows per page.
- **Row details**: `/cockpit/<id>` shows the same columns, then what the source recorded behind them (policy decisions oldest first, payment attempts, verified webhook deliveries, audit events with the chain note; or a refusal's explanation; or a benchmark run's expected and actual records, fingerprints and the file's hash). An unknown id, an id from a locked source, or an invalid address gets a "Row not found" page that says why. Details are a page, not an in-grid panel, because master/detail is an AG Grid Enterprise feature.
- **Counts** above the grid are plain tallies of the rows in view. The only derived figures anywhere in the Cockpit are the analytics in section 8, which state their denominators.

## 4. AG Grid: licence, version and APIs

- Installed: `ag-grid-community` and `ag-grid-react` **36.3.0**, both **MIT** (read from the installed `package.json` files; a test asserts it). No `ag-grid-enterprise`, no licence key, no trial key, nothing in `.env`.
- API used (checked against the installed typings and the vendor's Getting Started page): `AgGridProvider modules={[AllCommunityModule]}` and `AgGridReact` from `ag-grid-react`; `themeQuartz.withPart(colorSchemeDark)` from `ag-grid-community` through the `theme` prop (no CSS import); `getRowId`, `pagination`, `paginationPageSizeSelector`, `domLayout`, `overlayNoRowsTemplate`, column `valueFormatter`, `comparator`, `cellRenderer`, `pinned`, `sort`, `tooltipValueGetter` and the built-in `agTextColumnFilter`.
- Deliberately **not** used because they are Enterprise: set and multi filters, row grouping, pivoting, master/detail, the side bar, the status bar, integrated charts, context menu extras. Tests scan the column definitions and every source file for them and for any licence call.
- The grid is drawn on the client only (a "Loading grid..." placeholder renders on the server). Filtering by the toolbar is done by the same pure function (`applyFilters`) the API and the tests use.

## 5. AG Studio and the Studio Agent Framework (investigated, not installed)

Re-checked on 2026-11-05 against the npm registry and the vendor's documentation pages. Everything about it is in `src/app/cockpit/studio.ts`, which nothing but a footer note imports. The Cockpit, including its analytics, is complete without it.

| Package                              | Version | Licence (npm)  | Used here                                 |
| ------------------------------------ | ------- | -------------- | ----------------------------------------- |
| `ag-grid-community`, `ag-grid-react` | 36.3.0  | MIT            | **Yes**: the grid and the analytics table |
| `ag-grid-enterprise`                 | 36.3.0  | Commercial     | No                                        |
| `ag-charts-community`                | 14.3.0  | MIT            | No (the charts are plain HTML/CSS bars)   |
| `ag-studio`, `ag-studio-react`       | 3.1.0   | **Commercial** | **No**                                    |

- AG Studio is a separate, commercial product. It needs an Enterprise licence key; the vendor offers a trial. **A trial key must not be committed and this project holds no licence, so the packages are not installed.**
- React integration, per the React Quick Start: `import { AgStudio } from "ag-studio-react"`, `<AgStudio data={data} mode="edit" />` in a sized parent, with `data = { sources: [{ id, data: [plain objects] }] }`. `studioData(rows)` produces that shape from the Cockpit rows.
- The **Agent Framework** is `AgStudioAiModule` from `ag-studio`. It lets users explore data and build dashboards in natural language against **a model you supply**: Studio ships no model adapters (the documented adapter is "an example, not a shipped API", to be copied and adapted), the AI feature must be included in the licence key, and the documented example calls the provider from the browser, which would expose the provider key. Here any such call would have to go through a server route and this project's own provider settings. The page found for it is the Angular quick start; no React version of it was found.
- **Conclusion: the Agent Framework is not available to this project** (no licence, no provider adapter, no vetted server route). Per the brief, no widget-generation feature was built and nothing was added to delay core stability. The analytics in section 8 are built on supported AG Grid Community capabilities instead.
- **What a bounded Studio feature would have to look like if a licence is obtained** (design only, not built or tested): the model may only choose from a fixed allowlist of metric and grouping names defined in code (the fields `computeAnalytics` already returns), returned as JSON and validated with a strict schema before anything is drawn; unknown keys, expressions and free text are rejected; it runs behind an operator-only server route; it has read-only access to the rows the page already shows, no payment, mandate or policy access, and it never executes model-written code. Nothing in the current code depends on this.
- **Not verified:** none of the Studio parts has been run, because running them needs a licence this project does not hold.

## 6. Tests

`test/cockpit`: **data mapping** (every source, every branch, hand-built facts with obvious answers; malformed records), **the real benchmark file** (written by the real benchmark and read back by the Cockpit's own parser; tamper, truncation and shape errors are rejected whole), **filters** (each dimension, combinations, text, dates, menus, URL round trip, seeded property test), **detail navigation** (the ID cell's link, id encoding, detail pages for each source against a real migrated database driven through the real API routes, not-found cases, escaping), **live data** (who may see database rows, agents refused, read-only, the audit-chain column after a real tamper, empty and error states) and **licence discipline** (dependencies, installed licences, no Enterprise or Studio import, no licence key).

The grid component itself is not mounted by the test suite (no browser DOM). It was exercised once by hand in the in-app browser against a real migrated database and the real benchmark file (sign-in gating, 524 benchmark rows plus database rows, pagination, a filter that updates the address bar, and row-detail navigation); that is a manual check, not an automated one.

## 7. Limitations

- The Cockpit shows what is stored. An empty database shows few rows; it does not invent activity. Attack runs are read from `attack_runs`, which nothing in the application writes yet, so those rows appear only if something does.
- Benchmark rows all carry the file's generation time, so sorting by time orders them by id.
- "Verification" and "Reason code" mean different things for database rows and benchmark rows (see the table); filter by source first when that matters.
- The audit-chain column is whole-log tamper-evidence, not proof of authenticity; benchmark rows do not carry audit events. A benchmark file's integrity check proves it was not edited after being written, not that it came from a real run (someone who also recomputes the hash passes).
- Database reads are a snapshot per request on a read-only connection; there is no live push. Nothing in the Cockpit writes, pays, approves or retries anything.
- Operator access is the demo's shared-passcode session; it is not production authentication.

## 8. Benchmark analytics

Open the Cockpit and choose **Analytics** (next to **Table**; `?view=analytics`). The same filters as the table narrow it (search for a scenario or transaction id, category, buyer mode, decision, payment status, verification, audit chain, date range), because the analytics are computed from the rows in view. `GET /api/cockpit` returns the same object as `analytics`. The code is `src/domain/analytics.ts` (pure) and `src/app/cockpit/analytics-view.tsx`.

### What is counted, and what is not

Every figure is a count over the persisted benchmark runs in `benchmark-results/benchmark.json` (after its integrity check) or over stored database rows. Nothing is estimated. Ratios are always printed as "n of d (p%)" so the denominator is on screen; where the denominator is 0 the screen says "n/a (0 attempted)", not 0% or 100%.

- **Copies are excluded.** A run whose input fingerprint appeared earlier in the file is a copy. This is decided on the whole file, so filtering the original out of the view does not promote its copy to evidence.
- **Only completed runs are policy results.** Model errors (the policy was never asked) and infrastructure errors are counted in the scope panel and nowhere else; skipped runs are counted with their reasons (for example `NO_BASELINE_ANALOGUE`) and are not evidence at all.
- **Nothing is blended.** Baseline and protected, the arena simulation and the system layer, and your database's rows and the simulated benchmark rows are always separate lines.
- **Dates:** every benchmark row carries the file's generation time (the runs have no time of their own), so a date filter keeps or drops the whole benchmark; database rows have real timestamps.

### The views

| View                                        | Derived from                                                           | Denominator shown                                          |
| ------------------------------------------- | ---------------------------------------------------------------------- | ---------------------------------------------------------- |
| What these figures count                    | benchmark rows in view                                                 | in view, copies, skipped, executed, completed, errors      |
| Attack outcomes by category (AG Grid table) | completed runs, per layer, category and buyer mode                     | blocked of violations attempted, per row                   |
| Protected: blocked vs unexpectedly allowed  | completed protected runs, per layer                                    | violations attempted; legitimate attempts for false blocks |
| Unsafe baseline vs protected                | identical (scenario, simulated model) pairs, arena layer               | pairs, violations attempted; unpaired runs are counted     |
| Payment state distribution                  | the `paymentStatus` of each row, per source                            | rows of that source in view                                |
| Audit-chain verification                    | the `auditChain` of each row, per source, plus the chain's own verdict | rows of that source in view                                |

Details that matter when reading them:

- "Unexpectedly allowed" is a violation that went through in a **protected** run. If any exists the card turns into an alert listing each run with a link to its detail. A card also says when attempted is not blocked + corrected + allowed (the records do not reconcile).
- "Violations never attempted (model declined)" are shown next to, and never counted as, blocks.
- A zero is stated as a count over the runs in view ("0 of 58 attempted"), with the reminder that it is not a guarantee about other inputs.
- Benchmark money is a simulated ledger or a fake PayPal, shown in the scenario's own **minor units** (the benchmark does not record one currency for the aggregate).
- Benchmark audit status is "not recorded", never "verified": the benchmark keeps no audit events.

### Checked against the benchmark's own aggregation

`test/cockpit/analytics.test.ts` executes the real benchmark and compares the Cockpit's figures with the benchmark's independent aggregation (`test/benchmark/aggregate.ts`): recorded, copies, skipped, executed, completed and error counts; protected arena and system attempted, blocked, allowed, corrected, legitimate and false-block counts; baseline totals; the pairs. On the persisted file (seed 20260401) the Cockpit shows 524 runs, 14 copies, 123 skipped, 387 executed of which 374 completed and 13 model errors, protected arena 58 of 58 attempted violations blocked and 0 allowed, protected system 110 of 110, and 132 pairs in which the baseline allowed 58 of 58 and the protected buyer 0 (checked by eye in the browser against the benchmark's report). The rest of the tests use hand-built records with obvious answers for every exclusion and denominator rule, filters, empty views and the rendered panels.

### Limits of the analytics

- They describe **these runs**. Zero unexpected passes in a finite, mostly hand-written and generator-built benchmark does not show the absence of other bypasses; see [ADVERSARIAL_BENCHMARK.md](ADVERSARIAL_BENCHMARK.md) for the independence caveats (evidence units, repeated families).
- The system layer is judged by the project's own invariants, not an independent specification, and has no unprotected counterpart; the arena's baseline is a scripted simulation.
- Payment states and audit results for the database are those of whatever is in your database (often a handful of synthetic rows); a distribution over 2 rows says little.
- The analytics table is AG Grid Community (sorting, resizing); there are no integrated charts (Enterprise) and no charting dependency, so the "charts" are plain stacked and horizontal bars with the same numbers in text beside them.
- The grid component itself is not mounted by the test suite; the analytics page was checked by hand in the in-app browser (desktop layout, a buyer-mode filter, a 375px width).
