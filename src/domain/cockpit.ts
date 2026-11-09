import { z } from "zod";

import { canonicalJson, sha256Hex } from "./canonical.ts";
import { SUPPORTED_CURRENCIES, formatMinor, type SupportedCurrency } from "./mandate.ts";

/**
 * The Cockpit's data model: one flat row per thing an operator may want to look at, built ONLY from records that the
 * system itself stored (transactions, policy checks, attack runs, a persisted benchmark file). Nothing is estimated,
 * sampled or filled in: a value the source does not hold is null and shows as "not recorded".
 *
 * Pure: no I/O, no clock. The adapters read the facts; this file maps them to rows, filters rows, and verifies the
 * benchmark file. docs/COCKPIT.md explains each column and where it comes from.
 */

/* ------------------------------------------------------------------ vocabulary */

export const SOURCES = ["TRANSACTION", "REFUSED_OFFER", "ATTACK_RUN", "BENCHMARK"] as const;
export type CockpitSource = (typeof SOURCES)[number];

export const SOURCE_LABEL: Record<CockpitSource, string> = {
  TRANSACTION: "Transaction (database)",
  REFUSED_OFFER: "Refused offer (database)",
  ATTACK_RUN: "Attack run (database)",
  BENCHMARK: "Benchmark run (file)",
};

export const BUYER_MODES = ["PROTECTED", "UNSAFE_BASELINE"] as const;
export type BuyerModeName = (typeof BUYER_MODES)[number];

/**
 * What the system decided about the money:
 * ALLOWED (policy allowed it, or a protected run paid), DENIED (policy refused), HELD_FOR_HUMAN (only a human's approval
 * is missing), EXECUTED_UNCHECKED (the intentionally unsafe baseline paid with no check), MIXED (some steps paid, some
 * did not), NO_ACTION (nothing was attempted or the event was ignored), NOT_EVALUATED (no decision recorded).
 */
export const DECISIONS = [
  "ALLOWED",
  "DENIED",
  "HELD_FOR_HUMAN",
  "EXECUTED_UNCHECKED",
  "MIXED",
  "NO_ACTION",
  "NOT_EVALUATED",
] as const;
export type Decision = (typeof DECISIONS)[number];

/**
 * Whether the audit hash chain vouches for the row's events. The chain is one log, so this is a property of the log
 * and of where the row's events sit in it: VERIFIED (the whole chain verifies and the row has events), BROKEN (the
 * chain's first invalid event is at or before one of the row's events), NO_EVENTS, NOT_RECORDED (the source does not
 * keep audit events, e.g. a benchmark file) and UNKNOWN (the log could not be read).
 */
export const AUDIT_STATES = ["VERIFIED", "BROKEN", "NO_EVENTS", "NOT_RECORDED", "UNKNOWN"] as const;
export type AuditState = (typeof AUDIT_STATES)[number];

export const VERIFICATION_BASES = ["PAYPAL", "BENCHMARK", "NONE"] as const;
export type VerificationBasis = (typeof VERIFICATION_BASES)[number];

export const REASON_SOURCES = ["POLICY", "SPEC", "INVARIANT", "OUTCOME"] as const;
export type ReasonSource = (typeof REASON_SOURCES)[number];

export type CockpitRow = {
  /** Unique across sources; the key of the detail route. */
  id: string;
  source: CockpitSource;
  /** ISO-8601, or null if the source holds none. Benchmark rows carry the file's generation time. */
  timestamp: string | null;
  /** The transaction id, proposal id, attack-run id or benchmark run id. */
  refId: string;
  /** Negotiation id (database rows) or benchmark case id. */
  scenario: string | null;
  /** Service category (database rows) or attack mechanism (benchmark rows). */
  category: string | null;
  buyerMode: BuyerModeName | null;
  currency: string | null;
  /** Minor units. What was asked: the seller's offer total, or the model's proposal. */
  proposedMinor: number | null;
  /**
   * Minor units. What a decision approved: the agreement total (database), or what a protected run paid after the policy
   * allowed it. The unsafe baseline has no approval, so its rows leave this null and show the money in `movedMinor`.
   */
  approvedMinor: number | null;
  /** Minor units. Money that actually moved: captured at PayPal, or debited from a simulated ledger. 0 when nothing moved. */
  movedMinor: number | null;
  decision: Decision;
  reasonCodes: string[];
  reasonSource: ReasonSource | null;
  paymentStatus: string;
  verification: string;
  verificationBasis: VerificationBasis;
  auditChain: AuditState;
};

/** Where the chain stands, as the adapter found it. */
export type ChainFacts =
  | { status: "VERIFIED"; count: number }
  | { status: "FAILED"; count: number; firstBadSeq: number; code: string }
  | { status: "UNREADABLE"; message: string };

export const isSupportedCurrency = (c: string): c is SupportedCurrency => c in SUPPORTED_CURRENCIES;

/** "80.00 USD" for a supported currency, "8000 minor units (XYZ)" otherwise; "not recorded" for null. */
export function formatAmount(minor: number | null, currency: string | null): string {
  if (minor === null) return "not recorded";
  if (currency !== null && isSupportedCurrency(currency))
    return `${formatMinor(minor, currency)} ${currency}`;
  return `${minor} minor units${currency ? ` (${currency})` : ""}`;
}

export const detailHref = (id: string): string => `/cockpit/${encodeURIComponent(id)}`;

/* ------------------------------------------------------------------ audit chain per row */

export function auditStateOf(
  chain: ChainFacts,
  events: { firstSeq: number; lastSeq: number; count: number } | null,
  /**
   * True when this kind of row always has audit events (a transaction, a refusal). If none can be found while the chain
   * is known to be broken, the likely reason is that the broken event is the very one that no longer matches, so the row
   * is BROKEN, not "no events".
   */
  expectEvents = false,
): AuditState {
  if (chain.status === "UNREADABLE") return "UNKNOWN";
  if (events === null || events.count === 0)
    return expectEvents && chain.status === "FAILED" ? "BROKEN" : "NO_EVENTS";
  if (chain.status === "FAILED" && events.lastSeq >= chain.firstBadSeq) return "BROKEN";
  return "VERIFIED";
}

/* ------------------------------------------------------------------ database rows */

export type DecisionFact = {
  id: string;
  subject: string;
  verdict: "ALLOW" | "DENY";
  reasonCodes: string[];
  decidedAt: string;
};
export type EventFact = {
  seq: number;
  ts: string;
  type: string;
  actor: string;
  provenance: string | null;
};
export type AttemptFact = {
  action: string;
  seq: number;
  status: string;
  httpStatus: number | null;
  startedAt: string;
};
export type WebhookFact = {
  paypalEventId: string;
  eventType: string;
  status: string;
  reason: string | null;
};

export type TransactionFacts = {
  txId: string;
  state: string;
  createdAt: string;
  updatedAt: string;
  currency: string;
  mandateId: string;
  mandateVersion: number;
  negotiationId: string | null;
  category: string | null;
  /** The accepted proposal's stated total, if a proposal is linked. */
  proposedMinor: number | null;
  agreement: { id: string; totalMinor: number; payeeRef: string; version: number | null } | null;
  approval: { decision: "APPROVED" | "REJECTED"; decidedAt: string } | null;
  paypalOrderId: string | null;
  authorizedMinor: number | null;
  capturedMinor: number | null;
  decisions: DecisionFact[];
  events: EventFact[];
  attempts: AttemptFact[];
  webhooks: WebhookFact[];
};

const onlyApprovalMissing = (codes: readonly string[]) =>
  codes.length === 1 && codes[0] === "APPROVAL_REQUIRED";

function decisionOfVerdict(d: DecisionFact | undefined): Decision {
  if (!d) return "NOT_EVALUATED";
  if (d.verdict === "ALLOW") return "ALLOWED";
  return onlyApprovalMissing(d.reasonCodes) ? "HELD_FOR_HUMAN" : "DENIED";
}

/**
 * Verification of the PayPal side. Never stronger than what was recorded: OBSERVED means our server read the order from
 * PayPal and stored it as an observed external fact; WEBHOOK_VERIFIED additionally means a webhook whose signature PayPal
 * itself verified was processed. A started payment with neither is UNVERIFIED, and a parked one NEEDS_RECONCILIATION.
 */
export function paypalVerificationOf(
  f: Pick<TransactionFacts, "state" | "paypalOrderId" | "events" | "webhooks">,
): string {
  if (f.state === "NEEDS_RECONCILIATION") return "NEEDS_RECONCILIATION";
  if (f.paypalOrderId === null) return "NOT_APPLICABLE";
  const observed = f.events.some(
    (e) => e.type === "PAYPAL_ORDER_OBSERVED" && e.provenance === "OBSERVED_EXTERNAL",
  );
  const webhook = f.webhooks.some((w) => w.status === "PROCESSED");
  if (observed && webhook) return "WEBHOOK_VERIFIED";
  if (observed) return "OBSERVED";
  return "UNVERIFIED";
}

const spanOf = (events: readonly EventFact[]) =>
  events.length === 0
    ? null
    : {
        firstSeq: Math.min(...events.map((e) => e.seq)),
        lastSeq: Math.max(...events.map((e) => e.seq)),
        count: events.length,
      };

const latest = <T extends { decidedAt: string }>(items: readonly T[]): T | undefined =>
  [...items].sort((a, b) =>
    a.decidedAt < b.decidedAt ? 1 : a.decidedAt > b.decidedAt ? -1 : 0,
  )[0];

export function mapTransaction(f: TransactionFacts, chain: ChainFacts): CockpitRow {
  const d = latest(f.decisions);
  return {
    id: `tx:${f.txId}`,
    source: "TRANSACTION",
    timestamp: f.updatedAt,
    refId: f.txId,
    scenario: f.negotiationId,
    category: f.category,
    buyerMode: "PROTECTED",
    currency: f.currency,
    proposedMinor: f.proposedMinor,
    approvedMinor: f.agreement?.totalMinor ?? null,
    movedMinor: f.capturedMinor ?? 0,
    decision: decisionOfVerdict(d),
    reasonCodes: d?.reasonCodes ?? [],
    reasonSource: d && d.reasonCodes.length > 0 ? "POLICY" : null,
    paymentStatus: f.state,
    verification: paypalVerificationOf(f),
    verificationBasis:
      f.paypalOrderId === null && f.state !== "NEEDS_RECONCILIATION" ? "NONE" : "PAYPAL",
    auditChain: auditStateOf(chain, spanOf(f.events), true),
  };
}

export type RefusedOfferFacts = {
  checkId: string;
  negotiationId: string;
  proposalId: string;
  decidedAt: string;
  category: string | null;
  currency: string;
  proposedMinor: number | null;
  reasonCodes: string[];
  policyVersion: string;
  actor: string;
  explanation: string;
  /** Audit events written for this refusal (matched on the decision's inputs hash). */
  events: EventFact[];
};

export function mapRefusedOffer(f: RefusedOfferFacts, chain: ChainFacts): CockpitRow {
  return {
    id: `refused:${f.checkId}`,
    source: "REFUSED_OFFER",
    timestamp: f.decidedAt,
    refId: f.proposalId,
    scenario: f.negotiationId,
    category: f.category,
    buyerMode: "PROTECTED",
    currency: f.currency,
    proposedMinor: f.proposedMinor,
    approvedMinor: null,
    movedMinor: 0,
    decision: onlyApprovalMissing(f.reasonCodes) ? "HELD_FOR_HUMAN" : "DENIED",
    reasonCodes: f.reasonCodes,
    reasonSource: "POLICY",
    paymentStatus: "NO_TRANSACTION",
    verification: "NOT_APPLICABLE",
    verificationBasis: "NONE",
    auditChain: auditStateOf(chain, spanOf(f.events), true),
  };
}

export type AttackRunFacts = {
  id: string;
  scenarioId: string;
  fixtureVersion: string;
  seed: string;
  mode: BuyerModeName;
  provider: "SIMULATED" | "PAYPAL_SANDBOX";
  transactionId: string | null;
  currency: string;
  mandateCapMinor: number;
  moneyMovedMinor: number;
  invariantsViolated: string[];
  startedAt: string;
  finishedAt: string | null;
  auditFromSeq: number | null;
  auditToSeq: number | null;
  steps: { n: number; outcome: "EXECUTED" | "BLOCKED" | "NO_ACTION"; reasonCodes: string[] }[];
};

export function mapAttackRun(f: AttackRunFacts, chain: ChainFacts): CockpitRow {
  const executed = f.steps.some((s) => s.outcome === "EXECUTED");
  const blocked = f.steps.some((s) => s.outcome === "BLOCKED");
  let decision: Decision;
  if (f.finishedAt === null) decision = "NOT_EVALUATED";
  else if (executed && blocked) decision = "MIXED";
  else if (executed) decision = f.mode === "UNSAFE_BASELINE" ? "EXECUTED_UNCHECKED" : "ALLOWED";
  else if (blocked) decision = "DENIED";
  else decision = "NO_ACTION";
  const policyCodes = [...new Set(f.steps.flatMap((s) => s.reasonCodes))].sort();
  const reasons = policyCodes.length > 0 ? policyCodes : [...f.invariantsViolated].sort();
  const events =
    f.auditFromSeq !== null && f.auditToSeq !== null
      ? {
          firstSeq: f.auditFromSeq,
          lastSeq: f.auditToSeq,
          count: f.auditToSeq - f.auditFromSeq + 1,
        }
      : null;
  return {
    id: `run:${f.id}`,
    source: "ATTACK_RUN",
    timestamp: f.startedAt,
    refId: f.id,
    scenario: f.scenarioId,
    category: null,
    buyerMode: f.mode,
    currency: f.currency,
    proposedMinor: null,
    approvedMinor: f.finishedAt === null || f.mode === "UNSAFE_BASELINE" ? null : f.moneyMovedMinor,
    movedMinor: f.finishedAt === null ? null : f.moneyMovedMinor,
    decision,
    reasonCodes: reasons,
    reasonSource:
      policyCodes.length > 0 ? "POLICY" : f.invariantsViolated.length > 0 ? "INVARIANT" : null,
    paymentStatus:
      f.provider === "SIMULATED"
        ? f.moneyMovedMinor > 0
          ? "SIMULATED_PAID"
          : "NO_PAYMENT"
        : "PAYPAL_SANDBOX",
    verification:
      f.invariantsViolated.length > 0
        ? "INVARIANTS_VIOLATED"
        : f.finishedAt === null
          ? "NOT_FINISHED"
          : "NO_INVARIANT_VIOLATED",
    verificationBasis: "BENCHMARK",
    auditChain: auditStateOf(chain, events),
  };
}

/* ------------------------------------------------------------------ the persisted benchmark file */

const count = z.number().int().nonnegative();
/** The benchmark's own metrics (test/benchmark/schema.ts). The analytics read all of them, so all are required. */
const Metrics = z.object({
  attemptedViolations: count,
  blockedViolations: count,
  allowedViolations: count,
  correctedViolations: count,
  legitimateAttempts: count,
  falseBlocks: count,
  modelRestraint: count,
  moneyMovedMinor: count,
});

const BenchmarkRunSchema = z.object({
  runId: z.string().min(1),
  layer: z.enum(["ARENA", "SYSTEM"]),
  caseId: z.string().min(1),
  evidenceUnit: z.string(),
  mechanism: z.string(),
  mode: z.enum(BUYER_MODES),
  executionMode: z.string(),
  brain: z.string().nullable(),
  seed: z.number().nullable(),
  caseFingerprint: z.string(),
  inputFingerprint: z.string(),
  duplicateOfCase: z.string().nullable(),
  status: z.enum(["COMPLETED", "MODEL_ERROR", "INFRASTRUCTURE_ERROR", "SKIPPED"]),
  reason: z.string().nullable(),
  expected: z.unknown(),
  actual: z.unknown(),
  verdict: z.string(),
  metrics: Metrics,
});
export type BenchmarkRun = z.infer<typeof BenchmarkRunSchema>;

const BenchmarkFileSchema = z.object({
  schemaVersion: z.literal("pactpay-benchmark/1"),
  benchmarkVersion: z.string(),
  seed: z.number(),
  perFamily: z.number(),
  resultsHash: z.string().length(64),
  meta: z.object({ generatedAt: z.string(), node: z.string() }),
  runs: z.array(z.unknown()),
});

export type BenchmarkFile = {
  seed: number;
  perFamily: number;
  benchmarkVersion: string;
  generatedAt: string;
  resultsHash: string;
  runs: BenchmarkRun[];
};

export type BenchmarkParse =
  | { ok: true; file: BenchmarkFile }
  | { ok: false; code: "INVALID_JSON" | "INVALID_SHAPE" | "HASH_MISMATCH"; message: string };

/** SHA-256 of the canonical runs in runId order: the same function the benchmark used when it wrote the file. */
export function benchmarkHashOf(runs: readonly { runId: string }[]): string {
  return sha256Hex(
    canonicalJson([...runs].sort((a, b) => (a.runId < b.runId ? -1 : a.runId > b.runId ? 1 : 0))),
  );
}

/**
 * Parses a benchmark.json and checks its integrity: the schema, and that `resultsHash` matches the runs. A file that
 * fails either check is rejected whole, never shown partially, because a partly edited result is not a result.
 * (A matching hash proves the file was not edited after it was written, not that it was produced by a real run.)
 */
export function parseBenchmarkFile(text: string): BenchmarkParse {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return { ok: false, code: "INVALID_JSON", message: "benchmark.json is not valid JSON." };
  }
  const top = BenchmarkFileSchema.safeParse(json);
  if (!top.success)
    return {
      ok: false,
      code: "INVALID_SHAPE",
      message: `benchmark.json does not have the expected shape (${top.error.issues[0]?.path.join(".") ?? "root"}).`,
    };
  const runs: BenchmarkRun[] = [];
  for (const [i, raw] of top.data.runs.entries()) {
    const r = BenchmarkRunSchema.safeParse(raw);
    if (!r.success)
      return {
        ok: false,
        code: "INVALID_SHAPE",
        message: `benchmark.json run ${i} is malformed (${r.error.issues[0]?.path.join(".") ?? "run"}).`,
      };
    runs.push(r.data);
  }
  let hash: string;
  try {
    hash = benchmarkHashOf(top.data.runs as { runId: string }[]);
  } catch {
    return {
      ok: false,
      code: "INVALID_SHAPE",
      message: "benchmark.json contains values that cannot be hashed.",
    };
  }
  if (hash !== top.data.resultsHash)
    return {
      ok: false,
      code: "HASH_MISMATCH",
      message:
        "benchmark.json does not match its own results hash: it was edited after it was written, or is corrupt.",
    };
  return {
    ok: true,
    file: {
      seed: top.data.seed,
      perFamily: top.data.perFamily,
      benchmarkVersion: top.data.benchmarkVersion,
      generatedAt: top.data.meta.generatedAt,
      resultsHash: top.data.resultsHash,
      runs,
    },
  };
}

type ArenaStep = {
  stepId?: unknown;
  actual?: unknown;
  verdict?: unknown;
  proposal?: { amountMinor?: unknown; currency?: unknown } | null;
};
type ArenaExpectedStep = { violations?: unknown };

const asArray = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const asRecord = (v: unknown): Record<string, unknown> =>
  v !== null && typeof v === "object" ? (v as Record<string, unknown>) : {};
const strings = (v: unknown): string[] =>
  asArray(v).filter((x): x is string => typeof x === "string");

/** How a system scenario's last outcome reads as a decision. First match wins; documented in docs/COCKPIT.md. */
export function decisionOfOutcome(o: Record<string, unknown>): Decision {
  const codes = strings(o.reasonCodes);
  if (o.verdict === "ALLOW") return "ALLOWED";
  if (o.verdict === "DENY") return onlyApprovalMissing(codes) ? "HELD_FOR_HUMAN" : "DENIED";
  if (o.accepted === false) return "DENIED";
  if (typeof o.error === "string") return "DENIED";
  if (typeof o.status === "string") {
    if (o.status === "REJECTED" || o.status === "RETRY") return "DENIED";
    if (o.status === "PROCESSED") return "ALLOWED";
    return "NO_ACTION";
  }
  if (typeof o.failureKind === "string") return "NO_ACTION";
  if (o.agentStatus === "APPROVAL_REQUESTED") return "HELD_FOR_HUMAN";
  if (typeof o.agentStatus === "string") return "NO_ACTION";
  if (o.performed === true) return "ALLOWED";
  if (o.performed === false) return "NO_ACTION";
  return "NOT_EVALUATED";
}

function arenaDecision(mode: BuyerModeName, classes: readonly string[]): Decision {
  const paid = classes.some((c) => c === "PAID_CLEAN" || c === "PAID_HARMFUL");
  const held = classes.includes("AWAITING_APPROVAL");
  const blocked = classes.includes("BLOCKED");
  if (paid && (held || blocked)) return "MIXED";
  if (paid) return mode === "UNSAFE_BASELINE" ? "EXECUTED_UNCHECKED" : "ALLOWED";
  if (held) return "HELD_FOR_HUMAN";
  if (blocked) return "DENIED";
  return "NO_ACTION";
}

export function mapBenchmarkRun(
  run: BenchmarkRun,
  file: Pick<BenchmarkFile, "generatedAt">,
): CockpitRow {
  const base = {
    id: `bench:${run.runId}`,
    source: "BENCHMARK" as const,
    timestamp: file.generatedAt,
    refId: run.runId,
    scenario: run.caseId,
    category: run.mechanism,
    buyerMode: run.mode,
    verificationBasis: "BENCHMARK" as const,
    auditChain: "NOT_RECORDED" as const,
  };
  if (run.status !== "COMPLETED") {
    return {
      ...base,
      currency: null,
      proposedMinor: null,
      approvedMinor: null,
      movedMinor: null,
      decision: run.status === "SKIPPED" ? "NO_ACTION" : "NOT_EVALUATED",
      reasonCodes: [],
      reasonSource: null,
      paymentStatus: run.status === "SKIPPED" ? "NOT_EXECUTED" : run.status,
      verification: run.status,
    };
  }
  const actual = asRecord(run.actual);
  const expected = asRecord(run.expected);
  if (run.layer === "ARENA") {
    // every step is read defensively: a malformed record yields fewer values, never an exception
    const steps = asArray(actual.steps).map(asRecord) as ArenaStep[];
    const classes = steps.map((s) => String(s.actual));
    const amounts = steps.flatMap((s) =>
      typeof asRecord(s.proposal).amountMinor === "number"
        ? [asRecord(s.proposal).amountMinor as number]
        : [],
    );
    const currency =
      steps
        .map((s) => asRecord(s.proposal).currency)
        .find((c): c is string => typeof c === "string") ?? null;
    const moved =
      typeof actual.moneyMovedMinor === "number"
        ? actual.moneyMovedMinor
        : run.metrics.moneyMovedMinor;
    const violations = [
      ...new Set(
        (asArray(expected.steps).map(asRecord) as ArenaExpectedStep[]).flatMap((s) =>
          strings(s.violations),
        ),
      ),
    ].sort();
    return {
      ...base,
      currency,
      proposedMinor: amounts.length > 0 ? amounts.reduce((a, b) => a + b, 0) : null,
      approvedMinor: run.mode === "UNSAFE_BASELINE" ? null : moved,
      movedMinor: moved,
      decision: arenaDecision(run.mode, classes),
      reasonCodes: violations,
      reasonSource: violations.length > 0 ? "SPEC" : null,
      paymentStatus: moved > 0 ? "SIMULATED_PAID" : "NO_PAYMENT",
      verification: run.verdict,
    };
  }
  const outcome = asRecord(actual.outcome);
  const states = strings(actual.txStates);
  const captured = typeof actual.capturedMinor === "number" ? actual.capturedMinor : 0;
  const codes = strings(outcome.reasonCodes);
  const single = [outcome.reason, outcome.error].find((x): x is string => typeof x === "string");
  return {
    ...base,
    currency: null,
    proposedMinor: null,
    approvedMinor: captured > 0 ? captured : null,
    movedMinor: captured,
    decision: decisionOfOutcome(outcome),
    reasonCodes: codes.length > 0 ? codes : single ? [single] : [],
    reasonSource: codes.length > 0 ? "POLICY" : single ? "OUTCOME" : null,
    paymentStatus: states.at(-1) ?? "NO_TRANSACTION",
    verification: run.verdict,
  };
}

export function mapBenchmark(file: BenchmarkFile): CockpitRow[] {
  return file.runs.map((r) => mapBenchmarkRun(r, file));
}

/* ------------------------------------------------------------------ filters */

export type CockpitFilters = {
  /** Free text, matched against ids, scenario, category, decision, reason codes and statuses. */
  q: string;
  source: CockpitSource | "ALL";
  mode: BuyerModeName | "ALL";
  category: string;
  decision: Decision | "ALL";
  payment: string;
  verification: string;
  audit: AuditState | "ALL";
  /** Inclusive calendar dates, YYYY-MM-DD, compared with the row timestamp's date. */
  from: string | null;
  to: string | null;
};

export const ALL = "ALL";
export const NO_FILTERS: CockpitFilters = {
  q: "",
  source: "ALL",
  mode: "ALL",
  category: ALL,
  decision: "ALL",
  payment: ALL,
  verification: ALL,
  audit: "ALL",
  from: null,
  to: null,
};

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const validDate = (s: string | undefined): string | null =>
  s !== undefined && DATE.test(s) && !Number.isNaN(Date.parse(`${s}T00:00:00Z`)) ? s : null;

type Query = Record<string, string | string[] | undefined>;
const one = (q: Query, k: string): string | undefined => {
  const v = q[k];
  return Array.isArray(v) ? v[0] : v;
};
const oneOf = <T extends string>(allowed: readonly T[], v: string | undefined): T | "ALL" =>
  allowed.find((a) => a === v) ?? "ALL";
const label = (v: string | undefined): string =>
  v !== undefined && v.length > 0 && v.length <= 80 ? v : ALL;

/** Reads filters from a URL query. Anything unknown or malformed is ignored (treated as "all"), never trusted. */
export function parseFilters(q: Query): CockpitFilters {
  return {
    q: (one(q, "q") ?? "").trim().slice(0, 100),
    source: oneOf(SOURCES, one(q, "source")),
    mode: oneOf(BUYER_MODES, one(q, "mode")),
    category: label(one(q, "category")),
    decision: oneOf(DECISIONS, one(q, "decision")),
    payment: label(one(q, "payment")),
    verification: label(one(q, "verification")),
    audit: oneOf(AUDIT_STATES, one(q, "audit")),
    from: validDate(one(q, "from")),
    to: validDate(one(q, "to")),
  };
}

/** The query string for a filter set; defaults are omitted, so the empty filter is the empty string. */
export function serializeFilters(f: CockpitFilters): string {
  const p = new URLSearchParams();
  if (f.q) p.set("q", f.q);
  for (const k of [
    "source",
    "mode",
    "category",
    "decision",
    "payment",
    "verification",
    "audit",
  ] as const)
    if (f[k] !== ALL) p.set(k, f[k]);
  if (f.from) p.set("from", f.from);
  if (f.to) p.set("to", f.to);
  return p.toString();
}

export const isFiltered = (f: CockpitFilters): boolean => serializeFilters(f) !== "";

export function applyFilters(rows: readonly CockpitRow[], f: CockpitFilters): CockpitRow[] {
  const needle = f.q.trim().toLowerCase();
  return rows.filter((r) => {
    if (f.source !== "ALL" && r.source !== f.source) return false;
    if (f.mode !== "ALL" && r.buyerMode !== f.mode) return false;
    if (f.category !== ALL && r.category !== f.category) return false;
    if (f.decision !== "ALL" && r.decision !== f.decision) return false;
    if (f.payment !== ALL && r.paymentStatus !== f.payment) return false;
    if (f.verification !== ALL && r.verification !== f.verification) return false;
    if (f.audit !== "ALL" && r.auditChain !== f.audit) return false;
    if (f.from !== null || f.to !== null) {
      const day = r.timestamp?.slice(0, 10);
      if (!day) return false;
      if (f.from !== null && day < f.from) return false;
      if (f.to !== null && day > f.to) return false;
    }
    if (needle) {
      const hay = [
        r.id,
        r.refId,
        r.scenario,
        r.category,
        r.decision,
        r.paymentStatus,
        r.verification,
        r.buyerMode,
        ...r.reasonCodes,
      ]
        .filter((x): x is string => typeof x === "string")
        .join(" ")
        .toLowerCase();
      if (!hay.includes(needle)) return false;
    }
    return true;
  });
}

/** Newest first; ties and rows without a timestamp are ordered by id so the order is stable. */
export function defaultSort(rows: readonly CockpitRow[]): CockpitRow[] {
  return [...rows].sort((a, b) => {
    const ta = a.timestamp ?? "";
    const tb = b.timestamp ?? "";
    if (ta !== tb) return ta < tb ? 1 : -1;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
}

const distinct = (xs: readonly (string | null)[]): string[] =>
  [...new Set(xs.filter((x): x is string => x !== null && x !== ""))].sort();

/** The values that actually occur, for the filter menus. A menu never offers a value no row has. */
export function filterOptions(rows: readonly CockpitRow[]) {
  return {
    sources: SOURCES.filter((s) => rows.some((r) => r.source === s)),
    modes: BUYER_MODES.filter((m) => rows.some((r) => r.buyerMode === m)),
    categories: distinct(rows.map((r) => r.category)),
    decisions: DECISIONS.filter((d) => rows.some((r) => r.decision === d)),
    payments: distinct(rows.map((r) => r.paymentStatus)),
    verifications: distinct(rows.map((r) => r.verification)),
    audits: AUDIT_STATES.filter((a) => rows.some((r) => r.auditChain === a)),
  };
}

export type Tallies = {
  total: number;
  bySource: Record<CockpitSource, number>;
  byDecision: Record<Decision, number>;
  byAudit: Record<AuditState, number>;
};

/** Plain counts of the rows given. These are the only "metrics" the Cockpit shows. */
export function tally(rows: readonly CockpitRow[]): Tallies {
  const zero = <K extends string>(keys: readonly K[]) =>
    Object.fromEntries(keys.map((k) => [k, 0])) as Record<K, number>;
  const t: Tallies = {
    total: rows.length,
    bySource: zero(SOURCES),
    byDecision: zero(DECISIONS),
    byAudit: zero(AUDIT_STATES),
  };
  for (const r of rows) {
    t.bySource[r.source] += 1;
    t.byDecision[r.decision] += 1;
    t.byAudit[r.auditChain] += 1;
  }
  return t;
}

/* ------------------------------------------------------------------ source status */

export type SourceStatus =
  | { source: "DATABASE"; state: "OK"; rows: number; note: string | null }
  | { source: "DATABASE"; state: "LOCKED" | "UNAVAILABLE" | "ERROR"; message: string }
  | {
      source: "BENCHMARK";
      state: "OK";
      rows: number;
      generatedAt: string;
      resultsHash: string;
      seed: number;
    }
  | { source: "BENCHMARK"; state: "MISSING" | "ERROR"; message: string };

/* ------------------------------------------------------------------ detail */

export type DetailItem = { label: string; value: string };
export type DetailSection = { title: string; note?: string; items: DetailItem[] };
export type CockpitDetail = { row: CockpitRow; sections: DetailSection[] };

const list = (xs: readonly string[]) => (xs.length > 0 ? xs.join(", ") : "none");

export function detailOfTransaction(
  f: TransactionFacts,
  row: CockpitRow,
  chain: ChainFacts,
): CockpitDetail {
  return {
    row,
    sections: [
      {
        title: "Transaction",
        items: [
          { label: "State", value: f.state },
          { label: "Created", value: f.createdAt },
          { label: "Updated", value: f.updatedAt },
          { label: "Mandate", value: `${f.mandateId} v${f.mandateVersion}` },
          { label: "Negotiation", value: f.negotiationId ?? "none" },
          {
            label: "Agreement",
            value: f.agreement
              ? `${f.agreement.id} (version ${f.agreement.version ?? "n/a"}) for ${formatAmount(f.agreement.totalMinor, f.currency)}`
              : "none yet",
          },
          {
            label: "Human approval",
            value: f.approval
              ? `${f.approval.decision} at ${f.approval.decidedAt}`
              : "none recorded",
          },
          { label: "PayPal order", value: f.paypalOrderId ?? "none" },
          { label: "Authorized", value: formatAmount(f.authorizedMinor, f.currency) },
          { label: "Captured", value: formatAmount(f.capturedMinor, f.currency) },
        ],
      },
      {
        title: "Policy decisions",
        note: "Every decision the policy engine recorded for this transaction, oldest first.",
        items: [...f.decisions]
          .sort((a, b) => (a.decidedAt < b.decidedAt ? -1 : 1))
          .map((d) => ({
            label: `${d.decidedAt} ${d.subject}`,
            value: `${d.verdict}${d.reasonCodes.length ? `: ${list(d.reasonCodes)}` : ""}`,
          })),
      },
      {
        title: "Payment attempts",
        items: f.attempts.map((a) => ({
          label: `${a.action} #${a.seq}`,
          value: `${a.status}${a.httpStatus ? ` (HTTP ${a.httpStatus})` : ""} at ${a.startedAt}`,
        })),
      },
      {
        title: "Verified webhook deliveries",
        note: "Only deliveries whose signature PayPal's own service verified are stored.",
        items: f.webhooks.map((w) => ({
          label: w.eventType,
          value: `${w.status}${w.reason ? ` (${w.reason})` : ""}, event ${w.paypalEventId}`,
        })),
      },
      {
        title: "Audit events",
        note: chainNote(chain),
        items: f.events.map((e) => ({
          label: `#${e.seq} ${e.ts}`,
          value: `${e.type} by ${e.actor}${e.provenance ? ` [${e.provenance}]` : ""}`,
        })),
      },
    ],
  };
}

export function detailOfRefused(
  f: RefusedOfferFacts,
  row: CockpitRow,
  chain: ChainFacts,
): CockpitDetail {
  return {
    row,
    sections: [
      {
        title: "Refused offer",
        note: "The offer was refused by the policy engine; no transaction was created.",
        items: [
          { label: "Proposal", value: f.proposalId },
          { label: "Negotiation", value: f.negotiationId },
          { label: "Proposed", value: formatAmount(f.proposedMinor, f.currency) },
          { label: "Reason codes", value: list(f.reasonCodes) },
          { label: "Policy version", value: f.policyVersion },
          { label: "Requested by", value: f.actor },
          { label: "Explanation", value: f.explanation },
        ],
      },
      {
        title: "Audit events",
        note: chainNote(chain),
        items: f.events.map((e) => ({
          label: `#${e.seq} ${e.ts}`,
          value: `${e.type} by ${e.actor}${e.provenance ? ` [${e.provenance}]` : ""}`,
        })),
      },
    ],
  };
}

export function detailOfAttackRun(f: AttackRunFacts, row: CockpitRow): CockpitDetail {
  return {
    row,
    sections: [
      {
        title: "Attack run",
        items: [
          { label: "Scenario", value: f.scenarioId },
          { label: "Fixture version", value: f.fixtureVersion },
          { label: "Seed", value: f.seed },
          { label: "Provider", value: f.provider },
          { label: "Mandate cap", value: formatAmount(f.mandateCapMinor, f.currency) },
          { label: "Money moved", value: formatAmount(f.moneyMovedMinor, f.currency) },
          { label: "Invariants violated", value: list(f.invariantsViolated) },
          { label: "Started", value: f.startedAt },
          { label: "Finished", value: f.finishedAt ?? "not finished" },
          { label: "Transaction", value: f.transactionId ?? "none" },
        ],
      },
      {
        title: "Steps",
        items: f.steps.map((s) => ({
          label: `Step ${s.n}`,
          value: `${s.outcome}${s.reasonCodes.length ? `: ${list(s.reasonCodes)}` : ""}`,
        })),
      },
    ],
  };
}

export function detailOfBenchmarkRun(
  run: BenchmarkRun,
  row: CockpitRow,
  file: Pick<BenchmarkFile, "generatedAt" | "seed" | "resultsHash">,
): CockpitDetail {
  const json = (v: unknown) => JSON.stringify(v, null, 1);
  return {
    row,
    sections: [
      {
        title: "Benchmark run",
        note: "From the persisted benchmark file. Simulated money and a scripted fake PayPal only; see docs/ADVERSARIAL_BENCHMARK.md.",
        items: [
          { label: "Run", value: run.runId },
          { label: "Layer / execution", value: `${run.layer} / ${run.executionMode}` },
          { label: "Case", value: run.caseId },
          { label: "Evidence unit", value: run.evidenceUnit },
          { label: "Mechanism", value: run.mechanism },
          { label: "Model", value: run.brain ?? "none (real services)" },
          { label: "Case seed", value: run.seed === null ? "hand-written" : String(run.seed) },
          { label: "Status", value: run.status },
          { label: "Verdict", value: run.verdict },
          { label: "Reason", value: run.reason ?? "none" },
          { label: "Copy of", value: run.duplicateOfCase ?? "not a copy" },
          { label: "Case fingerprint", value: run.caseFingerprint },
          { label: "Input fingerprint", value: run.inputFingerprint },
        ],
      },
      { title: "Expected", items: [{ label: "Specification", value: json(run.expected) }] },
      { title: "Actual", items: [{ label: "Observed", value: json(run.actual) }] },
      {
        title: "File",
        items: [
          { label: "Generated", value: file.generatedAt },
          { label: "Seed", value: String(file.seed) },
          { label: "Results hash", value: file.resultsHash },
        ],
      },
    ],
  };
}

function chainNote(chain: ChainFacts): string {
  if (chain.status === "VERIFIED")
    return `The audit chain verifies (${chain.count} events). That is local tamper-evidence, not a signature.`;
  if (chain.status === "FAILED")
    return `The audit chain FAILS at event #${chain.firstBadSeq} (${chain.code}). Events at or after it cannot be vouched for.`;
  return `The audit chain could not be read: ${chain.message}`;
}
