import type { ExperimentResult, ModeResult, StepOutcome, SummaryRow } from "@/application/arena";
import { HARM_LABEL, type Harm } from "@/domain/experiment";
import { formatMinor, type SupportedCurrency } from "@/domain/mandate";

import { Explainer } from "../_ui/page-head";
import { Chip, type Tone } from "./panels";

/** Integer minor units to "80.00 USD". The currency comes from the result, never from the browser. */
export function money(minor: number, currency: string): string {
  try {
    return `${formatMinor(minor, currency as SupportedCurrency)} ${currency}`;
  } catch {
    return `${minor} minor units of ${currency}`;
  }
}

const DECISION: Record<StepOutcome["decision"], { tone: Tone; icon: string; label: string }> = {
  PAID_UNCHECKED: { tone: "danger", icon: "!", label: "Paid with no check (simulated)" },
  PAID_AFTER_POLICY: {
    tone: "success",
    icon: "✓",
    label: "Paid after policy allowed it (simulated)",
  },
  BLOCKED_BY_POLICY: { tone: "info", icon: "■", label: "Blocked by policy: no payment" },
  AWAITING_APPROVAL: {
    tone: "warning",
    icon: "…",
    label: "Waiting for a human's approval: no payment",
  },
  NO_ACTION: { tone: "neutral", icon: "○", label: "No action" },
};

export function HarmChips({ harms, none }: { harms: readonly Harm[]; none: string }) {
  if (harms.length === 0)
    return (
      <Chip tone="success" icon="✓">
        {none}
      </Chip>
    );
  return (
    <span className="chips">
      {harms.map((h) => (
        <Chip key={h} tone="danger" icon="!">
          {HARM_LABEL[h]}
        </Chip>
      ))}
    </span>
  );
}

/* ------------------------------------------------------------------ the shared input */

export function SharedInputPanel({ result }: { result: ExperimentResult }) {
  const { scenario, mandate } = result;
  const cur = mandate.currency;
  return (
    <section className="card" aria-labelledby="input-h">
      <header className="card__head">
        <h2 id="input-h">Same input for both buyers</h2>
        <div className="chips">
          {result.inputs.identical ? (
            <Chip tone="success" icon="✓">
              Inputs identical
            </Chip>
          ) : (
            <Chip tone="danger" icon="!">
              INPUTS DIFFER
            </Chip>
          )}
          <Chip tone="neutral">
            {scenario.threat === "control" ? "Control case" : `Threat ${scenario.threat}`}
          </Chip>
        </div>
      </header>
      <p>
        <strong>{scenario.title}</strong>
      </p>
      <p className="muted small">{scenario.summary}</p>
      <h3 className="subhead">Mandate and initial budget (identical)</h3>
      <dl className="kv">
        <div>
          <dt>Per-purchase cap (approved limit)</dt>
          <dd className="num strong">{money(mandate.perTxCapMinor, cur)}</dd>
        </div>
        <div>
          <dt>Total budget at the start</dt>
          <dd className="num strong">{money(mandate.totalBudgetMinor, cur)}</dd>
        </div>
        <div>
          <dt>Needs a human above</dt>
          <dd className="num">{money(mandate.approvalThresholdMinor, cur)}</dd>
        </div>
        <div>
          <dt>Allowed seller / categories</dt>
          <dd>
            {mandate.allowedSellerIds.join(", ")} / {mandate.allowedCategories.join(", ")}
          </dd>
        </div>
      </dl>
      {scenario.steps.map((s, n) => (
        <div key={s.id} className="step">
          <h3 className="subhead">
            {scenario.steps.length > 1 ? `Step ${n + 1} of ${scenario.steps.length}: ` : ""}
            Seller messages and offer (untrusted, shown as plain text)
          </h3>
          {s.messages.map((m) => (
            <div key={m.id} className="quote">
              <p>{m.text}</p>
              {m.tags.length > 0 ? (
                <p className="chips">
                  {m.tags.map((t) => (
                    <Chip key={t} tone="warning">
                      Technique: {t}
                    </Chip>
                  ))}
                </p>
              ) : null}
            </div>
          ))}
          <dl className="kv kv--tight">
            <div>
              <dt>Offer</dt>
              <dd>
                {s.offer.lines
                  .map((l) => `${l.qty} × ${l.sku} at ${money(l.unitPriceMinor, s.offer.currency)}`)
                  .join(", ")}
                {s.offer.feesMinor > 0
                  ? `, fees ${money(s.offer.feesMinor, s.offer.currency)}`
                  : ""}
              </dd>
            </div>
            <div>
              <dt>Seller states</dt>
              <dd className="num">{money(s.offer.claimedTotalMinor, s.offer.currency)}</dd>
            </div>
            <div>
              <dt>Server computes</dt>
              <dd className="num">
                {s.serverTotalMinor === null
                  ? "not representable"
                  : money(s.serverTotalMinor, s.offer.currency)}
              </dd>
            </div>
            <div>
              <dt>Input hash given to both</dt>
              <dd>
                <code className="code">{(result.inputs.baseline[n] ?? "").slice(0, 12)}</code>
                {result.inputs.baseline[n] === result.inputs.protected[n] ? " = " : " ≠ "}
                <code className="code">{(result.inputs.protected[n] ?? "").slice(0, 12)}</code>
              </dd>
            </div>
          </dl>
        </div>
      ))}
      <Explainer summary="About the simulated model">
        <p className="muted small">
          The model that reads this is a <strong>scripted simulation</strong>, the same for both
          buyers (<code className="code">{result.brain}</code>). Its assumed behaviour:{" "}
          {result.brainTraits.join("; ")}. This shows what enforcement changes; it is not a
          measurement of any real model.
        </p>
      </Explainer>
    </section>
  );
}

/* ------------------------------------------------------------------ one buyer's pane */

function GateBox({ gate }: { gate: StepOutcome["gates"][number] }) {
  const deny = gate.verdict === "DENY";
  return (
    <div className="policy">
      <Chip tone={deny ? "info" : "success"} icon={deny ? "■" : "✓"}>
        {gate.subject === "ACCEPT_OFFER" ? "Gate 1 · accept the deal" : "Gate 2 · start payment"}:{" "}
        {gate.verdict}
      </Chip>
      {gate.reasonCodes.map((c) => (
        <code key={c} className="code">
          {c}
        </code>
      ))}
      {gate.items.map((i) => (
        <p key={i.code} className="muted small">
          {i.title}. {i.detail}
        </p>
      ))}
    </div>
  );
}

function StepCard({
  s,
  mode,
  currency,
  many,
}: {
  s: StepOutcome;
  mode: ModeResult["mode"];
  currency: string;
  many: boolean;
}) {
  const d = DECISION[s.decision];
  const proposal = s.proposal;
  return (
    <div className={`pay pay--${d.tone}`} aria-live="polite">
      <div className="pay__head">
        {many ? <span className="strong">Step {s.stepNumber}</span> : null}
        <Chip tone={d.tone} icon={d.icon}>
          {d.label}
        </Chip>
      </div>
      <p className="muted small">
        Model said: <code className="code">{proposal.kind}</code>
        {proposal.kind === "PAY"
          ? ` (untrusted model text: “${proposal.rationale}”)`
          : ` (untrusted model text: “${proposal.reason}”)`}
      </p>
      <dl className="kv kv--tight">
        <div>
          <dt>Decision</dt>
          <dd className="strong">{d.label}</dd>
        </div>
        <div className="kv__money">
          <dt>Attempted amount</dt>
          <dd className="num strong">
            {s.attemptedAmountMinor === null
              ? "none"
              : money(s.attemptedAmountMinor, s.attemptedCurrency ?? currency)}
            {s.attemptedPayeeRef ? ` to ${s.attemptedPayeeRef}` : ""}
          </dd>
        </div>
        <div>
          <dt>Approved limit</dt>
          <dd className="num">
            {money(s.approvedLimitMinor, currency)} per purchase ·{" "}
            {money(s.remainingBudgetMinor, currency)} budget left
          </dd>
        </div>
        <div className="kv__reason">
          <dt>Reason</dt>
          <dd>{s.reason}</dd>
        </div>
        <div>
          <dt>Resulting transaction state</dt>
          <dd>
            <code className="code">{s.transactionState}</code>
          </dd>
        </div>
        <div className="kv__money">
          <dt>Money moved (simulated)</dt>
          <dd className="num strong">
            {s.settlement
              ? `${money(s.settlement.amountMinor, s.settlement.currency)} · ${s.settlement.receiptId}`
              : "none"}
          </dd>
        </div>
      </dl>
      {mode === "PROTECTED" ? (
        s.gates.length > 0 ? (
          s.gates.map((g) => <GateBox key={g.subject} gate={g} />)
        ) : (
          <p className="muted small">
            The model did not propose a payment, so the policy engine was not asked.
          </p>
        )
      ) : (
        <p className="muted small">
          <strong>No policy check, by design.</strong> The only limits this buyer has are the words
          in its instructions.
        </p>
      )}
      {s.harms.length > 0 ? <HarmChips harms={s.harms} none="" /> : null}
    </div>
  );
}

export function ModePane({ result, mode }: { result: ExperimentResult; mode: ModeResult["mode"] }) {
  const m = mode === "UNSAFE_BASELINE" ? result.baseline : result.protected;
  const baseline = mode === "UNSAFE_BASELINE";
  const id = `${baseline ? "baseline" : "protected"}-h`;
  const cur = result.mandate.currency;
  return (
    <section
      className={`card pane pane--${baseline ? "baseline" : "protected"}`}
      aria-labelledby={id}
    >
      <header className="pane__head">
        <h2 id={id}>{m.label}</h2>
        <div className="chips">
          {baseline ? (
            <>
              <Chip tone="danger" icon="!">
                UNSAFE BY DESIGN
              </Chip>
              <Chip tone="warning">SIMULATED LEDGER ONLY</Chip>
            </>
          ) : (
            <>
              <Chip tone="success" icon="✓">
                POLICY ENFORCED
              </Chip>
              <Chip tone="warning">SIMULATED LEDGER ONLY</Chip>
            </>
          )}
        </div>
        <p className="muted small">
          {baseline
            ? "The model's decision is executed as it stands. It has no policy layer, no payment credentials and no PayPal access: it can only debit a simulated ledger."
            : "The model only proposes. The independent policy engine decides from server-held facts, and only an allowed deal is paid, at the server's amount to the catalog's payee."}
        </p>
      </header>
      {m.steps.map((s) => (
        <StepCard key={s.stepId} s={s} mode={mode} currency={cur} many={m.steps.length > 1} />
      ))}
      <dl className="kv kv--tight">
        <div>
          <dt>Total moved (simulated)</dt>
          <dd className="num strong">{money(m.moneyMovedMinor, cur)}</dd>
        </div>
        <div>
          <dt>Mandate violations</dt>
          <dd>
            <HarmChips harms={m.harms} none="None" />
          </dd>
        </div>
      </dl>
    </section>
  );
}

/* ------------------------------------------------------------------ all scenarios */

export function SummaryPanel({
  rows,
  selectedId,
  brain,
}: {
  rows: SummaryRow[];
  selectedId: string;
  brain: string;
}) {
  const attacks = rows.filter((r) => r.kind === "attack");
  const harmful = (pick: (r: SummaryRow) => Harm[]) =>
    attacks.filter((r) => pick(r).length > 0).length;
  return (
    <section className="card results" aria-labelledby="results-h">
      <header className="card__head">
        <h2 id="results-h">All scenarios</h2>
        <p className="muted small">
          Attack scenarios where a buyer broke the mandate: baseline{" "}
          <strong>
            {harmful((r) => r.baselineHarms)} of {attacks.length}
          </strong>
          , protected{" "}
          <strong>
            {harmful((r) => r.protectedHarms)} of {attacks.length}
          </strong>{" "}
          (simulated model <code className="code">{brain}</code>).
        </p>
      </header>
      <div className="tablewrap">
        <table className="table">
          <caption className="sr-only">
            Money moved and mandate violations per scenario and buyer
          </caption>
          <thead>
            <tr>
              <th scope="col">Scenario</th>
              <th scope="col">Baseline moved</th>
              <th scope="col">Baseline violations</th>
              <th scope="col">Protected moved</th>
              <th scope="col">Protected violations</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr
                key={r.scenarioId}
                aria-current={r.scenarioId === selectedId ? "true" : undefined}
              >
                <th scope="row">
                  <a href={`/arena?scenario=${r.scenarioId}&brain=${brain}`}>{r.title}</a>
                </th>
                <td className="num">{money(r.baselineMovedMinor, "USD")}</td>
                <td>
                  <HarmChips harms={r.baselineHarms} none="None" />
                </td>
                <td className="num">{money(r.protectedMovedMinor, "USD")}</td>
                <td>
                  <HarmChips harms={r.protectedHarms} none="None" />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}
