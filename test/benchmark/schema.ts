import { z } from "zod";

/**
 * The benchmark's data model (docs/ADVERSARIAL_BENCHMARK.md). One RunRecord per (case, execution mode, model);
 * the report is computed from the records and from nothing else, so every number in it can be traced to a record.
 */

export const BENCHMARK_SCHEMA_VERSION = "pactpay-benchmark/1";

/** What kind of harness executed the run. Results of different layers are never added together. */
export const LAYERS = ["ARENA", "SYSTEM"] as const;
export type Layer = (typeof LAYERS)[number];

/** UNSAFE_BASELINE = executes what the (simulated) model proposes. PROTECTED = server-side policy enforcement. */
export const MODES = ["UNSAFE_BASELINE", "PROTECTED"] as const;
export type Mode = (typeof MODES)[number];

export const EXECUTION_MODES = [
  /** Arena: pure functions, a simulated in-memory ledger, a simulated model. No database, no PayPal. */
  "SIMULATED_LEDGER",
  /** System: the real services over an in-memory database, a scripted fake PayPal, mock/scripted agents. */
  "IN_MEMORY_SERVICES_FAKE_PAYPAL",
  /** The run did not execute (a SKIPPED record). */
  "NOT_EXECUTED",
] as const;
export type ExecutionMode = (typeof EXECUTION_MODES)[number];

export const BRAINS = ["SUSCEPTIBLE", "CAREFUL"] as const;
export type Brain = (typeof BRAINS)[number];

/**
 * COMPLETED: the run executed and its outcome was judged.
 * MODEL_ERROR: the (simulated or scripted) model layer failed or returned unusable output; the policy was never asked.
 * INFRASTRUCTURE_ERROR: the harness itself failed (setup, exception); says nothing about the system under test.
 * SKIPPED: requested but not executable; carries a reason.
 */
export const STATUSES = ["COMPLETED", "MODEL_ERROR", "INFRASTRUCTURE_ERROR", "SKIPPED"] as const;
export type Status = (typeof STATUSES)[number];

/**
 * How the actual outcome compares with the expected one (COMPLETED runs only).
 * UNEXPECTED_ALLOWED: something that should have been refused or sent to a human went through.
 * FALSE_BLOCK: something legitimate (or that only needed a human) was refused.
 * UNEXPECTED_OTHER: the outcome differs from the expectation in a way that is neither of the above.
 */
export const VERDICTS = [
  "AS_EXPECTED",
  "UNEXPECTED_ALLOWED",
  "FALSE_BLOCK",
  "UNEXPECTED_OTHER",
  "NOT_EVALUATED",
] as const;
export type Verdict = (typeof VERDICTS)[number];

export const HARM_NAMES = [
  "CAP_EXCEEDED",
  "BUDGET_EXCEEDED",
  "OVERPAID",
  "WRONG_PAYEE",
  "WRONG_CURRENCY",
  "UNAPPROVED_ABOVE_THRESHOLD",
] as const;

const count = z.number().int().nonnegative();

export const MetricsSchema = z.strictObject({
  /** Times the system was asked to pay (or do) something it must refuse, or must not do without a human. */
  attemptedViolations: count,
  /** ...of which the protection refused it (policy block, or awaiting a human). */
  blockedViolations: count,
  /** ...of which went through. */
  allowedViolations: count,
  /** ...of which ended safely without being refused (a protected buyer paying the server's own correct figures). */
  correctedViolations: count,
  /** Legitimate requests the system was asked to carry out. */
  legitimateAttempts: count,
  /** ...of which were refused or needlessly held for a human. */
  falseBlocks: count,
  /** Violations that were never attempted because the (simulated) model declined or asked a human first. */
  modelRestraint: count,
  /** Legitimate purchases the model itself did not attempt. */
  modelDeclinedLegitimate: count,
  /** Money that moved on the simulated ledger or the fake PayPal, in minor units. */
  moneyMovedMinor: count,
  /** Harms that were actually realised (money moved wrongly), by name. */
  harms: z.array(z.enum(HARM_NAMES)),
});
export type Metrics = z.infer<typeof MetricsSchema>;

export const RunRecordSchema = z.strictObject({
  runId: z.string().min(1),
  layer: z.enum(LAYERS),
  caseId: z.string().min(1),
  /** One distinct attack in the benchmark's own terms; variants of one generator family share a unit. */
  evidenceUnit: z.string().min(1),
  /** The coarse attack mechanism (arena technique family, or the adversarial suite's attack category). */
  mechanism: z.string().min(1),
  mode: z.enum(MODES),
  executionMode: z.enum(EXECUTION_MODES),
  brain: z.enum(BRAINS).nullable(),
  /** Explicit seed of the generator that produced this case, or null for a hand-written case. */
  seed: z.number().int().nullable(),
  /** SHA-256 of the case's input alone (the same for every mode and model). */
  caseFingerprint: z.string().length(64),
  /** SHA-256 of case input + mode + model + execution mode. */
  inputFingerprint: z.string().length(64),
  /** Set when an earlier case in the benchmark has the same caseFingerprint; such runs are not independent. */
  duplicateOfCase: z.string().nullable(),
  status: z.enum(STATUSES),
  reason: z.string().nullable(),
  expected: z.unknown(),
  actual: z.unknown(),
  verdict: z.enum(VERDICTS),
  metrics: MetricsSchema,
});
export type RunRecord = z.infer<typeof RunRecordSchema>;

export const emptyMetrics = (): Metrics => ({
  attemptedViolations: 0,
  blockedViolations: 0,
  allowedViolations: 0,
  correctedViolations: 0,
  legitimateAttempts: 0,
  falseBlocks: 0,
  modelRestraint: 0,
  modelDeclinedLegitimate: 0,
  moneyMovedMinor: 0,
  harms: [],
});
