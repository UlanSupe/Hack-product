# Security review

Date: 2026-11-05. Scope: the complete PactPay Arena flow as it exists in this repository: operator console, negotiation, mandate, policy engine, PayPal Orders flow (create, authorize, capture, void, reconcile), webhook endpoint, audit chain, Arena (unsafe baseline vs protected buyer), Cockpit, dependencies and configuration.

**Read this first.** This is a review by the engineer who wrote most of the code, helped by tests the same engineer wrote. It found and fixed real problems, which shows the method works; it does not show that no problems remain. **Passing tests do not make this application secure.** Tests prove that the specific cases they encode behave as specified. They do not cover cases nobody thought of, deployment mistakes, the real PayPal service, or an attacker with a different model of the system than the author's. No independent reviewer, penetration tester or real-PayPal-sandbox run was involved. Treat the result as "the properties below hold in the cases examined", nothing stronger.

## 1. Method

1. **Trace.** Every route under `src/app/api` was read, from the request to the point where it reaches the database or PayPal. Agent output (negotiation, proposals) was traced the same way to every place it can influence a payment. The payment core (`src/application/payments.ts`: `finalize`, `reconcileOrder`, `confirmReturn`), the operator session and guard, the PayPal adapter and webhook verifier, the policy engine and its rules table, the SQLite transaction helper and the audit chain were read in full.
2. **Enumerate by machine, not by memory.** `test/security/route-sweep.test.ts` discovers every `route.ts` from the file system and fails if a route is not classified. It then sends each one anonymous requests, agent requests, requests without CSRF token or with a foreign origin, forged cookies, and hostile ids and bodies.
3. **Reproduce before fixing.** For each suspected weakness a failing test was written first (F1, F2 below), then the fix.
4. **Run it for real.** The production build (`next start`) was run against a throwaway database and probed with `curl` (section 5).
5. **Dependencies.** `npm audit`, then upgrades.

Not done: a review by a second person; fuzzing beyond the fixed hostile-input lists; load testing; any run against the real PayPal sandbox (no credentials exist here); any model-driven red team against a real LLM (agents in this repository are deterministic mocks and a never-run-live provider adapter).

## 2. Summary of findings

| ID  | Severity                | Finding                                                                                                                                                                                                                                                                                                                                                                                                 | Status                                                                    |
| --- | ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| D1  | **Critical** (advisory) | `next` 16.4.0 had published critical advisories (remote code execution / denial of service class) reported by `npm audit`                                                                                                                                                                                                                                                                               | **Fixed**: upgraded to 16.4.5                                             |
| D2  | **High** (advisory)     | `zod` 4.6.5 had a published high-severity advisory                                                                                                                                                                                                                                                                                                                                                      | **Fixed**: upgraded to 4.6.7                                              |
| F1  | **High**                | Request bodies were checked against a size limit only after being read whole: a chunked body with no `Content-Length` was buffered fully                                                                                                                                                                                                                                                                | **Fixed**, test-first (`readBoundedText`)                                 |
| F2  | **Medium**              | The unauthenticated webhook endpoint could be flooded to make the server call PayPal's verification service without limit                                                                                                                                                                                                                                                                               | **Fixed**, test-first (120 verifications per minute cap, then 429)        |
| L1  | Low                     | A malformed percent-encoded path (for example `/api/negotiations/%E0%A4%A`) returns a generic 500                                                                                                                                                                                                                                                                                                       | Open (no data exposed, no state change)                                   |
| L2  | Low                     | A `NOT_FOUND` response echoes the id the caller supplied (escaped JSON, operator routes only)                                                                                                                                                                                                                                                                                                           | Open                                                                      |
| L3  | Low                     | No Content-Security-Policy header                                                                                                                                                                                                                                                                                                                                                                       | Open                                                                      |
| L4  | Low                     | The image optimiser endpoint was reachable although the app serves no images                                                                                                                                                                                                                                                                                                                            | **Fixed**: `images: { unoptimized: true }` in `next.config.ts`            |
| L5  | Low                     | Login throttle is global (5 failures per minute for everyone), so anyone can lock the operator out for a minute at a time                                                                                                                                                                                                                                                                               | Open, a deliberate trade-off (no per-client identity is trustworthy here) |
| L6  | Low                     | `GET /api/health` reveals whether PayPal credentials and a webhook id are configured, and the mode, as booleans                                                                                                                                                                                                                                                                                         | Open                                                                      |
| I1  | Info                    | The session cookie was `SameSite=Strict`, which made the browser drop it on the top-level return from PayPal (found live on 2026-11-09: the buyer landed on a JSON 401). It is now `SameSite=Lax`; mutating routes are still protected by the CSRF token and the `Origin` check, and the return route only asks PayPal what happened. Without a session the return redirects to the console to sign in. | Fixed 2026-11-09                                                          |
| I2  | Info                    | Capture does not require a freshly re-approved mandate version (`freshMandate: false` for CAPTURE by design); other limits are re-checked                                                                                                                                                                                                                                                               | Documented policy decision (section 4.2)                                  |
| I3  | Info                    | `npm audit` still reports 10 moderate advisories, all in development tooling (ESLint's dependency tree); `npm audit --omit=dev` reports 0                                                                                                                                                                                                                                                               | Accepted                                                                  |

No finding was left open at Critical or High severity. That is a statement about what was found, not about what exists.

## 3. Findings in detail

### D1, D2: vulnerable dependencies (Critical, High): fixed

- **Evidence.** `npm audit` listed critical advisories against `next@16.4.0` and a high one against `zod@4.6.5`. Both libraries sit on the request path (routing, input validation).
- **Fix.** `next` to 16.4.5, `zod` to 4.6.7 (`package.json`, lockfile). The production build and the whole suite pass after the upgrade.
- **After.** `npm audit --omit=dev` reports `found 0 vulnerabilities`. `npm audit` reports 10 moderate advisories, all in the lint toolchain (for example `minimatch` through `eslint`); they are not shipped and not reachable from a request.
- **Not claimed.** An audit database only knows published advisories. Zero reported is not zero present.

### F1: unbounded request body read (High): fixed

- **Weakness.** `readJsonBody` and the webhook route compared the declared `Content-Length` to a limit and then read the whole body. A chunked upload omits the header, so an attacker (for the webhook, unauthenticated) could stream megabytes into memory before any limit applied.
- **Reproduction.** `test/security/dos-and-secrets.test.ts` streams 8 MiB with no `Content-Length` into the webhook route and into an operator route. Before the fix both read the whole stream; the tests failed.
- **Fix.** `readBoundedText` in `src/server/http.ts` rejects on the declared length, then reads the stream chunk by chunk and cancels it as soon as the running total passes the limit (16 KiB for operator JSON, 256 KiB for webhooks). `readJsonBody` and the webhook route both use it. The webhook route answers 413 `BODY_TOO_LARGE` and sends nothing to PayPal.
- **After.** The same tests pass and assert the stream was cut off within one chunk of the limit.

### F2: webhook endpoint as a verification-call amplifier (Medium): fixed

- **Weakness.** Each syntactically valid but unsigned delivery made the server call PayPal's signature-verification API (an authenticated, rate-limited, third-party call). The endpoint is public by design, so an attacker could burn PayPal API quota and delay genuine verifications.
- **Reproduction.** The test sends 400 unsigned deliveries and counts calls to the fake `verify-webhook-signature`; before the fix it was 400.
- **Fix.** `src/application/webhooks.ts` keeps a sliding one-minute window; above `VERIFICATIONS_PER_MINUTE = 120` it answers `429 RETRY RATE_LIMITED` without calling PayPal. PayPal retries on non-2xx, so a genuine delivery refused during a flood is redelivered later; nothing is lost, only delayed.
- **Limits.** The window is in process memory (resets on restart, not shared between instances). It protects the PayPal quota, not the server's CPU. A flooder can still crowd out genuine deliveries for as long as they flood, until PayPal's retries succeed. Real protection against a determined flood belongs at the network edge.

### Low and informational

- **L1.** Malformed percent-encoding in a dynamic path segment produces the framework's generic 500 page. Verified with the live server. No stack trace, path or data in the body. Not fixed because it needs a framework-level decision; the sweep test uses the route handlers directly and shows handlers themselves return handled statuses for hostile ids.
- **L2.** `NOT_FOUND` messages include the requested id. The response is JSON, the id is encoded by the serializer, and only signed-in operators reach it, so there is no reflected-content issue in the API. If a UI ever renders that message as HTML it would need escaping (the React UI does).
- **L3.** No CSP. React escapes by default and no raw-HTML sink was found (`grep dangerouslySetInnerHTML src` finds none), but a CSP would be defence in depth for the console that triggers captures.
- **L4.** Fixed, see table. Verified with the production build.
- **L5.** The throttle counts failures globally: five wrong passcodes in a minute lock out everyone, including the operator, for 60 seconds (`Retry-After: 60`). The alternative (per-IP) would trust a forwarded header the app cannot validate. Brute-force attempts are slowed to five per minute; see limitation 3 in section 6 for what the passcode choice means.
- **L6.** Booleans only, no values. Useful to an attacker as reconnaissance; useful to the operator to see why a payment is disabled.
- **I1.** Documented in `src/app/api/paypal/return/route.ts` and `docs/PAYPAL_INTEGRATION.md`; it is a usability quirk, not a bypass (the return route never trusts query parameters; it asks PayPal).
- **I2.** See section 4.2.

## 4. The ten properties, one by one

Each item says what was checked, the evidence, and what the check does **not** show.

### 4.1 Every capture path requires server-side authorization

- **Paths to capture.** `POST /api/negotiations/[id]/payment/capture` is the only caller of `capturePayment`. The webhook and the return page can only call `reconcileOrder` / `confirmReturn`, which **observe** PayPal (they read the order back and record what PayPal reports); they never issue a capture, authorization or void request. A CAPTURE.COMPLETED webhook for a capture the server did not request is recorded as a PayPal-side fact to reconcile, not as an authorization.
- **Controls on the capture route.** Operator session cookie (HMAC, expiry) → CSRF token → same-origin check → agents refused (`x-agent-id` / `authorization` header, even with a valid cookie) → body must be `{}` (nothing from the client is used) → `requireOperator(actor)` again inside the service → `finalize("CAPTURE")`: fresh PayPal read, `evaluatePolicy` (actors: operator only; requires recorded human approval where the mandate demands it; requires PayPal state observed as AUTHORIZED; honours the agreement) → write-ahead attempt row and compare-and-set state change inside one `BEGIN IMMEDIATE` transaction → PayPal call → re-read before believing the answer.
- **Evidence.** `test/security/route-sweep.test.ts` (all 30 route files, and every exported method, found from the file system: anonymous → 401; agent header or bearer with a valid cookie → 403; missing, wrong or cross-origin CSRF → 403; ten forged/expired/truncated/re-signed cookie variants → 401). `test/payments/capture-api.test.ts`, `capture-flow.test.ts`. Adversarial categories APPROVAL_BYPASS (11), INVALID_TRANSITION (9) in `npm run adversarial`.
- **Manual (live `next start`).** Capture with no cookie → 401; with cookie but no CSRF → 403; with cookie, CSRF and `x-agent-id` → 403; with a valid session and `{"amount":99999,"payee":"x"}` → 400 `NO_PARAMETERS_ALLOWED` (observed in the second run, section 5).
- **Does not show.** That the operator passcode is strong or kept private (section 6), or that the real PayPal API behaves as the fake does.

### 4.2 Mandate and agreement versions are checked

- **Mechanism.** Every transaction stores the mandate version and agreement version it started under; the audit events carry them. Changing price, payee, scope, category, currency, deliverables or deadline creates a new agreement version and retires the old agreement **and its approval**. `evaluatePolicy` receives the current versions and denies on mismatch (stale agreement, retired approval). The rules table (`src/domain/policy.ts`, `RULES`) states per step what is checked.
- **Evidence.** `test/negotiation/changes-after-approval.test.ts`, `test/flagship/capture-after-change.test.ts`, adversarial categories "Changed agreement after approval" and "Mandate tampering", `test/policy/*`.
- **Deliberate gap (I2).** For CAPTURE the table sets `freshMandate: false`: a hold that was authorized under mandate version N may be captured after the operator approved version N+1 (for example a lower limit). AUTHORIZE requires a fresh mandate. The reasoning is that capturing is the completion of an already approved, already held amount, and the amount, currency and payee are re-checked against the agreement at capture time. If your risk appetite says a tightened mandate must also block pending captures, change that one flag and add a test. This is a policy choice, documented, not an oversight; it is also the single most likely thing a reviewer would argue about.
- **Time-of-check vs time-of-use.** Policy is evaluated at decision time inside the same database transaction that records the attempt, and PayPal is then called. A change made by another operator action in the few milliseconds between that transaction and the PayPal response is not re-checked before PayPal acts. With one operator, one process and `BEGIN IMMEDIATE` serialisation the window is small but exists.

### 4.3 Price, currency and payee cannot be substituted by client input

- **Mechanism.** Payment routes take no client data: the body must be `{}` (`paymentRoute`). The order's amount, currency and payee are built on the server from the stored agreement (integer minor units, never floats). On every capture/void/reconcile the server reads the PayPal order and compares amount, currency and payee (merchant id) with its own record; any difference is an **anomaly** that blocks the step and sets NEEDS_RECONCILIATION instead of acting. A webhook's own claims about amounts are never read (only the verified event id and type trigger a read of PayPal).
- **Evidence.** `test/security/route-sweep.test.ts` (hostile bodies, including `{amountMinor, currency, payee, total: -1}`, on every operator route: handled statuses only); `test/payments/observation.test.ts`; `test/flagship/browser-manipulation.test.ts` (an operator's browser edits the amount/payee/currency; the server ignores them); adversarial categories Budget escalation, Currency substitution, Payee substitution (all expected results met).
- **Does not show.** Anything about PayPal-side substitution beyond what the fake can simulate (a tampered order in PayPal's response is simulated, not real).

### 4.4 Duplicate and concurrent requests cannot create duplicate captures

- **Mechanism, three layers.** (1) State machine: CAS state transition inside `BEGIN IMMEDIATE`, so of N concurrent requests exactly one moves AUTHORIZED→CAPTURING; the others see the new state and are refused or return the existing attempt. (2) Write-ahead attempt row with a unique constraint; the PayPal request carries a stable `PayPal-Request-Id` derived from the attempt, so even a crash-and-retry reuses the same id and PayPal deduplicates. (3) After any ambiguous outcome the server **reads PayPal before sending anything again**.
- **Evidence.** `test/payments/capture-flow.test.ts` "duplicate submissions and concurrent requests" (six parallel captures and voids; capture racing void), `payment-flow.test.ts` "repeated and concurrent requests", adversarial categories DUPLICATE_REQUEST (8) and REPLAY (6), webhook concurrency test (section 4.7).
- **Does not show.** Safety across multiple server processes or hosts: protection comes from SQLite's single-writer locking and the stable request id, not from a distributed lock. The in-process pieces (login throttle, verification cap, any cache) are per process. The design assumes **one instance**.

### 4.5 Payment timeouts are reconciled safely

- **Mechanism.** A timeout or unknown failure never means "not captured" and never triggers a blind retry. The attempt is marked unknown, the transaction moves to NEEDS_RECONCILIATION, and a later reconcile (operator "refresh", the return page, or a verified webhook) reads PayPal first: if PayPal says captured, the local state follows and nothing is sent again; if PayPal shows no capture, the transaction returns to the usable state only after a quiet period, and a **new** attempt then captures once. A pending, failed or unknown payment is never shown as confirmed (the UI and Cockpit state names say so).
- **Evidence.** `test/payments/capture-flow.test.ts` "timeouts and ambiguous outcomes: reconcile before anything is repeated" (timeout that never reached PayPal; timeout after PayPal captured; unknown failure; repeat of each), `test/payments/webhook-flow.test.ts` (lost-response capture and authorization settled by webhook).
- **Does not show.** The real PayPal's behaviour for a request that times out and is retried with the same `PayPal-Request-Id`. The documented behaviour is relied on; it has not been observed.

### 4.6 Webhooks are verified (and rejected otherwise)

- **Mechanism.** The raw body, byte for byte, with PayPal's transmission headers and **our configured webhook id** (never one from the message) is sent to PayPal's `verify-webhook-signature`. Only `SUCCESS` passes. Not configured → 503; invalid → 401 and no state change; verifier unreachable → 503 retry (never a pass, never stored); malformed → rejected before any network call. A forged delivery cannot "squat" an event id and block the genuine one (the id is claimed only after verification). A verified event is a **trigger**: state follows what PayPal's own order read shows, so even a validly signed event cannot invent an amount or a state.
- **Evidence.** `test/payments/webhook-flow.test.ts`, `webhook-api.test.ts`, `webhook-verifier.test.ts`; adversarial category WEBHOOK_FORGERY (12); F1/F2 tests.
- **Does not show.** That PayPal's verification API accepts our exact call shape. It is implemented from the documentation and tested against a fake; no real sandbox delivery has ever been received.

### 4.7 Webhooks are idempotent

- **Mechanism.** The first verified delivery of an event id claims it (PROCESSING → PROCESSED / IGNORED / FAILED) in the database; a repeat is a no-op that only counts the delivery. Concurrent copies are serialised by the claim: one processes, the others are told to retry and later see a duplicate. An IGNORED event is final. A rejection flood writes a bounded number of audit events.
- **Evidence.** `test/payments/webhook-flow.test.ts` "duplicates" (same event again; ignored event again; copies arriving at the same time) and the bounded-audit test.

### 4.8 Audit-chain tampering is detectable

- **Mechanism.** Hash version 2 covers every field of an event (including provenance, actor, transaction id, mandate and agreement versions) over a canonical serialization; each event includes the previous hash. `npm run db:status` and the Cockpit verify the whole chain and name the first invalid event. Legacy v1 events verify under their original form; a v1 event cannot be added after the migration; downgrading an event to v1 does not hide its extra fields.
- **Evidence.** `test/persistence/audit-chain.test.ts`: edits to each column, re-hashing one event, deletion at the start/middle, reordering, moved events, wrong previous hashes, fabricated rows that satisfy database linkage but fail verification, and an independent SHA-256 implementation of the documented form that agrees.
- **What it does not do.**
  - It is **detective, not preventive**: someone with write access to the database file can still edit it; the chain only makes that visible.
  - Without an anchor, removal of the **newest** events cannot be seen by the chain itself (the test says so); an anchor taken earlier makes truncation visible. No anchor is shipped or scheduled by default.
  - Someone who can rewrite **the entire chain** consistently passes. It is not a signature and has no external timestamp.
  - A locally generated hash is not proof that an observed PayPal fact is authentic (provenance labels OBSERVED_EXTERNAL events as read from PayPal, which is what we saw, not a PayPal signature).

### 4.9 The unsafe baseline cannot access unrestricted payment execution

- **Mechanism.** The baseline executes only against `SimulatedLedger` (in memory). The experiment's modules are forbidden by lint and by test from importing the PayPal adapter, the database adapter or any payment service. The database refuses an `UNSAFE_BASELINE` attack run that is not marked SIMULATED or that references a transaction (migration 0004). Receipts are labelled simulated and never look like PayPal ids. The run ignores PayPal credentials even when set, and makes no network call.
- **Evidence.** `test/arena/isolation.test.ts` (import scan; no network; receipts; ledger refuses non-positive or unsafe integers; database constraint), `test/boundaries.test.ts` and ESLint `no-restricted-imports`; the route sweep confirms `arena/*` and `flagship` routes are the public simulated ones and the sweep checks they leak no database row or secret.
- **Does not show.** That a future code change cannot add such an import. The lint rule and test would catch the obvious cases, not every indirect route.

### 4.10 Errors and logs do not reveal secrets

- **Mechanism.** Secrets are read from the environment on the server only and are never put in a response. Errors reach the client as typed `{code, message}` with generic text; the PayPal adapter does not echo its upstream error body; no `console.*` call logs a token, header or credential.
- **Evidence.** `test/security/dos-and-secrets.test.ts` runs a full flow (create, authorize, capture against a failing PayPal) with distinctive client-secret, access-token, passcode and CSRF values, captures every response body and header, every `console.*` call and every row of the event tables, and asserts none of those values (and no `Basic …` / `Bearer …` strings) appears. `test/repo-hygiene.test.ts` checks that env files are git-ignored and `.env.example` holds only placeholders (it does not scan source for secrets; no such scan exists). The route sweep asserts no response contains stack-trace or SQL error text. Manual: `curl` against the live server showed no secret in headers or bodies; `.env.example` holds placeholders only; no `.env.local` exists in the tree.
- **Does not show.** Absence of a leak in paths nobody exercised, in the framework's own logs (a production deployment should check its platform logs), or in third-party error pages.

### 4.11 No critical route bypasses the policy engine

- **Mechanism.** Every state-changing payment step goes through `finalize` or its authorize/create equivalents, each calling `evaluatePolicy` with the step's rules before the PayPal request is composed. The only routes that can spend (create order, authorize, capture) are operator routes; void and refresh cannot increase spending. No route accepts a client-supplied amount, payee, currency, state or "skip policy" flag. Agent output (proposals, counters) can only become an agreement through the policy engine, and cannot approve a mandate.
- **Evidence.** The route sweep (inventory is derived from the file system, so a new route must be classified), `test/policy/bypass.test.ts`, `test/policy/purity.test.ts`, `test/payments/boundaries.test.ts`, the 124 adversarial scenarios and the benchmark. Public routes are exactly: simulated Arena runs, the flagship simulation, health, the Cockpit's public (benchmark) part, the operator session endpoints and the webhook, each justified in the sweep's `PUBLIC` table.
- **Manual note.** `/api/cockpit` returns 200 even with an agent header because it is a deliberately public, read-only partial route: benchmark rows are public, database rows are locked behind the operator session. This is by design and tested.

## 5. Manual adversarial checklist (production build, curl)

Setup: `next start` on the production build, a throwaway database created with the repository's own migrate script, operator passcode and base URL passed as process environment variables (no `.env` file written). Two runs: the first (port 3125) covered items 1 to 14; a second run on the final build (port 3126, after the fixes) re-checked the items marked **re-run** and added items 15 to 17. Servers were stopped and temporary files deleted afterwards. Results as observed:

| #   | Probe                                                                   | Result                                                                                                              |
| --- | ----------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| 1   | `GET /api/health`                                                       | 200, booleans only                                                                                                  |
| 2   | Protected route with no cookie                                          | 401                                                                                                                 |
| 3   | Login with wrong passcode                                               | 401 `Incorrect passcode.` (no hint which part)                                                                      |
| 4   | Five wrong logins, then more (**re-run**)                               | 401 ×5, then 429 with `Retry-After: 60`; the **right** passcode is refused too while locked                         |
| 5   | Valid session, state-changing call without CSRF header                  | 403                                                                                                                 |
| 6   | Valid session + CSRF, `Origin: https://evil.example`                    | 403                                                                                                                 |
| 7   | Valid session + CSRF, `x-agent-id` header                               | 403                                                                                                                 |
| 8   | Valid session + CSRF, `Authorization: Bearer x`                         | 403                                                                                                                 |
| 9   | Capture with body `{"amount":99999,"payee":"x"}` (**re-run**)           | 400 `NO_PARAMETERS_ALLOWED`, nothing sent                                                                           |
| 10  | 1 MiB chunked body to an operator route (**re-run**)                    | signed in: 413 `BODY_TOO_LARGE`; not signed in: 401 (the session check comes first)                                 |
| 11  | 1 MiB chunked body to `/api/webhooks/paypal` (**re-run**)               | 413 `BODY_TOO_LARGE`                                                                                                |
| 12  | Small unsigned webhook delivery, webhook id not configured (**re-run**) | 503 `WEBHOOK_NOT_CONFIGURED`, nothing stored                                                                        |
| 13  | Hostile ids (`' OR 1=1`, `../../etc/passwd`, 500-char, NUL)             | handled JSON statuses without SQL or path text; this one is covered by the automated sweep, not re-probed with curl |
| 14  | Malformed percent-encoded path (**re-run**)                             | 500 (finding L1)                                                                                                    |
| 15  | `/_next/image?url=...` after the L4 fix (**re-run**)                    | 404                                                                                                                 |
| 16  | Logout (`DELETE`), then reuse the old cookie (**re-run**)               | **still authenticated**: logout clears the browser's cookie only (limitation 4)                                     |
| 17  | Response headers (**re-run**)                                           | no `X-Powered-By`; `X-Content-Type-Options: nosniff`; cookie `HttpOnly; SameSite=Lax`, no `Secure` on http          |

These are observations of single runs on one machine. Items 5 to 8 and 13 were not repeated in the second run; the automated route sweep covers 5 to 8 and 13 on every route.

## 6. Remaining limitations (honest list)

1. **Never run against real PayPal.** Every payment, webhook and verification result comes from `test/payments/fake-paypal.ts` / `http-paypal.ts`. Field names, error shapes, retry semantics, `PayPal-Request-Id` behaviour, webhook signature verification and the sandbox's own rules may differ. `docs/PAYPAL_INTEGRATION.md` lists what was and was not verified. A first sandbox run is likely to find integration bugs.
2. **Simulated agents.** The negotiation agents are deterministic mocks; the real-model adapter has only run against mocked HTTP. Prompt-injection resilience of a real model is **not** established; the design assumption is that the model is untrusted and the policy engine is the control, which is what the tests check. The benchmark says so itself and does not treat repeated copies as independent evidence.
3. **Demo-grade operator authentication.** One shared passcode, a stateless HMAC session whose key is derived from that passcode, no accounts, no MFA, no per-user audit identity.
   - A **weak passcode** can be brute-forced offline if a cookie is captured (the key derives from the passcode); the environment schema requires at least 16 characters but cannot judge entropy. Use a long random value. Rotating the passcode invalidates all sessions (a feature) and is the only revocation.
   - Online guessing is slowed by the global throttle (L5).
4. **No server-side session revocation.** Logout clears the cookie in the browser; a stolen token works until its expiry. Short lifetime is the mitigation.
5. **Single instance assumed.** Concurrency protection relies on SQLite locking in one process on one disk. The login throttle and webhook verification cap are process memory. Do not run multiple instances behind a load balancer on this design.
6. **Policy is checked at decision time, not at send time** (section 4.2). The window is small; it is not zero.
7. **Capture ignores a newer mandate version** by design (I2).
8. **Audit chain is tamper-evident, not tamper-proof**, and truncation of the newest events is invisible without an externally stored anchor (section 4.8).
9. **No CSP, no rate limiting beyond the two throttles, no WAF, no TLS termination** in the application. Deployment must provide HTTPS (the cookie is `Secure` only when the base URL is https), edge rate limits and platform log hygiene.
10. **Secrets handling is only as good as the host.** Nothing prevents an operator putting a live key into `.env.local`; the code and documents assume sandbox credentials. A real-money deployment is out of scope and untested.
11. **Dependencies.** 10 moderate advisories remain in development tooling. Production dependencies report 0 known issues today; that will change as advisories are published, so audit again before any release.
12. **Payouts** are simulated; no seller is ever paid. A hold is not escrow. Nothing here promises refunds.
13. **Review independence.** See the opening paragraph.

## 7. Tests added or changed in this review

| File                                    | What it adds                                                                                                                                                                                                    |
| --------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `test/security/route-sweep.test.ts`     | 9 tests: route inventory from the file system; anonymous → 401; public routes leak nothing; agents → 403; CSRF and origin on every state-changing route; forged cookies; login throttle; hostile ids and bodies |
| `test/security/dos-and-secrets.test.ts` | 6 tests: streamed bodies bounded (webhook and operator), declared-oversize refusal, verification cap and ordinary traffic unaffected, secrets absent from responses, logs and tables                            |

Source changes: `src/server/http.ts` (`readBoundedText`), `src/app/api/webhooks/paypal/route.ts`, `src/application/webhooks.ts` (verification cap, new `429` response), `next.config.ts` (image optimiser off), `package.json` / lockfile (`next` 16.4.5, `zod` 4.6.7).

## 8. How to repeat this

```bash
npm run typecheck
npm run lint
npm run format:check
npx vitest run                  # whole suite
npx vitest run test/security    # this review's tests only
npm run adversarial             # 124 scenarios, fake PayPal only
npm run build
npm audit --omit=dev            # production dependencies
npm audit                       # everything
```

Results of the last full run (2026-11-05): typecheck clean; ESLint clean; Prettier clean; `vitest run` 87 files, 3188 tests passed; `npm run adversarial` 124 of 124 scenarios behaved as specified (2 documented known limits); production build succeeded; `npm audit --omit=dev` 0 vulnerabilities, `npm audit` 10 moderate (development tooling). These numbers describe that run only.

## 9. Changes after this review

The user-journey integration (see [USER_JOURNEY.md](USER_JOURNEY.md)) added one server route, `GET /api/journey`, after the review above was written. It is operator-only and read-only (same guard as the other reads of the operator's records: anonymous 401, agents 403), takes one optional id that is validated against `^[A-Za-z0-9_-]{1,64}$` and then looked up like any other id, and calls PayPal never. The route sweep in `test/security/route-sweep.test.ts` discovers it from the file system and enforces the anonymous and agent rules; `test/journey/flows.test.ts` adds hostile-id cases. The PayPal return route now also puts the negotiation id, taken from the server's own record of the order, into its redirect. **The security review itself was not repeated for these changes**; no existing security logic was modified.

## 10. Changes for deployment

The deployment preparation (see [DEPLOYMENT.md](DEPLOYMENT.md)) changed server code after this review: the state-changing same-origin check also accepts the configured public origin (`APP_BASE_URL`); the PayPal return redirect is built from `APP_BASE_URL`; the health route returns 503 when the service cannot serve; a global cap (240 a minute) protects the public replay and Cockpit; demo-mode response headers (HSTS, noindex) and startup validation were added. Each has tests (`test/deploy`). This review was **not repeated** for these changes, and nothing here has run on a public host.
