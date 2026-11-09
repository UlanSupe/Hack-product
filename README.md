# PactPay Arena

> **Agents negotiate. Code enforces. PayPal settles.**

PactPay Arena is a hackathon project that shows, side by side, the difference between an AI shopping agent that can be talked into overspending and the same agent operating behind a deterministic, server-side policy layer, with payments settled through the **PayPal Sandbox**.

It is a demonstration and a test bed, not a payment product. Everything runs on synthetic data, PayPal is **sandbox-only** (the app refuses to start against anything else), and the unsafe baseline only ever touches a simulated ledger.

## Status at a glance (read this first)

| Area                                                                                    | Status                                                                                                                                                                                                                                                                                                                                                                                                       |
| --------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Policy engine, mandate, negotiation, audit chain, Arena, Cockpit, benchmark             | Built and tested (see [Testing](#testing)).                                                                                                                                                                                                                                                                                                                                                                  |
| PayPal Orders flow: create, authorize, capture, void, verified webhooks, reconciliation | Built, tested against test doubles, and **run end to end against the real PayPal Sandbox on 2026-11-08** (order, buyer approval, hold, capture, a separate hold-and-void, and webhooks; two defects found and fixed). Webhook delivery needs a public HTTPS address, so it is **not** running in the shipped setup: [docs/PAYPAL_INTEGRATION.md §17](docs/PAYPAL_INTEGRATION.md).                            |
| Real AI model provider (Groq or Anthropic)                                              | Groq (`openai/gpt-oss-120b`) **called live on 2026-11-08**: `npm run agents:smoke` passed and the app's "Run with the AI model" recorded an offer. The Anthropic provider is tested against mocked HTTP only. The default is deterministic mock agents that need no key.                                                                                                                                     |
| Hosted demo (Render Blueprint)                                                          | **Deployed:** https://pactpay-arena.onrender.com (free plan: sleeps when idle, first load can take about a minute; data resets on restart). Health, Start, Flagship, Arena, Cockpit and Live model pages were checked on 2026-11-09; one PayPal Sandbox payment (order, approval, hold, capture) was run on this host and confirmed at PayPal on 2026-11-09, with the three webhook events issued by PayPal. |
| Real payouts to sellers, refunds, escrow                                                | **Not implemented, and not claimed.** A PayPal authorization hold is not escrow.                                                                                                                                                                                                                                                                                                                             |
| Security                                                                                | Reviewed by the code's own author ([docs/SECURITY_REVIEW.md](docs/SECURITY_REVIEW.md)). Passing tests are evidence, not proof.                                                                                                                                                                                                                                                                               |

Details and evidence for every row: [docs/RELEASE_CANDIDATE.md](docs/RELEASE_CANDIDATE.md) (the release-candidate review: exact tested version, commands, outcomes, limitations, exclusions), [docs/QA_REPORT.md](docs/QA_REPORT.md), [docs/PAYPAL_INTEGRATION.md](docs/PAYPAL_INTEGRATION.md) §15–17, [docs/END_TO_END_TEST.md](docs/END_TO_END_TEST.md).

## The problem

AI agents are starting to spend money on our behalf. A language model reads text written by the other side of the deal, and that text can contain pressure, false authority ("the manager already raised your limit"), a revised price, or a different payee. If the model is the thing that decides whether to pay, then whoever writes the best message controls the wallet. A prompt that says "never exceed the budget" is a request, not a control.

## What it demonstrates

Two buyers receive the _same_ scenario, budget, offers and attack:

|                       | Unsafe baseline (labelled, intentionally vulnerable)                | Protected buyer                                                                                                   |
| --------------------- | ------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| Who decides to pay    | The (simulated) model                                               | The model only **proposes**; an independent policy engine decides                                                 |
| What it can spend     | Whatever the model says, on an in-memory simulated ledger           | Only what the human-approved, versioned **mandate** allows, recomputed from the server's own records              |
| After a hostile offer | Overspends, pays a substituted payee, trusts the seller's own total | Refused with a stable reason code (`OVER_PER_TX_CAP`, `PAYEE_NOT_ALLOWED`, ...) and a `POLICY_DENIED` audit event |

The protected side then carries a real transaction through PayPal Sandbox states (create order, buyer approval, authorize, capture or void), where every step re-reads PayPal and re-checks policy before it is believed, and every decision is written to a hash-chained audit trail.

## What is in the app

| Page            | What it is                                                                                                                                                 | Needs               |
| --------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------- |
| `/`             | The 9-step user journey, from a task to a verified payment and an attack replay. Progress is derived from stored state.                                    | nothing             |
| `/arena`        | Split-screen A/B experiment over the scenarios, unsafe baseline vs protected buyer. Replays exactly. Simulated money only.                                 | nothing             |
| `/flagship`     | The headline attack: a valid $24.00 offer is revised to $36.00 under pressure. The baseline pays; the real policy engine refuses.                          | nothing             |
| `/cockpit`      | AG Grid (Community) data grid over transactions, refused offers, attack runs and stored benchmark results, with an analytics view that shows denominators. | a database          |
| `/mandate`      | Operator console: set budget, per-transaction cap, categories, approval threshold. Approving creates an immutable new version.                             | `OPERATOR_PASSCODE` |
| `/negotiations` | Operator console: state a request, collect seller offers, counter, accept, then run the payment steps.                                                     | `OPERATOR_PASSCODE` |

## Quick start

**Requirements:** Node.js **>= 22.18** (the project is tested on 24.18; `.nvmrc` pins 24) and npm. The code uses Node's built-in `node:sqlite` and native TypeScript execution for `scripts/`, so there is no native build step and no database server to install.

```bash
git clone <this repository> pactpay-arena
cd pactpay-arena
npm ci
npm run dev
```

Open <http://localhost:3000>. No `.env` file is needed to browse `/`, `/arena` and `/flagship`.

### The operator path (mandate, negotiation, agreement; no PayPal needed)

```bash
cp .env.example .env.local        # Windows cmd: copy .env.example .env.local
# edit .env.local: set OPERATOR_PASSCODE to at least 16 random characters, e.g.
node -e "console.log(require('crypto').randomBytes(24).toString('base64url'))"
npm run db:migrate && npm run db:seed
npm run dev
```

1. Open `/mandate`, sign in with the passcode, and review the seeded demo mandate `M1` ($100.00 per transaction, $150.00 total, approval above $90.00, category COMPUTE, one allowed seller).
2. Open `/negotiations`, submit a request, press **Run the demo agents** (deterministic mock agents, no network), and accept an offer. The policy engine's decision and reason codes are shown in plain language.
3. The payment panel states that PayPal is not configured and stops there. Nothing is simulated in place of a payment.

### The payment path (PayPal Sandbox)

See [PayPal Sandbox configuration](#paypal-sandbox-configuration). It needs your own sandbox credentials; none are included or required to evaluate the rest.

## Environment variables

`.env.example` lists every variable with a placeholder only. Real values go in `.env.local`, which is git-ignored. A value beginning with `replace-with-` counts as **unset**, never as a credential. The app reads the environment in exactly one server-only module (`src/server/env.ts`) and validates it with Zod; nothing is exposed to the browser and the parser rejects any `NEXT_PUBLIC_` secret.

| Variable                                                                                        | Needed for                     | Notes                                                                                       |
| ----------------------------------------------------------------------------------------------- | ------------------------------ | ------------------------------------------------------------------------------------------- |
| `OPERATOR_PASSCODE`                                                                             | `/mandate`, `/negotiations`    | 16+ characters. Demo-grade single-operator auth.                                            |
| `DATABASE_PATH`                                                                                 | everything stored              | Default `./data/pactpay.db` (git-ignored).                                                  |
| `APP_BASE_URL`                                                                                  | PayPal return URL, hosted demo | Default `http://localhost:3000`. Must be public HTTPS for a real PayPal round trip.         |
| `PAYPAL_CLIENT_ID`, `PAYPAL_CLIENT_SECRET`                                                      | PayPal calls                   | Sandbox REST app. Set both or neither.                                                      |
| `PAYPAL_MERCHANT_ID`                                                                            | authorizing a payment          | Sandbox business account id. Without it the payee cannot be verified and authorize refuses. |
| `PAYPAL_WEBHOOK_ID`                                                                             | webhook endpoint               | Without it `/api/webhooks/paypal` answers 503 and trusts nothing.                           |
| `PAYPAL_ENV`, `PAYPAL_API_BASE`                                                                 | (fixed)                        | Only `sandbox` and the sandbox host are accepted.                                           |
| `AGENT_MODE`, `AGENT_PROVIDER`, `AGENT_MODEL`, `GROQ_API_KEY` or `ANTHROPIC_API_KEY`, `AGENT_*` | real model (optional)          | Default `scripted` (no key, no network).                                                    |
| `DEPLOY_MODE`                                                                                   | hosted demo                    | `local` (default) or `demo`; see [Deployment](#deployment).                                 |

## Commands

| Command                                            | What it does                                                                                                                                                                 |
| -------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `npm run dev`                                      | Development server on port 3000                                                                                                                                              |
| `npm run build` / `npm start`                      | Production build / serve it                                                                                                                                                  |
| `npm run typecheck`                                | `tsc --noEmit` (strict, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`)                                                                                            |
| `npm run lint`                                     | ESLint, including the architecture layer-boundary rules                                                                                                                      |
| `npm run format` / `npm run format:check`          | Prettier                                                                                                                                                                     |
| `npm test`                                         | Vitest: unit, integration, security and failure-injection tests                                                                                                              |
| `npm run test:coverage`                            | Same, with V8 coverage of `src/` (excluding `src/app`)                                                                                                                       |
| `npm run adversarial`                              | 124 deterministic attack scenarios against the real services (fake PayPal), pass/fail per category                                                                           |
| `npm run benchmark`                                | Seeded benchmark: unsafe baseline vs protected; writes `benchmark-results/` (git-ignored)                                                                                    |
| `npm run e2e`                                      | Build, then Playwright browser tests (see the note below)                                                                                                                    |
| `npm run check`                                    | typecheck, lint, format check, tests and build, in CI order                                                                                                                  |
| `npm run db:migrate` / `db:seed` / `db:status`     | Create or upgrade the SQLite file; add synthetic data; list migrations and verify the audit chain                                                                            |
| `npm run db:reset -- --yes`                        | Delete the database file (development only; refuses paths outside the project)                                                                                               |
| `npm run paypal:smoke [-- --create-order]`         | One controlled sandbox connectivity check. Prints `SKIPPED` without credentials.                                                                                             |
| `npm run agents:smoke`                             | One controlled real-model call. Prints `SKIPPED` without a key.                                                                                                              |
| `npm run agents:attack`                            | Live: a real model as the buyer against the ten hostile-seller scripts (`--trials N`); writes `docs/live-model-attack.json`. Needs the provider key; not part of `npm test`. |
| `npm run start:demo` / `npm run verify:deployment` | Hosted-demo start script (validates, migrates, seeds, serves) and its black-box smoke checks                                                                                 |

**Playwright note.** The browser tests use the **Microsoft Edge** that is already installed on the machine (`channel: "msedge"` in `playwright.config.ts`), so no browser is downloaded. If you do not have Edge, change the channel to `chromium` and run `npx playwright install chromium`. The Cockpit analytics test needs the generated benchmark results; the test server runs `npm run benchmark` itself once if `benchmark-results/benchmark.json` is missing.

## Architecture

```
 seller text, offers ─►  buyer agent (mock or LLM) ─► structured proposal ─► Zod validation
        (hostile)            (untrusted output)                                     │
                                                                                     ▼
 operator browser ─► route handlers ─► application services ─► POLICY ENGINE (pure function, no I/O)
   (session + CSRF)       (thin)         (orchestration)        facts come only from the server's own database
                                                │                       │ ALLOW / DENY + reason codes
                                                ▼                       ▼
                                          SQLite (STRICT tables,  PayPal adapter ─► PayPal Sandbox
                                          integer minor units,    (read before believe, stable request ids)
                                          hash-chained audit)           ▲
                                                                        └─ webhook: verified by PayPal, deduped, then re-read
```

Layers are enforced by ESLint (`eslint.boundaries.mjs`) and proven by `test/boundaries.test.ts`:

```
src/
  domain/       pure rules: money, mandate, offers, policy engine, payment judgement, state machine, audit hashing
  ports/        interfaces: stores, payment provider, model transport, webhook verifier
  application/  use cases: negotiation, payments, webhooks, cockpit (no framework, no adapters)
  adapters/     sqlite/ (migrations, stores, audit), paypal/, llm/, benchmark/
  agents/       buyer and seller agents, runtime (timeouts, bounded retries), deterministic mocks, hostile-seller fixture
  server/       server-only: the one env reader, operator guard, HTTP helpers, composition roots
  app/          Next.js routes and UI only
```

Properties that are rules of the code, not conventions:

- **Money is integer minor units** end to end, including `STRICT` SQLite tables. `parseFloat` is a lint error.
- **The server is the source of truth** for amount, currency, payee, state and mandate version. A client or agent can _claim_ values; the policy engine judges the values it loaded itself.
- **`src/server/*` starts with `import "server-only"`**, so importing it from a client component fails the build.
- **Erasable TypeScript only**, so `node scripts/db.ts` runs with no build step.

### Policy engine

`src/domain/policy.ts` is a pure, synchronous function: `evaluatePolicy(input) -> ALLOW | DENY` with sorted reason codes, a plain-language explanation, the policy version and a hash of the evaluated input. It judges five actions (`ACCEPT_OFFER`, `CREATE_ORDER`, `AUTHORIZE`, `CAPTURE`, `VOID`) against the **immutable, versioned mandate** (per-transaction cap, total budget, allowed categories and sellers, expiry, approval threshold) and the transaction state machine, and it collects _every_ violated rule instead of stopping at the first. `CAPTURE` is operator-only; an agent can recommend, never release funds. Rules and reason codes: [docs/POLICY_ENGINE.md](docs/POLICY_ENGINE.md); the mandate model: [docs/MANDATE.md](docs/MANDATE.md).

### Agent architecture

Agents live behind two small interfaces (`BuyerAgent`, `SellerAgent`) that have **no method to approve a mandate, authorize, capture, or pay**. Every agent output, from a mock or from a real model, goes through the same pipeline: input check, prompt, call, size limit, strict JSON, strict Zod schema (unknown keys are errors), reference and constraint checks, typed result, with per-attempt timeouts and bounded retries. Inputs are split into `trusted` facts the server computed (recomputed totals, cap and budget checks) and `untrusted` text from the other party, which is sanitised and scanned for injection signals. A counter-offer's target is a negotiating position, never a payment amount: the amount that is paid comes only from the stored agreement. Details: [docs/AGENTS.md](docs/AGENTS.md), [docs/NEGOTIATION.md](docs/NEGOTIATION.md).

### Payment flow and audit trail

`AGREED -> CREATING_ORDER -> ORDER_CREATED -> ORDER_APPROVED -> AUTHORIZED -> CAPTURED` (or `VOIDED`), with `FAILED` and `NEEDS_RECONCILIATION` as honest terminal or holding states. Payment steps are operator-only, require an empty request body, write an attempt row before the PayPal call, reuse a stable `PayPal-Request-Id`, and read the order back before believing any answer. A timeout or unparseable reply is **unknown**, never success. Only an observed capture is shown as paid. State machine: [docs/TRANSACTION_STATE_MACHINE.md](docs/TRANSACTION_STATE_MACHINE.md).

Every decision and PayPal observation is appended to a SHA-256 hash-chained audit log; `npm run db:status` verifies the chain and names the first invalid event. This is local tamper-evidence, **not a digital signature**: someone who can rewrite the whole database can rewrite the chain ([docs/AUDIT_CHAIN.md](docs/AUDIT_CHAIN.md)).

## PayPal Sandbox configuration

**What the repository does and does not prove.** The whole flow is exercised by tests that run real application code against an HTTP-level fake of PayPal and a fake of PayPal's signature-verification service. **No step has been run against `api-m.sandbox.paypal.com`.** The adapter follows PayPal's documented shapes; the fake follows the adapter, so the two can agree and both be wrong. Treat your first live run as the actual test and expect at least one mismatch ([docs/PAYPAL_INTEGRATION.md](docs/PAYPAL_INTEGRATION.md) §12 and §15.6 list the open questions).

To try it for real:

1. In the [PayPal Developer Dashboard](https://developer.paypal.com), under **Apps & Credentials > Sandbox**, create a REST app and note its client id and secret. Under **Sandbox > Accounts** you need a **Business** account (the payee) and a **Personal** account (the buyer who approves).
2. Put the client id and secret in `.env.local` as `PAYPAL_CLIENT_ID` and `PAYPAL_CLIENT_SECRET`.
3. Run `npm run paypal:smoke`. It requests a token and prints only metadata. Then run `npm run paypal:smoke -- --create-order`: it creates one unapproved 1.00 USD order, reads it back, and prints the payee merchant id. Put that value in `PAYPAL_MERCHANT_ID`. The script never authorizes, captures, voids or pays out.
4. Set `APP_BASE_URL` to a public HTTPS address PayPal can send the buyer back to (a hosted deployment or a tunnel; `localhost` cannot receive webhooks).
5. In the dashboard, add a webhook listener for `https://<your host>/api/webhooks/paypal` and subscribe to `CHECKOUT.ORDER.APPROVED`, `PAYMENT.AUTHORIZATION.CREATED`, `PAYMENT.AUTHORIZATION.VOIDED`, `PAYMENT.CAPTURE.COMPLETED`, `PAYMENT.CAPTURE.PENDING`, `PAYMENT.CAPTURE.DECLINED`, `PAYMENT.CAPTURE.REFUNDED` and `PAYMENT.CAPTURE.REVERSED`. Copy the webhook id into `PAYPAL_WEBHOOK_ID`. Other events are stored as ignored.
6. In `/negotiations`, reach an agreement, then **Start payment**, open the approval link as the sandbox buyer, return, **Authorize** (a hold, nothing charged), then **Capture** or **Void**.

The webhook is a verified _trigger_, never evidence by itself: the endpoint asks PayPal to verify the signature, deduplicates by event id, then re-reads the order and applies the read through the same transition rules as the "Check status" button. Endpoint sequence, state mapping and failure handling: [docs/PAYPAL_INTEGRATION.md](docs/PAYPAL_INTEGRATION.md). The tested journey, with mocked and live evidence kept apart: [docs/END_TO_END_TEST.md](docs/END_TO_END_TEST.md).

## Threat model

The register ([docs/THREAT_MODEL.md](docs/THREAT_MODEL.md)) walks eight trust boundaries. The core stance:

- **Seller text, offers, uploaded content and every model output are adversarial or untrusted.** Text is data, never instructions.
- **Agents cannot reach money.** They have no capability to approve, capture or change a mandate, and the layers are enforced at compile and lint time.
- **Anything that moves money must pass the server-side policy engine** with values the server loaded itself, and then be confirmed by reading PayPal.
- **Public endpoints are treated as hostile:** the webhook is signature-verified by PayPal, size-bounded, rate-capped and idempotent; the PayPal return URL is only a lookup key.
- **Failure is not success:** pending, unknown and failed payments are never displayed as paid.

What the threat model does **not** cover, by design: a compromised host or database owner, a compromised PayPal account, and multi-tenant isolation (there is one shared operator passcode). The findings, fixes and open items of the security review are in [docs/SECURITY_REVIEW.md](docs/SECURITY_REVIEW.md); known risks are in [docs/KNOWN_RISKS.md](docs/KNOWN_RISKS.md).

## Benchmark methodology

`npm run benchmark` is a seeded, reproducible comparison of the unsafe baseline and the protected system. It never reaches PayPal or any network: it has no credentials, imports no PayPal client, and replaces `fetch` with a trap that fails the run (asserted by tests).

- **Cases** come from three sources reported separately: hand-written Arena scenarios, seeded generated variants of ten attack families (over-cap price, false authority, inflated stated total, foreign currency, payee redirect, above approval threshold, cumulative spend, price above catalog, multiple flaws, and a benign control), and the 124 system scenarios of the adversarial suite run through the real services over an in-memory database.
- **Arena cases** run under two simulated models (`SUSCEPTIBLE`, which yields to authority claims and trusts the seller's total; `CAREFUL`) in two modes (`UNSAFE_BASELINE`, `PROTECTED`). System scenarios run protected only, so their baseline leg is recorded as _skipped_ with a reason rather than invented.
- **Result classes are never blended:** as expected, unexpectedly allowed (a violation got through), false block, other deviation, and not evaluated. Failed, errored and skipped runs are counted apart and every ratio shows its denominator.
- **Reproducibility:** the run is fully described by `BENCH_SEED` and `BENCH_PER_FAMILY`; each run record carries input fingerprints; the file carries a `resultsHash` that is recomputed on load, so an edited file is detected. The command exits non-zero if any protected run deviates from expectation.
- **Limits:** the "models" are deterministic stand-ins, not a live LLM red team, so the numbers measure the enforcement layer, not the persuadability of any real model (one separate live measurement of a real model is in [docs/LIVE_MODEL_ATTACK.md](docs/LIVE_MODEL_ATTACK.md): 0 of 50 hostile negotiations ended in a recommendation the server rejects, but the model passed 17 server-rejected offers on to a human). Read section 8 of [docs/ADVERSARIAL_BENCHMARK.md](docs/ADVERSARIAL_BENCHMARK.md) before quoting a number.

**Reference run** (default seed `20260401`, 6 variants per family; reproduced on a clean checkout): 524 runs recorded, 387 executed (189 distinct cases, 142 independent evidence units), 123 skipped with reasons, 374 completed, 13 model-error runs (these must fail closed), 0 infrastructure errors; results hash `07821734040f436e736c7a818716365c262bcc85f27160344c04ff603886744a`. The unsafe baseline let 58 of 58 attempted violations through on the simulated ledger. The protected system had no unexpectedly allowed action and no false block in any evaluated unit (19 arena units, 110 system units). Those are properties of the enforcement layer against the attacks in this catalogue, not a statement about attacks outside it; with 16 and 110 exercised units the benchmark's own rule-of-three bounds are about 18.8% and 2.7% (95%, independent random samples only).

The results are generated, not committed. After `npm run benchmark`, `/cockpit` shows them (until then it says that no benchmark has been run). Related: [docs/ADVERSARIAL_SUITE.md](docs/ADVERSARIAL_SUITE.md), [docs/ADVERSARIAL_CATALOG.md](docs/ADVERSARIAL_CATALOG.md), [docs/ARENA_EXPERIMENT.md](docs/ARENA_EXPERIMENT.md).

## Testing

`npm run check` runs type checking, lint, format check, the full Vitest suite and a production build. Beyond unit tests there are database and migration tests, route-level security sweeps, webhook replay and concurrency tests, failure-injection tests (AI provider down, invalid model output, database errors, PayPal timeout, denied payment, missing and repeated webhooks, stale agreement), and Playwright browser flows on the production build including reloads mid-transaction. The exact commands, counts, flake checks, coverage, mutation spot-checks, remaining bugs and every skipped test are in [docs/QA_REPORT.md](docs/QA_REPORT.md).

## Deployment

A Render Blueprint (`render.yaml`) and a hosted start script (`npm run start:demo`) are provided. In `DEPLOY_MODE=demo` the process refuses to start without an HTTPS base URL and an operator passcode, adds HSTS and `noindex`, and keeps payment endpoints behind the operator session. The free plan's disk is ephemeral, so each start re-migrates and re-seeds. **It has not been deployed**; the local rehearsal (`npm run verify:deployment`) and the steps that need your own Render account are recorded in [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md). Run exactly **one instance**: the database is a SQLite file and the rate limits live in the process.

## Troubleshooting

| Symptom                                                                | Cause and fix                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| ---------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `npm run db:migrate` or another script fails on `.ts` or `node:sqlite` | Node is too old. Use **>= 22.18** (`node -v`); `nvm use` reads `.nvmrc`.                                                                                                                                                                                                                                                                                                                                                                                                      |
| `Invalid environment:` followed by a variable name                     | That variable failed validation. Values are never printed. Fix it in `.env.local`. `replace-with-*` placeholders count as unset, so replace the passcode with a real one.                                                                                                                                                                                                                                                                                                     |
| "An agent failed to answer" after **Run with the AI model**            | The model's reply was rejected by the strict validation, or the provider rate-limited a call (Groq's free tier allows 8000 tokens per minute for `openai/gpt-oss-120b`, about two runs a minute). Nothing is approved or paid when it fails; wait a minute and run it again. (A real cause was fixed on 2026-11-09: the model often left out the optional seller note, which used to make a valid offer fail. After the fix 5 of 5 runs and 12 of 12 seller calls succeeded.) |
| `/mandate` or `/negotiations` will not let you sign in                 | `OPERATOR_PASSCODE` is unset or under 16 characters. Edit `.env.local` and **restart** the dev server (Next reads it at start).                                                                                                                                                                                                                                                                                                                                               |
| "Too many attempts" at sign-in                                         | The login throttle is global: 5 failures per minute. Wait a minute.                                                                                                                                                                                                                                                                                                                                                                                                           |
| `/api/health` reports `database.state: "uninitialized"`                | Run `npm run db:migrate` (the health probe never creates the file).                                                                                                                                                                                                                                                                                                                                                                                                           |
| The payment step is unavailable, or payment routes answer 503          | PayPal is not configured. That is the expected, honest behaviour; see [PayPal Sandbox configuration](#paypal-sandbox-configuration).                                                                                                                                                                                                                                                                                                                                          |
| Authorize is refused although everything else looks fine               | `PAYPAL_MERCHANT_ID` is unset, so the payee cannot be verified. Run `npm run paypal:smoke -- --create-order` and copy the merchant id it prints.                                                                                                                                                                                                                                                                                                                              |
| Webhook returns 503 / 401                                              | 503: `PAYPAL_WEBHOOK_ID` is unset. 401: the signature did not verify (wrong webhook id, wrong environment, or a forged call). `localhost` cannot receive PayPal webhooks.                                                                                                                                                                                                                                                                                                     |
| Agreement refused with `OVER_TOTAL_BUDGET`                             | The seeded mandate has a **150.00 total budget**; two typical agreements exhaust it. Approve a larger mandate at `/mandate`, or start clean: `npm run db:reset -- --yes && npm run db:migrate && npm run db:seed`.                                                                                                                                                                                                                                                            |
| The Cockpit benchmark view says no benchmark has been run              | Results are generated and git-ignored. Run `npm run benchmark`.                                                                                                                                                                                                                                                                                                                                                                                                               |
| After returning from PayPal you appear signed out                      | The session may have expired (8 h). The return page then asks you to sign in and use "Check status with PayPal"; nothing is read from PayPal until you do. (The cookie is `SameSite=Lax`: with `Strict` a normal return from PayPal arrived without it, which was found and fixed on 2026-11-09.)                                                                                                                                                                             |
| `npm run e2e` cannot launch a browser                                  | The suite uses the installed Microsoft Edge. See the Playwright note under [Commands](#commands).                                                                                                                                                                                                                                                                                                                                                                             |
| Port 3000 is in use                                                    | `npm run dev -- -p 3001`, and set `APP_BASE_URL=http://localhost:3001`.                                                                                                                                                                                                                                                                                                                                                                                                       |
| Benchmark environment variables on Windows PowerShell                  | `$env:BENCH_SEED=7; npm run benchmark` (the bash form `BENCH_SEED=7 npm run benchmark` does not work there).                                                                                                                                                                                                                                                                                                                                                                  |
| Reset everything locally                                               | `npm run db:reset -- --yes`, then `db:migrate` and `db:seed`. This deletes the local database file only.                                                                                                                                                                                                                                                                                                                                                                      |

## Documentation map

| Topic                                 | Document                                                                                                                                                                                                                                                                                                  |
| ------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Design rationale (original, pre-code) | [ARCHITECTURE.md](docs/ARCHITECTURE.md), [TRANSACTION_STATE_MACHINE.md](docs/TRANSACTION_STATE_MACHINE.md), [ACCEPTANCE_CRITERIA.md](docs/ACCEPTANCE_CRITERIA.md)                                                                                                                                         |
| Policy, mandate, negotiation, agents  | [POLICY_ENGINE.md](docs/POLICY_ENGINE.md), [MANDATE.md](docs/MANDATE.md), [NEGOTIATION.md](docs/NEGOTIATION.md), [AGENTS.md](docs/AGENTS.md)                                                                                                                                                              |
| Data and audit                        | [DATABASE.md](docs/DATABASE.md), [AUDIT_CHAIN.md](docs/AUDIT_CHAIN.md)                                                                                                                                                                                                                                    |
| PayPal                                | [PAYPAL_INTEGRATION.md](docs/PAYPAL_INTEGRATION.md), [END_TO_END_TEST.md](docs/END_TO_END_TEST.md)                                                                                                                                                                                                        |
| Security                              | [THREAT_MODEL.md](docs/THREAT_MODEL.md), [SECURITY_REVIEW.md](docs/SECURITY_REVIEW.md), [KNOWN_RISKS.md](docs/KNOWN_RISKS.md)                                                                                                                                                                             |
| Experiments and benchmark             | [ARENA_EXPERIMENT.md](docs/ARENA_EXPERIMENT.md), [FLAGSHIP_SCENARIO.md](docs/FLAGSHIP_SCENARIO.md), [ADVERSARIAL_SUITE.md](docs/ADVERSARIAL_SUITE.md), [ADVERSARIAL_BENCHMARK.md](docs/ADVERSARIAL_BENCHMARK.md)                                                                                          |
| UI and Cockpit                        | [USER_JOURNEY.md](docs/USER_JOURNEY.md), [UI_DESIGN.md](docs/UI_DESIGN.md), [COCKPIT.md](docs/COCKPIT.md)                                                                                                                                                                                                 |
| Quality and deployment                | [QA_REPORT.md](docs/QA_REPORT.md), [RELEASE_CANDIDATE.md](docs/RELEASE_CANDIDATE.md), [DEPLOYMENT.md](docs/DEPLOYMENT.md), [DEMO_SCRIPT.md](docs/DEMO_SCRIPT.md) (demo video plan; the automated pipeline is in [demo/](demo/README.md)), [SUBMISSION.md](docs/SUBMISSION.md) (hackathon submission text) |

## Testing it (for judges)

Pick whichever is quicker; none of them needs a paid service.

1. **Hosted demo:** https://pactpay-arena.onrender.com (Render free plan: the first load after a sleep takes about a minute). The public pages need nothing: [Flagship attack](https://pactpay-arena.onrender.com/flagship), [Arena](https://pactpay-arena.onrender.com/arena), [Cockpit](https://pactpay-arena.onrender.com/cockpit) and [Live model](https://pactpay-arena.onrender.com/live-model). The operator pages (`/mandate`, `/negotiations`, where the PayPal payment is run) need the operator passcode and the sandbox buyer login, which are in the testing instructions of the Devpost submission (they are not in this public repository). The hosted demo uses the scripted agents, so its "Run with the AI model" button is off; the real-model scene needs your own free Groq key (below) and the measurement is on the Live model page.
2. **Locally, no credentials:** `npm ci`, `npm run db:migrate`, `npm run db:seed`, `npm run dev`, then open http://localhost:3000. Everything except the PayPal payment and the real model works.
3. **Locally, the full flow:** add your own PayPal Sandbox app (see [PayPal Sandbox configuration](#paypal-sandbox-configuration)) and, for the real model, a free Groq key (`AGENT_MODE=llm`, `AGENT_PROVIDER=groq`, `GROQ_API_KEY`, `AGENT_MODEL=openai/gpt-oss-120b`; see `.env.example`).

## Known limitations

- Live-verified against PayPal Sandbox: create, approve, authorize, capture, reconciliation. **Also verified live:** void (hold released, nothing charged) and signed webhooks (seven PayPal-delivered events over two runs, verified and stored, through a temporary tunnel; a refund event carries no order id and is stored but not applied). The real model was called live once (Groq); the benchmark's models are still deterministic; see [Status at a glance](#status-at-a-glance-read-this-first).
- One shared operator passcode and a global login throttle: demo-grade authentication, no per-user accounts, no session revocation.
- No Content-Security-Policy header yet (tracked as a low-severity finding in the security review).
- SQLite with in-process rate limits: single instance only.
- The CI workflow (`.github/workflows/ci.yml`) is written but has never run on a hosted runner.
- Payouts to sellers are not implemented. If you add them, keep them separate from order capture and label any simulation unmistakably.

## Development process and contributions

This project was built with an AI coding assistant (Claude Code) working under the engineering rules in [CLAUDE.md](CLAUDE.md) (server-side policy as the authority, integer money, no secrets in source, no claim of success that was not verified). Treat the documentation's verification statements the way the code is treated: check them. Issues and pull requests are welcome; please keep changes small, add tests, and never include real credentials, real personal data or non-sandbox PayPal values in an issue or a patch.

## License

MIT. See [LICENSE](LICENSE). The production dependencies are MIT, Apache-2.0, ISC, BSD or similar permissive licenses. The lockfile also lists **optional** LGPL-licensed image-library binaries (`@img/sharp-*`, pulled in by Next.js) that npm may download for your platform; this app disables image optimization and does not ship or link them itself. AG Grid is used in its MIT-licensed Community edition only, with no Enterprise feature or licence key.

**Trademarks.** PactPay Arena is an independent hackathon project. It is not affiliated with, endorsed by or sponsored by PayPal, Groq, Anthropic, ElevenLabs or Render; those names and PayPal's marks belong to their owners and are used only to say which services the project talks to. It uses the PayPal Sandbox only.
