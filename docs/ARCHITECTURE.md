# PactPay Arena — MVP Architecture

Status: **this is the original design document, written before the code; the application is now built.** Where the text below says "will" or "planned", read [README.md](../README.md) and the per-feature documents (`POLICY_ENGINE.md`, `PAYPAL_INTEGRATION.md`, `AGENTS.md`, `DATABASE.md`, `SECURITY_REVIEW.md`) for what exists and what was verified; this file is kept for the reasoning. Companion docs: [THREAT_MODEL.md](THREAT_MODEL.md), [TRANSACTION_STATE_MACHINE.md](TRANSACTION_STATE_MACHINE.md), [ACCEPTANCE_CRITERIA.md](ACCEPTANCE_CRITERIA.md), [PROJECT_AUDIT.md](PROJECT_AUDIT.md).

> **Agents negotiate. Code enforces. PayPal settles.**

## 1. What the MVP is

A split-screen **Arena** that replays the same adversarial seller scenario against two buyer agents:

| Left                                                                                                                                                                                  | Right                                                                                                                                                                                                        |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **INTENTIONALLY UNSAFE BASELINE** — buyer agent whose decisions directly drive a _simulated_ ledger. It can be talked into exceeding the user's mandate. **It never touches PayPal.** | **PROTECTED BUYER** — same agent, but every money-moving step passes through a deterministic server-side policy engine and a state machine. Settles through **PayPal Sandbox** (authorize → capture / void). |

Plus: reproducible attack scenarios, an append-only audit trail with hash-chain verification, and honest payment status (pending/unknown is never shown as success).

### Non-goals (MVP)

Real money, production PayPal, real user accounts/auth, multi-tenant, refunds/disputes handling, reauthorization, partial capture, multiple purchase units, real Payouts (P2), escrow (PayPal does not provide it — never claimed), AG Studio (P2, needs a commercial trial key).

## 2. Verified PayPal facts this design relies on

Source: PayPal's official OpenAPI specs (`developer.paypal.com/api/orders/v2/schema.json`, `.../payments/v2/schema.json`) and the Webhook event-names page, read 2026-10-11. Items under §2.2 are **not** verified and are design assumptions that must be checked (see §11).

### 2.1 Verified from the official specs

| #   | Fact                                                                                                                                                                                                                                                                                                                                                            | Used for                                                                            |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| V1  | `intent=AUTHORIZE` places a hold after buyer approval. Best captured within a **3-day honor period**; capturable up to **29 days**; after the honor period you must **reauthorize**. Not supported with >1 `purchase_unit`.                                                                                                                                     | Hold-then-charge flow; single purchase unit; MVP refuses capture after honor period |
| V2  | Order status: `CREATED, SAVED, APPROVED, VOIDED, COMPLETED, PAYER_ACTION_REQUIRED`. Authorization status: `CREATED, CAPTURED, DENIED, PARTIALLY_CAPTURED, VOIDED, PENDING` (**no `EXPIRED` value**). Capture status: `COMPLETED, DECLINED, PARTIALLY_REFUNDED, PENDING, REFUNDED, FAILED`.                                                                      | State mapping; expiry must be computed locally from time                            |
| V3  | `PayPal-Request-Id` header is a defined parameter on create order, authorize order, capture order, and on authorization capture / reauthorize / void / refund.                                                                                                                                                                                                  | Outbound idempotency                                                                |
| V4  | Void: "You cannot void an authorized payment that has been fully captured." Void/capture can return **409** (previous call in progress / conflict) and **422** (business validation). Authorize order can return **202** (accepted, not completed).                                                                                                             | Race handling; ambiguity handling                                                   |
| V5  | Capture of an authorization (`POST /v2/payments/authorizations/{id}/capture`) accepts `amount`, `final_capture`, `invoice_id`.                                                                                                                                                                                                                                  | Full capture with `final_capture=true`                                              |
| V6  | Authorization `PENDING` reasons: `PENDING_REVIEW`, `DECLINED_BY_RISK_FRAUD_FILTERS`. Capture `PENDING`/`DENIED` reasons include `PENDING_REVIEW`, `ECHECK`, `BUYER_COMPLAINT`, `CHARGEBACK`, `VERIFICATION_REQUIRED`, `TRANSACTION_APPROVED_AWAITING_FUNDING`, `DECLINED_BY_RISK_FRAUD_FILTERS`, …                                                              | Pending ≠ success                                                                   |
| V7  | Webhook events: `CHECKOUT.ORDER.APPROVED`; `PAYMENT.AUTHORIZATION.CREATED`, `.VOIDED` (also fired when the 30-day validity lapses); `PAYMENT.CAPTURE.COMPLETED / DECLINED / PENDING / REFUNDED / REVERSED`.                                                                                                                                                     | Webhook handling                                                                    |
| V8  | Webhook signature: offline verification preferred (transmission id + time + webhook id + CRC32 of **raw body**, cert from `paypal-cert-url`, SHA256); postback `verify-webhook-signature` also exists. Headers: `paypal-transmission-id/-time/-cert-url/-transmission-sig`. Simulator mock events: offline only. HTTPS 443 only; retries up to 25× over 3 days. | Webhook verifier                                                                    |
| V9  | `platform_fees` / `disbursement_mode` in `payment_instruction` apply only to merchants enabled for PayPal Complete Payments Platform.                                                                                                                                                                                                                           | **No** automatic seller split → payout is a _simulation_                            |
| V10 | `invoice_id` must be unique per merchant account by default; `custom_id` is for reconciliation and not shown to the payer.                                                                                                                                                                                                                                      | Bind PayPal order to our transaction                                                |

### 2.2 Assumptions requiring official-doc or account-permission checks (A-list)

> Updated status of these items after the 2026-10-13 feasibility spike: see [PAYPAL_INTEGRATION.md](PAYPAL_INTEGRATION.md) §14. No PayPal endpoint has been called yet; every item is still unverified live.

| #   | Assumption                                                                                                                                                                                        | How to settle                                                                                                          | By   |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- | ---- |
| A1  | The sandbox business account / REST app can use Orders v2 `intent=AUTHORIZE` and Payments v2 capture/void without extra enablement.                                                               | Day-2 smoke test                                                                                                       | D2   |
| A2  | `PayPal-Request-Id` retention window and behavior when replayed with a _different_ body are unspecified.                                                                                          | Test in sandbox; treat as unknown, keep local dedupe as primary                                                        | D16  |
| A3  | `GET /v2/checkout/orders/{id}` returns `purchase_units[0].payments.authorizations[]` / `.captures[]` and echoes `payee`, `amount`, `custom_id`, `invoice_id`.                                     | Inspect real sandbox response                                                                                          | D16  |
| A4  | `payee` can only be the REST app's own merchant (no third-party payee without partner permissions). MVP: _sellers are logical identities mapped to one sandbox merchant_.                         | Check docs/permissions; do not attempt multi-merchant                                                                  | D2   |
| A5  | Buyer approval requires an interactive sandbox-buyer login at PayPal; it cannot be reliably automated. CI therefore uses the simulated provider; the real flow is verified manually and recorded. | Manual run, store evidence IDs                                                                                         | D17  |
| A6  | Authorization/honor-period expiry can't be observed in sandbox within the project timeline. Expiry logic is tested with an injected clock only and is **not** verified against PayPal.            | State this limitation in docs                                                                                          | —    |
| A7  | Webhook `cert_url` host allow-list values for sandbox vs live; exact payload fields.                                                                                                              | Capture real sandbox webhook samples                                                                                   | D26  |
| A8  | Payouts API enabled for the sandbox merchant and its scopes.                                                                                                                                      | Only if P2 reached                                                                                                     | D32+ |
| A9  | Whether SQLite-on-disk persistence is available on the chosen host (serverless platforms have ephemeral disks).                                                                                   | Decide host by D3 (prefer a long-running Node container with a volume)                                                 | D3   |
| A10 | `node:sqlite` works under the Next.js server runtime on Node 24; otherwise `better-sqlite3`.                                                                                                      | **Resolved**: verified under Vitest, the native-TS CLI and the Next production server (see [DATABASE.md](DATABASE.md)) | done |

## 3. System overview

```
 Browser (Arena UI, AG Grid Community)             — untrusted
    │  HTTPS, same-origin, operator session
┌───▼──────────────────────────── Next.js server (trusted) ───────────────────────────────┐
│ web/        route handlers + UI. Thin: parse (Zod) → call application service           │
│ application/ NegotiationService · TransactionService · WebhookService ·                  │
│              VerificationService · AttackRunner · ActionGateway ◄── only path to money   │
│ domain/     PURE: money · mandate · offer · agreement · policy · state machine · audit   │
│ ports/      PaymentProvider · AgentModel · Store · Clock · Ids                           │
│ adapters/   paypal-http · simulated-ledger · sqlite · llm(anthropic) · scripted-agent    │
└───────┬───────────────────────────┬──────────────────────────┬──────────────────────────┘
        │ HTTPS (server-only creds)  │ HTTPS (optional)          │ file
   PayPal Sandbox API / webhooks   LLM API (untrusted output)   SQLite (audit, state)
```

### 3.1 Layering rules (enforced by lint + a dependency test)

1. `domain/` imports nothing outside itself and the standard library. No I/O, no `Date.now()`, no randomness — time and ids are passed in.
2. `agents/` (negotiation, scripted seller/buyer, unsafe baseline) may import `domain/` types and `ports/AgentModel`. It **must not** import `adapters/paypal`, `ActionGateway`, or `Store`. Enforced with ESLint `no-restricted-imports` and a test that scans imports.
3. Only `ActionGateway` constructs the branded `AuthorizedAction` type and only `adapters/paypal` and `adapters/simulated-ledger` accept it (§5). A `PaymentProvider` method cannot be called with a plain object — it will not type-check.
4. `web/` route handlers contain no business logic.
5. The **unsafe baseline can only be wired to `SimulatedLedger`**: constructor type + runtime assertion `provider.kind === "SIMULATED"` + test.

## 4. Domain models

TypeScript-style sketches; Zod schemas will mirror them. All money is `{ minor: number /*safe integer ≥ 0*/, currency: "USD" }`; the currency exponent table lives in one module; decimal strings for PayPal are produced only there. No floats anywhere in money paths (lint rule bans `parseFloat`/`Number()` on amount fields; tests for overflow, rounding, mismatch).

```ts
type Money = { minor: number; currency: "USD" }; // MVP: USD only (other currencies exist only as attack inputs)

// Set by the human operator only. Immutable once created; "editing" creates version n+1.
type Mandate = {
  id: string;
  version: number; // (id, version) is the identity
  ownerId: string; // synthetic demo user
  perTransactionCap: Money;
  totalBudget: Money;
  allowedSellerIds: string[]; // seller allow-list (maps to payee refs)
  expiresAt: string; // ISO-8601
  status: "ACTIVE" | "REVOKED";
  createdBy: "OPERATOR"; // literal — an agent cannot be an author
  contentHash: string; // SHA-256 of canonical JSON
};

// Seller-issued. UNTRUSTED text; only structured, validated fields are used by code.
type Offer = {
  id: string;
  sellerId: string;
  negotiationId: string;
  revision: number;
  supersedes?: string;
  lines: { sku: string; description: string; qty: number; unitPrice: Money }[]; // catalog-checked
  shipping: Money;
  fees: Money; // declared fees; included in total
  claimedTotal: Money; // seller's number — never trusted
  serverTotal: Money; // recomputed by server from lines+shipping+fees
  termsText: string; // untrusted; displayed as inert text
  validUntil: string;
  termsHash: string; // SHA-256 of canonical(lines, shipping, fees, currency, sellerId)
  status: "OPEN" | "SUPERSEDED" | "EXPIRED" | "ACCEPTED" | "REJECTED";
};

// Frozen contract created when policy ALLOWs acceptance. The only source of amount/payee for payment.
type Agreement = {
  id: string;
  offerId: string;
  termsHash: string; // copy of the accepted offer's hash
  mandateId: string;
  mandateVersion: number;
  payeeRef: string; // from server seller catalog, never from messages
  total: Money; // == offer.serverTotal
  policyDecisionId: string;
  createdAt: string;
};

type Transaction = {
  id: string;
  agreementId: string; // 1:1 with agreement (UNIQUE)
  state: TxState; // see TRANSACTION_STATE_MACHINE.md
  version: number; // optimistic-concurrency token
  reconcilingFrom?: TxState; // set only in NEEDS_RECONCILIATION
  paypal: { orderId?: string; authorizationId?: string; captureId?: string };
  authorizedAt?: string;
  honorExpiresAt?: string; // computed locally from authorizedAt (+3d) — V1/A6
  amounts: { authorized?: Money; captured?: Money };
  lastObservedPayPal?: {
    resource: "ORDER" | "AUTHORIZATION" | "CAPTURE";
    status: string;
    observedAt: string;
    source: "API_RESPONSE" | "API_GET" | "VERIFIED_WEBHOOK";
  };
};

// One row per outbound money-relevant call (create order, authorize, capture, void). Write-ahead.
type PaymentAttempt = {
  id: string;
  transactionId: string;
  action: "CREATE_ORDER" | "AUTHORIZE" | "CAPTURE" | "VOID";
  seq: number; // 1..3; a new seq only after FAILED_DEFINITE
  requestId: string; // PayPal-Request-Id = pp:{tx}:{action}:{seq}; reused on retry of the same attempt
  requestHash: string; // SHA-256 of the canonical request body we sent
  status: "IN_FLIGHT" | "SUCCEEDED" | "FAILED_DEFINITE" | "UNKNOWN";
  tries: number;
  httpStatus?: number;
  paypalDebugId?: string;
  startedAt: string;
  finishedAt?: string;
  // partial UNIQUE (transactionId, action) WHERE status <> 'FAILED_DEFINITE'
};

// Server-side decision record. Every ALLOW/DENY is persisted with its inputs.
type PolicyDecision = {
  id: string;
  subject: "ACCEPT_OFFER" | "CREATE_ORDER" | "AUTHORIZE" | "CAPTURE" | "VOID";
  transactionId?: string;
  agreementId?: string;
  verdict: "ALLOW" | "DENY";
  reasonCodes: string[]; // e.g. OVER_PER_TX_CAP, PAYEE_NOT_ALLOWED, TERMS_HASH_MISMATCH
  inputsHash: string;
  mandateRef: { id: string; version: number };
  decidedAt: string;
};

// Advisory only. Zod-validated model output. Cannot carry authority.
type AgentRecommendation = {
  id: string;
  negotiationId: string;
  agent: "UNSAFE_BASELINE" | "PROTECTED_BUYER" | "SELLER";
  kind: "ACCEPT_OFFER" | "COUNTER" | "REJECT" | "REQUEST_RELEASE" | "REQUEST_VOID" | "NONE";
  offerId?: string; // reference by id; amounts are NOT carried
  rationale: string; // untrusted text, display-only
  modelRef: string;
  fixtureStep?: string; // "scripted:v1/step-3" or LLM model id
};

type AuditEvent = {
  // Implemented shape and hashing: docs/AUDIT_CHAIN.md (hash version 2). Also carried: hashVersion, eventId,
  // transactionId, mandateId/mandateVersion, agreementId/agreementVersion, provenance
  // (OBSERVED_EXTERNAL | LOCAL_DECISION); `payload` is the canonical JSON string.
  seq: number;
  ts: string;
  actor: "OPERATOR" | "AGENT" | "SYSTEM" | "PAYPAL_API" | "PAYPAL_WEBHOOK";
  type: string; // e.g. TX_STATE_CHANGED, POLICY_DENIED, WEBHOOK_REJECTED
  subjectType: string;
  subjectId: string;
  payload: unknown; // redacted: never tokens/secrets
  prevHash: string;
  hash: string; // v2: SHA-256("pactpay.audit.v2
" + canonicalJson(every field except hash, prevHash included))
};

type AttackRun = {
  id: string;
  scenarioId: string;
  fixtureVersion: string;
  seed: string;
  mode: "UNSAFE_BASELINE" | "PROTECTED";
  provider: "SIMULATED" | "PAYPAL_SANDBOX";
  steps: {
    n: number;
    sellerMessageRef: string;
    recommendationId?: string;
    policyDecisionId?: string;
    outcome: "EXECUTED" | "BLOCKED" | "NO_ACTION";
  }[];
  result: {
    moneyMovedMinor: number;
    mandateCapMinor: number;
    capExceeded: boolean;
    invariantsViolated: string[];
  };
  startedAt: string;
  finishedAt?: string;
  auditRange: { fromSeq: number; toSeq: number };
};

// Output of an independent check. Never produced by an agent.
type VerificationResult = {
  id: string;
  kind: "HASH_CHAIN" | "WEBHOOK_SIGNATURE" | "PAYPAL_STATE_RECONCILIATION" | "INVARIANT_SWEEP";
  subjectType: string;
  subjectId: string;
  status: "VERIFIED" | "FAILED" | "UNVERIFIABLE"; // UNVERIFIABLE ≠ VERIFIED (e.g. cert fetch failed)
  detail: unknown;
  checkedAt: string;
};

type WebhookEvent = {
  paypalEventId: string; // UNIQUE → duplicate delivery is a no-op
  eventType: string;
  receivedAt: string;
  rawBodySha256: string;
  verification: "VERIFIED" | "FAILED" | "UNVERIFIABLE";
  processed: boolean;
  outcome?: string;
};
```

Other records: `SellerCatalogEntry` (server-owned seller→payeeRef + SKU price list), `PayoutSimulation` (§8), `RequestDedup` (inbound idempotency).

Relationships: `Mandate(1)─(n)Agreement`; `Offer(1)─(0..1)Agreement`; `Agreement(1)─(1)Transaction`; `Transaction(1)─(≤4)PaymentAttempt`; every state change → `AuditEvent`; `AttackRun` references audit seq range.

## 5. Separating AI recommendations from server-authorized actions

```
 seller msg ─► [AgentModel] ─► AgentRecommendation ─► Zod validate ─► ActionGateway
 (untrusted)   (untrusted)     (advisory data)                        │
                                                                      ├─ load Offer/Agreement/Mandate from DB by id (never from the recommendation)
                                                                      ├─ recompute amounts, hashes
                                                                      ├─ PolicyEngine.evaluate() → PolicyDecision (persisted)
                                                                      ├─ StateMachine.guard(tx, action)
                                                                      └─ ALLOW → mint AuthorizedAction<A> ─► PaymentProvider.A()
```

- **Recommendation types carry ids and prose, not authority.** An `ACCEPT_OFFER` names an `offerId`; the amount, payee, currency and mandate are looked up server-side. A recommendation containing "pay $5,000" has nowhere to put that number.
- **`AuthorizedAction<A>`** is a branded type (`unique symbol`) constructed in exactly one module (`application/action-gateway.ts`) after a persisted `ALLOW`. `PaymentProvider` methods accept only `AuthorizedAction<…>`. Compile-time guarantee + unit test that grepping for the brand constructor finds one site.
- **Human-authority actions** (set/revoke mandate, buyer approval at PayPal, "release funds"/capture confirmation) require an authenticated _operator session_ and a CSRF token; they live on routes the agent code cannot reach (no agent port exposes them). Agent `REQUEST_RELEASE` merely lights up a UI prompt.
- **Protected buyer rule:** even if the model's output says `ACCEPT_OFFER` for an out-of-policy offer, `PolicyEngine` returns `DENY`, the gateway mints nothing, and the denial is audited (this is test AC-P0-04).
- **Void** is risk-reducing. An agent may _request_ it; the server executes only if the state machine guard passes (§ TRANSACTION_STATE_MACHINE G3). It is the only agent-initiated action that can reach PayPal, and it can only reduce exposure.

## 6. Components

| Module                             | Responsibility                                                                                                                                                      | Key rules                                                                                               |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| `domain/money`                     | integer minor-unit arithmetic, currency exponent, decimal-string codec                                                                                              | no floats; overflow guard (`Number.isSafeInteger`)                                                      |
| `domain/canonical`                 | canonical JSON + SHA-256                                                                                                                                            | used for `termsHash`, `contentHash`, audit chain                                                        |
| `domain/policy`                    | `evaluatePolicy(input) → PolicyDecision` — **implemented**, see [POLICY_ENGINE.md](POLICY_ENGINE.md); not yet wired                                                 | pure, total, fully unit-tested incl. property tests                                                     |
| `domain/transaction`               | state machine: `transition(tx, event) → tx'` or typed error                                                                                                         | table-driven; illegal transitions impossible                                                            |
| `application/action-gateway`       | the only mint of `AuthorizedAction`                                                                                                                                 | persists decision before minting                                                                        |
| `application/transaction-service`  | orchestrates: guard → write-ahead attempt → provider call → observe → persist in one DB txn                                                                         | `BEGIN IMMEDIATE`; CAS on `tx.version`                                                                  |
| `application/webhook-service`      | verify → dedupe → **pull-confirm via GET** → transition                                                                                                             | webhook alone never moves money state                                                                   |
| `application/verification-service` | hash-chain verify, invariant sweep, reconciliation                                                                                                                  | writes `VerificationResult`                                                                             |
| `application/attack-runner`        | runs scenario fixture against baseline and protected pipelines                                                                                                      | deterministic, seedable                                                                                 |
| `adapters/paypal`                  | OAuth (server-only), Orders/Payments calls, error mapping                                                                                                           | refuses to start unless `PAYPAL_ENV=sandbox` and base URL is `api-m.sandbox.paypal.com`; redacts tokens |
| `adapters/simulated-ledger`        | in-memory/SQLite fake PayPal for baseline + CI; output labeled `SIMULATED`                                                                                          | different class/brand from the real adapter; never reports as PayPal                                    |
| `adapters/sqlite`                  | persistence with constraints (§7)                                                                                                                                   | all money columns INTEGER                                                                               |
| `agents/*`                         | seller and buyer agents, runtime, deterministic mocks, orchestrator — **implemented**, see [AGENTS.md](AGENTS.md); the unsafe baseline and a live LLM are not built | untrusted output, Zod-validated                                                                         |
| `application/negotiations`         | negotiation, versioned offers and counter-offers, agreement versions — **implemented**, see [NEGOTIATION.md](NEGOTIATION.md)                                        | every acceptance goes through `domain/policy`; an approval belongs to one agreement version             |
| `web/*`                            | Arena UI, routes, SSE event feed                                                                                                                                    | status text only from server state (§9)                                                                 |

### Routes (all Zod-validated; mutation routes require operator session + CSRF; inbound `Idempotency-Key`)

`POST /api/arena/runs` · `GET /api/arena/runs/:id/stream` (SSE) · `POST /api/mandates` (operator) · `POST /api/transactions/:id/release` (operator → capture) · `POST /api/transactions/:id/void` · `GET /api/paypal/return` (untrusted redirect; only triggers a server-side GET confirm) · `POST /api/webhooks/paypal` · `POST /api/verify/chain` · `GET /api/audit`.

## 7. Persistence (SQLite)

> Implemented: see [DATABASE.md](DATABASE.md) for the real schema, commands, and the deliberate deviations from the sketch below (notably: a transaction starts in `NEGOTIATING` with no agreement, and mandate revocation is a new version row).

Tables: `mandates`, `offers`, `agreements`, `transactions`, `payment_attempts`, `policy_decisions`, `agent_recommendations`, `audit_events`, `attack_runs`, `verification_results`, `webhook_events`, `request_dedup`, `payout_simulations`, `seller_catalog`.

Constraints that carry security weight (enforced by DB, not just code):

- `UNIQUE(agreements.offer_id)`, `UNIQUE(transactions.agreement_id)`.
- Partial `UNIQUE(payment_attempts.transaction_id, action) WHERE status <> 'FAILED_DEFINITE'` → at most one live (in-flight, succeeded, or unknown) authorize, capture, and void per transaction; a retry is possible only after a _definite_ failure (max 3 attempts per action).
- `UNIQUE(webhook_events.paypal_event_id)`.
- `UNIQUE(request_dedup.idempotency_key)` storing the request hash; same key with different body → 422.
- `audit_events` is insert-only (trigger rejects UPDATE/DELETE); `seq` monotonic.
- `CHECK(amount_minor >= 0)`; all money columns `INTEGER`.
- `mandates` insert-only (trigger rejects UPDATE of money fields); new version = new row.

A state change, its `AuditEvent`, and the `PaymentAttempt` row are written in **one DB transaction** (`BEGIN IMMEDIATE`). The remote PayPal call happens _between_ two such transactions (write-ahead "IN_FLIGHT", then record the outcome) — never inside an open DB transaction.

**Hash chain scope (honest limit):** it makes the _local_ log tamper-evident to someone who can edit the DB but not to someone who can rewrite the whole chain. It is **not** proof of external authenticity, and **not a digital signature** (no key is involved). Removal of the newest events, or a rewrite of the whole chain, is only detectable against a head-hash anchor kept elsewhere (supported by `verifyChain`, not automated). Details: [AUDIT_CHAIN.md](AUDIT_CHAIN.md). External evidence = PayPal ids confirmed by authenticated GETs and verified webhooks.

## 8. Payout (simulation only)

After `CAPTURED`, an operator may click "Release to seller (simulated)". It writes a `PayoutSimulation` row with `isSimulated: true`, rendered with a permanent "SIMULATED — no PayPal payout was made" badge and never joined into "paid" metrics. Rationale: V9 (no platform split) and A8 (Payouts access unconfirmed). Real Payouts = P2, a separate adapter, separate state machine, never implied by capture.

## 9. Status honesty (UI contract)

The UI renders status solely from `Transaction.state` + `lastObservedPayPal`:

| Internal state                                               | Label                                    | Style                  |
| ------------------------------------------------------------ | ---------------------------------------- | ---------------------- |
| `CAPTURED` (capture status `COMPLETED` observed from PayPal) | "Paid (PayPal Sandbox)" + capture id     | success                |
| `CAPTURE_PENDING`                                            | "Pending at PayPal — not confirmed"      | warning                |
| `NEEDS_RECONCILIATION`                                       | "Status unknown — verifying with PayPal" | warning                |
| `AUTHORIZED`                                                 | "Funds on hold (not charged)"            | info                   |
| `FAILED`, `REJECTED`, `VOIDED`, `CANCELLED`                  | specific text                            | neutral/danger         |
| any simulated provider                                       | prefix "SIMULATED"                       | distinct color + badge |

An LLM response, an HTTP 2xx from our own API, a redirect to `/return`, or a webhook alone **never** produces the "Paid" label.

## 10. Configuration & secrets

Env (names only; `.env.example` holds placeholders; `.env*` gitignored): `PAYPAL_ENV` (must be `sandbox`), `PAYPAL_CLIENT_ID`, `PAYPAL_CLIENT_SECRET`, `PAYPAL_WEBHOOK_ID`, `APP_BASE_URL`, `DATABASE_PATH`, `OPERATOR_PASSCODE`, `ANTHROPIC_API_KEY` (optional), `AGENT_MODE=scripted|llm`. Secrets are read only in server-only modules (`import "server-only"`), never prefixed `NEXT_PUBLIC_`, never logged; the logger redacts `authorization`, `access_token`, `client_secret`. App refuses to boot if a live-looking base URL or credential prefix is detected.

## 11. Key decisions and trade-offs

| Decision                                                         | Why                                                | Cost                                                                                                    |
| ---------------------------------------------------------------- | -------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| authorize→capture/void (not `intent=CAPTURE`)                    | Demonstrates a safe release gate; void exists      | Honor period (3d) handled by local clock; reauth out of scope; buyer approval is manual in sandbox (A5) |
| Unsafe baseline is simulation-only                               | Safety invariant + no accidental real spend        | Left panel doesn't show real PayPal; clearly labeled                                                    |
| Webhooks corroborate, GET confirms                               | A signature-verification bug can't move state      | One extra API call per event                                                                            |
| Explicit in-flight states (`AUTHORIZING`…)                       | Duplicate requests blocked by state CAS; UI honest | More states (18) but table-driven                                                                       |
| One live attempt per (tx, action), stable request id per attempt | Stable idempotency keys; DB-level uniqueness       | No partial/multi capture or reauth in MVP                                                               |
| Sellers are logical, one real sandbox merchant                   | A4/V9 limits                                       | "Altered payee" attack demonstrated at catalog/policy layer, not by routing real funds elsewhere        |
| SQLite on a persistent-disk host                                 | Zero-ops, transactions, constraints                | Not serverless-friendly (A9)                                                                            |
| Scripted fixtures first, LLM optional                            | Deterministic replay, no API key needed            | LLM mode is a bonus, not a dependency                                                                   |

## 12. 32-day delivery plan (scope-budgeted)

| Days  | Deliverable                                                                                                                                        | Gate                                                             |
| ----- | -------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| 1–3   | Scaffold; `node:sqlite` spike (A10); **PayPal smoke test: token + create order (A1, A4)**; host decision (A9); `money`, `canonical`, `audit` chain | `typecheck/lint/test/build` green; smoke-test evidence           |
| 4–7   | `mandate`, `offer`, `agreement`, `policy`, state machine tables + property tests                                                                   | AC-P0-01, 02, 06, 07 pass                                        |
| 8–10  | SQLite store + constraints; `ActionGateway`; `TransactionService`; `SimulatedLedger`                                                               | AC-P0-03, 09, 10, 15 on simulated provider                       |
| 11–14 | Agent schemas, scripted seller/buyer, unsafe baseline, protected buyer, attack scenarios S1–S9                                                     | baseline loses cap, protected holds (AC-P0-04, 05, 14)           |
| 15–19 | PayPal adapter: authorize, capture, void, GET reconcile; manual buyer approval; evidence run (A2, A3, A5)                                          | one real sandbox transaction + one void (AC-P0-08, 13; AC-P1-04) |
| 20–24 | Arena UI (split screen, replay, SSE), status-honesty labels, audit viewer, payout simulation                                                       | AC-P0-11, 12, 16; **scope cut line**                             |
| 25–27 | Verified webhooks, dedupe, pull-confirm, reconciliation worker, abuse limits; public HTTPS deploy                                                  | AC-P0-17; AC-P1-01..03, 08, 09                                   |
| 28–29 | Adversarial benchmark runner, AG Grid Community analytics, hash-chain verify UI                                                                    | AC-P1-05..07                                                     |
| 30–31 | README, demo script, recorded fallback video, polish, security re-read                                                                             | AC-DOC-01..04                                                    |
| 32    | Freeze + buffer. P2 (real Payouts, AG Studio) only if everything above is green                                                                    | —                                                                |

**Cut line:** if behind at day 20, drop (in order) AG Grid analytics → benchmark UI → live-LLM mode → SSE (use polling). The P0 path (policy, state machine, one real sandbox transaction, Arena, audit) is never cut. **Day-3 risk gate:** if the PayPal smoke test fails for permission reasons, fall back to the `SimulatedLedger` as the "settlement" in the demo, state this plainly in all docs, and keep working on independent modules.
