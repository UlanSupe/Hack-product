# The end-to-end user journey

One path from "I want to buy something" to "it was paid, and here is the proof", with the attack replay at the end. Every page shares one header, one navigation and one progress bar; the progress shown is read from stored state, never remembered in the browser.

## 1. The nine steps

| #   | Step                                      | Where                                        | What decides it                                                       |
| --- | ----------------------------------------- | -------------------------------------------- | --------------------------------------------------------------------- |
| 1   | Start a transaction scenario              | `/` (Start)                                  | You pick a fixture; it only pre-fills the task form                   |
| 2   | Review or configure the financial mandate | `/mandate`                                   | You. The server stores an immutable, versioned mandate                |
| 3   | Submit the task                           | `/negotiations` (open form)                  | You submit; the server validates every field                          |
| 4   | Compare seller offers                     | `/negotiations#threads-h`                    | Offers are stored as numbered versions, with the server's own total   |
| 5   | Observe the agent negotiation             | `/negotiations#threads-h`                    | The (mock) agents only propose; each proposal is marked "by agent"    |
| 6   | Inspect the agreement and policy decision | `/negotiations#agr-h`                        | The deterministic policy engine, with reason codes in plain words     |
| 7   | Run the protected payment workflow        | `/negotiations#pay-h`                        | Operator-only steps; the server reads PayPal before it believes it    |
| 8   | Inspect verification and audit history    | `/cockpit/tx:<id>`                           | Stored records, PayPal's own order read, and the audit-chain verifier |
| 9   | Replay the budget-escalation attack       | `/flagship` (and every scenario at `/arena`) | A **simulation** on throwaway data; never part of your transaction    |

Steps 1 to 8 are your transaction. Step 9 is always labelled a simulation, always shows as "Simulation" in the bar, and never counts toward "8 of 8 done".

## 2. How progress is derived

`GET /api/journey?negotiation=<id>` (operator-only, read-only) assembles the facts the consoles already show (approved mandate, offers and counters, who recorded them, the agreement and its policy state, the payment state, whether PayPal credentials exist, the audit-chain state the Cockpit computes) and passes them to `deriveJourney` in `src/domain/journey.ts`, a pure function. The bar, the start page and the consoles all read the same server records, so they cannot drift apart. The only thing kept in the browser is **which transaction is followed**, in the address (`?n=<id>`), so a reload, a shared link and the back button agree. Links between pages carry it.

Status words: **Done**, **Next** (where you should act), **To do**, **Blocked** (a decision or check stands in the way, with its reason), **Unavailable** (cannot run on this server, for example no PayPal credentials), **Simulation**. Colour is never the only signal.

What each step needs (summary of `deriveJourney`; the tests in `test/journey/derive.test.ts` state it case by case):

- Mandate: **Done** with an approved mandate, else **Blocked** with the instruction to create one.
- Offers: **Done** with at least one stored seller offer.
- Negotiation: **Done** if agents recorded proposals or counters; if the agreement was reached by hand it says "No agent was run", rather than pretending.
- Agreement: **Done** when the agreement passes the policy engine (and has your approval where required); **Next** while it awaits approval; **Blocked** with the policy reason code when an offer was refused or the engine blocks the agreement.
- Payment: **Done** only for a captured payment (PayPal's capture observed) or a released hold (it says nothing was charged). `FAILED`, `NEEDS_RECONCILIATION` and the like are **Blocked**, never done. Without PayPal credentials it is **Unavailable**, and nothing is simulated in its place.
- Verify: **Done** only when the payment is final and the audit chain verifies; a broken chain is **Blocked**.

## 3. Scenarios are fixtures

`SCENARIOS` in `src/domain/journey.ts`:

- **Buy GPU hours inside the mandate**: a fixture _task_ (made-up values) that pre-fills the form. The records it creates are real records in your database.
- **Replay the budget-escalation attack**: the existing flagship simulation on throwaway data.

A scenario has no authority. It cannot approve a mandate, skip the policy engine or pay anything; the task is submitted through the same validated route as any other.

## 4. Recovery paths

| Situation                           | What happens                                                                                                                |
| ----------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| Not signed in                       | The bar says progress is tracked for the signed-in operator and links to the sign-in; the step links still work             |
| Operator passcode not configured    | The bar and the start page say so and name the setting                                                                      |
| Lost your place (new tab, reload)   | The start page lists your recent transactions with "Continue"; `?n=` in the address reopens one                             |
| Stale or mistyped `?n=`             | A 404 from the server is turned into "That negotiation was not found", the id is dropped from the address, nothing breaks   |
| No approved mandate                 | Task and mandate steps are **Blocked** with the reason; the scenario link explains it instead of showing an empty form      |
| No PayPal credentials               | The payment panel says it cannot start here, disables its button, and points to the README; the other steps still work      |
| Progress cannot be loaded           | A message and a "Try again" button, never a made-up status                                                                  |
| An unexpected error on any page     | `error.tsx` says nothing was paid or changed, offers "Try again" and "Back to the start", and never prints the error's text |
| Unknown page                        | `not-found.tsx` keeps the navigation and links to the start                                                                 |
| A page being prepared on the server | `loading.tsx` shows a labelled loading state                                                                                |

## 5. What changed from the earlier layout

- The Arena experiment moved from `/` to **`/arena`** ("Arena (simulation)"); `/` is now the journey start.
- Three hand-copied headers (Arena/flagship/Cockpit shared one, Mandate and Negotiations each had their own) became one `JourneyHeader`; a test fails if a page declares its own.
- The negotiation console reads `?n=` and `?scenario=` and writes `?n=` when you open or select a transaction (before, the selection was lost on reload).
- The PayPal return route redirects to `/negotiations?payment=checked&n=<id>`, where the id comes from the server's record of the order (never from the query), so you land on the same transaction.
- The payment panel, each policy refusal and the end of each transaction link onward to the Cockpit and to the replay.

No security logic was changed. The only new server code is the read-only `/api/journey` route; it is operator-only like every other read of the operator's records and is covered by the route sweep in `test/security/route-sweep.test.ts` (anonymous 401, agents 403, hostile ids handled).

## 6. Tests

`test/journey`:

- `derive.test.ts`: the pure derivation, fact by fact, plus an exhaustive sweep of 2×2×10×6×5 fact combinations asserting nine steps, a current step among the real eight, "complete" only with a final payment and a verified chain, and the simulation never counting as progress.
- `flows.test.ts`: the **primary flow** and the **blocked-payment flow**, end to end through the real routes, policy engine, SQLite and PayPal client against an in-process fake PayPal, asking `/api/journey` after every step:
  - primary: sign-in → mandate in force → fixture task → mock agents → accept (policy ALLOW) → order → buyer approval at PayPal → hold → capture (exactly one capture call) → Cockpit row `CAPTURED`, audit `VERIFIED` → journey complete → flagship replay (baseline pays on a simulated ledger, protected pays 0) leaves the real transaction untouched;
  - blocked: an offer above the cap is refused with `OVER_PER_TX_CAP`, every payment route answers 404, **no request reaches PayPal**, the Cockpit records a `DENIED` refusal with 0 moved; a post-agreement price "revision" with pressure text is refused too and the order PayPal receives is still 80.00, never 120.00; a capture before a hold is refused;
  - recovery: no credentials (payment unavailable, 503, no network call), stale and hostile ids, agents refused, passcode not configured.
- `pages.test.tsx`: the start page (fixtures labelled, nine steps, loading state claims nothing), the shared header on every page, the step list's words and screen-reader text, the error, loading and not-found pages (the error text is never printed).

### Limits of this verification

- The flows are driven through the route handlers, not a real browser. The React client pieces (the provider, the progress bar's fetching, the console wiring) are not mounted by the test suite. They were exercised once by hand in the in-app browser against a production build with a throwaway database and **no PayPal credentials**: sign-in, scenario pre-fill, opening a task, running the mock agents, accepting an offer (policy check passed), the payment panel's "cannot start" state, the Cockpit detail and the replay page, deep links, a stale `?n=`, and a 375 px-wide layout. That is a manual check on one machine, not an automated one.
- The payment steps in the browser (order, approval at PayPal, hold, capture) were **not** exercised, because no sandbox credentials exist here. They are covered only by the fake-PayPal tests, as before; nothing about the real PayPal sandbox is verified. See [PAYPAL_INTEGRATION.md](PAYPAL_INTEGRATION.md).
- The agents are the deterministic mocks. "Observe agent negotiation" shows what they recorded; the mock seller made one offer and no counter-offers in the run above.
