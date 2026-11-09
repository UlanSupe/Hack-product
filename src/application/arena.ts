import { formatMoney } from "../domain/mandate.ts";
import { canonicalJson, sha256Hex } from "../domain/canonical.ts";
import {
  BRAINS,
  BRAIN_TRAITS,
  EXPERIMENT_VERSION,
  MODE_LABEL,
  SimulatedLedger,
  WORLD_CATALOG,
  WORLD_MANDATE,
  WORLD_NOW,
  WORLD_SELLER,
  deepFreeze,
  harmsOf,
  inputHashOf,
  serverTotalOf,
  sharedInputFor,
  type BrainFn,
  type BrainInput,
  type BrainProfile,
  type BuyerMode,
  type BuyerProposal,
  type Harm,
  type Scenario,
  type ScenarioStep,
  type SimulatedReceipt,
  type WorldMandate,
} from "../domain/experiment.ts";
import { DEFAULT_SCENARIO_ID, SCENARIOS, findScenario } from "../domain/experiment-scenarios.ts";
import { mandateContentHash } from "../domain/mandate-hash.ts";
import { termsHashOf } from "../domain/offer.ts";
import { evaluatePolicy, type PolicyInput } from "../domain/policy.ts";
import { explainCodes } from "../domain/policy-explanations.ts";
import { executeUnchecked } from "./arena-baseline.ts";

/**
 * Runs the A/B experiment: the same scenario, the same budget, the same offers, the same seller messages and the same
 * model behaviour go to two buyer modes, and everything each one did is reported in the same shape.
 *
 *  - UNSAFE_BASELINE: `executeUnchecked` (see arena-baseline.ts).
 *  - PROTECTED: the model's proposal is a request. The policy engine is asked twice, from server-held facts and never
 *    from the model's numbers: ACCEPT_OFFER (does the deal fit the mandate?) and CREATE_ORDER (may payment start, with
 *    any human approval it needs?). Only two ALLOWs lead to a payment, and that payment is the SERVER's total to the
 *    catalog's payee.
 *
 * Both modes pay only through a `SimulatedLedger`. Nothing here is asynchronous, reads the clock or the environment,
 * or touches PayPal, so a run is a pure function of (scenario, model profile) and replays exactly.
 */

/* ------------------------------------------------------------------ result shapes (JSON-safe) */

export type GateView = {
  subject: "ACCEPT_OFFER" | "CREATE_ORDER";
  verdict: "ALLOW" | "DENY";
  reasonCodes: string[];
  headline: string;
  items: { code: string; title: string; detail: string }[];
  policyVersion: string;
};

export type StepDecision =
  "PAID_UNCHECKED" | "PAID_AFTER_POLICY" | "BLOCKED_BY_POLICY" | "AWAITING_APPROVAL" | "NO_ACTION";

export type StepOutcome = {
  stepId: string;
  stepNumber: number;
  /** Hash of the shared input this mode's model call received. */
  inputHash: string;
  proposal: BuyerProposal;
  attemptedAmountMinor: number | null;
  attemptedPayeeRef: string | null;
  attemptedCurrency: string | null;
  /** The mandate's per-purchase cap. */
  approvedLimitMinor: number;
  /** What this mode had left of the total budget before this step. */
  remainingBudgetMinor: number;
  serverTotalMinor: number | null;
  decision: StepDecision;
  /** Written by us from the facts above; never repeats seller or model text. */
  reason: string;
  /** Empty for the baseline: it has no policy check, by design. */
  gates: GateView[];
  /** The state-machine state for the protected buyer; the baseline keeps no transaction. */
  transactionState: string;
  settlement: SimulatedReceipt | null;
  harms: Harm[];
};

export type ModeResult = {
  mode: BuyerMode;
  label: string;
  provider: "SIMULATED";
  steps: StepOutcome[];
  moneyMovedMinor: number;
  harms: Harm[];
};

export type ScenarioView = {
  id: string;
  threat: string;
  title: string;
  kind: Scenario["kind"];
  technique: string;
  summary: string;
  steps: {
    id: string;
    messages: { id: string; text: string; tags: readonly string[] }[];
    offer: ScenarioStep["offer"];
    serverTotalMinor: number | null;
  }[];
};

export type ExperimentResult = {
  experimentVersion: string;
  brain: BrainProfile | "CUSTOM";
  brainTraits: readonly string[];
  scenario: ScenarioView;
  mandate: WorldMandate;
  /** Proof that both modes received the same input: the hash of each step's shared input, per mode. */
  inputs: { baseline: string[]; protected: string[]; identical: boolean };
  baseline: ModeResult;
  protected: ModeResult;
  /** SHA-256 of everything above. A replay must reproduce it exactly. */
  runHash: string;
};

/* ------------------------------------------------------------------ policy bridge (protected mode only) */

const catalogPayee = WORLD_SELLER.payeeRef;

function policyInputFor(args: {
  subject: "ACCEPT_OFFER" | "CREATE_ORDER";
  scenario: Scenario;
  step: ScenarioStep;
  proposal: Extract<BuyerProposal, { kind: "PAY" }> | null;
  others: { id: string; totalMinor: number }[];
  mandate: WorldMandate;
}): PolicyInput {
  const { subject, scenario, step, proposal, mandate } = args;
  const accepting = subject === "ACCEPT_OFFER";
  const o = step.offer;
  const txId = `sim_${scenario.id}_${step.id}`;
  const serverTotal = serverTotalOf(o) ?? 0;
  const lines = o.lines.map((l) => {
    const c = WORLD_CATALOG.find((x) => x.sku === l.sku);
    return {
      sku: l.sku,
      qty: l.qty,
      unitPriceMinor: l.unitPriceMinor,
      catalogUnitPriceMinor: c?.unitPriceMinor ?? null,
      category: c?.category ?? null,
    };
  });
  const termsHash = termsHashOf({
    sellerId: o.sellerId,
    currency: o.currency,
    shippingMinor: o.shippingMinor,
    feesMinor: o.feesMinor,
    lines: o.lines,
  });
  const contentHash = mandateContentHash({
    id: mandate.id,
    version: mandate.version,
    ownerId: mandate.ownerId,
    perTxCapMinor: mandate.perTxCapMinor,
    totalBudgetMinor: mandate.totalBudgetMinor,
    approvalThresholdMinor: mandate.approvalThresholdMinor,
    requireReview: false,
    currency: mandate.currency,
    allowedCategories: mandate.allowedCategories,
    allowedSellerIds: mandate.allowedSellerIds,
    expiresAt: mandate.expiresAt,
    status: "ACTIVE",
  });
  return {
    subject,
    now: WORLD_NOW,
    actor: accepting ? "AGENT" : "SYSTEM",
    transaction: {
      id: txId,
      state: accepting ? "NEGOTIATING" : "AGREED",
      mandateId: mandate.id,
      mandateVersion: mandate.version,
      agreementId: accepting ? null : `agr_${txId}`,
      honorExpiresAt: null,
    },
    mandate: {
      id: mandate.id,
      version: mandate.version,
      ownerId: mandate.ownerId,
      status: "ACTIVE",
      expiresAt: mandate.expiresAt,
      contentHash,
      terms: {
        currency: mandate.currency as "USD",
        totalBudgetMinor: mandate.totalBudgetMinor,
        maxTransactionMinor: mandate.perTxCapMinor,
        approvalThresholdMinor: mandate.approvalThresholdMinor,
        allowedCategories: [...mandate.allowedCategories] as "COMPUTE"[],
        allowedSellerIds: [...mandate.allowedSellerIds],
        requireReviewBeforeExecution: false,
        validDays: 365,
      },
    },
    latestMandate: { id: mandate.id, version: mandate.version, status: "ACTIVE" },
    offer: {
      id: o.id,
      transactionId: txId,
      sellerId: o.sellerId,
      catalogPayeeRef: catalogPayee,
      currency: o.currency,
      status: accepting ? "OPEN" : "ACCEPTED",
      validUntil: new Date(Date.parse(WORLD_NOW) + 60 * 60_000).toISOString(),
      shippingMinor: o.shippingMinor,
      feesMinor: o.feesMinor,
      claimedTotalMinor: o.claimedTotalMinor,
      storedServerTotalMinor: serverTotal,
      storedTermsHash: termsHash,
      lines,
    },
    agreement: accepting
      ? null
      : {
          id: `agr_${txId}`,
          offerId: o.id,
          termsHash,
          mandateId: mandate.id,
          mandateVersion: mandate.version,
          payeeRef: catalogPayee,
          currency: o.currency,
          totalMinor: serverTotal,
        },
    others: args.others.map((x) => ({
      id: x.id,
      state: "AGREED" as const,
      currency: mandate.currency,
      totalMinor: x.totalMinor,
    })),
    approval: null,
    attempts: { liveForSubject: false, captureSucceeded: false },
    observed: null,
    // What the model asked for. The engine compares it with its own facts and never uses it.
    claims:
      accepting && proposal
        ? {
            offerId: proposal.offerId,
            sellerId: proposal.sellerId,
            payeeRef: proposal.payeeRef,
            currency: proposal.currency,
            amountMinor: proposal.amountMinor,
          }
        : {},
  };
}

function gateOf(subject: GateView["subject"], input: PolicyInput): GateView {
  const d = evaluatePolicy(input);
  const e = explainCodes(d.verdict, d.reasonCodes, subject);
  return {
    subject,
    verdict: d.verdict,
    reasonCodes: [...d.reasonCodes],
    headline: e.headline,
    items: e.items.map((i) => ({ code: i.code, title: i.title, detail: i.detail })),
    policyVersion: d.policyVersion,
  };
}

/* ------------------------------------------------------------------ one buyer mode */

type Run = {
  scenario: Scenario;
  brain: BrainFn;
  mandate: WorldMandate;
  buildInput: typeof sharedInputFor;
};

const money = formatMoney;

/** Calls the model. A thrown error or an unusable answer is a refusal to act, never a payment. */
function propose(brain: BrainFn, input: BrainInput): BuyerProposal {
  try {
    const p = brain(input);
    if (p && (p.kind === "PAY" || p.kind === "ASK_HUMAN" || p.kind === "DECLINE")) return p;
  } catch {
    // fall through
  }
  return { kind: "DECLINE", reason: "The model gave no usable answer." };
}

const attempted = (p: BuyerProposal) =>
  p.kind === "PAY"
    ? { amount: p.amountMinor, payee: p.payeeRef, currency: p.currency }
    : { amount: null, payee: null, currency: null };

function runMode(mode: BuyerMode, run: Run): { result: ModeResult; hashes: string[] } {
  const { scenario, brain, mandate, buildInput } = run;
  const ledger = new SimulatedLedger(mode === "PROTECTED" ? "P" : "B");
  const steps: StepOutcome[] = [];
  const hashes: string[] = [];
  const agreed: { id: string; totalMinor: number }[] = [];
  let paid = 0;

  for (const step of scenario.steps) {
    const shared = buildInput(scenario, step, mandate);
    const hash = inputHashOf(shared);
    hashes.push(hash);
    // Budget the buyer still has: spent so far (baseline) or spent plus reserved by agreements (protected).
    const reserved = mode === "PROTECTED" ? agreed.reduce((n, a) => n + a.totalMinor, 0) : paid;
    const state = {
      spentMinor: paid,
      remainingBudgetMinor: Math.max(0, mandate.totalBudgetMinor - reserved),
    };
    const proposal = propose(brain, deepFreeze({ shared, state }));
    const a = attempted(proposal);
    const serverTotal = serverTotalOf(step.offer);
    const base = {
      stepId: step.id,
      stepNumber: scenario.steps.indexOf(step) + 1,
      inputHash: hash,
      proposal,
      attemptedAmountMinor: a.amount,
      attemptedPayeeRef: a.payee,
      attemptedCurrency: a.currency,
      approvedLimitMinor: mandate.perTxCapMinor,
      remainingBudgetMinor: state.remainingBudgetMinor,
      serverTotalMinor: serverTotal,
    };
    const truth = { serverTotalMinor: serverTotal, catalogPayeeRef: catalogPayee };

    if (proposal.kind !== "PAY") {
      steps.push({
        ...base,
        decision: "NO_ACTION",
        reason:
          proposal.kind === "ASK_HUMAN"
            ? "The model asked for a human instead of paying. Nothing was executed."
            : "The model declined to pay. Nothing was executed.",
        gates: [],
        transactionState: mode === "PROTECTED" ? "NEGOTIATING" : "NO_TRANSACTION_RECORD",
        settlement: null,
        harms: [],
      });
      continue;
    }

    if (mode === "UNSAFE_BASELINE") {
      let receipt: SimulatedReceipt | null;
      try {
        receipt = executeUnchecked(proposal, ledger);
      } catch {
        receipt = null; // the simulated ledger itself refuses a non-positive amount
      }
      const harms = receipt ? harmsOf(receipt, truth, paid, mandate) : [];
      if (receipt) paid += receipt.amountMinor;
      steps.push({
        ...base,
        decision: receipt ? "PAID_UNCHECKED" : "NO_ACTION",
        reason: receipt
          ? `Executed the model's proposal of ${money(receipt.amountMinor, receipt.currency)} to ${receipt.payeeRef} with no independent check.`
          : "The simulated ledger refused the amount. Nothing was executed.",
        gates: [],
        transactionState: receipt ? "SIMULATED_DEBIT_EXECUTED" : "NO_TRANSACTION_RECORD",
        settlement: receipt,
        harms,
      });
      continue;
    }

    // PROTECTED: the proposal is a request. Ask the engine, twice, from server-held facts.
    const accept = gateOf(
      "ACCEPT_OFFER",
      policyInputFor({
        subject: "ACCEPT_OFFER",
        scenario,
        step,
        proposal,
        others: agreed,
        mandate,
      }),
    );
    if (accept.verdict === "DENY") {
      steps.push({
        ...base,
        decision: "BLOCKED_BY_POLICY",
        reason: `Refused before any payment: ${accept.items.map((i) => i.title.toLowerCase()).join("; ")}.`,
        gates: [accept],
        transactionState: "REJECTED",
        settlement: null,
        harms: [],
      });
      continue;
    }
    agreed.push({ id: `sim_${scenario.id}_${step.id}`, totalMinor: serverTotal ?? 0 });
    const create = gateOf(
      "CREATE_ORDER",
      policyInputFor({
        subject: "CREATE_ORDER",
        scenario,
        step,
        proposal,
        others: agreed.slice(0, -1),
        mandate,
      }),
    );
    if (create.verdict === "DENY") {
      const onlyApproval =
        create.reasonCodes.length === 1 && create.reasonCodes[0] === "APPROVAL_REQUIRED";
      steps.push({
        ...base,
        decision: onlyApproval ? "AWAITING_APPROVAL" : "BLOCKED_BY_POLICY",
        reason: onlyApproval
          ? "The deal fits the mandate, but this amount needs a human's approval. Nothing was paid."
          : `Payment refused: ${create.items.map((i) => i.title.toLowerCase()).join("; ")}.`,
        gates: [accept, create],
        transactionState: "AGREED",
        settlement: null,
        harms: [],
      });
      continue;
    }
    // Both ALLOW: pay the SERVER's total to the CATALOG's payee, never the model's numbers.
    const receipt = ledger.debit({
      amountMinor: serverTotal ?? 0,
      payeeRef: catalogPayee,
      currency: mandate.currency,
    });
    const harms = harmsOf(receipt, truth, paid, mandate);
    paid += receipt.amountMinor;
    steps.push({
      ...base,
      decision: "PAID_AFTER_POLICY",
      reason: `Policy allowed both gates; paid the server's total of ${money(receipt.amountMinor, receipt.currency)} to the catalog payee ${receipt.payeeRef} (simulated).`,
      gates: [accept, create],
      transactionState: "AGREED",
      settlement: receipt,
      harms,
    });
  }

  const harms = [...new Set(steps.flatMap((s) => s.harms))].sort();
  return {
    hashes,
    result: {
      mode,
      label: MODE_LABEL[mode],
      provider: "SIMULATED",
      steps,
      moneyMovedMinor: ledger.totalMinor,
      harms,
    },
  };
}

/* ------------------------------------------------------------------ the experiment */

export function viewOfScenario(s: Scenario): ScenarioView {
  return {
    id: s.id,
    threat: s.threat,
    title: s.title,
    kind: s.kind,
    technique: s.technique,
    summary: s.summary,
    steps: s.steps.map((st) => ({
      id: st.id,
      messages: st.messages.map((m) => ({ id: m.id, text: m.text, tags: m.tags })),
      offer: st.offer,
      serverTotalMinor: serverTotalOf(st.offer),
    })),
  };
}

export function runExperiment(args: {
  scenarioId: string;
  /** A named simulated model, or a function (tests pass a recording one). */
  brain?: BrainProfile | BrainFn;
  mandate?: WorldMandate;
  /**
   * Test seams, not for the page or the API. `scenario` runs a scenario that is not in the catalogue; `buildInput`
   * replaces how a step's shared input is built, so a test can prove the equivalence check really can fail.
   */
  scenario?: Scenario;
  buildInput?: typeof sharedInputFor;
}): ExperimentResult | undefined {
  const scenario = args.scenario ?? findScenario(args.scenarioId);
  if (!scenario) return undefined;
  const buildInput = args.buildInput ?? sharedInputFor;
  const mandate = args.mandate ?? WORLD_MANDATE;
  const profile: BrainProfile | "CUSTOM" =
    typeof args.brain === "function" ? "CUSTOM" : (args.brain ?? "SUSCEPTIBLE");
  const brain =
    typeof args.brain === "function"
      ? args.brain
      : BRAINS[profile === "CUSTOM" ? "SUSCEPTIBLE" : profile];

  const b = runMode("UNSAFE_BASELINE", { scenario, brain, mandate, buildInput });
  const p = runMode("PROTECTED", { scenario, brain, mandate, buildInput });
  const without = {
    experimentVersion: EXPERIMENT_VERSION,
    brain: profile,
    brainTraits:
      profile === "CUSTOM"
        ? ["a custom model function supplied by the caller"]
        : BRAIN_TRAITS[profile],
    scenario: viewOfScenario(scenario),
    mandate,
    inputs: {
      baseline: b.hashes,
      protected: p.hashes,
      identical: canonicalJson(b.hashes) === canonicalJson(p.hashes),
    },
    baseline: b.result,
    protected: p.result,
  };
  return { ...without, runHash: sha256Hex(canonicalJson(JSON.parse(JSON.stringify(without)))) };
}

/* ------------------------------------------------------------------ all scenarios at a glance */

export type SummaryRow = {
  scenarioId: string;
  title: string;
  kind: Scenario["kind"];
  baselineMovedMinor: number;
  protectedMovedMinor: number;
  baselineHarms: Harm[];
  protectedHarms: Harm[];
  runHash: string;
};

export function summarizeAll(brain: BrainProfile = "SUSCEPTIBLE"): SummaryRow[] {
  return SCENARIOS.map((s) => {
    const r = runExperiment({ scenarioId: s.id, brain }) as ExperimentResult;
    return {
      scenarioId: s.id,
      title: s.title,
      kind: s.kind,
      baselineMovedMinor: r.baseline.moneyMovedMinor,
      protectedMovedMinor: r.protected.moneyMovedMinor,
      baselineHarms: r.baseline.harms,
      protectedHarms: r.protected.harms,
      runHash: r.runHash,
    };
  });
}

export { DEFAULT_SCENARIO_ID, SCENARIOS };
