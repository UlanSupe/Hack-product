/**
 * The end-to-end user journey, as data. Pure: no I/O, no framework, no clock.
 *
 * The journey has nine steps. Eight describe the operator's real transaction and are derived ONLY from stored,
 * server-verified state (`JourneyFacts`, assembled by the application layer from the same services the consoles use).
 * The ninth, the replay of the budget-escalation attack, is a simulation on throwaway data and is always labelled so:
 * it never counts as progress on the operator's transaction.
 *
 * Nothing here authorizes anything. A step being "DONE" or "CURRENT" is a description for the screen; every action
 * behind it is still decided by the server (session, CSRF, policy engine).
 */

export const STEP_IDS = [
  "scenario",
  "mandate",
  "task",
  "offers",
  "negotiation",
  "agreement",
  "payment",
  "verify",
  "replay",
] as const;
export type StepId = (typeof STEP_IDS)[number];

export const STEP_STATUSES = [
  "DONE",
  "CURRENT",
  "TODO",
  "BLOCKED",
  "UNAVAILABLE",
  "SIMULATION",
] as const;
export type StepStatus = (typeof STEP_STATUSES)[number];

export const STEP_LABELS: Record<StepId, { short: string; title: string }> = {
  scenario: { short: "Scenario", title: "Start a transaction scenario" },
  mandate: { short: "Mandate", title: "Review or configure the financial mandate" },
  task: { short: "Task", title: "Submit the task" },
  offers: { short: "Offers", title: "Compare seller offers" },
  negotiation: { short: "Negotiation", title: "Observe the agent negotiation" },
  agreement: { short: "Agreement", title: "Inspect the agreement and policy decision" },
  payment: { short: "Payment", title: "Run the protected payment workflow" },
  verify: { short: "Verify", title: "Inspect verification and audit history" },
  replay: { short: "Replay attack", title: "Replay the budget-escalation attack" },
};

/* ------------------------------------------------------------------ scenario fixtures */

/**
 * A starting point for the task form. FIXTURE DATA: the values are made up for the demo and only pre-fill a form the
 * operator then submits through the normal validated route. A scenario grants no authority and bypasses no check.
 */
export type ScenarioFixture = {
  id: string;
  title: string;
  /** What happens, in one or two sentences, for the start page. */
  blurb: string;
  /** Where the scenario runs: the operator's own database, or a replay on throwaway data. */
  kind: "OPERATOR_TRANSACTION" | "SIMULATED_REPLAY";
  /** Pre-fill for the task form (OPERATOR_TRANSACTION only). */
  task?: {
    category: string;
    quantity: number;
    summary: string;
    maxTotal: string;
    neededWithinDays: number;
    deliverables: string[];
    sellerIds: string[];
  };
};

export const SCENARIOS: readonly ScenarioFixture[] = [
  {
    id: "compute-within-budget",
    title: "Buy GPU hours inside the mandate",
    blurb:
      "Open a negotiation with the seeded compute seller, let the (mock) agents propose offers, accept one that passes the policy engine, then pay it through the PayPal sandbox.",
    kind: "OPERATOR_TRANSACTION",
    task: {
      category: "COMPUTE",
      quantity: 1,
      summary: "80 GPU-hours of compute for a model fine-tuning run",
      maxTotal: "90.00",
      neededWithinDays: 5,
      deliverables: ["80 GPU-hours", "Written confirmation of delivery"],
      sellerIds: ["seller_acme"],
    },
  },
  {
    id: "budget-escalation",
    title: "Replay the budget-escalation attack",
    blurb:
      "A design seller's valid $24.00 offer is revised to $36.00 with pressure. The unsafe baseline pays; the protected buyer is refused by the policy engine. Simulation on throwaway data: it does not use your mandate or database.",
    kind: "SIMULATED_REPLAY",
  },
];

export const DEFAULT_SCENARIO_ID = "compute-within-budget";

export function scenarioById(id: string | null | undefined): ScenarioFixture | undefined {
  return SCENARIOS.find((s) => s.id === id);
}

/* ------------------------------------------------------------------ facts (inputs) */

export type ApprovalFact = "NOT_REQUIRED" | "REQUIRED" | "APPROVED" | "REJECTED" | "INVALIDATED";
export type EligibilityFact = "ELIGIBLE" | "AWAITING_APPROVAL" | "BLOCKED" | "IN_PROGRESS";
export type AuditFact = "VERIFIED" | "BROKEN" | "NO_EVENTS" | "UNKNOWN";

/** Everything the screens need to know about the operator's transaction. All of it comes from stored state. */
export type JourneyFacts = {
  /** At least one approved, in-force mandate exists. */
  mandateApproved: boolean;
  /** Whether the server holds PayPal sandbox credentials (never the credentials themselves). */
  paypalConfigured: boolean;
  negotiation: null | {
    id: string;
    status: "OPEN" | "AGREED" | "REJECTED" | "TIMED_OUT" | "CANCELLED";
    offers: number;
    counters: number;
    /** Proposals (offers and counters) recorded by an AGENT rather than typed in by the operator. */
    agentProposals: number;
    /** The latest policy refusal of an offer (ACCEPT_OFFER) that left no agreement, if any. */
    refusal: null | { code: string; headline: string };
    agreement: null | {
      version: number;
      totalText: string;
      approval: ApprovalFact;
      eligibility: EligibilityFact | null;
      eligibilityHeadline: string | null;
      /** The transaction id the agreement created (the Cockpit's row is `tx:<id>`). */
      transactionId: string;
    };
    pendingRevisions: number;
  };
  payment: null | {
    state: string;
    moneyMoved: boolean;
    headline: string;
  };
  audit: AuditFact | null;
};

/* ------------------------------------------------------------------ outputs */

export type StepView = {
  id: StepId;
  number: number;
  short: string;
  title: string;
  status: StepStatus;
  /** One plain sentence saying why the step is in this state. Never invented: it restates a fact. */
  detail: string;
  href: string;
};

export type JourneyState = {
  steps: StepView[];
  /** The step the operator should look at now (first step of the real transaction that is not done). */
  currentId: StepId;
  next: { id: StepId; label: string; href: string } | null;
  negotiationId: string | null;
  /** True when every one of the first eight steps is DONE. */
  complete: boolean;
};

const TERMINAL_PAYMENT = new Set(["CAPTURED", "VOIDED"]);
const FAILED_PAYMENT = new Set([
  "FAILED",
  "REJECTED",
  "CANCELLED",
  "NEEDS_RECONCILIATION",
  "REVERSED",
]);

/** Facts for a visitor who has done nothing yet (or whose progress is not known): every link still works. */
export const NO_FACTS: JourneyFacts = {
  mandateApproved: false,
  paypalConfigured: false,
  negotiation: null,
  payment: null,
  audit: null,
};

/**
 * Where a step lives. The negotiation id is carried in the address (`n`) to every page so that the progress bar can
 * find the same transaction again after a reload or on another page; the address is the only place that choice lives.
 */
export function hrefFor(id: StepId, f: JourneyFacts): string {
  const n = f.negotiation;
  const q = n ? `n=${encodeURIComponent(n.id)}` : "";
  const withN = (path: string) => (n ? `${path}?${q}` : path);
  const neg = n ? `/negotiations?${q}` : "/negotiations";
  switch (id) {
    case "scenario":
      return withN("/");
    case "mandate":
      return withN("/mandate");
    case "task":
      return n ? neg : `/negotiations?scenario=${DEFAULT_SCENARIO_ID}`;
    case "offers":
    case "negotiation":
      return n ? `${neg}#threads-h` : neg;
    case "agreement":
      return n ? `${neg}#agr-h` : neg;
    case "payment":
      return n ? `${neg}#pay-h` : neg;
    case "verify": {
      const tx = n?.agreement?.transactionId;
      return withN(tx ? `/cockpit/${encodeURIComponent(`tx:${tx}`)}` : "/cockpit");
    }
    case "replay":
      return withN("/flagship");
  }
}

/** The steps as plain links with no status, for the moments when the real state is not (yet) known. */
export const PLAIN_STEPS: readonly {
  id: StepId;
  number: number;
  short: string;
  title: string;
  href: string;
}[] = STEP_IDS.map((id, i) => ({
  id,
  number: i + 1,
  short: STEP_LABELS[id].short,
  title: STEP_LABELS[id].title,
  href: hrefFor(id, NO_FACTS),
}));

type Cell = { status: StepStatus; detail: string };

/** The derivation. Total over its input: every combination of facts yields nine steps and a current step. */
export function deriveJourney(f: JourneyFacts): JourneyState {
  const n = f.negotiation;
  const ag = n?.agreement ?? null;
  const cells = {} as Record<StepId, Cell>;

  cells.scenario = n
    ? { status: "DONE", detail: "A transaction scenario is open." }
    : { status: "TODO", detail: "Pick a scenario to begin." };

  cells.mandate = f.mandateApproved
    ? { status: "DONE", detail: "An approved mandate is in force." }
    : {
        status: "BLOCKED",
        detail: "No approved mandate yet. Every purchase must follow one: create and approve it.",
      };

  if (n) cells.task = { status: "DONE", detail: "The task is submitted." };
  else if (!f.mandateApproved)
    cells.task = { status: "BLOCKED", detail: "Approve a mandate before submitting a task." };
  else cells.task = { status: "TODO", detail: "Describe what you want to buy." };

  if (!n) cells.offers = { status: "TODO", detail: "Offers appear after the task is submitted." };
  else if (n.offers > 0)
    cells.offers = {
      status: "DONE",
      detail: `${n.offers} seller offer${n.offers === 1 ? "" : "s"} recorded.`,
    };
  else if (n.status === "OPEN")
    cells.offers = {
      status: "TODO",
      detail: "No offers yet. Run the demo agents or add an offer.",
    };
  else
    cells.offers = {
      status: "BLOCKED",
      detail: "The negotiation closed before any offer arrived.",
    };

  if (!n) cells.negotiation = { status: "TODO", detail: "Nothing to observe yet." };
  else if (n.agentProposals > 0 || n.counters > 0)
    cells.negotiation = {
      status: "DONE",
      detail: `Agents recorded ${n.agentProposals} proposal${n.agentProposals === 1 ? "" : "s"}; ${n.counters} counter-offer${n.counters === 1 ? "" : "s"} in total. Every offer and counter is a numbered version.`,
    };
  else if (ag)
    cells.negotiation = {
      status: "DONE",
      detail: "No agent was run for this transaction: the offers were entered by hand.",
    };
  else
    cells.negotiation = {
      status: "TODO",
      detail: "Run the demo agents to watch them negotiate, or accept an offer yourself.",
    };

  const paymentUnderWay = f.payment !== null && f.payment.state !== "AGREED";
  if (ag) {
    if (ag.eligibility === "ELIGIBLE")
      cells.agreement = {
        status: "DONE",
        detail: `Agreement v${ag.version} (${ag.totalText}) passed the policy engine${ag.approval === "APPROVED" ? " and has your approval" : ""}.`,
      };
    else if (ag.eligibility === "AWAITING_APPROVAL")
      cells.agreement = {
        status: "CURRENT",
        detail: `Agreement v${ag.version} (${ag.totalText}) needs your explicit approval before it can be paid.`,
      };
    else if (ag.eligibility === "BLOCKED")
      cells.agreement = {
        status: "BLOCKED",
        detail: ag.eligibilityHeadline ?? "The policy engine blocks this agreement.",
      };
    else if (paymentUnderWay)
      cells.agreement = {
        status: "DONE",
        detail: `Agreement v${ag.version} (${ag.totalText}) passed the policy engine; the payment is under way.`,
      };
    else
      cells.agreement = {
        status: "CURRENT",
        detail: ag.eligibilityHeadline ?? "The agreement is in progress.",
      };
  } else if (n?.refusal)
    cells.agreement = {
      status: "BLOCKED",
      detail: `The policy engine refused the offer (${n.refusal.code}): ${n.refusal.headline}`,
    };
  else if (n && n.status !== "OPEN")
    cells.agreement = {
      status: "BLOCKED",
      detail: `The negotiation ended without an agreement (${n.status.toLowerCase().replace("_", " ")}).`,
    };
  else
    cells.agreement = {
      status: n && n.offers > 0 ? "CURRENT" : "TODO",
      detail: "Accept an offer to run the policy check and create the agreement.",
    };

  const payable = ag?.eligibility === "ELIGIBLE";
  if (f.payment && TERMINAL_PAYMENT.has(f.payment.state))
    cells.payment = {
      status: "DONE",
      detail: f.payment.moneyMoved
        ? "Captured: PayPal reports the sandbox capture completed. Nothing was paid out to the seller."
        : "The hold was released. Nothing was charged.",
    };
  else if (f.payment && FAILED_PAYMENT.has(f.payment.state))
    cells.payment = { status: "BLOCKED", detail: f.payment.headline };
  else if (f.payment && paymentUnderWay)
    cells.payment = { status: "CURRENT", detail: f.payment.headline };
  else if (!payable)
    cells.payment = {
      status: ag?.eligibility === "BLOCKED" || (!ag && n?.refusal) ? "BLOCKED" : "TODO",
      detail: "Payment unlocks only after an agreement passes the policy engine.",
    };
  else if (!f.paypalConfigured)
    cells.payment = {
      status: "UNAVAILABLE",
      detail:
        "This server has no PayPal sandbox credentials, so the payment step cannot run. Nothing is simulated in its place.",
    };
  else
    cells.payment = {
      status: "CURRENT",
      detail: f.payment?.headline ?? "Ready to start the PayPal sandbox payment.",
    };

  const hasRecord = ag !== null || (n?.refusal ?? null) !== null;
  if (f.audit === "BROKEN")
    cells.verify = {
      status: "BLOCKED",
      detail:
        "The audit chain does not verify. Treat the history as untrustworthy until explained.",
    };
  else if (f.payment && TERMINAL_PAYMENT.has(f.payment.state) && f.audit === "VERIFIED")
    cells.verify = { status: "DONE", detail: "The payment is final and the audit chain verifies." };
  else if (hasRecord)
    cells.verify = {
      status: "TODO",
      detail: "History is available now; it is complete once the payment is final.",
    };
  else cells.verify = { status: "TODO", detail: "History appears once a decision is recorded." };

  cells.replay = {
    status: "SIMULATION",
    detail: "A fixture on throwaway data. It does not use your mandate, database or PayPal.",
  };

  const steps: StepView[] = STEP_IDS.map((id, i) => ({
    id,
    number: i + 1,
    short: STEP_LABELS[id].short,
    title: STEP_LABELS[id].title,
    status: cells[id].status,
    detail: cells[id].detail,
    href: hrefFor(id, f),
  }));

  // The current step is where the operator must act: the first step that is blocked or explicitly current, else the
  // first one not finished. A step that is merely unavailable (no PayPal here) is skipped past, and the optional
  // "observe the agents" step never takes the focus from a decision that is waiting.
  const CURRENT: StepStatus = "CURRENT";
  const real = steps.slice(0, 8);
  // With a mandate in force, choosing a scenario is just the way into the task form, so the next real step is the task.
  const candidates = real.filter((s) => !(f.mandateApproved && s.id === "scenario"));
  const focus =
    candidates.find((s) => s.status === "BLOCKED" || s.status === "CURRENT") ??
    candidates.find((s) => s.status !== "DONE" && s.status !== "UNAVAILABLE") ??
    real[7]!;
  const ranked = steps.map((s) =>
    s.id === focus.id && (s.status === "TODO" || s.status === "DONE")
      ? { ...s, status: CURRENT }
      : s,
  );
  const complete = real.every((s) => s.status === "DONE");
  const nextStep = complete ? null : focus;
  return {
    steps: complete ? steps : ranked,
    currentId: focus.id,
    next: nextStep ? { id: nextStep.id, label: nextStep.title, href: nextStep.href } : null,
    negotiationId: n?.id ?? null,
    complete,
  };
}
