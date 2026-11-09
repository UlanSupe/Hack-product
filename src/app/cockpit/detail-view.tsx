import type { CockpitDetail } from "@/domain/cockpit";
import { SOURCE_LABEL, formatAmount } from "@/domain/cockpit";
import { Chip } from "../_arena/panels";
import { JourneyHeader } from "../_journey/journey-header";
import {
  AUDIT_LABEL,
  DECISION_LABEL,
  MODE_LABEL,
  auditTone,
  decisionTone,
  formatTimestamp,
  verificationTone,
} from "./columns";

/** The detail of one Cockpit row: the same columns as the grid, then what the source recorded behind them. */
export function DetailView({ detail }: { detail: CockpitDetail }) {
  const r = detail.row;
  const d = decisionTone(r.decision);
  const a = auditTone(r.auditChain);
  const v = verificationTone(r.verification);
  return (
    <>
      <JourneyHeader current="cockpit" />
      <main className="wrap" id="main">
        <p className="small">
          <a href="/cockpit">← Back to the Cockpit</a>
        </p>
        <h1>
          <span className="mono">{r.refId}</span>
        </h1>
        <p className="muted">{SOURCE_LABEL[r.source]}</p>

        <section className="card" aria-labelledby="sum-h">
          <h2 id="sum-h">Summary</h2>
          <dl className="kv">
            <div>
              <dt>Timestamp</dt>
              <dd>{formatTimestamp(r.timestamp)}</dd>
            </div>
            <div>
              <dt>Scenario</dt>
              <dd>{r.scenario ?? "not recorded"}</dd>
            </div>
            <div>
              <dt>Category</dt>
              <dd>{r.category ?? "not recorded"}</dd>
            </div>
            <div>
              <dt>Buyer mode</dt>
              <dd>{r.buyerMode ? MODE_LABEL[r.buyerMode] : "not recorded"}</dd>
            </div>
            <div>
              <dt>Proposed amount</dt>
              <dd>{formatAmount(r.proposedMinor, r.currency)}</dd>
            </div>
            <div>
              <dt>Approved amount</dt>
              <dd>{formatAmount(r.approvedMinor, r.currency)}</dd>
            </div>
            <div>
              <dt>Money moved</dt>
              <dd>{formatAmount(r.movedMinor, r.currency)}</dd>
            </div>
            <div>
              <dt>Decision</dt>
              <dd>
                <Chip tone={d.tone} icon={d.icon}>
                  {DECISION_LABEL[r.decision]}
                </Chip>
              </dd>
            </div>
            <div>
              <dt>Reason code{r.reasonCodes.length === 1 ? "" : "s"}</dt>
              <dd>
                {r.reasonCodes.length > 0 ? r.reasonCodes.join(", ") : "none"}
                {r.reasonSource ? (
                  <span className="muted small"> ({r.reasonSource.toLowerCase()})</span>
                ) : null}
              </dd>
            </div>
            <div>
              <dt>Payment status</dt>
              <dd>{r.paymentStatus}</dd>
            </div>
            <div>
              <dt>Verification</dt>
              <dd>
                <Chip tone={v.tone} icon={v.icon}>
                  {r.verification.replaceAll("_", " ").toLowerCase()}
                </Chip>
              </dd>
            </div>
            <div>
              <dt>Audit chain</dt>
              <dd>
                <Chip tone={a.tone} icon={a.icon}>
                  {AUDIT_LABEL[r.auditChain]}
                </Chip>
              </dd>
            </div>
          </dl>
        </section>

        {detail.sections.map((s) => (
          <section key={s.title} className="card" aria-label={s.title}>
            <h2>{s.title}</h2>
            {s.note ? <p className="muted small">{s.note}</p> : null}
            {s.items.length === 0 ? (
              <p className="muted">Nothing recorded.</p>
            ) : (
              <dl className="kv kv--tight">
                {s.items.map((i, n) => (
                  <div key={`${i.label}-${n}`} className="kv__wide">
                    <dt>{i.label}</dt>
                    <dd className="pre">{i.value}</dd>
                  </div>
                ))}
              </dl>
            )}
          </section>
        ))}
      </main>
    </>
  );
}

/** Shown for an id that matches no row, or whose source cannot be read right now. */
export function DetailNotFound({ id, reason }: { id: string; reason: string }) {
  return (
    <>
      <JourneyHeader current="cockpit" />
      <main className="wrap" id="main">
        <p className="small">
          <a href="/cockpit">← Back to the Cockpit</a>
        </p>
        <h1>Row not found</h1>
        <p className="banner banner--warning" role="alert">
          {reason}
        </p>
        <p className="muted small">
          Requested id: <span className="mono">{id.slice(0, 120)}</span>
        </p>
      </main>
    </>
  );
}
