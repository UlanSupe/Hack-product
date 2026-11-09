# Policy Engine — Test Report

Run on 2026-10-11, Windows 11, Node 24.18.0, Vitest 5.0.3. Subject: `src/domain/policy.ts` (`pactpay-policy/1.0.0`) and the two small modules it shares with persistence (`src/domain/offer.ts`, `src/domain/mandate-hash.ts`). Specification: [POLICY_ENGINE.md](POLICY_ENGINE.md).

**Verdict: no critical invariant fails in the final engine.** One real gap was found and fixed during the work (section 4), and the suite was shown to catch 24 of 24 deliberate weakenings of the engine (section 3). Read section 6 before relying on any of it.

## 1. Commands and exact results

| Command                      | Result                                                                                                                       |
| ---------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `npm run typecheck`          | exit 0                                                                                                                       |
| `npm run lint`               | exit 0 (type-checked rules + layer boundaries)                                                                               |
| `npm run format:check`       | "All matched files use Prettier code style!"                                                                                 |
| `npm test`                   | **31 files, 1552 tests, 1552 passed, 0 failed, 0 skipped** (6.7 s). Before this task: 25 files, 511 tests, all still passing |
| `npx vitest run test/policy` | **6 files, 1041 tests, 1041 passed, 0 failed, 0 skipped**                                                                    |
| `npm run build`              | exit 0; all 11 routes built                                                                                                  |
| `npm audit`                  | found 0 vulnerabilities                                                                                                      |

Not repeated for this task: the clean-checkout run (`npm ci` in a fresh copy). No dependency or config changed, so I did not repeat it; the previous task's run covered the same dependency set.

## 2. What the 1041 tests cover

| File                  | Tests | Covers                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| --------------------- | ----: | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `policy.test.ts`      |   550 | Every rule, per subject (388 cases from one shared table); happy path; **subject × state matrix (5 × 18 = 90)** derived from the state machine; boundaries (cap, budget, approval threshold, offer/mandate expiry, honor margin, max safe integer, JPY); the exposure table against the state-machine document; **every one of the 43 reason codes is produced by at least one test**                                                                                                                                      |
| `bypass.test.ts`      |   450 | Malformed and hostile input; subject spoofing; 14 "override" keys at 11 nesting levels (162 tests); wrong types for 11 money fields; impossible dates; throwing getters, Proxies, circular and 100,000-deep claims; frozen decision and untouched input; 30 attack-scenario tests (cap breach, split purchases, altered terms, look-alike sellers, stale/forged mandates, replayed capture, forged approval, agent release)                                                                                                |
| `property.test.ts`    |    20 | Seeded and reproducible. **20,000** random cap/budget/threshold/exposure/approval combinations compared **exactly** (verdict and full reason-code set) with an independent re-implementation; **5,000** random inputs where every ALLOW is re-proved from the raw data; **4,000** stacks of 1–5 violations that must always DENY; **every leaf** of a valid input (50–61 per subject) corrupted with 10 wrong-typed values and removed, none may ALLOW; **10,000** random garbage values; claim and determinism properties |
| `integration.test.ts` |    12 | The engine fed from **real SQLite rows** (a test-only loader): a genuinely agreed transaction is allowed; a newer mandate version makes it stale; a revocation blocks it; two agreements that the schema accepts but that together exceed the budget are denied; off-catalog price/sku and a wrong seller total are refused; both ALLOW and DENY decisions are **stored in `policy_decisions` unchanged**; the engine's total and terms hash equal what persistence stores (5,000 random offers incl. overflow)            |
| `purity.test.ts`      |     6 | Static: the engine reaches only 7 domain files, imports only `zod` / `node:crypto` (hashing) / siblings, and contains no network, filesystem, process, clock, randomness, async or dynamic-code usage. Runtime: with `fetch`, `Date.now` and `Math.random` booby-trapped, all five subjects still evaluate                                                                                                                                                                                                                 |
| `docs.test.ts`        |     3 | `POLICY_ENGINE.md` lists exactly the engine's reason codes with identical wording, names the current policy version, and mentions no unknown code                                                                                                                                                                                                                                                                                                                                                                          |

## 3. Critical invariants

| ID    | Invariant                                                                                                  | Principal evidence                                                                                                    | Result |
| ----- | ---------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- | ------ |
| CI-1  | Anything not exactly the documented shape is denied (never an exception, never ALLOW)                      | shape/type/range/date tests; every-leaf corruption and removal; 10,000 garbage values; hostile getters and Proxies    | holds  |
| CI-2  | No model, agent or client field can override a decision                                                    | 162 "override" tests (unknown field at every level ⇒ `INPUT_INVALID`); agent cannot capture, create or authorize      | holds  |
| CI-3  | ALLOW ⇒ amount ≤ cap and reserved + amount ≤ budget (inclusive), amount > 0, exact decimal-safe arithmetic | 20,000-case exact oracle; 5,000-case ALLOW proof; boundaries ±1; split-purchase and `NEEDS_RECONCILIATION` scenarios  | holds  |
| CI-4  | Client-supplied amount, payee, currency, version, ids and hashes are only compared, never used             | claims tests (13 wrong amounts × 4 subjects, every claim key × 17 wrong values); S1b "claims 1.00 for a 450.00 offer" | holds  |
| CI-5  | A stale, revoked, expired or forged mandate never authorizes new spend                                     | stale/revoked/expired cases; 8 `MANDATE_INTEGRITY` cases; real-database stale and revoked tests                       | holds  |
| CI-6  | An action is legal only from the state the state machine names; replays and duplicates are refused         | 90-case subject × state matrix; duplicate-attempt, duplicate-capture and void-after-capture cases                     | holds  |
| CI-7  | Money-out and approvals are human-only                                                                     | `CAPTURE` operator-only; approval rules (agent / lower-case / wrong agreement / rejected); S9, S9b, S9c               | holds  |
| CI-8  | Altered terms, payee or currency after agreement are detected                                              | terms-hash, payee, currency and total cases; S3–S6; observed-PayPal mismatches                                        | holds  |
| CI-9  | Pure, deterministic, total, immutable                                                                      | purity file; 1,000 repeat evaluations identical; frozen decision; deep-frozen input unchanged                         | holds  |
| CI-10 | The decision record is persistable and traceable                                                           | ALLOW ⇒ no codes / DENY ⇒ ≥ 1 on every sampled decision; real inserts into `policy_decisions`; stable `inputsHash`    | holds  |

### Do the tests actually bite? Mutation check

I weakened the engine one guard at a time, ran `test/policy` (1,036 tests at that point; the later additions were the docs and persistence round-trip tests), and restored the file byte-for-byte (SHA-256 checked afterwards). Every mutation made tests fail; none survived.

| Mutation                                              | Tests that failed | Mutation                                             | Tests that failed |
| ----------------------------------------------------- | ----------------: | ---------------------------------------------------- | ----------------: |
| cap made exclusive (`>=`)                             |                 6 | mandate integrity check removed                      |                35 |
| budget made exclusive                                 |                 6 | duplicate-capture / void-after-capture block removed |                 6 |
| actor check removed                                   |                 9 | category check removed                               |                19 |
| state check removed                                   |                90 | own transaction double counted                       |                 1 |
| stale-version check removed                           |                12 | calendar-date validation removed                     |                 5 |
| mandate expiry made inclusive                         |                 5 | observed amount check removed                        |                 4 |
| offer expiry made inclusive                           |                 3 | approval requirement check removed                   |                16 |
| revocation check removed                              |                20 | decision no longer frozen                            |                11 |
| terms-hash check removed                              |                 3 | `POLICY_ERROR` code renamed (see note)               |                 3 |
| client amount claim ignored                           |                58 | approval threshold made inclusive (`mandate.ts`)     |                 4 |
| input schema relaxed (`strictObject` → `looseObject`) |                15 | unresolved reconciliation stops counting             |                 4 |
| operator-only approval check removed                  |                 9 | honor margin made exclusive                          |                 2 |

Note: the `POLICY_ERROR` row renames the code rather than making the catch block fail open; it shows the stable code is pinned, not that an internal error cannot allow. That property is guaranteed structurally (the `catch` returns a `DENY` built only from a `POLICY_ERROR` finding) and by the throwing-getter test. "Own transaction double counted" is caught by a single test, the thinnest coverage of the 24.

## 4. What the work found

**Engine: no invariant test failed against the final code.** The first run of the rule tests had 7 failures and the first run of the adversarial tests had 2, all in my tests, not the engine:

- 7 cases meant to test "no approval" were built on a helper that attached an approval (a test-design error; fixed by clearing it).
- 2 cases asserted wrong expectations (`mandate.terms.maxTransactionMinor` is a real field, not an "extra" one; a `null` catalog price is a valid input meaning "not in catalog").

**One genuine gap was found and fixed before finishing.** The second of those mistakes exposed a real hole: the engine trusted the mandate terms it was handed, so a loader bug that passed **draft** terms, or a hand-edited row, would have been evaluated as if approved. That is the exact failure the mandate feature promises cannot happen ("editing a draft must not silently change the rules of an existing transaction"). Fix: the engine now recomputes the approved version's content hash from the terms and denies on mismatch (`MANDATE_INTEGRITY`), with the hash function shared with persistence (`src/domain/mandate-hash.ts`). Covered by 8 forged-row cases, a real-database test and a mutation.

**Smaller hardening done on the way:**

- Timestamps are validated as real calendar dates: `Date.parse("2026-02-30…")` silently rolls over to 2 March, which could have extended a deadline.
- The offer total and terms hash now have one definition (`src/domain/offer.ts`) used by both persistence and the engine, with a test comparing them on 5,000 random offers.

## 5. Judgement calls to confirm (details in POLICY_ENGINE.md §6)

1. **Capture is not blocked by a newer non-revoked mandate version or by mandate expiry** (revocation does block it), following guard G2 in the state-machine document. Stricter is a one-line change.
2. **Capture is operator-only**, narrower than the state-machine text, which also allows a pre-registered release rule.
3. **Void is allowed for an agent and ignores mandate state**, because it only reduces exposure.

## 5a. Addendum: policy 1.1.0 (the catalog price is a ceiling)

When the negotiation workflow was built, the rule "a line's unit price must equal the catalog price" turned out to deny **every negotiated discount**, so no negotiated deal could ever be allowed. Version **1.1.0** changes that one rule to "a line may be priced at or below the catalog price"; a mark-up, or an item missing from the catalog, is still `PRICE_NOT_IN_CATALOG`. A buyer can never pay more than the catalog price, and a lower price only helps the buyer. The engine's behaviour therefore changed after this report was written: the counts in sections 1–3 are for 1.0.0. The policy suite was re-run with the change (one new case for the discount, one integration test updated); its current totals are in NEGOTIATION.md. This is a decision for the project owner to confirm (POLICY_ENGINE.md §6, item 5).

## 6. Limits of this evidence (honest list)

- **The engine is not wired into payment execution.** (It has since been wired into the negotiation workflow's acceptance and eligibility checks.) Everything above shows the function is correct, not that the system is safe. Nothing calls it for `AUTHORIZE`, `CAPTURE` or `VOID`.
- **The engine judges only the facts it is given.** It cannot detect an incomplete `others` list, a false `attempts` flag or a fabricated `observed` value; the loader (week two) must build these from the database in the same transaction as the state change. The test loader in `integration.test.ts` is a preview, not the production one.
- **The oracle and the engine were written by the same author** from the same documents. Their agreement shows internal consistency, not that the documents are right. The mutation check and the real-database tests reduce, but do not remove, that risk.
- **Property tests are seeded random samples**, not proofs. Iteration counts are the loop bounds in the code; I did not measure how many of the sampled cases landed on each boundary beyond the in-test guards (`allowed > 300`, `multi > 1000`).
- **No PayPal behavior is tested.** `observed` values are supplied by the test; how PayPal objects map to `payeeRef`, amounts and statuses is unverified (ARCHITECTURE §2.2).
- **Not run:** a clean-checkout reproduction (see section 1), concurrency tests (nothing concurrent exists yet), and any test with a real browser (the engine has no UI).
- **Money is single-currency per mandate**; mixed-currency exposure is denied, not converted.
