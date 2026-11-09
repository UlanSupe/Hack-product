# PactPay Arena — Implementation Plan

> The phase outline below is superseded for scheduling and scope by the 32-day plan in [ARCHITECTURE.md §12](ARCHITECTURE.md) and the criteria in [ACCEPTANCE_CRITERIA.md](ACCEPTANCE_CRITERIA.md). The blocker list below is still current.

Principle: _Agents negotiate. Code enforces. PayPal settles._ Smallest vertical slice first; every phase ends with typecheck + lint + tests green. No commits unless asked.

## Blockers (prioritized)

| #   | Blocker                                                                                                                           | Needed from                                      | Blocks                                      |
| --- | --------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------ | ------------------------------------------- |
| B1  | **PayPal sandbox REST app credentials** (Client ID/Secret), sandbox business + personal accounts                                  | User (developer.paypal.com → Apps & Credentials) | P0 real payment flow, P1 webhooks           |
| B2  | **Public HTTPS URL + webhook ID** (port 443; localhost can't receive)                                                             | User decides host/tunnel                         | P1 verified webhooks, public demo           |
| B3  | **PayPal behavior verification** (honor period, request-id idempotency, partial capture, void) via schema + one live sandbox call | Me, once B1 exists                               | Payment state machine timings               |
| B4  | Not a git repo, no `.gitignore`                                                                                                   | User: OK to `git init`? (I won't commit)         | Safe secret handling, rollback              |
| B5  | AI API key (Anthropic)                                                                                                            | User, optional                                   | Live-model agent; fixtures work without it  |
| B6  | AG Studio / Grid Enterprise trial key                                                                                             | User, optional                                   | P2 only                                     |
| B7  | Payouts API sandbox access unconfirmed                                                                                            | Me, with B1                                      | P2 real payouts; simulation ships otherwise |

Nothing in B4–B7 stops P0 scaffolding, policy engine, Arena or tests from starting now. Only B1 blocks the real-payment slice, and B2 blocks webhooks.

## Phase 0 — Scaffold (no features)

- `git init` (if approved), `.gitignore` (node_modules, .next, .env*, *.db), `.env.example` (placeholders only).
- Next.js App Router + strict TS + ESLint + Vitest + Zod. npm.
- Module layout (separation required by constitution):
  `src/domain/` (money, mandate, policy engine) · `src/payments/` (PayPal client + test double) · `src/agents/` (negotiation, fixtures, schemas) · `src/store/` (persistence, audit log) · `src/app/` (UI + routes only).
- Scripts: `typecheck`, `lint`, `test`, `build`. Spike `node:sqlite` under Next runtime.
- **Exit:** all four scripts pass on a hello-world.

## Phase 1 — P0 core (no network needed)

1. **Money + mandate:** integer minor units, currency, versioned immutable mandate (cap, currency, allowed payees, expiry). Tests incl. rounding/overflow/currency mismatch.
2. **Policy engine:** pure function `evaluate(mandate, proposal, state) → allow|deny + reasons`. Validates amount, currency, payee, state, mandate version. Tests: boundary, over-limit, wrong payee/currency, stale mandate version.
3. **Audit log:** append-only events with hash chain + verifier (documented as local tamper-evidence only).
4. **Agents:** Zod-validated structured output; scripted deterministic seller + buyer fixtures; intentionally-unsafe baseline vs protected buyer. Adversarial fixtures (authority claims, urgency, "raise your limit", fee smuggling). Test: protected buyer blocked even when model output says "pay".
5. **Arena UI:** split screen (unsafe vs protected), replayable scenarios, payment status derived only from server-verified state (pending/failed/unknown never shown as success).

- **Exit:** adversarial suite green; demo runs offline with the PayPal test double clearly labeled.

## Phase 2 — P0 PayPal Sandbox (needs B1)

- Verify B3 items first; record findings in this doc.
- Client: OAuth token (server-only, never logged), Orders create → approve (buyer sandbox) → authorize/capture, void via Payments v2. Policy check gates every server call; amount/currency/payee re-validated against the stored order.
- Local state machine + unique idempotency key per (order, action); duplicate-capture test.
- Payout: separate module; labeled simulation unless B7 resolved. Never describe as escrow.
- **Exit:** one real sandbox transaction end to end (evidence: PayPal order/capture IDs), plus a blocked over-limit attempt that never reaches PayPal.

## Phase 3 — P1 (needs B2)

Verified webhooks (offline verification, raw body, cert-host allow-list, event-ID dedupe), benchmark runner over adversarial fixtures, AG Grid Community analytics, hash-chain verification UI, README/demo script, public deploy.

## Phase 4 — P2 (only after P0 stable)

Real Payouts API, AG Studio widgets (trial key), extra agents.

## Per-task protocol (from CLAUDE.md)

Inspect → state plan → implement smallest slice → add tests → run typecheck/lint/test → report exact commands/results and unverified assumptions.

## Immediate next step (awaiting go-ahead)

Phase 0 scaffold. Questions that change what I do: approve `git init`? hosting preference for the public HTTPS demo? Do you have PayPal sandbox credentials ready?
