# PactPay Arena — Financial Mandate

A **mandate** is the budget and rules every purchase must follow. Only the human operator can create, approve or revoke one. AI agents can do none of that, and the server (not the interface) enforces it. This document is the exact specification; each rule names where it is enforced and which test proves it.

Code: pure rules in `src/domain/mandate.ts`; use cases in `src/application/mandates.ts`; operator session in `src/application/operator-session.ts`; HTTP in `src/app/api/{operator,mandates}/**`; UI in `src/app/mandate/`; schema in migration `0005_mandate_policy.sql`.

## 1. Fields

| Field (API)                    | Type on the wire   | Meaning                                                                                      |
| ------------------------------ | ------------------ | -------------------------------------------------------------------------------------------- |
| `currency`                     | string             | One of `USD`, `EUR`, `GBP`, `JPY` (uppercase). Fixes the number of decimals of every amount. |
| `totalBudget`                  | **decimal string** | The most that can be spent across all transactions under this mandate.                       |
| `maxTransactionAmount`         | decimal string     | No single transaction may exceed this (stored as `per_tx_cap_minor`).                        |
| `approvalThreshold`            | decimal string     | A transaction **above** this amount needs human approval before execution.                   |
| `requireReviewBeforeExecution` | boolean            | When `true`, **every** transaction needs human approval, whatever its amount.                |
| `allowedCategories`            | string[]           | Service categories that may be bought (§2.4).                                                |
| `allowedSellerIds`             | string[]           | Sellers that may be paid; each must exist.                                                   |
| `validDays`                    | integer            | Validity from approval, 1–365 days. The version stores the absolute `expiresAt`.             |

Not accepted from any client: `status`, `version`, `createdBy`, `approved`, `id`, `mandateId`, `contentHash`, `actor`, or anything else not listed. Unknown keys are rejected with an error naming them (they cannot be smuggled in).

## 2. Exact validation rules (server-authoritative)

The same pure function (`validateMandateInput`) runs in the browser for instant hints and on the server as the authority. It collects **all** problems at once and never throws.

### 2.1 Money is a decimal string, never a number

Grammar: `^(0|[1-9][0-9]*)(\.[0-9]+)?$`, ASCII only, at most 24 characters. Rejected, with a specific message: negatives (`-1`, `-0`), `+5`, exponents (`1e3`), separators (`1,000.00`, `1,5`), spaces, `10.`, `.5`, leading zeros (`007`), hex, `NaN`/`Infinity`, currency symbols, non-ASCII digits, empty, and **JSON numbers of any kind** (`100`, `0.1`). It never rounds: more decimals than the currency allows is an error (`10.999` and `0.001` in USD; any `.` in JPY).

Conversion uses `BigInt`: `"0.10"` is exactly 10 minor units, with no floating point anywhere. Values above `Number.MAX_SAFE_INTEGER` minor units (90,071,992,547,409.91 USD) are rejected. Amounts leave the system as integer minor units (database `INTEGER`, `STRICT`, `typeof = 'integer'` checks) and are formatted back with `BigInt` (`formatMinor`).

| Currency      | Decimals | Example valid            | Example invalid        |
| ------------- | -------- | ------------------------ | ---------------------- |
| USD, EUR, GBP | 2        | `100`, `100.5`, `100.50` | `100.505`, `-1`, `1e2` |
| JPY           | 0        | `5000`                   | `5000.0`, `5000.5`     |

Currency support in PayPal Sandbox is **unverified** per currency; only USD is exercised in the demo.

### 2.2 Cross-field rules

1. `totalBudget > 0` and `maxTransactionAmount > 0`.
2. `maxTransactionAmount ≤ totalBudget` (one cent over is rejected).
3. `0 ≤ approvalThreshold ≤ maxTransactionAmount` (a threshold above the maximum could never trigger; `0` means everything needs approval).

### 2.3 Approval rule

`approvalRequirement(terms, total)`:

| Condition                                          | Result                                                               |
| -------------------------------------------------- | -------------------------------------------------------------------- |
| `requireReviewBeforeExecution = true`              | `REVIEW_REQUIRED` for every amount (the threshold no longer matters) |
| `total > approvalThreshold`                        | `ABOVE_THRESHOLD`                                                    |
| otherwise (including `total == approvalThreshold`) | `NOT_REQUIRED`                                                       |

Example with threshold 90.00 USD: 89.99 → not required, **90.00 → not required**, 90.01 → required.

### 2.4 Categories and sellers

- Categories are a closed server-owned list: `COMPUTE`, `STORAGE`, `DATA`, `SOFTWARE`, `DESIGN`, `CONSULTING`. At least one, no duplicates, none unsupported (the error lists exactly which).
- Sellers: 1–20 ids matching `^[a-z0-9_]{1,64}$`, unique, and all must exist (checked by the service and by the database).
- A line's category comes from the **seller catalog**, never from the offer. A line whose SKU is not in the catalog has no category and can never be agreed.

## 3. Drafts, versions and what can change

```
 (nothing) ──create──▶ DRAFT ──edit (revision+1)──▶ DRAFT ──approve──▶ APPROVED (final)
                          │                                   │
                          └────────discard──────▶ DISCARDED   └─ creates mandate version N+1 (ACTIVE, immutable)
 mandate version N (ACTIVE) ──revoke──▶ version N+1 (REVOKED, final)
```

- A **draft** is the only mutable record. It lives in `mandate_drafts` with an optimistic `revision`. It has no foreign key from any transaction, so **editing a draft cannot change any approved mandate or any transaction**.
- **Approving** a draft atomically inserts the next version and closes the draft. The database requires that version to match its draft exactly (every field), and the draft can only become APPROVED pointing at that version.
- **Approved versions are immutable**: triggers reject any `UPDATE`/`DELETE`. "Editing" an approved mandate means a new draft based on its latest version.
- One open draft per mandate. A draft must be based on the **latest ACTIVE** version; if the mandate changed meanwhile (new version or revocation), approval is refused with a conflict and the operator starts a new draft.
- **Revocation** adds a final `REVOKED` version. A revoked mandate cannot be edited again; create a new mandate.
- A **transaction pins** the exact `(mandate id, version)` that was latest, ACTIVE and unexpired when it started, forever. Consequences, all enforced in the schema and tested:
  - Approving or editing never rewrites a started transaction's rules (its pinned version row is unchanged).
  - A negotiation still open on an older version **cannot become an agreement** (the agreement must use the latest ACTIVE version); it fails closed and must start again.
  - The human-approval gate reads the **pinned** version, so a later, laxer version cannot unlock a transaction.
- Every create, edit, discard, approval and revocation writes an `audit_events` row with the operator id, in the same database transaction.

## 4. Human approval gate

`transactions_approval_gate` blocks `AGREED → CREATING_ORDER` (the first step that can move money) unless an `APPROVED` row exists in `transaction_approvals` whenever the pinned mandate has `require_review = 1` or the agreement total is above its threshold. A `REJECTED` decision never unlocks it. Approvals can only be recorded for an `AGREED` transaction, once, with `decided_by = 'OPERATOR'`, and are immutable.

**Not built yet:** a UI or API for the operator to approve a specific transaction (there are no real transactions in the UI yet). The rule, the store function (`recordTransactionApproval`) and the database gate exist and are tested.

## 5. Who may do what (authority)

| Actor                      | View | Create/edit draft | Approve | Discard | Revoke |
| -------------------------- | ---- | ----------------- | ------- | ------- | ------ |
| Human operator (signed in) | ✓    | ✓                 | ✓       | ✓       | ✓      |
| AI agent                   | ✗    | ✗                 | ✗       | ✗       | ✗      |
| Anonymous                  | ✗    | ✗                 | ✗       | ✗       | ✗      |

Defence in depth, each layer tested on its own:

| Layer          | Mechanism                                                                                                                                                                                                                  |
| -------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Import graph   | `src/agents/**` cannot import `application/`, `adapters/`, `server/` (lint rule + `test/boundaries.test.ts`, including the mandate modules); agents _may_ import `domain/mandate` to read the rules.                       |
| HTTP guard     | Any request carrying `X-Agent-Id` or `Authorization` is refused with 403 **before** the session is even looked at, including when it also carries a valid operator cookie.                                                 |
| Session        | `pp_operator` cookie: `HttpOnly`, `SameSite=Lax`, signed (HMAC) with a key derived from `OPERATOR_PASSCODE`, 8 h expiry, no secret inside.                                                                                 |
| CSRF / origin  | Every change needs the `X-CSRF-Token` matching the session, `Content-Type: application/json`, and a same-origin `Origin` (cross-site `Sec-Fetch-Site` refused). Body capped at 16 KB.                                      |
| Service        | Every method calls `requireOperator(actor)` **first**, before reading or validating anything, so a non-operator learns nothing from error messages. Forged actor shapes (no id, wrong case, `null`, a string) are refused. |
| Request schema | Strict objects: forged keys such as `status`, `version`, `approved`, `createdBy` are errors. The resource id comes from the URL and overrides any `draftId` in the body.                                                   |
| Database       | `mandates.created_by` must be `'OPERATOR'`; approved rows are immutable; a version from a draft must equal that draft.                                                                                                     |

Login is throttled (5 failures per minute, then 429). Passcode comparison is constant-time.

## 6. API

All responses are `Cache-Control: no-store`. Errors: `401` not signed in · `403` agent/CSRF/origin · `404` unknown · `409` conflict (stale revision, already approved, mandate changed, duplicate draft, already revoked) · `415` wrong content type · `413` too large · `422` field errors `{error:"VALIDATION_FAILED", fields:[{field,message}]}` · `429` too many logins · `503` operator access or database not configured (`OPERATOR_NOT_CONFIGURED`, `DATABASE_NOT_READY`).

| Method and path                         | Body                                     | Result                                                               |
| --------------------------------------- | ---------------------------------------- | -------------------------------------------------------------------- |
| `GET /api/operator/session`             | —                                        | `{configured, authenticated, csrfToken?}`                            |
| `POST /api/operator/session`            | `{passcode}`                             | signs in (sets cookie)                                               |
| `DELETE /api/operator/session`          | — (needs CSRF)                           | clears the cookie                                                    |
| `GET /api/mandates`                     | —                                        | mandates with versions, open drafts, sellers, currencies, categories |
| `POST /api/mandates/drafts`             | `{fields, basedOn?:{mandateId,version}}` | `201 {draft}`                                                        |
| `PUT /api/mandates/drafts/:id`          | `{revision, fields}`                     | `{draft}`                                                            |
| `POST /api/mandates/drafts/:id/approve` | `{revision}`                             | `{mandate}` (new immutable version)                                  |
| `POST /api/mandates/drafts/:id/discard` | `{revision}`                             | `{draft}`                                                            |
| `POST /api/mandates/:id/revoke`         | `{expectedVersion}`                      | `{mandate}` (REVOKED version)                                        |

## 7. The operator console (`/mandate`)

States: **loading** (skeleton), **error** (alert + Retry), **not configured** (how to set `OPERATOR_PASSCODE`), **signed out** (login form, server error announced), **empty** (no mandates, with a hint if there are no sellers), **loaded**. In the editor: live decimal-safe hints ("Reads as 100.00 USD (10,000 minor units)" or why it is not valid yet), a preview of the exact rules once everything is valid, a server error summary (focused, `role="alert"`, links to each field, `aria-invalid`/`aria-describedby` per field), a notice region (`aria-live`). **Approve is disabled with a visible reason** until the draft is saved and has no unsaved changes; approving first shows the exact rules and states that the version is permanent. Revocation asks for confirmation. Tap targets are at least 40 px; layout was checked at 1280, 768 and 375 px.

## 8. Setup

```bash
# .env.local (git-ignored)
OPERATOR_PASSCODE=<at least 16 random characters>
npm run db:migrate && npm run db:seed
npm run dev        # then open http://localhost:3000/mandate
```

## 9. Limits and unverified items

- **Demo-grade authentication.** One shared passcode, stateless cookie. Signing out clears the cookie but **cannot invalidate it server-side**: a copied cookie stays valid until its 8 h expiry or until `OPERATOR_PASSCODE` changes. No per-user accounts, no MFA.
- **Rate limiting is global and in memory** (resets on restart); fine for one operator, not for a public deployment.
- **Category enforcement on the real paths happens at agreement time** (database trigger, using catalog categories). The policy engine ([POLICY_ENGINE.md](POLICY_ENGINE.md)) re-checks categories, the per-transaction cap and the **cumulative budget** (`Σ exposure ≤ totalBudget`), and the negotiation workflow calls it when an offer is accepted and when payment eligibility is checked ([NEGOTIATION.md](NEGOTIATION.md)). It is not yet called for payment execution, which does not exist.
- **Approval of a transaction** is done in the negotiation console (`/negotiations`): the operator approves or rejects the current agreement version there ([NEGOTIATION.md](NEGOTIATION.md) §6). The schema gate (§4) is unchanged.
- **Currencies**: only USD is exercised; PayPal Sandbox support for EUR/GBP/JPY is unverified.
- **Accessibility** was designed for and checked structurally (labels, landmarks, focus management, contrast tokens tested) but **not tested with a screen reader or keyboard-only walkthrough**. Browser checks used Chromium only.
- **Production**: HTTPS is required (the cookie is marked `Secure` when the app URL is https); no CSP header yet.

## 10. Where each requirement is proven

| Requirement                                                                            | Tests                                                                                                                                                                                              |
| -------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Negative amounts, invalid currency, unsupported categories, boundaries, missing fields | `src/domain/mandate.test.ts`, `test/mandates/service.test.ts`, `test/mandates/api.test.ts` (16 HTTP cases), `test/persistence/mandate-policy.test.ts` (database level)                             |
| Decimal safety (no float, no rounding)                                                 | `parseDecimalAmount` tables + 840 round-trip values across the four currencies, `0.10 → 10` over HTTP                                                                                              |
| Drafts never change approved mandates / existing transactions                          | `test/mandates/service.test.ts` ("drafts versus approved mandates"), `test/persistence/mandate-policy.test.ts`                                                                                     |
| Immutable, versioned, pinned                                                           | the same files + `test/persistence/mandates.test.ts`                                                                                                                                               |
| Agents cannot approve or modify                                                        | `test/mandates/service.test.ts` (10 forged actors × 6 methods), `test/mandates/api.test.ts` ("AI agents cannot…"), `test/boundaries.test.ts`; replayed against a real server with curl (§5)        |
| UI states and feedback                                                                 | `test/mandates/views.test.tsx` (22) + browser verification                                                                                                                                         |
| Guards actually matter                                                                 | mutation checks: removing the agent refusal, CSRF, origin, the actor check on approval, strict schemas, the approval gate, draft finality, or making the threshold inclusive each makes tests fail |
