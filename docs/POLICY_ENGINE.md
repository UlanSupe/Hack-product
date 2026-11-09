# PactPay Arena — Policy Engine

`src/domain/policy.ts` is the deterministic, server-side authority on whether a proposed action may happen. It is a **pure, synchronous, total function**: `evaluatePolicy(input: unknown) → PolicyDecision`. It makes no network call, performs no payment, reads no clock (time is injected), uses no randomness, never throws and never mutates its input. A model cannot override it: the input schema is strict, so there is no field in which a recommendation, an "override" or a "force" flag could travel.

Companion documents: [ARCHITECTURE.md](ARCHITECTURE.md) (where it sits), [TRANSACTION_STATE_MACHINE.md](TRANSACTION_STATE_MACHINE.md) (guards G-ACCEPT, G0–G3), [MANDATE.md](MANDATE.md) (the rules it enforces), [POLICY_TEST_REPORT.md](POLICY_TEST_REPORT.md) (evidence).

**Status: implemented, tested, and wired into the negotiation workflow** ([NEGOTIATION.md](NEGOTIATION.md) §5): every acceptance of an offer runs `ACCEPT_OFFER`, and the "may payment start?" check runs `CREATE_ORDER`, with inputs built from database rows inside the same transaction that acts on the answer. **Not yet wired into payment execution**: there is no `ActionGateway` and no PayPal call, so `AUTHORIZE`, `CAPTURE` and `VOID` are still unused. See [Limits](#7-limits-read-these).

## 1. What it decides

Five subjects, one per money-relevant action (the same names as `policy_decisions.subject`):

| Subject        | Meaning                                       | Who may ask             | Legal from state | Moves the transaction to |
| -------------- | --------------------------------------------- | ----------------------- | ---------------- | ------------------------ |
| `ACCEPT_OFFER` | Turn the seller's open offer into a contract  | operator, system, agent | `NEGOTIATING`    | `AGREED`                 |
| `CREATE_ORDER` | Create the PayPal order from the agreement    | operator, system        | `AGREED`         | `CREATING_ORDER`         |
| `AUTHORIZE`    | Authorize (hold) the approved order           | operator, system        | `ORDER_APPROVED` | `AUTHORIZING`            |
| `CAPTURE`      | Release funds                                 | **operator only**       | `AUTHORIZED`     | `CAPTURING`              |
| `VOID`         | Release the hold (only ever reduces exposure) | operator, system, agent | `AUTHORIZED`     | `VOIDING`                |

"Legal from state" is not a second table: the engine asks `canTransition(state, target)` of the state machine in `transaction-states.ts`, so the two cannot drift. An agent may _recommend_ acceptance, but that recommendation is only the question; this function gives the answer.

## 2. Authority model: facts versus claims

| Part of the input                                                                                                                        | Where it comes from                                                                                              | How it is used                                                                                                          |
| ---------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| **Facts**: `transaction`, `mandate`, `latestMandate`, `offer`, `agreement`, `others`, `approval`, `attempts`, `observed`, `now`, `actor` | Loaded by the server from its own database / a server-side PayPal read; `actor` set from the authenticated route | Evaluated                                                                                                               |
| **Claims**: `claims.*` (transaction, mandate id/version, offer, agreement, seller, payee, currency, amount, terms hash)                  | A client, an agent, a seller message                                                                             | **Only compared with the facts.** Any difference denies. They never supply an amount, a payee, a currency or a version. |

Consequences, each covered by tests: a client saying "the amount is 1.00" does not lower the amount judged; a client saying "mandate version 3" does not select a version; an extra key such as `override: true` is `INPUT_INVALID`; every value is recomputed (offer total, terms hash, mandate content hash) rather than trusted.

## 3. The decision

```ts
type PolicyDecision = {
  verdict: "ALLOW" | "DENY";
  subject: PolicySubject | null; // null only if the input was too malformed to say
  reasonCodes: ReasonCode[]; // sorted, unique; empty exactly when ALLOW
  findings: { code; message }[]; // one per violated rule, in check order
  explanation: string; // human readable, never contains seller text
  policyVersion: string; // "pactpay-policy/1.1.0"
  mandateRef: { id; version } | null; // the mandate version evaluated
  approvalRequirement: "NOT_REQUIRED" | "ABOVE_THRESHOLD" | "REVIEW_REQUIRED" | null;
  inputsHash: string; // SHA-256 of the canonical evaluated input
};
```

- The decision is **deeply frozen**. `verdict`, `reasonCodes` and `mandateRef` shape match the `policy_decisions` table checks (ALLOW ⇒ no codes; DENY ⇒ at least one; 64-hex `inputsHash`).
- The engine collects **every** violated rule instead of stopping at the first, so a denial explains itself completely.
- `approvalRequirement` is informational for `ACCEPT_OFFER`: it tells the caller that human approval will be needed later, without blocking acceptance.
- A decision for malformed input has `mandateRef: null`, so it cannot be stored in `policy_decisions` (which references a mandate version); record it in the audit log instead.
- `POLICY_VERSION` must be bumped whenever a rule changes behaviour.

## 4. Rules, by subject

`✔` = evaluated; `–` = not evaluated.

| Rule (reason codes)                                                                                                                | ACCEPT_OFFER | CREATE_ORDER | AUTHORIZE | CAPTURE | VOID |
| ---------------------------------------------------------------------------------------------------------------------------------- | :----------: | :----------: | :-------: | :-----: | :--: |
| Strict input shape and ranges (`INPUT_INVALID`, `POLICY_ERROR`)                                                                    |      ✔       |      ✔       |     ✔     |    ✔    |  ✔   |
| Requester kind (`ACTOR_NOT_PERMITTED`)                                                                                             |      ✔       |      ✔       |     ✔     |    ✔    |  ✔   |
| Transaction state (`STATE_NOT_PERMITTED`)                                                                                          |      ✔       |      ✔       |     ✔     |    ✔    |  ✔   |
| Claimed transaction id (`TRANSACTION_MISMATCH`)                                                                                    |      ✔       |      ✔       |     ✔     |    ✔    |  ✔   |
| Duplicate / live attempt (`DUPLICATE_ATTEMPT`)                                                                                     |      –       |      ✔       |     ✔     |    ✔    |  ✔   |
| Capture already succeeded (`DUPLICATE_CAPTURE`, `VOID_AFTER_CAPTURE`)                                                              |      –       |      –       |     –     |    ✔    |  ✔   |
| Mandate integrity: terms equal the approved row (`MANDATE_INTEGRITY`)                                                              |      ✔       |      ✔       |     ✔     |    ✔    |  –   |
| Mandate identity and pinned version (`MANDATE_MISMATCH`, `MANDATE_VERSION_MISMATCH`)                                               |      ✔       |      ✔       |     ✔     |    ✔    |  –   |
| Mandate not revoked (`MANDATE_REVOKED`)                                                                                            |      ✔       |      ✔       |     ✔     |    ✔    |  –   |
| Mandate is the latest version, not expired (`MANDATE_STALE`, `MANDATE_EXPIRED`)                                                    |      ✔       |      ✔       |     ✔     |    –    |  –   |
| Offer present, status, validity, not empty (`OFFER_*`)                                                                             |      ✔       |      ✔       |     ✔     |    ✔    |  –   |
| Agreement present, attached, matches offer, not duplicated (`AGREEMENT_*`)                                                         |      ✔       |      ✔       |     ✔     |    ✔    |  –   |
| Terms hash recomputed (`TERMS_HASH_MISMATCH`)                                                                                      |      ✔       |      ✔       |     ✔     |    ✔    |  –   |
| Total recomputed exactly; seller's number compared (`TOTAL_MISMATCH`, `AMOUNT_OVERFLOW`, `AMOUNT_NOT_POSITIVE`, `AMOUNT_MISMATCH`) |      ✔       |      ✔       |     ✔     |    ✔    |  –   |
| Currency equals the mandate's (`CURRENCY_MISMATCH`)                                                                                |      ✔       |      ✔       |     ✔     |    ✔    |  –   |
| Seller allow-list; payee is the catalog payee (`PAYEE_NOT_ALLOWED`, `PAYEE_MISMATCH`)                                              |      ✔       |      ✔       |     ✔     |    ✔    |  –   |
| Every line has a known, allowed category; catalog price (`CATEGORY_*`, `PRICE_NOT_IN_CATALOG`)                                     |      ✔       |      ✔       |     ✔     |    ✔    |  –   |
| Per-transaction cap, inclusive (`OVER_PER_TX_CAP`)                                                                                 |      ✔       |      ✔       |     ✔     |    ✔    |  –   |
| Cumulative budget, inclusive (`OVER_TOTAL_BUDGET`, `EXPOSURE_INVALID`)                                                             |      ✔       |      ✔       |     ✔     |    ✔    |  –   |
| Human approval when required: above the threshold, or review forced (`APPROVAL_*`)                                                 |   informs    |      ✔       |     ✔     |    ✔    |  –   |
| Fresh PayPal observation equals the agreement (`OBSERVATION_REQUIRED`, plus amount / currency / payee mismatches)                  |      –       |      –       |     ✔     |    ✔    |  –   |
| Authorization honor period, with a 1 h safety margin (`HONOR_WINDOW_UNKNOWN`, `HONOR_PERIOD_ENDED`)                                |      –       |      –       |     –     |    ✔    |  –   |

Precise semantics worth knowing:

- **Which amount is judged.** At `ACCEPT_OFFER`: the total the server recomputes from the offer lines (`Σ qty × unit price + shipping + fees`, in `BigInt`, `null` on overflow). Afterwards: the agreement's frozen total, which must equal that recomputation.
- **Cumulative budget.** `Σ total(other transactions in a counting state) + this total ≤ totalBudget`. Counting states follow the state-machine document: everything from `AGREED` to `CAPTURED`, `VOIDING`, `NEEDS_RECONCILIATION` (unresolved payments stay reserved) and `REVERSED`; not `NEGOTIATING`, `VOIDED`, `REJECTED`, `CANCELLED`, `FAILED`. The transaction being judged is counted once, even if it appears in `others`. Duplicate ids or a different currency among counted transactions is `EXPOSURE_INVALID` (fail closed). Sums use `BigInt`, so they cannot wrap.
- **Catalog price is a ceiling (v1.1.0).** A line may be priced at or below the seller's catalog price, so a negotiated discount can be allowed; one unit above it, or a SKU missing from the catalog, is `PRICE_NOT_IN_CATALOG`. Version 1.0.0 required the price to be _exactly_ the catalog price, which would have denied every negotiated discount.
- **Boundaries.** Cap and budget are inclusive (`total == cap` is allowed, `cap + 1` is not). Human approval is required **strictly above** the threshold (`total == threshold` is allowed without it), or always when review is forced. An offer is valid while `now < validUntil`; a mandate while `now < expiresAt`; capture is refused once `now ≥ honorExpiresAt − 1 h`.
- **Approval.** Valid means: `decision = APPROVED`, `decidedBy = "OPERATOR"` (exact), recorded for _this_ agreement. A recorded `REJECTED` denies even when approval would not have been required. An approval presented before an agreement exists is `APPROVAL_MISMATCH`.
- **Mandate integrity.** The engine recomputes the content hash from the terms it was given (owner, limits, categories, sellers, expiry, status) and compares it with the stored hash of the approved version. Draft terms, a stale copy, or a hand-edited row cannot pass. The hash function is shared with persistence (`src/domain/mandate-hash.ts`); so are the offer total and terms hash (`src/domain/offer.ts`), and a test fails if they ever diverge.
- **Timestamps** must be UTC (`…Z`) and real calendar dates (`2026-02-30` is rejected rather than rolled over to 2 March).

## 5. Reason codes

Stable identifiers: add freely, never rename or remove. A test keeps this table identical to `REASON_CODES` in the code and requires every code to be produced by at least one test.

| Code                       | Meaning                                                                                     |
| -------------------------- | ------------------------------------------------------------------------------------------- |
| `INPUT_INVALID`            | The policy input is malformed, has unknown fields, or has out-of-range values.              |
| `POLICY_ERROR`             | The engine hit an unexpected internal error and failed closed.                              |
| `ACTOR_NOT_PERMITTED`      | This kind of requester may not perform this action.                                         |
| `STATE_NOT_PERMITTED`      | The transaction is not in a state from which this action is legal.                          |
| `TRANSACTION_MISMATCH`     | A transaction id does not match the transaction being acted on.                             |
| `MANDATE_MISMATCH`         | The mandate presented is not the mandate this transaction is pinned to.                     |
| `MANDATE_VERSION_MISMATCH` | The mandate version presented is not the pinned version.                                    |
| `MANDATE_STALE`            | A newer version of the mandate exists; the pinned version no longer authorizes new spend.   |
| `MANDATE_REVOKED`          | The mandate has been revoked.                                                               |
| `MANDATE_EXPIRED`          | The mandate has expired.                                                                    |
| `MANDATE_INTEGRITY`        | The mandate terms are not exactly the approved version (their content hash does not match). |
| `OFFER_REQUIRED`           | No offer was supplied.                                                                      |
| `OFFER_NOT_OPEN`           | The offer is not open (superseded, expired, rejected or already accepted).                  |
| `OFFER_NOT_ACCEPTED`       | The offer behind this agreement is not in the accepted state.                               |
| `OFFER_EXPIRED`            | The offer's validity time has passed.                                                       |
| `OFFER_EMPTY`              | The offer has no line items.                                                                |
| `AGREEMENT_REQUIRED`       | No agreement exists for this transaction.                                                   |
| `AGREEMENT_EXISTS`         | An agreement already exists; an offer cannot be accepted twice.                             |
| `AGREEMENT_MISMATCH`       | The agreement does not belong to this transaction or offer.                                 |
| `TERMS_HASH_MISMATCH`      | The offer's terms no longer match the hash that was agreed.                                 |
| `PRICE_NOT_IN_CATALOG`     | A line is priced above the seller's catalog price, or the item is not in the catalog.       |
| `TOTAL_MISMATCH`           | The seller's stated total differs from the server-computed total.                           |
| `AMOUNT_NOT_POSITIVE`      | The amount must be greater than zero.                                                       |
| `AMOUNT_OVERFLOW`          | The amount is outside the representable money range.                                        |
| `AMOUNT_MISMATCH`          | An amount differs from the server-held amount.                                              |
| `CURRENCY_MISMATCH`        | A currency differs from the mandate or agreement currency.                                  |
| `PAYEE_NOT_ALLOWED`        | The seller is not on the mandate's allow-list.                                              |
| `PAYEE_MISMATCH`           | A payee reference differs from the one in the seller catalog or agreement.                  |
| `CATEGORY_NOT_ALLOWED`     | A line is outside the mandate's allowed service categories.                                 |
| `CATEGORY_UNKNOWN`         | A line has no known service category, so it cannot be allowed.                              |
| `OVER_PER_TX_CAP`          | The amount exceeds the mandate's maximum transaction amount.                                |
| `OVER_TOTAL_BUDGET`        | Reserved and spent amounts plus this one would exceed the total budget.                     |
| `EXPOSURE_INVALID`         | The data used to compute cumulative spending is inconsistent.                               |
| `APPROVAL_REQUIRED`        | Human approval is required by the mandate and has not been given.                           |
| `APPROVAL_REJECTED`        | A human rejected this transaction.                                                          |
| `APPROVAL_NOT_HUMAN`       | The approval was not recorded by the human operator.                                        |
| `APPROVAL_MISMATCH`        | The approval does not belong to this agreement.                                             |
| `DUPLICATE_ATTEMPT`        | A live attempt for this action already exists.                                              |
| `DUPLICATE_CAPTURE`        | A capture has already succeeded for this transaction.                                       |
| `VOID_AFTER_CAPTURE`       | A captured authorization cannot be voided.                                                  |
| `OBSERVATION_REQUIRED`     | A fresh server-side observation of the PayPal object is required.                           |
| `HONOR_WINDOW_UNKNOWN`     | The authorization honor period is unknown.                                                  |
| `HONOR_PERIOD_ENDED`       | The authorization honor period has ended or is about to.                                    |

## 6. Decisions you may want to flip

These are judgement calls, made explicit so they can be changed in one place (`RULES` in `policy.ts`) with a `POLICY_VERSION` bump:

1. **Capture ignores a newer, non-revoked mandate version and mandate expiry.** The state-machine guard G2 only requires "not revoked, cap and budget still satisfied". The money is already on hold, its amount is frozen in the agreement, and capture needs a human acting right now, so a later unrelated mandate edit should not strand the hold. Revocation _does_ block capture. If you prefer the stricter rule, set `freshMandate: true` for `CAPTURE`.
2. **`CAPTURE` is operator-only**, not "operator or a pre-registered release rule" (the state-machine text allows both). A scheduled release rule can be added later as an explicit `SYSTEM` entry.
3. **`VOID` is allowed for an agent** (it only reduces exposure) and ignores mandate state entirely, so a revoked or expired mandate never traps a hold.
4. **Category and price are re-checked at every money step**, not only at agreement time (the database enforces categories only at agreement insert).
5. **The catalog price is a ceiling, not an exact price** (changed in v1.1.0 so that negotiation can end in an allowed deal). The buyer can never pay more than the catalog price; a lower price only helps the buyer. To go back to exact-match, restore `!==` in the line check and bump `POLICY_VERSION`.

## 7. Limits (read these)

- **The engine can only judge the facts it is given.** It cannot know that `others` lists _every_ other transaction, that `attempts` reflects the database, or that `observed` is a genuine PayPal read. The week-two loader must build the input from the database inside the same `BEGIN IMMEDIATE` transaction that performs the state compare-and-swap, or a concurrent request can slip between decision and action. The engine's mandate content-hash check narrows this for the mandate terms only.
- **Partly wired.** The negotiation service calls it for `ACCEPT_OFFER` and `CREATE_ORDER` and stores each answer (`negotiation_policy_checks`, plus a `policy_decisions` row for an allowed acceptance). Nothing calls it for `AUTHORIZE`, `CAPTURE` or `VOID`, `AuthorizedAction` does not exist, and no payment is executed, so the cumulative budget is enforced when deals are agreed but there is no payment path to protect yet.
- **`validDays` is not covered by the mandate hash** (it is derived from the expiry, which is) and is not used by the engine.
- **Operator approval binds the agreement, not a separate amount.** That is safe because the agreement is immutable, and the engine checks the agreement's id.
- **A decision is evidence of a computation, not of the outside world.** `inputsHash` ties it to its inputs; it proves nothing about PayPal.
- **PayPal assumptions are unchanged** (ARCHITECTURE §2.2 A-list): the engine takes the observed amount, currency and payee reference as already-mapped values. How a PayPal merchant id maps to `payeeRef` is unverified and belongs to the adapter.
- **Single currency per mandate**, matching the schema; mixed currencies are denied, never converted.

## 8. Using it (week two preview)

```ts
const decision = evaluatePolicy(inputBuiltFromDatabaseRows); // pure, instant
persist(decision); // policy_decisions row + audit event, same DB transaction as the state change
if (decision.verdict === "ALLOW") mintAuthorizedAction(...); // only ActionGateway does this
```

A model's output may decide _what to ask_; it never appears in `inputBuiltFromDatabaseRows` except as an id to look up, and it cannot appear in `claims` as anything but a value to be compared.
