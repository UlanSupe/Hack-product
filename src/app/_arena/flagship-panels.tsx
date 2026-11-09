import type {
  AuditEventView,
  BaselineRound,
  FlagshipResult,
  ProtectedRound,
} from "@/server/flagship";

import { HarmChips, money } from "./experiment-panels";
import { Chip, type Tone } from "./panels";

const BASELINE_DECISION: Record<
  BaselineRound["decision"],
  { tone: Tone; icon: string; label: string }
> = {
  AGREED_NO_PAYMENT_YET: {
    tone: "neutral",
    icon: "○",
    label: "Accepted with no check; nothing paid yet",
  },
  PAID_UNCHECKED: { tone: "danger", icon: "!", label: "Paid with no check (simulated)" },
  NO_ACTION: { tone: "neutral", icon: "○", label: "No action" },
};

const PROTECTED_DECISION: Record<
  ProtectedRound["decision"],
  { tone: Tone; icon: string; label: string }
> = {
  AGREED_UNDER_POLICY: { tone: "success", icon: "✓", label: "Agreed: the server allowed it" },
  AGREED_NEEDS_APPROVAL: {
    tone: "warning",
    icon: "…",
    label: "Agreed, but a human must approve before any payment",
  },
  REFUSED_BY_POLICY: { tone: "info", icon: "■", label: "Refused by the server's policy engine" },
  NO_ACTION: { tone: "neutral", icon: "○", label: "No action" },
};

const short = (h: string | null, n = 16) => (h === null ? "-" : h.slice(0, n));

/* ------------------------------------------------------------------ mandate and story */

export function MandateCard({ r }: { r: FlagshipResult }) {
  const m = r.mandate;
  return (
    <section className="card" aria-labelledby="fm-h">
      <header className="card__head">
        <h2 id="fm-h">The approved mandate</h2>
        <div className="chips">
          <Chip tone="info">Synthetic data</Chip>
        </div>
      </header>
      <dl className="kv">
        <div>
          <dt>Currency</dt>
          <dd className="strong">{m.currency}</dd>
        </div>
        <div>
          <dt>Maximum transaction</dt>
          <dd className="num strong">{money(m.perTxCapMinor, m.currency)}</dd>
        </div>
        <div>
          <dt>Approved category</dt>
          <dd className="strong">Digital design ({m.category})</dd>
        </div>
        <div>
          <dt>A human must approve any agreement above</dt>
          <dd className="num strong">{money(m.approvalThresholdMinor, m.currency)}</dd>
        </div>
        <div>
          <dt>Total budget</dt>
          <dd className="num">{money(m.totalBudgetMinor, m.currency)}</dd>
        </div>
        <div>
          <dt>Allowed seller</dt>
          <dd>{m.sellerName}</dd>
        </div>
      </dl>
      <p className="muted small">
        An approval belongs to exactly one agreement: it never carries over to changed terms, and no
        approval can lift the maximum transaction. Only the operator can change the mandate.
      </p>
    </section>
  );
}

export function StoryCard({ r }: { r: FlagshipResult }) {
  return (
    <section className="card" aria-labelledby="fs-h">
      <header className="card__head">
        <h2 id="fs-h">The attack, as both buyers received it</h2>
        <div className="chips">
          {r.inputs.identical ? (
            <Chip tone="success" icon="✓">
              Inputs identical
            </Chip>
          ) : (
            <Chip tone="danger" icon="!">
              INPUTS DIFFER
            </Chip>
          )}
        </div>
      </header>
      {r.rounds.map((round, i) => (
        <div key={round.n} className="step">
          <h3 className="subhead">{round.title}</h3>
          {round.messages.map((m) => (
            <div key={m.text} className="quote">
              <p>{m.text}</p>
              {m.tags.length > 0 ? (
                <p className="chips">
                  {m.tags.map((t) => (
                    <Chip key={t} tone="warning">
                      Tactic: {t}
                    </Chip>
                  ))}
                </p>
              ) : null}
            </div>
          ))}
          <dl className="kv kv--tight">
            <div>
              <dt>Offer</dt>
              <dd>{round.offer.lineText}</dd>
            </div>
            <div>
              <dt>Seller states</dt>
              <dd className="num">{money(round.offer.claimedTotalMinor, r.mandate.currency)}</dd>
            </div>
            <div>
              <dt>Server computes</dt>
              <dd className="num">{money(round.offer.serverTotalMinor, r.mandate.currency)}</dd>
            </div>
            <div>
              <dt>Input hash given to both</dt>
              <dd>
                <code className="code">{short(r.inputs.baseline[i] ?? null, 12)}</code>
                {r.inputs.baseline[i] === r.inputs.protected[i] ? " = " : " ≠ "}
                <code className="code">{short(r.inputs.protected[i] ?? null, 12)}</code>
              </dd>
            </div>
          </dl>
        </div>
      ))}
      <p className="muted small">
        Seller text is untrusted. The model that reads it is a <strong>scripted simulation</strong>{" "}
        (<code className="code">{r.brain}</code>), the same for both buyers. Assumed behaviour:{" "}
        {r.brainTraits.join("; ")}. It is not a measurement of any real model.
      </p>
    </section>
  );
}

/* ------------------------------------------------------------------ the two panes */

function ProposalLine({ p }: { p: BaselineRound["proposal"] }) {
  return (
    <p className="muted small">
      Model said: <code className="code">{p.kind}</code>{" "}
      {p.kind === "PAY"
        ? `(untrusted model text: “${p.rationale}”)`
        : `(untrusted model text: “${p.reason}”)`}
    </p>
  );
}

export function BaselinePane({ r }: { r: FlagshipResult }) {
  const b = r.baseline;
  const cur = r.mandate.currency;
  return (
    <section className="card pane pane--baseline" aria-labelledby="fb-h">
      <header className="pane__head">
        <h2 id="fb-h">{b.label}</h2>
        <div className="chips">
          <Chip tone="danger" icon="!">
            UNSAFE BY DESIGN
          </Chip>
          <Chip tone="warning">SIMULATED LEDGER ONLY</Chip>
        </div>
        <p className="muted small">
          The model&rsquo;s decision is executed as it stands. No policy layer, no payment
          credentials, no PayPal access: it can only debit a simulated ledger.
        </p>
      </header>
      {b.rounds.map((x) => {
        const d = BASELINE_DECISION[x.decision];
        return (
          <div key={x.round} className={`pay pay--${d.tone}`} aria-live="polite">
            <div className="pay__head">
              <span className="strong">Round {x.round}</span>
              <Chip tone={d.tone} icon={d.icon}>
                {d.label}
              </Chip>
            </div>
            <ProposalLine p={x.proposal} />
            <dl className="kv kv--tight">
              <div>
                <dt>Decision</dt>
                <dd className="strong">{d.label}</dd>
              </div>
              <div>
                <dt>Attempted amount</dt>
                <dd className="num strong">
                  {x.attemptedAmountMinor === null
                    ? "none"
                    : `${money(x.attemptedAmountMinor, cur)} to ${x.attemptedPayeeRef ?? "-"}`}
                </dd>
              </div>
              <div>
                <dt>Approved limit</dt>
                <dd className="num">{money(r.mandate.perTxCapMinor, cur)} per transaction</dd>
              </div>
              <div>
                <dt>Reason</dt>
                <dd>{x.reason}</dd>
              </div>
              <div>
                <dt>Resulting transaction state</dt>
                <dd>
                  <code className="code">
                    {x.receipt ? "SIMULATED_DEBIT_EXECUTED" : "NO_TRANSACTION_RECORD"}
                  </code>
                </dd>
              </div>
              <div>
                <dt>Money moved (simulated)</dt>
                <dd className="num strong">
                  {x.receipt
                    ? `${money(x.receipt.amountMinor, cur)} · ${x.receipt.receiptId}`
                    : "none"}
                </dd>
              </div>
            </dl>
            {x.harms.length > 0 ? <HarmChips harms={x.harms} none="" /> : null}
          </div>
        );
      })}
      <p className="muted small">
        <strong>No policy check, by design.</strong> The only limits this buyer has are the words in
        its instructions.
      </p>
      <dl className="kv kv--tight">
        <div>
          <dt>Total moved (simulated)</dt>
          <dd className="num strong">{money(b.moneyMovedMinor, cur)}</dd>
        </div>
        <div>
          <dt>Mandate violations</dt>
          <dd>
            <HarmChips harms={b.harms} none="None" />
          </dd>
        </div>
      </dl>
    </section>
  );
}

export function ProtectedPane({ r }: { r: FlagshipResult }) {
  const p = r.protected;
  const cur = r.mandate.currency;
  return (
    <section className="card pane pane--protected" aria-labelledby="fp-h">
      <header className="pane__head">
        <h2 id="fp-h">{p.label}</h2>
        <div className="chips">
          <Chip tone="success" icon="✓">
            POLICY ENFORCED
          </Chip>
          <Chip tone="info">Real server decisions</Chip>
        </div>
        <p className="muted small">
          The model only asks to accept an offer. The real negotiation service and policy engine
          decide from the stored offer and mandate; no amount or payee from the model is read.
        </p>
      </header>
      {p.rounds.map((x) => {
        const d = PROTECTED_DECISION[x.decision];
        const s = x.server;
        return (
          <div key={x.round} className={`pay pay--${d.tone}`} aria-live="polite">
            <div className="pay__head">
              <span className="strong">Round {x.round}</span>
              <Chip tone={d.tone} icon={d.icon}>
                {d.label}
              </Chip>
            </div>
            <ProposalLine p={x.proposal} />
            <dl className="kv kv--tight">
              <div>
                <dt>Decision</dt>
                <dd className="strong">{d.label}</dd>
              </div>
              <div>
                <dt>Attempted amount</dt>
                <dd className="num strong">
                  {r.rounds[x.round - 1]
                    ? money(r.rounds[x.round - 1]!.offer.serverTotalMinor, cur)
                    : "-"}{" "}
                  (the offer on record)
                </dd>
              </div>
              <div>
                <dt>Approved limit</dt>
                <dd className="num">
                  {money(r.mandate.perTxCapMinor, cur)} per transaction · human approval above{" "}
                  {money(r.mandate.approvalThresholdMinor, cur)}
                </dd>
              </div>
              <div>
                <dt>Reason</dt>
                <dd>{x.reason}</dd>
              </div>
              <div>
                <dt>Resulting transaction state</dt>
                <dd>
                  <code className="code">{x.agreementAfter?.transactionState ?? "none"}</code>
                  {x.agreementAfter
                    ? ` (agreement v${x.agreementAfter.version} in force at ${money(x.agreementAfter.totalMinor, cur)})`
                    : ""}
                </dd>
              </div>
              <div>
                <dt>Money moved</dt>
                <dd className="num strong">none</dd>
              </div>
            </dl>
            {s ? (
              <div className="policy">
                <Chip
                  tone={s.verdict === "DENY" ? "info" : "success"}
                  icon={s.verdict === "DENY" ? "■" : "✓"}
                >
                  Server policy check (accept this offer): {s.verdict ?? "?"}
                </Chip>
                {s.reasonCodes.map((c) => (
                  <code key={c} className="code">
                    {c}
                  </code>
                ))}
                {s.explanation.map((i) => (
                  <p key={i.code} className="muted small">
                    {i.title}. {i.detail}
                  </p>
                ))}
                <p className="muted small">
                  Policy {s.policyVersion ?? "?"} · check{" "}
                  <code className="code">{s.checkId ?? "-"}</code> · inputs hash{" "}
                  <code className="code">{short(s.inputsHash)}</code> · offer{" "}
                  {s.proposalStatus?.toLowerCase() ?? "?"}
                </p>
              </div>
            ) : (
              <p className="muted small">
                The server was not asked, because the model did not ask to accept.
              </p>
            )}
            {x.eligibility ? (
              <p className="muted small">
                Payment eligibility from the server:{" "}
                <code className="code">{x.eligibility.state}</code>
                {x.eligibility.reasonCodes.map((c) => (
                  <code key={c} className="code">
                    {" "}
                    {c}
                  </code>
                ))}
              </p>
            ) : null}
          </div>
        );
      })}
      <dl className="kv kv--tight">
        <div>
          <dt>Payable agreement now</dt>
          <dd className="num strong">
            {p.payableAgreement
              ? `v${p.payableAgreement.version}: ${money(p.payableAgreement.totalMinor, cur)} (${p.payableAgreement.transactionState})`
              : "none"}
          </dd>
        </div>
        <div>
          <dt>Mandate violations</dt>
          <dd>
            <Chip tone="success" icon="✓">
              None
            </Chip>
          </dd>
        </div>
      </dl>
    </section>
  );
}

/* ------------------------------------------------------------------ audit and tampering */

function AuditRow({ e, decisive }: { e: AuditEventView; decisive: boolean }) {
  return (
    <tr
      className={decisive ? "row--decisive" : undefined}
      aria-current={decisive ? "true" : undefined}
    >
      <th scope="row" className="num">
        {e.seq}
      </th>
      <td>{e.actor.toLowerCase().replaceAll("_", " ")}</td>
      <td>
        <code className="code">{e.type}</code>
        {decisive ? (
          <>
            {" "}
            <Chip tone="info" icon="■">
              Decisive
            </Chip>
          </>
        ) : null}
      </td>
      <td className="small">{e.summary}</td>
      <td>
        <code className="code">{short(e.hash, 12)}</code>
      </td>
    </tr>
  );
}

export function AuditCard({ r }: { r: FlagshipResult }) {
  const d = r.audit.decisive;
  return (
    <section className="card" aria-labelledby="fa-h">
      <header className="card__head">
        <h2 id="fa-h">The server&rsquo;s audit trail</h2>
        <div className="chips">
          <Chip
            tone={r.audit.chain === "VERIFIED" ? "success" : "danger"}
            icon={r.audit.chain === "VERIFIED" ? "✓" : "!"}
          >
            Hash chain {r.audit.chain}
          </Chip>
        </div>
      </header>
      {d ? (
        <div className="policy">
          <Chip tone="info" icon="■">
            Decisive event #{d.seq}: {d.type}
          </Chip>
          {d.reasonCodes.map((c) => (
            <code key={c} className="code">
              {c}
            </code>
          ))}
          <p className="muted small" style={{ overflowWrap: "anywhere" }}>
            Recorded by the server at {d.ts.slice(0, 19).replace("T", " ")} UTC for actor{" "}
            {d.actor.toLowerCase().replaceAll("_", " ")}. {d.summary}. Inputs hash{" "}
            <code className="code">{short(d.inputsHash, 64)}</code>; event hash{" "}
            <code className="code">{short(d.hash, 64)}</code>.
          </p>
        </div>
      ) : (
        <p className="muted small">No policy refusal was recorded in this run.</p>
      )}
      <div className="tablewrap">
        <table className="table">
          <caption className="sr-only">Every audit event of this run, oldest first</caption>
          <thead>
            <tr>
              <th scope="col">#</th>
              <th scope="col">Actor</th>
              <th scope="col">Event</th>
              <th scope="col">Detail</th>
              <th scope="col">Hash</th>
            </tr>
          </thead>
          <tbody>
            {r.audit.events.map((e) => (
              <AuditRow key={e.seq} e={e} decisive={d?.seq === e.seq} />
            ))}
          </tbody>
        </table>
      </div>
      <p className="muted small">
        The chain is local tamper evidence. It does not prove anything about PayPal. Malformed
        requests (below) are refused before anything is recorded, so they leave no event.
      </p>
    </section>
  );
}

export function TamperCard({ r }: { r: FlagshipResult }) {
  return (
    <section className="card" aria-labelledby="ft-h">
      <header className="card__head">
        <h2 id="ft-h">Tampering attempts, answered by the server</h2>
      </header>
      <div className="tablewrap">
        <table className="table">
          <caption className="sr-only">Manipulation attempts and what the server did</caption>
          <thead>
            <tr>
              <th scope="col">Attempt</th>
              <th scope="col">Result</th>
              <th scope="col">Exact code</th>
              <th scope="col">Detail</th>
            </tr>
          </thead>
          <tbody>
            {r.tamperAttempts.map((t) => (
              <tr key={t.id}>
                <th scope="row">{t.attempt}</th>
                <td>
                  <Chip tone="info" icon="■">
                    {t.outcome}
                  </Chip>
                </td>
                <td>
                  <code className="code">{t.code}</code>
                </td>
                <td className="small">{t.detail}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}
