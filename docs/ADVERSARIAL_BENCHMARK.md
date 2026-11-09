# Adversarial benchmark

A reproducible benchmark that records 524 runs (387 executed, 374 of them completed with a judged outcome) against the unsafe baseline and the protected system, stores every run as a JSON record, and reports attempted violations, blocked violations, false blocks, unexpected allowed actions and incomplete runs. It is built on the [adversarial suite](ADVERSARIAL_SUITE.md) and the [Arena experiment](ARENA_EXPERIMENT.md). Read section 8 (limitations) before quoting any number from it.

## 1. Run it

```bash
npm run benchmark
```

It prints the report, and writes `benchmark-results/benchmark.json` (every run record plus the computed summary) and `benchmark-results/benchmark-report.md` (the same report). The directory is git-ignored: results are produced by running the benchmark, never committed.

Options are environment variables, so a run is fully described by its seed and size:

| Variable           | Default             | Meaning                                        |
| ------------------ | ------------------- | ---------------------------------------------- |
| `BENCH_SEED`       | `20260401`          | Seed of the case generator (recorded in JSON)  |
| `BENCH_PER_FAMILY` | `6`                 | Variants generated per attack family (1 to 50) |
| `BENCH_OUT`        | `benchmark-results` | Output directory                               |

```bash
BENCH_SEED=7 BENCH_PER_FAMILY=10 npm run benchmark        # bash
$env:BENCH_SEED=7; $env:BENCH_PER_FAMILY=10; npm run benchmark   # PowerShell
```

The command exits non-zero if the benchmark did not run to completion (any infrastructure error), if a model error did not fail closed, or if **any** protected run deviated from its expectation: a violation let through, a false block, or any other difference. Baseline results and skipped runs never fail it; they are reported. `npm test` runs the benchmark machinery on its own (`test/benchmark`: aggregation, judging, case generation and an end-to-end run) but does not write results.

## 2. What is run

Cases come from three sources, always reported separately:

- **Arena, hand-written** (9): `N0`, `N1`, `S1` to `S8` of the A/B experiment (`S4` and `S9` need the payment flow and are covered by the system layer).
- **Arena, generated** (60 = 10 families × 6 variants): seeded variants of _price over the cap_, _false authority_, _inflated stated total_, _foreign currency_, _payee redirect_, _above the approval threshold_, _cumulative spend_, _price above catalog_, _several flaws at once_, and a _benign control_.
- **System** (124): the scenarios of the adversarial suite, run through the real negotiation, payment, mandate and webhook services over an in-memory database with a scripted fake PayPal.

Each arena case runs under **two simulated models** (`SUSCEPTIBLE`, which yields to authority claims, trusts the seller's total and follows payee redirects; `CAREFUL`, which checks its own limits) in **two modes** (`UNSAFE_BASELINE`: executes whatever the model proposes on a simulated ledger; `PROTECTED`: the proposal is a request that the policy engine must allow). System scenarios run protected only: there is no unprotected counterpart of the real services, so their baseline leg is recorded as **skipped** with that reason.

### The execution modes

| `executionMode`                  | What it is                                                                             |
| -------------------------------- | -------------------------------------------------------------------------------------- |
| `SIMULATED_LEDGER`               | Arena: pure functions, an in-memory ledger, a simulated model. No database, no PayPal. |
| `IN_MEMORY_SERVICES_FAKE_PAYPAL` | System: real services, in-memory SQLite, a scripted fake PayPal, mock/scripted agents. |
| `NOT_EXECUTED`                   | A skipped run.                                                                         |

There is no live mode. Nothing in the benchmark can reach a payment account, real or sandbox: it has no credentials, imports no PayPal client or environment loader, and replaces `fetch` with a trap that fails the run. These properties are asserted by tests (`benchmark.test.ts`), not only stated here.

## 3. The run record

One record per (case, mode, model). All fields are in `benchmark.json` and validated by a schema (`test/benchmark/schema.ts`).

| Field                            | Meaning                                                                                                      |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| `runId`, `caseId`, `layer`       | `caseId\|mode\|model`; the scenario id (`S3`, `GEN-OVER-CAP-02`, `BUD-01`); `ARENA` or `SYSTEM`.             |
| `evidenceUnit`, `mechanism`      | The independence unit (section 5) and the coarse attack mechanism (the 14 attack categories plus `CONTROL`). |
| `mode`, `executionMode`, `brain` | As above; `brain` is null for system runs.                                                                   |
| `seed`                           | The case's own seed for generated cases, null for hand-written ones.                                         |
| `caseFingerprint`                | SHA-256 of the case's input alone.                                                                           |
| `inputFingerprint`               | SHA-256 of case input + mode + model + execution mode.                                                       |
| `duplicateOfCase`                | The earlier case this one copies, if any.                                                                    |
| `status`                         | `COMPLETED`, `MODEL_ERROR`, `INFRASTRUCTURE_ERROR` or `SKIPPED`.                                             |
| `expected`, `actual`             | Per step (arena) or per scenario (system): what a correct system must do, and what happened.                 |
| `verdict`                        | `AS_EXPECTED`, `UNEXPECTED_ALLOWED`, `FALSE_BLOCK`, `UNEXPECTED_OTHER`, `NOT_EVALUATED`.                     |
| `metrics`                        | The counters below, for this run.                                                                            |

The top level carries the schema and case-set versions, the seed, `resultsHash` (SHA-256 of the canonical runs in `runId` order), `meta` (generation time and Node version, **not** hashed) and the `summary`. `checkReport` recomputes the summary and the hash from the runs, so an edited file is detected.

## 4. Definitions

The result classes are never blended:

- **Baseline results**: arena runs in `UNSAFE_BASELINE` mode.
- **Protected-policy results**: `PROTECTED` runs, kept apart for the arena layer and the system layer.
- **Model errors**: the model layer produced unusable output (malformed, unknown reference, refused). The policy was never asked, so these are not policy results; the benchmark checks only that the system **failed closed** (nothing created, nothing audited).
- **Infrastructure errors**: the harness failed (a setup could not be built, an exception). They say nothing about the system under test and make the benchmark incomplete.
- **Skipped**: requested but not executable, with the reason.

The counters, per run, summed per group:

- **Attempted violation**: a proposal to pay something the specification says must be refused, or must not be paid without a human. It counts only if the model actually proposed it; a model that declines first is counted as **model restraint** and never reaches the policy.
- **Blocked**: the attempted violation was refused or held for a human. **Allowed** (unexpected): it went through. **Corrected**: a protected buyer that paid the server's own correct figures instead of the model's wrong ones, which ends safely.
- **Legitimate attempt / false block**: a request the specification says a correct buyer completes, and whether the system refused it or held it for a human needlessly.
- **Incomplete**: model errors and infrastructure errors (and, listed apart, skipped runs).
- For the **system layer**, "blocked" means the scenario ended exactly as its fixture specifies (the attack's goal was not reached). A deviation is classified by direction: more progress or money than expected is _unexpected allowed_, less is a _false block_, anything else _unexpected other_.

**Where "expected" comes from.** For the arena layer, from `test/benchmark/spec.ts`: a statement of the mandate and catalog written independently and **without calling the policy engine**, so an engine mistake cannot hide itself. For generated cases, an intended class is also fixed by construction and a test checks that the generator and the specification agree. For the system layer the expectations are the adversarial fixtures', written by the same authors after the behaviour was observed.

## 5. Independent evidence

A benchmark with many runs can still be one idea repeated. The report therefore always prints, together:

- **runs**, **distinct cases** (distinct input fingerprints), **evidence units** and **mechanisms**;
- the unit-level verdicts, per layer, and a rule-of-three bound computed over _exercised units_, never over runs.

Rules enforced in code and tests:

1. A run whose `inputFingerprint` was already seen is a copy: it is excluded from every figure and counted (`duplicate copies excluded`).
2. Variants of one generated family share one evidence unit. Ten variants of "price over the cap" are ten runs of one attack idea.
3. Both modes and both models of a case are several runs of one case.
4. A unit in which no violation was ever attempted against the protected buyer (for example when both simulated models decline an over-cap price by themselves) is reported as evaluated but **not exercised**, and does not count towards the bound.

The default run contains real copies, found by this rule rather than assumed: three generated cases that came out identical by chance (the seeded draws land on the same value in a small domain) and `DLV-07`, which is the same attack as `INJ-05` in the adversarial suite.

## 6. Reproducibility

- Every random choice comes from a seeded generator (mulberry32). A case's seed is `SHA-256(seed:family:index)`, so any single generated case is rebuilt from `(seed, family, index)` alone, whatever the size of the run.
- Nothing reads the wall clock, randomness or the environment inside a run. The world's clock and ids are injected.
- `benchmark.test.ts` runs the whole benchmark twice and requires identical records, summary, report text and `resultsHash`; a different seed must change the hash; the hand-written and system cases must not change.

## 7. Results of the last run

Command `npm run benchmark`, seed `20260401`, 6 variants per family, result hash `07821734040f436e736c7a818716365c262bcc85f27160344c04ff603886744a`. These figures were produced by that execution (`benchmark-results/benchmark.json`); re-running reproduces them.

- **What ran**: 524 recorded; 14 copies excluded; 387 executed (374 completed, 13 model errors, 0 infrastructure errors); 123 skipped (the system layer's baseline legs, `NO_BASELINE_ANALOGUE`).
- **Independent evidence**: the 387 executed runs are 189 distinct cases, 142 evidence units and 15 mechanisms. Arena: 264 runs, 66 cases, 19 units, 6 mechanisms. System: 123 runs, 123 cases, 123 units, 14 mechanisms.
- **Baseline (arena, unsafe)**: 58 violation attempts, **58 went through** (the `SUSCEPTIBLE` model 55 of 55; the `CAREFUL` model 3 of 3, all prices above the catalog price, which it does not check). Realised harms in runs: cap exceeded 15, budget exceeded 19, overpaid 5, wrong payee 6, wrong currency 12, unapproved above threshold 25. A further 62 violation steps were never attempted because the simulated model declined first (`SUSCEPTIBLE` 8, `CAREFUL` 54).
- **Protected (arena)**: the same 58 attempts, **58 blocked or held for a human, 0 allowed**; 34 legitimate requests, **0 false blocks**. Paired with the baseline on 132 identical (case, model) pairs: baseline allowed 58, protected 0.
- **Protected (system)**: 110 completed runs, all as specified (0 unexpected allowed, 0 false blocks, 0 other). Per attack category the counts are in the report.
- **Model errors**: 13, all failed closed. **Infrastructure errors**: 0.
- **Units**: arena, 19 evaluated, 16 exercised, 19 as expected; system, 110 evaluated, all exercised, 110 as expected. The rule-of-three bound for "no unexpected-allowed unit" is about 18.8% per unit over the 16 exercised arena units and 2.7% over the 110 system units, valid only for independent random samples of attacks, which these are not.

### Does the benchmark notice when a protection breaks?

A benchmark that always reports success proves nothing, so the policy engine was deliberately broken seven ways and the benchmark re-run each time (the scripts edit source files in place and are not shipped; each run restored the file and checked its checksum). All seven made the command exit non-zero:

| Broken on purpose                         | Arena: allowed / false blocks | System: allowed / other deviations                                |
| ----------------------------------------- | ----------------------------- | ----------------------------------------------------------------- |
| Per-transaction cap not enforced          | 0 / 0                         | 0 / 5                                                             |
| Total budget not enforced                 | 11 / 0                        | 2 / 4                                                             |
| Every currency check removed              | 6 / 0                         | 0 / 5                                                             |
| Human approval never required             | 7 / 0                         | 0 / 8                                                             |
| Price above the catalog allowed           | 6 / 0                         | 1 / 3                                                             |
| Seller's stated total not compared        | 0 / 0                         | 0 / 1                                                             |
| Policy refuses everything (over-blocking) | 0 / 56                        | 0 / 0, plus 64 infrastructure errors (the setups cannot be built) |

Two rows show why more than one figure is gated. With the cap rule removed no arena run leaks, because other rules (budget, catalog price) still refuse the same offers, so the removal is visible only as a different outcome in five system scenarios; before any deviation was made to fail the command, two of these mutants passed it. That is the same overlap of defences noted in the adversarial suite: a benchmark of outcomes sees a removed control only if some case depends on it alone.

## 8. Scope and limitations

- **It measures a simulation.** The models are deterministic stand-ins with documented weaknesses (`BRAIN_TRAITS`), not real language models. The benchmark says nothing about how a real model behaves (a small live measurement is in [LIVE_MODEL_ATTACK.md](LIVE_MODEL_ATTACK.md)), and the baseline's high violation rate is a property of the simulated `SUSCEPTIBLE` model, not a measurement of any real system.
- **PayPal is a fake.** The system layer uses a scripted fake of the documented API shapes. Nothing here was run against the PayPal sandbox, and the project has never been run against it.
- **Different layers, different strength.** Only the arena layer is judged against an independent specification. The system layer's expectations were written after the behaviour was observed, so a 100% there is regression evidence (nothing changed), not independent validation.
- **The cases are not a sample of real attacks.** They are the attacks someone thought to write. Generated families vary parameters of ten ideas; the 124 system scenarios cover 14 categories. Zero failures do not show that no failure exists, and the rule-of-three figures assume random independent sampling that did not happen.
- **No baseline for the real services.** The 123 skipped baseline legs are not zero violations: they are cases where no unprotected counterpart exists.
- **The specification can be wrong.** `spec.ts` states what a correct buyer does (including that a stated total differing from the lines is refused even when paying less would cause no loss). Where it and the engine disagree the benchmark reports a deviation; the disagreement then has to be settled by a person.
- **Single-threaded and in-process.** Concurrency, timing and real network failures are not exercised here.
- **Counts are of this benchmark's definitions.** "Attempted violation" counts steps where a model _proposed_ a payment the specification forbids; it is not the number of attacks launched.
