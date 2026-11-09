# Adversarial test suite

A deterministic set of 124 attack scenarios, grouped in 14 categories, that is run against the real policy engine, services and database with a scripted fake PayPal. Every scenario states its initial state, the attack input, the expected policy result, the expected transaction state and the expected audit events. The full list, generated from the fixtures, is in [ADVERSARIAL_CATALOG.md](ADVERSARIAL_CATALOG.md).

A seeded benchmark built on these scenarios, with a baseline, separated result classes and JSON export, is described in [ADVERSARIAL_BENCHMARK.md](ADVERSARIAL_BENCHMARK.md).

## 1. Run it

```bash
npm run adversarial
```

It prints a pass/fail table per attack category, then every failure with what differed and the command that reproduces it:

```
CATEGORY               SCENARIOS  PASSED  FAILED  KNOWN LIMITS
BUDGET_ESCALATION             11      11       0             1
...
TOTAL                        124     124       0             2
```

Re-run one scenario, or one category, with vitest's name filter (the test names start with the scenario id and sit under the category name):

```bash
npm run adversarial -- -t BUD-01
npm run adversarial -- -t WEBHOOK_FORGERY
```

The same tests also run as part of `npm test`. To refresh the catalog after editing a fixture: `npm run adversarial:catalog` (a normal run fails if the catalog is stale).

## 2. How a scenario is written

A scenario is data (`test/adversarial/fixtures/*.ts`, type in `types.ts`):

- **initial**: optional mandate overrides, the payee the fake PayPal reports, and _setup steps_ that must succeed (an accepted offer, an approved agreement, a hold...). If a setup step does not do what it says, the scenario fails at that step instead of attacking a state nobody intended.
- **attack**: the steps the attacker (or a faulty agent) performs.
- **expect**: the outcome of the last attack step (policy verdict and reason codes, error kind, webhook status...), the state of every transaction, money moved and money-moving PayPal calls caused by the attack, the audit events the attack must record (in order, with actor, provenance and payload fields), event types that must not appear, and read-only checks on stored rows. An empty audit list means the attack must have recorded _no_ events at all.

Steps use the real services: the negotiation, mandate, payment and webhook services, the policy engine called directly with a mutated input, the agent layer with the hostile-seller fixtures and scripted model replies, and raw SQL for attacks on the database.

### Attack categories

| Category              | Scenarios | What the attacker tries                                                                                                           |
| --------------------- | --------: | --------------------------------------------------------------------------------------------------------------------------------- |
| BUDGET_ESCALATION     |        11 | Exceed the per-transaction cap or total budget: overpriced, understated, padded, inflated, cumulative; PayPal over-authorizing.   |
| CURRENCY_SUBSTITUTION |         7 | Pay in another currency: EUR/JPY offers, malformed codes, a revision into EUR, PayPal settling in EUR.                            |
| PAYEE_SUBSTITUTION    |         6 | Pay someone else: a seller off the allow-list, an uninvited seller, a payee account in the offer, a tampered payee reference.     |
| CATEGORY_MISMATCH     |         5 | Buy outside the approved category: a storage plan, relabelled SKUs, unknown SKUs, mixed baskets.                                  |
| CHANGED_AGREEMENT     |        10 | Change the deal after approval or after payment started; edit stored agreements.                                                  |
| MANDATE_TAMPERING     |        10 | Let an agent write rules; edit, delete or re-pin mandates in SQL; use a stale, revoked or expired mandate.                        |
| PROMPT_INJECTION      |         7 | Hide instructions in seller text (fake authority, Unicode tricks, encoded payloads, payee redirects, urgency).                    |
| APPROVAL_BYPASS       |        11 | Pay without the human approval or fake it: agents and anonymous callers, rejected approvals, forged rows, a review-only mandate.  |
| DUPLICATE_REQUEST     |         8 | Double accept, start, authorize, capture, void; spend the same budget twice.                                                      |
| REPLAY                |         6 | Replay an accepted offer, an approval, a capture, a webhook delivery, an event id with other content, an old delivery.            |
| INVALID_TRANSITION    |         9 | Force or skip states: through the store, with SQL, with no audit event, capture before authorization, void after capture.         |
| MALFORMED_AI_OUTPUT   |        15 | Prose, truncated JSON, authority verbs, smuggled amounts, unknown fields, bad numbers, unknown references, a `force` flag.        |
| DELIVERABLES          |         7 | Missing, dropped, swapped, empty or over-long deliverables; deliverables used as an injection channel.                            |
| WEBHOOK_FORGERY       |        12 | Forged signatures, missing or foreign certificate headers, bad bodies, outages, contradicting events, duplicates, foreign orders. |

### The suite-wide oracle

After every scenario, whatever the fixture says, the runner checks invariants the product promises (`universalViolations` in `run.ts`): the audit hash chain verifies; every capture the system _asked_ PayPal for equals the agreed amount and is not above the cap; no transaction is CAPTURED without a recorded PayPal capture; captured totals stay within the budget. A fixture cannot forget to check them. (`integrity.test.ts` proves the oracle fires: a privileged edit of history that satisfies every other expectation still fails the scenario.)

## 3. Determinism and isolation

- **Deterministic.** The clock, the ids and the PayPal fake are injected and scripted; nothing reads the wall clock, randomness, the environment or the network. `integrity.test.ts` runs every scenario twice, and again in reverse order, and requires an identical transcript (outcomes, transaction states, money, PayPal calls and every audit event hash).
- **Never touches a payment account.** The only payment provider in the world is `createFakePayPal` (`world.ts`); the suite imports no PayPal client, environment loader or credential module and reads no environment variable (checked statically in `integrity.test.ts`); `fetch` is replaced by a trap for the whole run and any call fails it. No credentials are needed, none are used, and a real or sandbox account cannot be reached from this directory.

This is enforced by tests and by construction, not by an operating-system sandbox: a developer who deliberately wrote network code into the suite would be stopped by the trap and the static checks, not by the machine.

## 4. What it showed

Results of the last run (`npm run adversarial`): **124 of 124 scenarios behave as specified**; 2 are marked as known limitations. `npm test`: 76 files, 2935 tests passed.

**Does the suite catch regressions?** A suite that cannot fail proves nothing, so the product code was deliberately broken in 59 ways (one rule or guard removed at a time, then in groups): the per-transaction cap, the budget, currency, allow-list, category, price ceiling, human approval, who may approve, actor permissions, duplicate-attempt and duplicate-capture rules, mandate revoked/stale/expired/forged, total and terms-hash comparisons, PayPal amount/currency/payee comparison, webhook signature, duplicate, replay, size and certificate checks, who may touch mandates, and several database triggers. Every removal was caught by at least one scenario, with these exceptions that are **not** gaps in the suite but redundant layers:

- Removing _one_ of several overlapping controls changes nothing observable, because another layer still refuses: the offer-currency rule (four layers; removing all four fails five scenarios), the capture pre-flight state guard (removing every guard fails `REP-03` and `TRN-05`), the screening of payee-looking keys (the strict offer schema rejects the same field anyway), and the accept-time check that payment has not started (a second guard in the store refuses the same request; removing both fails `CHG-03` and `CHG-05`).
- One real gap was found by this exercise: no scenario attacked the database rule that a state change must cite a new audit event. `TRN-09` was added and kills that mutant.

The mutation runs were done by hand with throw-away scripts (they edit source files in place, so they are not shipped) and each run restored the files and verified their checksums. They are evidence about the suite as it stands today, not a standing test.

## 5. Limitations (read these before relying on it)

- **The PayPal side is a fake.** It reproduces the documented shapes of the Orders and Payments APIs, so these scenarios prove how _our_ code reacts, not how PayPal behaves. Nothing here was run against the real sandbox, and the project has still never been run against it (see [PAYPAL_INTEGRATION.md](PAYPAL_INTEGRATION.md)).
- **The AI is simulated.** Agent scenarios use the deterministic mock agents, the hostile-seller fixtures and scripted model replies. They show that structure, validation and the policy engine hold; they say nothing about how a real language model would behave.
- **Policy-only scenarios test the engine, not the loader.** Steps of kind `policy` evaluate a mutated, otherwise valid input. They prove the rule fires; the scenarios that go through the services prove the real loaders build the inputs from stored rows.
- **Expectations pin current, believed-secure behaviour.** Each expected value was derived from the product's rules and checked against what the system actually did, but the suite cannot find an attack nobody wrote. 124 scenarios are not a proof of safety.
- **Two scenarios document limitations rather than prevention:**
  - `BUD-09`: if PayPal itself captured more than asked, the money has moved. The system only ever asks for the agreed amount, detects the discrepancy, freezes the transaction for reconciliation and audits it; it cannot undo the capture.
  - `DLV-01`: the policy engine does not judge whether an offer's deliverables satisfy the request (money, payee, currency, category and terms integrity only). The protection is the human approval gate; an offer below the approval threshold that omits a required deliverable would not be stopped by the server.
- **One suite, one process.** Scenarios run on in-memory SQLite one after another; real concurrency (two requests racing) is covered by the payment and webhook tests, not here. Duplicate-request scenarios send the second request after the first completed.
