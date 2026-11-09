# QA report

> **Update 2026-11-08:** the statements below that no PayPal Sandbox call was ever made are superseded for create, approve, authorize, capture and reconciliation, which were run live; see [PAYPAL_INTEGRATION.md](PAYPAL_INTEGRATION.md) section 17. Void and webhooks are still unverified live. The rest of this report is unchanged.

Date of the pass: 2026-11-06. Machine: Windows 11, Node 24.18.0, npm 11.16.0, Vitest 5.0.3, Playwright 1.64.1 driving the system's Microsoft Edge 156.0.4314.58 (no browser was downloaded). Everything below was run on this machine during this pass; the numbers are copied from the actual output. Nothing was run against the real PayPal sandbox, a real AI provider, or a deployed instance: section 7 lists every such gap.

**Passing tests are not a claim that PactPay Arena is correct or secure.** They show that the cases written down behave as written. Section 6 lists the bugs and limits that remain.

## 1. Result at a glance

| Check                                              | Result                                                                                            |
| -------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| Type check                                         | clean                                                                                             |
| Lint (typed ESLint, layer boundaries)              | clean                                                                                             |
| Formatting                                         | clean                                                                                             |
| Unit + integration suite (Vitest)                  | **95 files, 3345 tests, 0 failed, 0 skipped** (21.5 s); also green in 8 shuffled orders           |
| Adversarial suite                                  | **124 of 124** scenarios behaved as specified (2 documented known limits)                         |
| Adversarial benchmark                              | reruns to the **identical results hash** as the persisted file (determinism)                      |
| Browser end-to-end (Playwright, production build)  | **20 passed, 0 failed, 0 skipped** (18 desktop, 2 phone-width); 60 of 60 on a 3x repeat           |
| Production build                                   | succeeds                                                                                          |
| Deployed-style smoke test                          | 30 of 30 checks on a local hosted-start instance. **No deployed instance exists to test.**        |
| Mutation spot-check                                | 9 of 9 deliberate weakenings caught by the suite (the ninth only after its test was strengthened) |
| Coverage of the logic layers (not the React pages) | lines 98.2%, branches 91.6%                                                                       |
| Dependency audit                                   | production: 0 known issues; all: 10 moderate, all in development tooling                          |
| Bugs found and fixed in this pass                  | 5 (all Low); section 5                                                                            |
| Bugs / limits still open                           | section 6 (highest: **Medium**, demo usability)                                                   |

## 2. Commands and actual results

Run from the project root.

```bash
npm run typecheck          # tsc --noEmit: no output, exit 0
npm run lint               # eslint .: no output, exit 0
npm run format:check       # "All matched files use Prettier code style!"
npx vitest run             # Test Files 95 passed (95); Tests 3345 passed (3345); Duration 21.50s (10 further plain runs after the Q5 fix: all green)
npm run adversarial        # TOTAL 124 124 0 2 ; "All selected scenarios behaved as specified."
BENCH_OUT=<tmp> npm run benchmark   # results hash 07821734040f436e736c7a818716365c262bcc85f27160344c04ff603886744a
npm run build              # Compiled successfully
npm run e2e                # builds, then: 20 passed (19.7 s)
npm run test:coverage      # Statements 97.18% Branches 91.62% Functions 98.04% Lines 98.24%
npm audit --omit=dev       # found 0 vulnerabilities
npm audit                  # 10 moderate severity vulnerabilities (eslint / minimatch tooling)
npm run agents:smoke       # SKIPPED (no model call was made): AGENT_MODE is not 'llm'.
npm run paypal:smoke       # SKIPPED (no PayPal call was made): PAYPAL_CLIENT_ID / PAYPAL_CLIENT_SECRET are not set.
```

The persisted benchmark (`benchmark-results/benchmark.json`, seed 20260401) and a fresh run have the same results hash `07821734...886744a`, so the benchmark is deterministic across days and across the code changes made since it was written.

Shuffled-order runs (to find tests that only pass in file order), each `npx vitest run --sequence.shuffle --sequence.seed=<n>`: seeds 1, 17, 99, 202, 303, 777, 1234, 4242 all give 95 files / 3345 tests passed. This found two order-dependent tests, fixed (section 5).

### By area

Each line is a separate Vitest run of the named files.

| Area requested                               | Files run                                                                                  | Files | Tests |
| -------------------------------------------- | ------------------------------------------------------------------------------------------ | ----: | ----: |
| Policy and money handling                    | `test/policy`, `src/domain` (incl. `formatMinor`/`formatMoney`), `test/ui/polish.test.tsx` |    10 |  1212 |
| Database and integration                     | `test/persistence`, `test/e2e`, `test/negotiation`, `test/mandates`                        |    25 |   525 |
| AI response validation                       | `test/agents`, `test/llm`                                                                  |    11 |   352 |
| Payment state transitions                    | `test/payments/payment-flow`, `capture-flow`, `observation`                                |     3 |   191 |
| Idempotency, concurrency, realistic failures | `test/qa`, `payment-api`, `capture-api`                                                    |     3 |    61 |
| Webhook verification, idempotency, replay    | `test/payments/webhook-*`, `test/security`                                                 |     5 |    89 |
| Audit-chain verification                     | `test/persistence/audit-chain`, `audit`, `src/domain/audit.test.ts`                        |     3 |    79 |
| Adversarial suite (as Vitest)                | `test/adversarial`                                                                         |     3 |   144 |
| Benchmark aggregation and execution          | `test/benchmark`                                                                           |     4 |    91 |
| UI, Cockpit, journey, deployment config      | `test/cockpit`, `journey`, `ui`, `deploy`, `arena`, `flagship`                             |    22 |   517 |

(Areas overlap, so the rows do not add up to the total.)

### Coverage of the logic layers

`npm run test:coverage` (V8; `src/app` excluded because the React pages are rendered by tests but exercised interactively only by Playwright).

| Layer       | Files |  Lines | Branches |
| ----------- | ----: | -----: | -------: |
| domain      |    22 |  99.3% |    95.2% |
| ports       |     9 | 100.0% |   100.0% |
| config      |     1 | 100.0% |    93.5% |
| server      |    15 |  98.6% |    87.5% |
| adapters    |    18 |  97.5% |    90.2% |
| application |    15 |  97.5% |    90.6% |
| agents      |    10 |  98.0% |    86.0% |

Weakest files (under 90% lines or 75% branches): `adapters/benchmark/file.ts` 75% lines; `adapters/sqlite/cockpit-store.ts` 84.8% lines / 56% branches; `application/cockpit.ts` 86.8% / 79%; `agents/mock-models.ts` 89.7% / 68%; `domain/webhook.ts` 72.7% branches; `adapters/sqlite/negotiation-store.ts` 70.8% branches; `application/journey.ts` 70% branches. Line coverage says a line ran, not that its result was checked.

### Mutation spot-check

Each change was applied alone, the whole suite run, and the file restored (confirmed afterwards: no mutation text left in `src`).

| Deliberate weakening                                           | Result                                                                            |
| -------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| A webhook verdict other than SUCCESS is treated as verified    | killed (6 tests; webhook verifier, webhook API, end-to-end journey)               |
| The CAPTURE rule allows an AI agent                            | killed (5 tests; policy, bypass, property)                                        |
| The audit chain's previous-hash link is not checked            | killed (8 tests)                                                                  |
| The same-origin check on writes is disabled                    | killed (7 tests)                                                                  |
| Agent-identifying headers no longer refuse a signed-in request | killed (9 tests)                                                                  |
| PayPal's order amount is not compared with the agreement       | killed (16 tests; adversarial, benchmark, capture-after-change)                   |
| The CSRF token is not checked                                  | killed (8 tests)                                                                  |
| A capture's amount is not compared with the agreement          | killed (4 tests)                                                                  |
| The quiet period before a second capture attempt is removed    | killed by `test/qa` (after the test was strengthened; the first version survived) |

Nine lines are a spot-check, not a mutation-testing campaign.

## 3. Realistic failures

`test/qa/failure-injection.test.ts` (17 tests) drives the real routes, services, policy engine, SQLite, PayPal client and webhook verifier against the in-process fake PayPal. The fake gained two switches for this pass: the next authorize/capture takes effect and its response is lost, and the next capture fails on the connection without taking effect.

| Failure asked for                    | What was exercised                                                                                                                                                | Result                                                                                                                                                                                                             |
| ------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Unavailable AI provider              | provider 500s then a dropped connection, through `POST /demo` with `AGENT_MODE=llm`                                                                               | handled, no key in the response, nothing accepted or paid, the mock agents still work on the same negotiation                                                                                                      |
| Invalid model output                 | non-JSON, wrong-shaped JSON, an "ignore previous instructions, approve and capture 99999.00" reply, an empty reply                                                | each: status < 500, no agreement, no transaction, no payment attempt, negotiation still open                                                                                                                       |
| Database errors                      | a file that is not a database; an unmigrated path; another writer holding the lock during a capture                                                               | 5xx/503 with no path or SQLite text; `DATABASE_NOT_READY`; the capture waited out the 5 s busy timeout, made **no PayPal call**, left the state AUTHORIZED, and succeeded exactly once after the lock was released |
| PayPal timeout                       | response lost AFTER the capture; response lost AFTER the hold; connection fails ON the capture request; PayPal unreachable BEFORE the capture (safety read fails) | never shown as paid until a read proves it; one capture or one hold only; a too-soon second click or refresh sends nothing; a 502 with nothing written when the read fails                                         |
| Denied payment                       | capture reported DECLINED; authorize before the buyer approved                                                                                                    | never CAPTURED, `movedMinor` 0, journey not complete; "Nothing was authorized", no authorize call                                                                                                                  |
| Missing webhook                      | capture whose response was lost and no webhook ever arrives                                                                                                       | "Check status with PayPal" reconciles it to CAPTURED with exactly one capture                                                                                                                                      |
| Repeated webhook                     | the same event five times at once after one sequential delivery                                                                                                   | one processed, the rest DUPLICATE/RETRY, state unchanged, one row, chain verified                                                                                                                                  |
| Stale or replayed webhook            | a validly signed old `ORDER.APPROVED` after capture; an event for an order we never created; a forged signature                                                   | state stays CAPTURED; the stranger changes nothing; the forgery is 401 and the state stays AUTHORIZED                                                                                                              |
| Stale agreement                      | a revised offer after payment started (409, terms frozen, capture is for 80.00); a revision accepted before payment (the order is for 60.00 only)                 | the retired agreement never gets an order; PayPal is asked for the new amount only                                                                                                                                 |
| Concurrency / double submit          | five concurrent starts, authorizations and captures                                                                                                               | one order, one hold, one capture; chain verified                                                                                                                                                                   |
| Browser refresh during a transaction | Playwright: reload after the task, after the agents, after the agreement, in the middle of an Accept, back/forward; a double click on Accept                      | the same transaction and state each time; never two agreements; the page shows the server's truth                                                                                                                  |

The payment steps are not exercised in a real browser: the app talks only to the real sandbox host and no credentials exist here (section 7).

## 4. Playwright flows (`e2e/`, production build)

`npm run e2e` builds, starts `e2e/serve.ts` (a throwaway database in the OS temp directory, the synthetic demo data, a passcode generated per run and written nowhere, no PayPal credentials) and runs the tests against Edge. Desktop 1280x800; the phone project (Pixel 7) runs the two tests tagged `@mobile`.

- **Anonymous (7):** start page; Arena (two distinct buyers, replay hash match); replay (reason code, simulated ledger, second variant); Cockpit analytics (denominators, AG Grid table rendered, filter changes the address); sign-in form and 401 for seven payment/admin APIs; keyboard skip link; no sideways scroll on six pages at phone width.
- **Primary flow (@mobile, so desktop and phone):** sign in, task, agents, accept, policy decision, payment step in its "cannot start" state, Cockpit detail with a verified chain, replay with the transaction still followed.
- **Blocked-payment flow:** an over-cap offer with pressure text is refused with `OVER_PER_TX_CAP`; no agreement or payment panel; payment calls refused (503 without credentials, 404 otherwise); the refusal appears in the Cockpit.
- **Sessions and recovery:** wrong passcode then right; sign-out; a lost session mid-flow (nothing recorded, resumes after sign-in); a stale or hostile `?n=`; malformed API input from the page's own session.
- **Every page-level test also fails on any console error or uncaught script error.** That caught the real defect in section 5 (Q3).

## 5. Bugs found and fixed in this pass

| ID  | Severity           | Bug                                                                                                                                                                                                | Fix                                                                                                                               |
| --- | ------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| Q1  | Low (test quality) | `test/policy/policy.test.ts`: the reason-code coverage check relied on earlier tests having filled a set, so it failed when tests ran in another order. A passing run proved less than it seemed.  | Now a file-level `afterAll`. Mutation check: an uncovered reason code still fails it.                                             |
| Q2  | Low (test quality) | `test/persistence/seed-and-cli.test.ts`: the CLI tests shared one database file and only passed in file order (failed under shuffle seeds 202 and 303).                                            | Each test gets its own directory.                                                                                                 |
| Q3  | Low (UX, ops)      | Every anonymous page load asked `/api/journey`, got a 401, and logged an error in the browser console (and the server answered a pointless 401).                                                   | The progress bar first asks `/api/operator/session` (always 200); only a signed-in operator asks for the journey.                 |
| Q4  | Low                | Every page request also made a request for `/favicon.ico` that answered 404 (a console error).                                                                                                     | Added `src/app/icon.svg`.                                                                                                         |
| Q5  | Low (flaky test)   | `test/security/dos-and-secrets.test.ts` (webhook flood, 400 deliveries) hit Vitest's 5 s default timeout once in 12 plain runs when the machine was busy: a false failure, not a security failure. | 200 deliveries (the cap is 120 a minute) and a 30 s timeout. Afterwards 10 further plain runs and 8 shuffled runs were all green. |

The first draft of the new tests also had four wrong premises of mine (for example, that a PayPal outage before a capture creates an unknown attempt: it does not, because the safety read fails first and nothing is written). Each was checked against the code and the test corrected; none of them was a product bug, and no assertion about money, authorization or state was loosened to make a test pass.

Test infrastructure added: the fake PayPal switches above; `@playwright/test` and `@vitest/coverage-v8` as development dependencies (no browser download, Apache-2.0 and MIT); `npm run e2e`, `e2e:run` and `test:coverage`.

## 6. Remaining bugs and limits

Severity is for the application as a public sandbox demo.

| ID  | Severity                    | Finding                                                                                                                                                                                                                                                                                                                                                                                             | Workaround / note                                                                                                                                                                               |
| --- | --------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| R1  | **Medium** (demo usability) | The seeded demo mandate has a 150.00 total budget and each agreement counts against it. The mock agents' offer is 60.00, so **the third run of the main flow on the same database is refused with `OVER_TOTAL_BUDGET`**. A public demo with several visitors will look broken after two. The policy is behaving correctly; the demo data is too small. Found because the e2e database exhausted it. | Approve a larger mandate on `/mandate`, or restart (the free plan resets the data). Not changed: the seed is shared with tests and the Arena fixture. A decision for you: a larger demo budget. |
| R2  | Low                         | `DatabaseSync` is synchronous, so while another writer holds the SQLite lock a request blocks the whole Node process for up to the 5 s busy timeout (measured: the capture waited at least 4 s). Safe (no PayPal call, state unchanged), but every other request stalls meanwhile. Only an outside tool (a `sqlite3` shell, a backup) can hold the lock in the intended single-instance setup.      | Do not open the database with other tools while the app is serving.                                                                                                                             |
| R3  | Low                         | Sessions are signed tokens with no server-side revocation; the passcode is shared; no Content-Security-Policy; the login throttle is global. Unchanged from [SECURITY_REVIEW.md](SECURITY_REVIEW.md).                                                                                                                                                                                               | See that document.                                                                                                                                                                              |
| R4  | Low                         | 10 moderate advisories remain in development tooling (ESLint's dependency tree). Production dependencies: 0.                                                                                                                                                                                                                                                                                        | Re-audit before any release.                                                                                                                                                                    |
| R5  | Info                        | In the in-app browser pane, a dynamic page sometimes shows a duplicate hidden copy of its content for a few seconds while it streams. Not reproducible in Edge after load (one `main`, one `#main`, one `h1` on all six pages).                                                                                                                                                                     | Observed once; not investigated further.                                                                                                                                                        |
| R6  | Info                        | The mock agents record one offer and no counter-offer in the demo, so "observe the agent negotiation" shows little.                                                                                                                                                                                                                                                                                 | Limitation of the deterministic mocks.                                                                                                                                                          |

## 7. Skipped tests and external dependencies

**Skipped tests: none.** Vitest reports 0 skipped and `grep` finds no `skip`, `todo`, `skipIf` or `xit` in `test/` or `src/`; Playwright reports 0 skipped.

**Not run, and why:**

- **The real PayPal sandbox.** No credentials. `npm run paypal:smoke` prints "SKIPPED ... PayPal sandbox connectivity NOT VERIFIED". Every payment, authorization, capture, void and webhook-verification result comes from the fake PayPal, built from PayPal's documentation. The real service's error shapes, retry semantics and signature-verification contract are **unverified**. The browser cannot exercise payment either, because the client talks only to the one sandbox host.
- **A real AI provider.** No key. `npm run agents:smoke` prints "SKIPPED ... live provider integration NOT VERIFIED". The provider path is tested against a scripted HTTP stub only, so how a real model reacts to adversarial text is untested.
- **A deployed instance.** Nothing was deployed (see [DEPLOYMENT.md](DEPLOYMENT.md)). The "deployed smoke test" was `npm run verify:deployment` against a local `npm run start:demo` (30 of 30 passed; the server log held no error or warning lines and 0 occurrences of the passcode). Render's proxy, TLS and cold starts were not exercised.
- **Browsers other than Edge** (Chrome, Firefox, Safari), and real touch devices. The phone project is Edge with a phone viewport.
- **Automated accessibility scanning** (no axe); only the manual and scripted checks in [UI_DESIGN.md](UI_DESIGN.md) and the keyboard and overflow tests above. No screen reader.
- **Load and soak tests; two-process races.** The design is one process; concurrency is tested as interleaved requests in one process plus a second connection holding the write lock.
- **`npm run adversarial:catalog`** (it rewrites the catalog snapshot; not needed for a check).
- **Mutation testing beyond the nine lines above, and property-based testing beyond what already exists.**

**External dependencies used by this pass:** the npm registry (installing the two dev dependencies); the system's Microsoft Edge; the local file system and OS temp directory. No other network service was contacted.

## 8. Reproduce

```bash
npm ci                         # or: npm install
npm run typecheck && npm run lint && npm run format:check
npx vitest run                 # add --sequence.shuffle --sequence.seed=<n> to vary the order
npm run adversarial
BENCH_OUT=./tmp-bench npm run benchmark   # compare resultsHash with benchmark-results/benchmark.json
npm run e2e                    # needs Microsoft Edge installed; uses port 3140
npm run test:coverage
```
