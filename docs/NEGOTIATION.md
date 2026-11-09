# PactPay Arena — Negotiation and Agreement Workflow

A buyer states what they want and a deadline. Sellers (or the mock agents) make offers; the buyer counters; one offer is accepted **only if the deterministic policy engine allows it**, which creates a numbered **agreement version**. Changing the deal after that retires the old version _and its approval_. Nothing in this workflow moves money: it ends at "this agreement is eligible to start payment, or it is not, and here is why".

Companion documents: [POLICY_ENGINE.md](POLICY_ENGINE.md) (the rules that decide), [MANDATE.md](MANDATE.md) (the operator's limits), [AGENTS.md](AGENTS.md) (the agents that propose), [DATABASE.md](DATABASE.md) §10 (the tables), [TRANSACTION_STATE_MACHINE.md](TRANSACTION_STATE_MACHINE.md) (what happens after an agreement).

## 1. Vocabulary

| Term            | Meaning                                                                                                                                                                                                                           |
| --------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Negotiation** | One buyer request with its constraints, a deadline (timeout), and 1–5 invited sellers. Its request is immutable. Statuses: `OPEN`, `AGREED`, `REJECTED`, `TIMED_OUT`, `CANCELLED`.                                                |
| **Proposal**    | A stored, immutable **version** of someone's terms. A `SELLER_OFFER` is a seller's terms; a `BUYER_COUNTER` is the buyer's structured counter-offer. A change is a **new version**, never an edit.                                |
| **Chain**       | The versions of one kind from one seller in one negotiation: v1, v2, v3… Each names the version it supersedes.                                                                                                                    |
| **Agreement**   | Version _n_ of the deal. Created only from an accepted seller offer that passed the policy engine. It pins a core transaction, a core agreement and the mandate version in force. Statuses: `ACTIVE`, `INVALIDATED`, `CANCELLED`. |
| **Approval**    | The operator's decision on **one** agreement version, recorded against its transaction. It never carries to another version.                                                                                                      |
| **Eligibility** | "May payment start?" — the policy engine's answer for `CREATE_ORDER` on the current agreement. Computed fresh; recorded when asked.                                                                                               |

## 2. What is stored, and what a "version" covers

Every offer and counter-offer is a row in `negotiation_proposals` (migration `0006`). The schema makes the terms immutable: only `status` may change, once, from `OPEN` to a final value.

| Field                                                                |  Offer   | Counter-offer | Notes                                                                                                                                                       |
| -------------------------------------------------------------------- | :------: | :-----------: | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Price**: lines (`sku`, `qty`, unit price), shipping, fees          |    ✔     |  total only   | The **total is computed by the server**. The seller's stated total is stored for audit and compared, never used. A counter states an explicit target total. |
| **Currency**                                                         |    ✔     |       ✔       | Explicit on every proposal.                                                                                                                                 |
| **Category**                                                         |    ✔     |       ✔       | A claim. The policy engine uses the **catalog's** category for each item, not this field.                                                                   |
| **Deliverables** (the acceptance criteria)                           |    ✔     |       ✔       | 1–10 short items.                                                                                                                                           |
| **Deadline**: delivery days, and the absolute `deliver_by` time      |    ✔     |       ✔       | `deliver_by` is computed from the server clock at submission.                                                                                               |
| **Payee**                                                            | snapshot |   snapshot    | **Never an input.** Always the seller's catalog payee at submission; the schema refuses any other value.                                                    |
| Written terms / note                                                 |    ✔     |       ✔       | Seller- or model-written: shown as inert plain text.                                                                                                        |
| Validity (`valid_until`)                                             |    ✔     |       ✔       | When the proposal stops being acceptable. Not part of the deal's identity.                                                                                  |
| `terms_hash`                                                         |    ✔     |       ✔       | SHA-256 of everything above except validity, text order and ids. Identifies a version of the deal.                                                          |
| `changes`                                                            |    ✔     |       ✔       | Which of `PRICE`, `PAYEE`, `SCOPE`, `CATEGORY`, `CURRENCY`, `ACCEPTANCE_CRITERIA`, `DEADLINE` differ from the previous version.                             |
| Who recorded it, when, `seq`, `version`, `supersedes`, `responds_to` |    ✔     |       ✔       | Gap-free `seq` per negotiation; contiguous `version` per chain.                                                                                             |

Every step also writes an audit event (hash-chained, local tamper-evidence only; see DATABASE §6), and every policy evaluation is stored in `negotiation_policy_checks` with its reason codes, the policy version and a hash of its inputs.

## 3. Lifecycle

```
open (operator)
  │  request + constraints + deadline + invited sellers
  ▼
OPEN ── seller offer v1, v2… (agents/system/operator) ── buyer counter v1, v2… (agent/operator)
  │          each a stored version; the previous open version is SUPERSEDED
  │
  │  accept(offer)  ──►  policy engine (ACCEPT_OFFER) on stored rows
  │        ├─ DENY  → proposal closed (REJECTED, or EXPIRED if the offer expired); reasons recorded; nothing else changes
  │        └─ ALLOW → core transaction + agreement created; proposal ACCEPTED; agreement v(n) ACTIVE; negotiation AGREED
  ▼
AGREED ── approve / reject agreement (operator) ── eligibility (policy engine, CREATE_ORDER)
  │
  │  accept(a DIFFERENT, allowed proposal)  ──►  v(n) INVALIDATED (+ its approval), its transaction CANCELLED, v(n+1) ACTIVE
  ▼
close (operator): REJECTED / CANCELLED          timeout: TIMED_OUT (only while OPEN)
```

### Proposal statuses

`OPEN → SUPERSEDED | ACCEPTED | REJECTED | EXPIRED | WITHDRAWN`, once. Only a seller offer can be `ACCEPTED`. Final statuses never change again (the schema enforces it).

### Negotiation statuses

`OPEN → AGREED | REJECTED | TIMED_OUT | CANCELLED`; `AGREED → OPEN` (only when its agreement is retired) or `CANCELLED`. `REJECTED`, `TIMED_OUT` and `CANCELLED` are final.

## 4. Who may do what

| Action                                  | Operator | Agent | System | Anonymous |
| --------------------------------------- | :------: | :---: | :----: | :-------: |
| Open a negotiation                      |    ✔     |   –   |   –    |     –     |
| Record a seller offer                   |    ✔     |   ✔   |   ✔    |     –     |
| Record a buyer counter-offer            |    ✔     |   ✔   |   –    |     –     |
| Ask to accept an offer (engine decides) |    ✔     |   ✔   |   ✔    |     –     |
| Check eligibility                       |    ✔     |   ✔   |   ✔    |     –     |
| **Approve or reject an agreement**      |  **✔**   | **–** | **–**  |     –     |
| Reject a proposal, close a negotiation  |    ✔     |   –   | reject |     –     |
| Read negotiations                       |    ✔     |   –   |   –    |     –     |

The HTTP API is operator-only (anything declaring itself an agent is refused 403 even with a valid session). Agents act inside the server through the service and have no HTTP path. An agent may **ask** for an acceptance, but the engine still decides, and an agreement made that way is still not approved.

## 5. Every agreement runs through the policy engine

`accept` never trusts the request. It builds the engine's input **from stored rows in the same database transaction that acts on the answer** (so nothing can change between "allowed" and "done"), evaluates it, stores the decision, and only then writes anything else.

- **Facts** come from the database: the latest mandate version (verified against its content hash), the seller's current catalog payee and prices, the other transactions' exposure, the proposal's stored terms.
- **Claims** are the proposal's own snapshot values (payee, currency, amount, seller). They are compared with the facts; a difference is a denial. This is how a **substituted payee** is caught: if the catalog payee changed after the offer was recorded, the snapshot no longer matches (`PAYEE_MISMATCH`).
- **Replacing an agreement** ignores the retiring transaction's reservation, so the same deal is not counted against the budget twice.
- **Eligibility for payment** is the engine's answer for `CREATE_ORDER`, judged as the system would start the order (who asks does not change it). `ELIGIBLE` means the engine would allow it _now_; `AWAITING_APPROVAL` means the only thing missing is the operator's approval; `BLOCKED` lists why; `IN_PROGRESS` means payment steps already began.
- A **denial is a normal answer**, not an error: `accepted: false` with the reasons in plain words (see POLICY_ENGINE.md §5 and `src/domain/policy-explanations.ts`, which has wording and "what you can do" for every reason code).

The schema independently re-checks the money-critical parts when the agreement row is created (cap, currency, payee from the catalog, mandate latest/unexpired/allowing the seller, categories, an `ALLOW` decision on the same mandate version). The engine is the authority; the database is the backstop.

## 6. What invalidates an approval

An approval belongs to exactly one agreement version. **Accepting any proposal whose terms differ from the current agreement retires that version** and its approval, and creates version _n_ + 1, which has no approval and gets its own eligibility check.

| A change to…                                 | Classified as         | Effect on accepting the new version                                                             |
| -------------------------------------------- | --------------------- | ----------------------------------------------------------------------------------------------- |
| total, unit price, shipping or fees          | `PRICE`               | Retires v(n); v(n+1) needs approval if the mandate requires it for the new amount               |
| seller or payee                              | `PAYEE`               | Same. Switching sellers after approval is exactly this.                                         |
| items, quantities, written terms             | `SCOPE`               | Same                                                                                            |
| service category                             | `CATEGORY`            | Same, and refused by the engine if the mandate does not allow the new category                  |
| currency                                     | `CURRENCY`            | Refused by the engine unless it equals the mandate's currency                                   |
| deliverables                                 | `ACCEPTANCE_CRITERIA` | Same                                                                                            |
| delivery time                                | `DEADLINE`            | Same                                                                                            |
| only the validity time or the order of lists | _(none)_              | Not a change: accepting it is refused as "identical"; the agreement and its approval stay valid |

Precisely:

- A **proposed but unaccepted** change does **not** alter the agreement. Payment always follows the agreed version; the console shows the pending change and says so. (Otherwise a seller could cancel a good, approved deal just by posting a junk revision.)
- The retired version records _why_ (the changes in words), _by which proposal_, and whether an approval was on file (`approval_was_valid`). Its core transaction is cancelled.
- A **refused** replacement leaves the current agreement and its approval untouched.
- Once **payment steps have started** (the transaction left `AGREED`), the deal cannot be changed: new offers, counters, acceptances, rejection and cancellation are refused with an explanation.
- The operator can also reject the current version (`disapprove`): it is cancelled, the negotiation reopens, and any other offer may be accepted.

## 7. Rejection and timeout

- **Reject one proposal** (operator or system): it becomes `REJECTED` with a reason; the negotiation carries on. A seller may offer again; the new version continues the chain.
- **Reject everything / cancel** (operator): the negotiation becomes `REJECTED` or `CANCELLED`; open proposals are rejected or withdrawn; an active agreement is cancelled (unless payment began).
- **Policy refusal** closes that proposal (`REJECTED`, or `EXPIRED` when the reason is an expired offer).
- **Offer validity**: a proposal is acceptable while `now < valid_until`. Accepting one at or after that instant is a recorded denial (`OFFER_EXPIRED`). Reading the negotiation (or the sweep) marks such proposals `EXPIRED`; accepting an already-expired one is a conflict that says so.
- **Negotiation timeout**: an `OPEN` negotiation whose `expires_at` has passed becomes `TIMED_OUT` (at the instant, to the millisecond), every open proposal expires, and no offer, counter, acceptance or approval is accepted afterwards. An `AGREED` negotiation does not time out. Deadlines are applied lazily on every read and write and by `sweep` (no background timer is needed).

## 8. API (operator session + CSRF, JSON)

| Route                                                          | Purpose                                                                               |
| -------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| `GET /api/negotiations`                                        | Overview + sellers + mandates for the form                                            |
| `POST /api/negotiations`                                       | Open (the request and constraints)                                                    |
| `GET /api/negotiations/:id`                                    | Everything: request, per-seller versions, agreements, pending changes, policy history |
| `POST /api/negotiations/:id/offers` · `/counters`              | Record a version (ids come from the URL; a payee is refused with an explanation)      |
| `POST /api/negotiations/:id/proposals/:pid/accept` · `/reject` | Accept (engine decides) / reject                                                      |
| `POST /api/negotiations/:id/approve` · `/disapprove`           | Operator decision on the current agreement                                            |
| `POST /api/negotiations/:id/eligibility`                       | Ask the engine whether payment may start (recorded)                                   |
| `POST /api/negotiations/:id/close`                             | `{ outcome: "REJECTED" \| "CANCELLED", reason? }`                                     |
| `POST /api/negotiations/:id/demo`                              | Run the deterministic mock agents (they only record offers and counters)              |

## 9. The console (`/negotiations`)

Plain-language everywhere: each status carries a sentence saying what it means; each proposal shows its numbered version, its terms (price, currency, category, deliverables, delivery time and absolute deadline), what changed since the previous version, and **the policy engine's answer in words** — a live preview for open offers (labelled "nothing was stored") and the recorded check once one was made, with, for each reason, what it means and what you can do. A seller's stated total that disagrees with the lines is flagged. The current agreement shows its approval state and eligibility; retired versions show why they were retired and that their approval no longer counts; a pending seller change is announced before it can surprise anyone. Seller- and model-written text is rendered as inert plain text in a visibly separate style; payee references are never displayed.

## 10. Limits (read these)

- **Sellers are not authenticated.** Offers arrive from agents or are recorded by the operator on a seller's behalf. There is no seller login, signature or inbox; the "seller" is whatever the service is told. A real marketplace would need that.
- **Counter-offers are proposals, not commitments.** A seller is not bound by a counter; it answers with a new offer version, which still has to be accepted and pass the engine.
- **The catalog price is a ceiling** (policy 1.1.0): a negotiated discount is allowed, a mark-up is not. The mock sellers' floors (80% of list) are synthetic demo data.
- **One active agreement per negotiation.** Several sellers can offer; accepting a different seller's offer replaces the current agreement (a `PAYEE` change). It does not split a purchase.
- **A seller's category claim is not authority.** The engine uses the catalog's category for each SKU; a mismatch is shown to the operator and, if the category is not allowed, refused.
- **Deadlines use the server clock** at the moment each call runs; there is no timer, so a timed-out negotiation shows as `OPEN` in the database until something reads or sweeps it (reads and writes always apply it first).
- **Denied acceptances leave a denied proposal, not a transaction.** Their evidence is in `negotiation_policy_checks` and the audit log (not in `policy_decisions`, which requires a transaction).
- **Nothing here talks to PayPal.** `ELIGIBLE` is the policy engine's local answer; the PayPal observation checks of later steps (G1/G2) are not part of it, and no PayPal behaviour is verified.
- The pending-revision notice and the "identical terms" rule compare the stored `terms_hash` only; they do not judge whether a change is _good_.
- Demo-grade operator authentication (shared passcode) as in MANDATE.md §9; no screen-reader testing; browser checks used Chromium only, by DOM inspection (screenshots could not be captured in this environment).

## 11. Where each requirement is covered

| Requirement                                            | Mechanism                                                                       | Tests                                                                           |
| ------------------------------------------------------ | ------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| Buyer requests and constraints                         | `negotiations` (immutable request, deadline)                                    | `proposals.test.ts` (opening), `schema.test.ts`                                 |
| Multiple seller offers                                 | Per-seller chains in one negotiation                                            | `proposals.test.ts`, `demo.test.ts`                                             |
| Structured counteroffers                               | `BUYER_COUNTER` with explicit total, currency, category, deliverables, deadline | `proposals.test.ts` (counter-offers)                                            |
| Explicit price/currency/category/deliverables/deadline | Columns + `terms_hash`                                                          | `domain.test.ts`, `proposals.test.ts`                                           |
| Agreement acceptance and versioning                    | `negotiation_agreements` v1, v2…                                                | `acceptance.test.ts`, `changes-after-approval.test.ts`                          |
| Rejection and timeout                                  | §7                                                                              | `lifecycle.test.ts`                                                             |
| Every offer/counter stored as a versioned record       | Immutable rows, contiguous versions, triggers                                   | `schema.test.ts`, `proposals.test.ts`                                           |
| Changes invalidate approval                            | §6                                                                              | `changes-after-approval.test.ts`                                                |
| Policy engine before payment eligibility               | §5                                                                              | `acceptance.test.ts`, `changes-after-approval.test.ts`                          |
| Price change after approval                            | §6                                                                              | `changes-after-approval.test.ts` (price)                                        |
| Category changes                                       | §6                                                                              | `changes-after-approval.test.ts` (category)                                     |
| Expired offers                                         | §7                                                                              | `acceptance.test.ts` (expired), `lifecycle.test.ts`                             |
| Mismatched currency                                    | Engine `CURRENCY_MISMATCH`                                                      | `acceptance.test.ts`, `changes-after-approval.test.ts`                          |
| Substituting a payee                                   | Schema + engine claims + no payee input                                         | `acceptance.test.ts` (substituting a payee), `proposals.test.ts`, `api.test.ts` |
| Meaningful explanations in the UI                      | §9, `policy-explanations.ts`                                                    | `views.test.tsx`, `domain.test.ts`                                              |

Run just these: `npx vitest run test/negotiation`.

## 12. Verification (what was actually run)

Run on 2026-10-12, Node 24.18.0, on the final code, in the project and again in a fresh copy (`npm ci`, then every check):

| Check                       | Result                                                                                                                                 |
| --------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| `npm run typecheck`         | exit 0                                                                                                                                 |
| `npm run lint`              | exit 0                                                                                                                                 |
| `npm run format:check`      | passes                                                                                                                                 |
| `npm test`                  | **48 files, 2013 tests, 0 failed**; three consecutive runs identical                                                                   |
| of which `test/negotiation` | 183 tests in 10 files: proposals, acceptance, changes after approval, lifecycle, schema, domain, demo agents, HTTP API, UI views, docs |
| of which `test/agents`      | 263 tests in 7 files                                                                                                                   |
| of which `test/policy`      | 1046 tests in 6 files (policy 1.1.0)                                                                                                   |
| `npm run build`             | exit 0                                                                                                                                 |
| `npm audit`                 | 0 vulnerabilities                                                                                                                      |

- **Mutation check.** 24 deliberate weakenings of the workflow (a refusal ignored; an old agreement not retired when replaced; an agent allowed to approve, open, reject or reject an agreement; the timeout or an offer's validity made exclusive; an identical re-issue accepted; changes allowed after payment started; the retiring deal double-counted in the budget; eligibility judged as the asker; closed negotiations accepting offers; a counter-offer acceptable; five change kinds no longer classified; payee-looking keys no longer flagged; the payee claim taken from the catalog; retirement under a payment in progress; pending revisions unreported) were applied one at a time, and every one made tests fail. The first pass found one survivor (the exact instant an offer's validity ends when a read applies the deadline); a boundary test was added and that mutation is now caught. Files were restored byte-for-byte (checksums verified).
- **Real browser** (Chromium pane, production build, throwaway database, deleted afterwards): sign-in; a form with an invalid budget and an empty description showed the field error beside the field; opening a negotiation; running the demo agents; the live policy preview on the recorded offer; accepting it; approving it with a confirmation step; a seller revision posted through the API showing as a **pending change** with payment still following the agreed version; accepting it, which retired v1 with its approval marked invalid and the reason in words; no horizontal overflow and no tap target under 40 px at 375 px and 768 px. Checked by reading the page and measuring the DOM; **screenshots could not be captured** in this environment, so nothing was judged by eye.
- **Found and fixed while building:** the policy engine denied every negotiated discount (now 1.1.0, catalog price is a ceiling); an eligibility check asked by an agent was judged as if the agent were creating the order; a SKU swap at the same price was also reported as a price change; the mock seller rewrote its terms text on every revision (reported as a scope change); the accepted offer carried a redundant "identical" note; the retirement note claimed a new approval was needed even where the mandate does not require one; a 20,000-case policy test timed out under full-suite load (heavy tests now have an explicit timeout).

Not verified: any PayPal behaviour; any live model-provider call (the provider adapter is tested against mocked HTTP only, see [AGENTS.md](AGENTS.md) section 9); screen-reader or keyboard-only use; browsers other than Chromium; behaviour under concurrent operators or multiple server processes (one SQLite writer, single process).
