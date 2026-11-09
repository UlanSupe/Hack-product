# PactPay Arena — Project Audit

Audit date: 2026-10-11. Scope: inspection only; no product code written.

## 1. Repository state

| Item                                             | Finding                                                                               |
| ------------------------------------------------ | ------------------------------------------------------------------------------------- |
| Contents                                         | One file: `CLAUDE.md` (engineering constitution). Nothing else.                       |
| Git                                              | **Not a git repository** (`Is a git repository: false`). No history, no `.gitignore`. |
| `package.json` / lockfile                        | None                                                                                  |
| Source, tests, DB schema, `.env.example`, README | None                                                                                  |
| Parent directory                                 | Has its own unrelated `CLAUDE.md` and no `graphify-out/`; irrelevant to this project. |

**Verdict: empty greenfield repo.** There is no existing work to preserve beyond `CLAUDE.md`.

## 2. Development environment (verified by running commands)

| Tool                                                                                                                       | Result                                               |
| -------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------- |
| OS / shell                                                                                                                 | Windows 11 Pro 10.0.26200, PowerShell 5.1 + Git Bash |
| Node                                                                                                                       | v24.18.0                                             |
| npm                                                                                                                        | 11.16.0                                              |
| pnpm / yarn / bun                                                                                                          | not installed                                        |
| git                                                                                                                        | 2.55.0.windows.3                                     |
| Python                                                                                                                     | 3.12.0                                               |
| Docker                                                                                                                     | not installed                                        |
| `sqlite3` CLI                                                                                                              | not installed                                        |
| Credential env vars (`PAYPAL_CLIENT_ID`, `PAYPAL_CLIENT_SECRET`, `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `AG_GRID_LICENSE`) | **none set** in this shell                           |

## 3. Requested checks

| Check             | Result                                |
| ----------------- | ------------------------------------- |
| Does the app run? | N/A — no app exists                   |
| Build             | N/A — no build script                 |
| Type check        | N/A — no `tsconfig.json` / TypeScript |
| Lint              | N/A — no ESLint config                |
| Existing tests    | **None** (0 test files, no runner)    |

No check commands were run because none are defined. Nothing failed; nothing exists to fail.

## 4. Existing integrations

| Area           | Present?                                  |
| -------------- | ----------------------------------------- |
| UI / framework | No                                        |
| Database       | No                                        |
| Authentication | No                                        |
| PayPal         | No code; **no sandbox credentials found** |
| AI provider    | No code; **no API key found**             |
| AG Grid        | Not installed; no licence key found       |

## 5. Package availability (checked against the npm registry, 2026-10-11)

| Package                               | Latest               | License                                                |
| ------------------------------------- | -------------------- | ------------------------------------------------------ |
| next                                  | 16.4.0 (node >=20.9) | MIT                                                    |
| react                                 | 19.3.0               | MIT                                                    |
| typescript                            | 7.0.2                | Apache-2.0                                             |
| vitest                                | 5.0.3                | MIT                                                    |
| zod                                   | 4.6.5                | MIT                                                    |
| eslint                                | 10.12.0              | MIT                                                    |
| playwright                            | 1.64.0               | Apache-2.0                                             |
| better-sqlite3                        | 13.0.3               | MIT (native build; may need MSVC toolchain on Windows) |
| @paypal/paypal-server-sdk             | 2.5.0                | MIT                                                    |
| @anthropic-ai/sdk                     | 0.133.0              | MIT                                                    |
| ag-grid-community / ag-grid-react     | 36.2.0               | MIT                                                    |
| ag-grid-enterprise                    | 36.2.0               | Commercial                                             |
| ag-charts-community / ag-charts-react | 14.2.0               | MIT                                                    |
| ag-studio / ag-studio-react           | 3.0.0                | **Commercial**                                         |

Versions are "latest published", not tested for compatibility with each other.

## 6. PayPal capabilities — what is documented vs. what still needs verification

Sources: developer.paypal.com pages fetched during this audit. Index pages gave endpoints but not full field-level behavior; items marked **UNVERIFIED** must be confirmed against the schema (`/api/orders/v2/schema.json`) or a live sandbox call.

| Capability                                                                                                                                                | Status                                                                                                               |
| --------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| Orders v2 create / get / patch / authorize / capture (`POST /v2/checkout/orders[/{id}/authorize\|capture]`)                                               | Documented                                                                                                           |
| Void authorization: `POST /v2/payments/authorizations/{id}/void` (Payments v2, **not** Orders)                                                            | Documented                                                                                                           |
| Capture authorization: `POST /v2/payments/authorizations/{id}/capture`; reauthorize endpoint                                                              | Documented                                                                                                           |
| `intent=AUTHORIZE` semantics, 3-day honor period, 29-day capture window, reauthorize after honor period, single purchase unit only                        | **Verified 2026-10-11** from PayPal's official OpenAPI spec (see ARCHITECTURE §2.1)                                  |
| `PayPal-Request-Id` header on create/authorize/capture/void                                                                                               | **Verified as a defined parameter**; retention window and replay-with-different-body behavior still **UNVERIFIED**   |
| `final_capture` on authorization capture                                                                                                                  | **Verified** (field exists). Partial-capture business rules still unverified                                         |
| Webhook verification: offline (CRC32 + cert-URL + SHA256) preferred; postback via `verify-webhook-signature` also supported                               | Documented                                                                                                           |
| Webhook headers: `paypal-transmission-id`, `-time`, `-cert-url`, `-transmission-sig`; webhook ID comes from the listener subscription                     | Documented                                                                                                           |
| Webhook simulator mock events: postback verification **not supported** (use offline, id `WEBHOOK_ID`); realistic flow needs sandbox REST app subscription | Documented                                                                                                           |
| Webhooks delivered to **HTTPS port 443 only**; non-2xx retried up to 25× over 3 days                                                                      | Documented                                                                                                           |
| Payouts API `POST /v1/payments/payouts` available in sandbox; rate limit 400 POST/min; no separate approval mentioned on the integrate page               | Partially documented — **live-account enablement and required app features/scopes UNVERIFIED**                       |
| Escrow                                                                                                                                                    | **PayPal Orders does not provide escrow.** authorize→capture is a hold-then-charge, not escrow. Do not claim escrow. |
| Multi-seller / payee routing (`payee`, platform fees) in Orders                                                                                           | **UNVERIFIED**; may require partner/Commerce Platform approval. Plan assumes a single sandbox merchant as payee.     |

Credentials needed (none available yet): sandbox REST app Client ID + Secret, a sandbox business (merchant) account, a sandbox personal (buyer) account, a webhook ID for a public HTTPS URL.

## 7. AG Grid licensing — what this project can actually use

| Product                                                  | License                                                                                                                                 | Usable now?                                                                                      |
| -------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| AG Grid Community (`ag-grid-community`, `ag-grid-react`) | MIT, free, no key                                                                                                                       | **Yes**                                                                                          |
| AG Charts Community                                      | MIT, free                                                                                                                               | **Yes**                                                                                          |
| AG Grid Enterprise                                       | Commercial ($999/dev per ag-grid.com pricing page); key required; 30-day trial key available                                            | **No** until a key/trial is obtained. No key present.                                            |
| Integrated Charts                                        | Only in Enterprise Bundle ($1,498/dev)                                                                                                  | **No**                                                                                           |
| AG Studio (`ag-studio`, `ag-studio-react` 3.0.0)         | Commercial; 45-day free trial, no watermark; React wrapper exists; has an AI "Agent Playground" for natural-language dashboard building | **No** until trial/licence obtained. Whether it also requires Grid Enterprise is **UNVERIFIED**. |

Conclusion: Community Grid + Community Charts are the only safe assumption. Treat AG Studio / dynamic agent-generated widgets as P2, gated on a trial key (and mind the trial expiry vs. the judging date).

## 8. Recommended minimal stack (empty repo)

- **Next.js (App Router) + React + strict TypeScript** — one deployable that holds both Arena UI and server-side policy/payment routes; secrets stay server-side.
- **Zod** — runtime validation of all external input, agent output, PayPal responses and webhooks.
- **Vitest** — unit/integration tests for policy engine, money math, hash chain, webhook idempotency; adversarial scenario fixtures as data-driven tests.
- **Persistence: SQLite.** Prefer Node's built-in `node:sqlite` (Node 24 here; no native build) — **verify it works under Next's server runtime**; fallback `better-sqlite3`. Money stored as integer minor units.
- **PayPal:** thin typed `fetch` client for Orders v2 / Payments v2 / Payouts, behind an interface with a test double. Evaluate `@paypal/paypal-server-sdk` but don't depend on it until void/webhook/payout coverage is confirmed.
- **AI:** `@anthropic-ai/sdk` behind an `AgentModel` interface with a deterministic scripted fixture implementation (demo must replay without an API key).
- **Grid:** `ag-grid-community` + `ag-grid-react`.
- **Lint:** ESLint. **E2E (later):** Playwright.
- **Package manager:** npm (only one installed; avoids extra setup).
- Public demo hosting needs HTTPS (webhooks require 443) — Vercel-style host or a tunnel; decide later.
