# PactPay Arena — Database

SQLite through Node's built-in `node:sqlite` (no native build, no extra dependency). Verified on Node 24.18 / SQLite 3.53.1: under Vitest, under the native-TypeScript CLI, and under the Next.js production server (the A10 assumption in [ARCHITECTURE.md](ARCHITECTURE.md) is resolved).

The schema is the last line of defence, not the first. Business rules live in the policy engine ([POLICY_ENGINE.md](POLICY_ENGINE.md), built and tested but not yet wired into any flow) and the state machine; the database makes sure that **a bug in them cannot persist an invalid state**. What the database can and cannot enforce is listed explicitly in §6.

## 1. Setup and commands

Requires Node ≥ 22.12 (the repo pins 24 in `.nvmrc`). No `.env` is needed; the default path is `./data/pactpay.db` (git-ignored). Override it with `DATABASE_PATH`.

```bash
npm run db:migrate           # create the file if needed and apply pending migrations
npm run db:seed              # synthetic development data (idempotent; refuses NODE_ENV=production)
npm run db:status            # applied/pending migrations, foreign_key_check, audit-chain verification
npm run db:reset -- --yes    # DELETE the database file (+ -wal/-shm); refuses paths outside the project
```

These run `node scripts/db.ts …` on Node's native TypeScript support (no build step, no `tsx`). The CLI reads `.env.local`/`.env` if present, validates the environment with the same Zod schema as the app (so `PAYPAL_ENV=live` is refused), and never prints secrets.

`GET /api/health` reports `database.state`: `uninitialized` (no file, or no migrations yet), `ready` (with migration count and latest name), or `error`. The probe is read-only: it never creates the file and never returns a path or error text.

### Adding a migration

1. Create `src/adapters/sqlite/migrations/NNNN_short_name.sql` (next number, contiguous, lowercase `a-z0-9_`).
2. Never edit an applied migration: each file's SHA-256 is recorded in `schema_migrations`, and `migrate`/`status` fail loudly on a mismatch, a gap, or a missing file.
3. Each migration runs in its own transaction; a failure rolls it back completely and records nothing.
4. The state tables are read-only at runtime. To change legal transitions: update `src/domain/transaction-states.ts`, add a migration that drops the `*_readonly_*` triggers, edits the rows, and recreates them. A test fails if the domain table and the database table ever disagree.

## 2. Tables and relationships

```
sellers ──< seller_catalog_items
   ▲
   │ (allowed_seller_ids, JSON, validated by trigger)
mandates (id, version) ◄──────────────┐  immutable; a change or revocation = new version row
   ▲   ▲                              │
   │   └────────── policy_decisions ◄─┼──────────┐
   │                    ▲             │          │
transactions ──< offers ──< offer_lines          │
 (pins mandate id+version)  │  (immutable terms) │
   │   ▲                    └── agreements ──────┘  (frozen contract; 1 per offer, 1 per transaction)
   │   └───────────────────────────┘
   ├──< payment_attempts   (write-ahead outbound PayPal calls)
   └──< audit_events       (append-only hash chain; every state change cites one)

attack_runs ──< attack_run_steps ──> agent_recommendations (advisory)      idempotency_keys (inbound)
tx_states / tx_transitions / reconcile_targets  (read-only reference tables)    schema_migrations
```

| Table                                                      | Purpose                                                                                                                                                                                     |
| ---------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `mandates`                                                 | The user's approved policy: per-transaction cap, total budget, currency, seller allow-list, expiry. Identity `(id, version)`.                                                               |
| `sellers`, `seller_catalog_items`                          | Synthetic seller identities, their `payee_ref` (a catalog key, never a PayPal credential) and prices.                                                                                       |
| `transactions`                                             | One negotiation→payment lifecycle. State, optimistic-concurrency `version`, pinned mandate `(id, version)`, PayPal object ids, authorized/captured amounts, honor window, `last_event_seq`. |
| `offers`, `offer_lines`                                    | Seller proposals. Untrusted text, immutable terms, revisions numbered per transaction.                                                                                                      |
| `policy_decisions`                                         | Every ALLOW/DENY with reason codes and an `inputs_hash`.                                                                                                                                    |
| `agreements`                                               | The frozen contract: the only source of amount, currency and payee for payment.                                                                                                             |
| `payment_attempts`                                         | One row per outbound call, written _before_ the call. Holds the derived `PayPal-Request-Id`.                                                                                                |
| `audit_events`                                             | Append-only, hash-chained event log (event id, transaction id, mandate/agreement versions, provenance; [AUDIT_CHAIN.md](AUDIT_CHAIN.md)).                                                   |
| `attack_runs`, `attack_run_steps`, `agent_recommendations` | Arena runs, per-step outcomes, and advisory agent output (ids and prose only, no amounts).                                                                                                  |
| `idempotency_keys`                                         | Inbound `Idempotency-Key` bookkeeping.                                                                                                                                                      |
| `tx_states`, `tx_transitions`, `reconcile_targets`         | The state machine as data (read-only).                                                                                                                                                      |
| `mandate_drafts`                                           | The only mutable place a mandate is edited (migration 0005). One open draft per mandate; approving it creates the next immutable version. See [MANDATE.md](MANDATE.md).                     |
| `service_categories`                                       | Closed, read-only list of service categories (mirrors `src/domain/mandate.ts`).                                                                                                             |
| `transaction_approvals`                                    | The operator's APPROVED/REJECTED decision on an AGREED transaction; the schema blocks execution without it when the pinned mandate requires approval.                                       |

## 3. How each requirement is met

| Requirement                                    | Mechanism                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| ---------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Stable identifiers, explicit relationships** | Text primary keys (≤ 64 chars, non-empty, NOT NULL), composite `(mandate_id, mandate_version)` foreign keys, `PRAGMA foreign_keys = ON` verified at connection time, `foreign_key_check` after every migration run and in `db:status`. Nothing that others depend on can be deleted (no-delete triggers; FKs).                                                                                                                                                                                                                                                                                                                                           |
| **Integer minor units**                        | Every `*_minor` column is `INTEGER` in a `STRICT` table with `CHECK (typeof(x) = 'integer' AND x >= 0 AND x <= 9007199254740991)`. Floats and text are rejected by the engine; the TS layer (`assertMinor`) rejects them first. No floating point anywhere: totals are summed in code with overflow checks, and re-checked in SQL.                                                                                                                                                                                                                                                                                                                       |
| **Explicit currency**                          | A 3-letter uppercase `currency` column next to every table that holds money (a test asserts this for the whole schema). Cross-table triggers require offer lines = offer currency, agreement = offer = mandate currency, transaction = mandate currency.                                                                                                                                                                                                                                                                                                                                                                                                 |
| **Mandate versioning**                         | `mandates` is insert-only; versions must be contiguous (`version = previous + 1`); a revocation is a new row and is final. A transaction pins the exact `(id, version)` that was latest, ACTIVE and unexpired when it started and keeps it forever. Creating a transaction or agreement requires the _latest_ ACTIVE version, so a newer version or a revocation stops in-flight negotiations.                                                                                                                                                                                                                                                           |
| **Constrained transitions**                    | A `BEFORE UPDATE` trigger on `transactions` accepts a state change only if `(OLD.state, NEW.state)` is in `tx_transitions` (39 edges, mirrored from `src/domain/transaction-states.ts` and checked by a test). Terminal states have no outgoing edges. `NEEDS_RECONCILIATION` must come from an in-flight state, records which, and can only resolve to the targets allowed for it (`reconcile_targets`). `version` must grow by exactly 1; `state`/amount/PayPal-id `CHECK`s keep data consistent with the state (e.g. `AUTHORIZED` requires an authorization id, an amount equal to the agreement total, and a honor window).                          |
| **Idempotency / uniqueness**                   | `UNIQUE(agreements.offer_id)`, `UNIQUE(transactions.agreement_id)`, `UNIQUE(agreements.policy_decision_id)`, unique PayPal order/authorization/capture ids, `UNIQUE(offers.transaction_id, revision)`, `UNIQUE(audit_events.hash)`, `UNIQUE(payment_attempts.request_id)`, and a **partial unique index** allowing at most one live (non-`FAILED_DEFINITE`) attempt per `(transaction, action)`. The `PayPal-Request-Id` is a function of the row (`pp:{tx}:{action}:{seq}`, enforced by a CHECK). Retrying an `UNKNOWN` attempt reuses the same id and increments `tries`. `idempotency_keys` + `claimIdempotencyKey()` give `NEW`/`REPLAY`/`CONFLICT`. |
| **Timestamps and traceable references**        | All timestamps are ISO-8601 UTC text, validated by a GLOB check and supplied by the application clock (no DB defaults, so tests control time). Every state change must cite a _newer_ `TX_STATE_CHANGED` audit event for the same transaction (`transactions.last_event_seq`, checked by trigger). Decisions, attempts, recommendations and runs reference their transaction/offer/run/audit range by foreign key.                                                                                                                                                                                                                                       |
| **Synthetic seed data**                        | `seedDevelopment()` inserts two made-up sellers, three catalog items and mandate `M1` ($100 cap / $150 budget, one allowed seller, owner `demo_operator`). A test asserts the seed contains no emails, URLs, credentials or PayPal identifiers. It matches the Arena fixtures.                                                                                                                                                                                                                                                                                                                                                                           |
| **No secrets**                                 | No column can hold one (a test scans every column name for secret-like words). `payment_attempts` stores only ids, hashes, statuses. `appendAuditEvent` refuses payloads with secret-looking keys (`client_secret`, `access_token`, `password`, `authorization`, `api_key`, `card_number`, …). PayPal credentials stay in environment variables, never in the database.                                                                                                                                                                                                                                                                                  |

## 4. Negotiation rules enforced in the schema

- Offers can only be added while the transaction is `NEGOTIATING`, so **a seller "revision" after agreement cannot be stored** (the altered-terms attack); an offer's terms are immutable and only its status can change, once.
- An agreement is derived from stored rows (offer total, catalog `payee_ref`, terms hash, pinned mandate). The insert trigger re-checks: the offer is OPEN, `terms_hash` and total match the offer, the total equals `Σ qty × unit price + shipping + fees`, the payee comes from the seller catalog, the seller is on the mandate allow-list, the total is within the per-transaction cap, the mandate is the latest ACTIVE unexpired version, and the policy decision is an `ALLOW` for `ACCEPT_OFFER` on the same transaction and mandate version.
- `payment_attempts` can only be inserted when the transaction is already in the matching in-flight state (`CREATE_ORDER`↔`CREATING_ORDER`, `AUTHORIZE`↔`AUTHORIZING`, `CAPTURE`↔`CAPTURING`, `VOID`↔`VOIDING`).
- `attack_runs`: the unsafe baseline can only be `SIMULATED` and can never reference a transaction (`CHECK`), `cap_exceeded` is a generated column, and a `BLOCKED` step must cite a `DENY` decision.

## 5. Store functions (`src/adapters/sqlite/store.ts`)

Typed primitives the application layer will call (a `Store` port will be extracted when that layer exists). Highlights:

- `transitionTransaction` — the only way to change state: compare-and-swap on `version` (`StaleVersionError`), one audit event, and the update, all in one `BEGIN IMMEDIATE` transaction. Illegal moves roll everything back, including the audit event.
- `acceptOffer` — creates the agreement from the offer + decision, marks the offer `ACCEPTED`, moves the transaction `NEGOTIATING → AGREED`, atomically.
- `insertOffer` — computes the server total and terms hash itself; the seller's claimed total is stored for audit only.
- `startPaymentAttempt` / `finishPaymentAttempt` / `retryPaymentAttempt`, `claimIdempotencyKey`, `createAttackRun` / `addAttackStep` / `finishAttackRun`, `recordPolicyDecision`, `recordRecommendation`, `insertMandateVersion`, `createTransaction`.
- `appendAuditEvent` / `verifyChain` (`audit.ts`).

Never call a remote service inside `inTransaction`; the pattern is _commit write-ahead row → call PayPal → commit outcome_.

## 6. Limits — what the database does not guarantee

- **Policy.** The schema re-checks cap, currency, payee, seller allow-list and totals as a backstop, but the policy engine remains the source of truth. **Cumulative budget** (`exposure ≤ total_budget` across transactions) is _not_ enforced by the database; the policy engine computes it (a test shows two agreements that together exceed the budget are accepted by the schema and denied by the engine), but it is not yet called from a live path.
- **Guards G0–G3** (fresh PayPal `GET`s, honor-window checks, operator-only release) are application logic, not schema.
- **Audit chain.** The database enforces gap-free `seq` and `prev_hash` linkage, append-only rows, a unique event id, hash version 2 for every new row, and that only a PayPal actor can record an `OBSERVED_EXTERNAL` event; the application computes SHA-256 over a canonical serialization of every field and `verifyChain()` recomputes it, reporting the first invalid event. Rows written before migration 0008 keep hash version 1 and are verified under their original form. Format, verification codes and threat model: [AUDIT_CHAIN.md](AUDIT_CHAIN.md). It is a hash chain, **not a digital signature**, and it is **local tamper-evidence only**: someone who can rewrite the file _and_ recompute every later hash will pass verification (a test demonstrates it), and it proves nothing about external authenticity. A privileged writer can also `DROP TRIGGER`; verification then catches partial edits (also tested).
- **Triggers are not an access-control system.** Anyone with write access to the file can bypass them. Production would add file permissions and an out-of-band copy of the chain head.
- **Single writer.** SQLite serialises writers (`BEGIN IMMEDIATE`, 5 s busy timeout). Fine for the demo; requires a persistent disk (serverless hosts with ephemeral disks are not suitable — assumption A9).
- **Tables not yet created** (later work, new migrations): `webhook_events`, `verification_results`, `payout_simulations`.
- Whole-system correctness against PayPal (statuses, amounts) is untested here; no PayPal call exists yet.

## 7. Deviations from ARCHITECTURE.md (deliberate)

| Architecture doc                                                   | This implementation                                                                                                                                                                                    | Why                                                                                                                               |
| ------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------- |
| Transaction is created with an `agreementId`                       | Transaction is created in `NEGOTIATING` with `agreement_id` NULL; the agreement attaches on `NEGOTIATING → AGREED`. `offers.transaction_id` replaces `negotiationId` (negotiation id = transaction id) | `NEGOTIATING` and `REJECTED` are real states before any agreement exists, so a NOT NULL agreement would make them unrepresentable |
| `Mandate.allowedSellerIds`                                         | JSON array column validated by trigger, inside the immutable row (and its content hash)                                                                                                                | A join table could be altered after the fact; the array cannot                                                                    |
| Mandate revocation as a status flip                                | Revocation is a new, final version row                                                                                                                                                                 | Preserves "mandate rows are never updated"                                                                                        |
| `AgentRecommendation.transactionId` required                       | Optional, with an `attack_run_id` alternative (at least one)                                                                                                                                           | The unsafe baseline has no transaction by design                                                                                  |
| `offer_lines` without currency                                     | Explicit `currency`, must equal the offer's                                                                                                                                                            | Every money-bearing row has its own currency                                                                                      |
| Audit hash = `SHA-256(canonicalJSON(event minus hash) ‖ prevHash)` | `SHA-256(canonicalJSON(event minus hash))` where the event already includes `prevHash`                                                                                                                 | Equivalent chaining, one input                                                                                                    |

## 8. Tests

`npm test` runs 511 tests (persistence, mandates, UI and domain suites), all on in-memory databases except the CLI and health tests, which use temp files. Coverage: migration runner (idempotency, tamper/gap/removal detection, rollback of a failing migration), schema invariants (STRICT, integer money, currency pairing, no secret-like columns, state tables identical to the domain), per-table validation (invalid values, missing references, duplicate identifiers, immutability), the full state machine (legal paths, illegal shortcuts, reconciliation rules, CAS, audit linkage), agreements, payment attempts, idempotency keys, the audit chain (including tamper cases), attack runs, the seed, the CLI as a real subprocess, and the health probe. Deliberate weakening of four constraints during development was caught by the suite each time.

## 9. Mandate policy (migration 0005)

The fifth migration adds the financial-mandate feature to the schema; the rules themselves are specified in [MANDATE.md](MANDATE.md).

- **`mandates`** gains `allowed_categories` (JSON array of supported categories), `approval_threshold_minor`, `require_review` and `source_draft_id`, all immutable like the rest of the row. New rows must have at least one supported category and a threshold not above the per-transaction cap. Rows created before the migration receive the **safest defaults** (no allowed categories, threshold 0, review required), so they fail closed; a test migrates the old schema, inserts a legacy row, upgrades, and checks this.
- **`mandate_drafts`** holds the only mutable mandate state, with an optimistic `revision`, a partial unique index (one open draft per mandate), and triggers: new drafts must be based on the latest ACTIVE version, only an open draft can change, and a draft can become APPROVED only when a mandate version created _from that draft_ matches it field for field. A version with `source_draft_id` must itself match its draft exactly.
- **`seller_catalog_items.category`** and **`offer_lines.category`**: a line's category is copied from the catalog and the database refuses a spoofed one. An `agreements` trigger requires every line to be in a category the pinned mandate allows; an unknown SKU has no category and can never be agreed.
- **`transaction_approvals`** plus the **`transactions_approval_gate`** trigger: `AGREED → CREATING_ORDER` requires an APPROVED decision when the _pinned_ mandate has `require_review = 1` or the agreement total is **above** its threshold (equal does not need approval).
- Audit events added: `MANDATE_DRAFT_CREATED`, `MANDATE_DRAFT_UPDATED`, `MANDATE_DRAFT_DISCARDED`, `MANDATE_APPROVED`, `MANDATE_REVOKED`, `TX_APPROVAL_RECORDED` (payloads carry the operator id, never secrets).
- Port and adapter: `src/ports/mandate-store.ts` (`MandateStore`) with `src/adapters/sqlite/mandate-store.ts`; the application layer depends only on the port.

## 10. Negotiation workflow (migration 0006)

The sixth migration adds the negotiation and agreement workflow; the rules are specified in [NEGOTIATION.md](NEGOTIATION.md). The core tables (`transactions`, `offers`, `agreements`, `transaction_approvals`, `policy_decisions`) are reused unchanged for the executable part of a deal.

- **`negotiations`**: the buyer's request and constraints (immutable), the timeout (`expires_at`), and a status that can only move along `OPEN → AGREED | REJECTED | TIMED_OUT | CANCELLED` and `AGREED → OPEN | CANCELLED` (a closure needs a reason; versions grow by exactly 1; never deleted).
- **`negotiation_proposals`**: every seller offer and buyer counter-offer, as an immutable version. Triggers require: an `OPEN`/`AGREED` negotiation and an invited seller; gap-free `seq` per negotiation; contiguous `version` per (negotiation, seller, kind) with `supersedes_id` pointing at the previous one; and **`payee_ref` equal to the seller's catalog payee** at insertion. Only the status may change, once, from `OPEN` to a final value with a decision time; only an offer can become `ACCEPTED`. An offer has lines and a claimed total; a counter-offer has neither (and no shipping or fees). Money columns are `STRICT` integers with an explicit `currency`.
- **`negotiation_agreements`**: agreement versions 1, 2, 3… linking an `ACCEPTED` offer (hash must match) to the core transaction and agreement it created (total, currency and payee must match). A partial unique index allows **one `ACTIVE` version per negotiation**; retiring one records the reason, the proposal that replaced it, and whether an approval was on file. A retired version can never return to `ACTIVE`.
- **`negotiation_policy_checks`**: every policy evaluation for the workflow (`ACCEPT_OFFER`, `CREATE_ORDER`), allowed or refused, with reason codes (an ALLOW has none, a DENY at least one), the policy version and the input hash. Append-only.
- Audit events added: `NEGOTIATION_OPENED`, `NEGOTIATION_STATUS_CHANGED`, `OFFER_RECORDED`, `COUNTER_RECORDED`, `PROPOSAL_STATUS_CHANGED`, `POLICY_ALLOWED`, `POLICY_DENIED`, `AGREEMENT_CREATED`, `AGREEMENT_RETIRED`.
- Port and adapter: `src/ports/negotiation-store.ts` (`NegotiationStore.transaction(fn)`: atomic and synchronous, so the policy input is read and acted on in one transaction) with `src/adapters/sqlite/negotiation-store.ts`.
- **Not enforced by the schema:** that an offer passed the policy engine's _full_ rule set (only the money-critical subset is re-checked at agreement creation; the engine is the authority); that a proposal's category claim matches the catalog; seller authenticity.
