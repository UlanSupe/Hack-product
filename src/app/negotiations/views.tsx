import type { ReactNode } from "react";

import type {
  AgreementView,
  NegotiationDetail,
  PolicyCheckView,
  ProposalView,
  SellerThread,
} from "@/application/negotiation-views";
import type { NegotiationOverview } from "@/application/negotiations";
import type { PaymentView } from "@/application/payment-views";
import type { PolicyExplanation } from "@/application/negotiation-policy";
import { SERVICE_CATEGORIES, type FieldError } from "@/domain/mandate";
import type { NegotiationStatus, ProposalStatus } from "@/domain/negotiation";
import { Chip, Skeleton } from "../_arena/panels";
import { NoticeBar, type Notice } from "../mandate/views";
import { useJourney } from "../_journey/journey-context";
import { StateNote } from "../_ui/state-note";

/* ------------------------------------------------------------------ state shapes (owned by the container) */

export type Phase =
  | { kind: "loading" }
  | { kind: "error"; message: string }
  | { kind: "not_configured" }
  | { kind: "signed_out" }
  | { kind: "ready"; overview: NegotiationOverview };

export type OpenForm = {
  mandateId: string;
  category: string;
  quantity: string;
  summary: string;
  maxTotal: string;
  neededWithinDays: string;
  deliverables: string;
  sellers: string[];
  timeoutMinutes: string;
};

export type Confirming =
  | null
  | "approve"
  | "disapprove"
  | "close-rejected"
  | "close-cancelled"
  | "pay-capture"
  | "pay-void";

export type Actions = {
  startPayment: () => void;
  checkPayment: () => void;
  authorizePayment: () => void;
  capturePayment: () => void;
  voidPayment: () => void;
  retry: () => void;
  login: (passcode: string) => void;
  signOut: () => void;
  select: (id: string | null) => void;
  refresh: () => void;
  toggleOpen: () => void;
  changeForm: (patch: Partial<OpenForm>) => void;
  submitOpen: () => void;
  runDemo: (agents: "mock" | "model") => void;
  accept: (proposalId: string) => void;
  reject: (proposalId: string) => void;
  check: () => void;
  confirm: (what: Confirming) => void;
  approve: () => void;
  disapprove: () => void;
  close: (outcome: "REJECTED" | "CANCELLED") => void;
};

export type ViewProps = {
  phase: Phase;
  loginError: string | null;
  loginBusy: boolean;
  selectedId: string | null;
  detail: NegotiationDetail | null;
  detailLoading: boolean;
  form: OpenForm | null;
  formErrors: FieldError[];
  notice: Notice | null;
  busy: string | null;
  confirming: Confirming;
  /** The server's record of the payment for the selected negotiation, if it has an active agreement. */
  payment?: PaymentView | null;
  actions: Actions;
};

/* ------------------------------------------------------------------ small pieces */

const when = (iso: string) => `${iso.slice(0, 16).replace("T", " ")} UTC`;

const NEGOTIATION_TONE: Record<
  NegotiationStatus,
  "success" | "warning" | "danger" | "info" | "neutral"
> = {
  OPEN: "info",
  AGREED: "success",
  REJECTED: "danger",
  TIMED_OUT: "warning",
  CANCELLED: "neutral",
};
const PROPOSAL_TONE: Record<ProposalStatus, "success" | "warning" | "danger" | "info" | "neutral"> =
  {
    OPEN: "info",
    SUPERSEDED: "neutral",
    ACCEPTED: "success",
    REJECTED: "danger",
    EXPIRED: "warning",
    WITHDRAWN: "neutral",
  };
const NEGOTIATION_LABEL: Record<NegotiationStatus, string> = {
  OPEN: "Open",
  AGREED: "Agreed",
  REJECTED: "Rejected",
  TIMED_OUT: "Timed out",
  CANCELLED: "Cancelled",
};

function Panel({
  id,
  title,
  aside,
  children,
}: {
  id: string;
  title: string;
  aside?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="card" aria-labelledby={id}>
      <header className="card__head">
        <h2 id={id}>{title}</h2>
        {aside}
      </header>
      {children}
    </section>
  );
}

/** Seller- or model-written text is always shown as plain text, labelled as such. */
function Untrusted({ children }: { children: ReactNode }) {
  return <span className="untrusted">{children}</span>;
}

/* ------------------------------------------------------------------ the policy engine's answer, in words */

export function PolicyBox({ policy, label }: { policy: PolicyExplanation; label?: string }) {
  const allowed = policy.verdict === "ALLOW";
  return (
    <div className={`explain explain--${allowed ? "allow" : "deny"}`}>
      <p className="explain__head">
        <Chip tone={allowed ? "success" : "info"} icon={allowed ? "✓" : "■"}>
          {allowed ? "Allowed" : "Refused"}
        </Chip>{" "}
        <span>{policy.headline}</span>
      </p>
      {policy.items.length > 0 ? (
        <ul className="explain__items">
          {policy.items.map((item) => (
            <li key={item.code}>
              <strong>{item.title}.</strong> {item.detail}{" "}
              <span className="explain__code">({item.code})</span>
              <em>What you can do: {item.next}</em>
            </li>
          ))}
        </ul>
      ) : null}
      <p className="muted small">
        {label ??
          (policy.source === "RECORDED"
            ? `Recorded policy check, ${policy.policyVersion}${policy.decidedAt ? `, ${when(policy.decidedAt)}` : ""}.`
            : "Live preview of the policy engine; nothing was stored.")}
      </p>
    </div>
  );
}

/* ------------------------------------------------------------------ gate states */

export function LoadingView() {
  return (
    <Panel id="loading-h" title="Negotiations">
      <Skeleton lines={6} />
    </Panel>
  );
}

export function ErrorView({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <Panel id="error-h" title="Could not load negotiations">
      <StateNote
        kind="failed"
        title={message}
        actions={
          <button type="button" className="btn" onClick={onRetry}>
            Retry
          </button>
        }
      />
    </Panel>
  );
}

export function NotConfiguredView() {
  return (
    <Panel id="nc-h" title="Operator access is not set up">
      <p>
        Negotiations are run by the human operator. This server has no operator passcode yet, so
        nobody can sign in.
      </p>
      <p>
        Add <code className="code">OPERATOR_PASSCODE</code> (at least 16 characters) to{" "}
        <code className="code">.env.local</code>, run{" "}
        <code className="code">npm run db:migrate &amp;&amp; npm run db:seed</code>, restart, and
        reload.
      </p>
    </Panel>
  );
}

export function LoginView({
  error,
  busy,
  onLogin,
}: {
  error: string | null;
  busy: boolean;
  onLogin: (passcode: string) => void;
}) {
  return (
    <Panel id="login-h" title="Operator sign-in">
      <p className="muted">
        Only the human operator can open, accept, approve or close a negotiation. AI agents have no
        access to this page.
      </p>
      <form
        className="stack"
        onSubmit={(e) => {
          e.preventDefault();
          const value = new FormData(e.currentTarget).get("passcode");
          onLogin(typeof value === "string" ? value : "");
        }}
      >
        <div className="field">
          <label htmlFor="passcode">Operator passcode</label>
          <input
            id="passcode"
            name="passcode"
            type="password"
            className="input"
            autoComplete="current-password"
            required
            aria-invalid={error ? true : undefined}
            aria-describedby={error ? "login-error" : undefined}
          />
        </div>
        {error ? (
          <p id="login-error" className="field-error" role="alert">
            {error}
          </p>
        ) : null}
        <div>
          <button type="submit" className="btn btn--primary" disabled={busy}>
            {busy ? "Signing in…" : "Sign in"}
          </button>
        </div>
      </form>
    </Panel>
  );
}

/* ------------------------------------------------------------------ list and open form */

function NegotiationList({
  overview,
  selectedId,
  actions,
}: {
  overview: NegotiationOverview;
  selectedId: string | null;
  actions: Actions;
}) {
  return (
    <Panel
      id="list-h"
      title="Negotiations"
      aside={
        <button type="button" className="btn btn--primary" onClick={actions.toggleOpen}>
          New negotiation
        </button>
      }
    >
      {overview.negotiations.length === 0 ? (
        <div className="state state--empty">
          <p className="state__title">No negotiations yet</p>
          <p className="muted">
            Open one to state what you want to buy and set a deadline. Sellers (or the demo agents)
            then make offers.
          </p>
        </div>
      ) : (
        <ul className="list">
          {overview.negotiations.map((n) => (
            <li key={n.id}>
              <button
                type="button"
                className={`listitem${n.id === selectedId ? " listitem--on" : ""}`}
                aria-current={n.id === selectedId ? "true" : undefined}
                onClick={() => actions.select(n.id)}
              >
                <span className="listitem__title">{n.summary}</span>
                <span className="chips">
                  <Chip tone={NEGOTIATION_TONE[n.status]}>{NEGOTIATION_LABEL[n.status]}</Chip>
                  <span className="muted small">
                    {n.categoryLabel} · {n.offers} offer{n.offers === 1 ? "" : "s"}
                    {n.activeAgreement
                      ? ` · agreement v${n.activeAgreement.version}: ${n.activeAgreement.totalText}`
                      : ""}
                  </span>
                </span>
                <span className="muted small">Deadline {when(n.expiresAt)}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </Panel>
  );
}

const errorFor = (errors: FieldError[], field: string) =>
  errors.find((e) => e.field === field)?.message;

function OpenFormView({
  overview,
  form,
  errors,
  busy,
  actions,
}: {
  overview: NegotiationOverview;
  form: OpenForm;
  errors: FieldError[];
  busy: boolean;
  actions: Actions;
}) {
  const mandate = overview.mandates.find((m) => m.id === form.mandateId);
  const field = (name: keyof OpenForm, label: string, hint?: string, input?: ReactNode) => {
    const message = errorFor(
      errors,
      name === "deliverables"
        ? "requiredDeliverables"
        : name === "sellers"
          ? "invitedSellerIds"
          : name === "maxTotal"
            ? "maxTotal"
            : name === "timeoutMinutes"
              ? "timeoutMinutes"
              : name,
    );
    return (
      <div className="field">
        <label htmlFor={`f-${name}`}>{label}</label>
        {input ?? (
          <input
            id={`f-${name}`}
            className="input"
            value={String(form[name])}
            aria-invalid={message ? true : undefined}
            aria-describedby={message ? `f-${name}-err` : undefined}
            onChange={(e) => actions.changeForm({ [name]: e.target.value })}
          />
        )}
        {hint ? <span className="hint block">{hint}</span> : null}
        {message ? (
          <p id={`f-${name}-err`} className="field-error" role="alert">
            {message}
          </p>
        ) : null}
      </div>
    );
  };
  return (
    <Panel id="open-h" title="New negotiation">
      <form
        className="stack"
        onSubmit={(e) => {
          e.preventDefault();
          actions.submitOpen();
        }}
        noValidate
      >
        <div className="formgrid">
          {field(
            "mandateId",
            "Mandate",
            mandate
              ? `Currency ${mandate.currency}. Every offer is checked against this mandate's current version.`
              : undefined,
            <select
              id="f-mandateId"
              className="input"
              value={form.mandateId}
              onChange={(e) => actions.changeForm({ mandateId: e.target.value })}
            >
              {overview.mandates.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.id} (version {m.version}, {m.currency})
                </option>
              ))}
            </select>,
          )}
          {field(
            "category",
            "Service category",
            undefined,
            <select
              id="f-category"
              className="input"
              value={form.category}
              onChange={(e) => actions.changeForm({ category: e.target.value })}
            >
              {Object.entries(SERVICE_CATEGORIES).map(([code, label]) => (
                <option key={code} value={code}>
                  {label}
                </option>
              ))}
            </select>,
          )}
          {field("quantity", "Quantity")}
          {field(
            "maxTotal",
            `Most you want to pay in total${mandate ? ` (${mandate.currency})` : ""}`,
            "Optional, as a plain decimal such as 70.00. Your mandate's limits still apply on top.",
          )}
          {field("neededWithinDays", "Needed within (days)", "Optional.")}
          {field(
            "timeoutMinutes",
            "Negotiation timeout",
            "After this the negotiation closes and open offers expire.",
            <select
              id="f-timeoutMinutes"
              className="input"
              value={form.timeoutMinutes}
              onChange={(e) => actions.changeForm({ timeoutMinutes: e.target.value })}
            >
              {[
                ["15", "15 minutes"],
                ["60", "1 hour"],
                ["240", "4 hours"],
                ["1440", "1 day"],
              ].map(([v, l]) => (
                <option key={v} value={v}>
                  {l}
                </option>
              ))}
            </select>,
          )}
        </div>
        {field("summary", "What do you want to buy?")}
        {field(
          "deliverables",
          "Required deliverables (one per line)",
          "These are the acceptance criteria. A change to them later counts as a change to the deal.",
          <textarea
            id="f-deliverables"
            className="input"
            rows={3}
            value={form.deliverables}
            onChange={(e) => actions.changeForm({ deliverables: e.target.value })}
          />,
        )}
        <fieldset className="field">
          <legend>Invite sellers</legend>
          {overview.sellers.map((s) => {
            const allowed = mandate?.allowedSellerIds.includes(s.id) ?? false;
            return (
              <label key={s.id} className="check">
                <input
                  type="checkbox"
                  checked={form.sellers.includes(s.id)}
                  onChange={(e) =>
                    actions.changeForm({
                      sellers: e.target.checked
                        ? [...form.sellers, s.id]
                        : form.sellers.filter((x) => x !== s.id),
                    })
                  }
                />{" "}
                {s.displayName}{" "}
                <span className="muted small">
                  {allowed
                    ? "(on the mandate's allow-list)"
                    : "(NOT on the allow-list: its offers will be refused)"}
                </span>
              </label>
            );
          })}
          {errorFor(errors, "invitedSellerIds") ? (
            <p className="field-error" role="alert">
              {errorFor(errors, "invitedSellerIds")}
            </p>
          ) : null}
        </fieldset>
        <div className="row">
          <button type="submit" className="btn btn--primary" disabled={busy}>
            {busy ? "Opening…" : "Open negotiation"}
          </button>
          <button type="button" className="btn btn--quiet" onClick={actions.toggleOpen}>
            Cancel
          </button>
        </div>
      </form>
    </Panel>
  );
}

/* ------------------------------------------------------------------ one negotiation */

function ProposalCard({
  p,
  live,
  busy,
  actions,
}: {
  p: ProposalView;
  live: boolean;
  busy: string | null;
  actions: Actions;
}) {
  const counter = p.kind === "BUYER_COUNTER";
  const who = `${p.sellerName} ${counter ? "counter-offer" : "offer"} version ${p.version}`;
  return (
    <article className={`proposal proposal--${p.status.toLowerCase()}`} aria-label={who}>
      <header className="proposal__head">
        <h4>
          {counter ? "Your counter-offer" : "Offer"} v{p.version}
        </h4>
        <Chip tone={PROPOSAL_TONE[p.status]}>{p.statusText}</Chip>
        <span className="muted small">
          {when(p.createdAt)} · recorded by {p.actor.toLowerCase()}
        </span>
      </header>
      {p.statusReason ? <p className="muted small">{p.statusReason}</p> : null}

      <dl className="terms terms--key">
        <div>
          <dt>Total price</dt>
          <dd>
            <strong>{p.terms.totalText}</strong>
            {p.totalMatchesClaim === false ? (
              <span className="warn">
                {" "}
                The seller stated {p.claimedTotalText}; we use our own sum.
              </span>
            ) : null}
          </dd>
        </div>
        <div>
          <dt>Delivery</dt>
          <dd>
            within {p.terms.deliveryDays} day{p.terms.deliveryDays === 1 ? "" : "s"} (by{" "}
            {when(p.terms.deliverBy)})
          </dd>
        </div>
        <div>
          <dt>{counter ? "Valid until" : "Offer valid until"}</dt>
          <dd>
            {when(p.terms.validUntil)}
            {p.expired && p.status === "OPEN" ? <span className="warn"> (expired)</span> : null}
          </dd>
        </div>
      </dl>
      <details className="details" open={p.status === "OPEN"}>
        <summary>Full terms, items and deliverables</summary>
        <dl className="terms">
          <div>
            <dt>Currency</dt>
            <dd>{p.terms.currency}</dd>
          </div>
          <div>
            <dt>Category</dt>
            <dd>{p.terms.categoryLabel}</dd>
          </div>
          {p.terms.lines ? (
            <div>
              <dt>Items</dt>
              <dd>
                {p.terms.lines.map((l) => (
                  <span key={l.sku} className="block">
                    {l.qty} × <span className="code">{l.sku}</span> at {l.unitText}
                  </span>
                ))}
                {p.terms.shippingText && p.terms.shippingText !== "0.00 USD" ? (
                  <span className="block">Shipping {p.terms.shippingText}</span>
                ) : null}
              </dd>
            </div>
          ) : null}
          <div>
            <dt>Deliverables (acceptance criteria)</dt>
            <dd>
              <ul className="plain">
                {p.terms.deliverables.map((d) => (
                  <li key={d}>
                    <Untrusted>{d}</Untrusted>
                  </li>
                ))}
              </ul>
            </dd>
          </div>
          {p.terms.termsText ? (
            <div>
              <dt>{counter ? "Note" : "Written terms"}</dt>
              <dd>
                <Untrusted>{p.terms.termsText}</Untrusted>
              </dd>
            </div>
          ) : null}
        </dl>
      </details>

      {p.changes.length > 0 ? (
        <div className="changes">
          <p className="small">
            <strong>Changed since the previous version:</strong>
          </p>
          <ul>
            {p.changes.map((c) => (
              <li key={c.kind}>
                <Chip tone="warning">{c.kind.replace("_", " ").toLowerCase()}</Chip> {c.text}
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {p.policy ? <PolicyBox policy={p.policy} /> : null}

      {live && (p.actions.canAccept || p.actions.canReject) ? (
        <div className="row">
          {p.actions.canAccept ? (
            <button
              type="button"
              className="btn btn--primary"
              aria-label={`Accept ${who}`}
              disabled={busy !== null}
              onClick={() => actions.accept(p.id)}
            >
              {busy === `accept:${p.id}` ? "Checking…" : "Accept (policy check)"}
            </button>
          ) : null}
          {p.actions.canReject ? (
            <button
              type="button"
              className="btn btn--quiet"
              aria-label={`Reject ${who}`}
              disabled={busy !== null}
              onClick={() => actions.reject(p.id)}
            >
              Reject
            </button>
          ) : null}
        </div>
      ) : null}
      {p.actions.note ? <p className="muted small">{p.actions.note}</p> : null}
    </article>
  );
}

function SellerThreadView({
  t,
  live,
  busy,
  actions,
}: {
  t: SellerThread;
  live: boolean;
  busy: string | null;
  actions: Actions;
}) {
  return (
    <section className="thread" aria-label={`Proposals with ${t.sellerName}`}>
      <h3>{t.sellerName}</h3>
      {t.offers.length === 0 && t.counters.length === 0 ? (
        <p className="muted">No proposals yet.</p>
      ) : null}
      {[...t.offers, ...t.counters]
        .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.version - b.version)
        .map((p) => (
          <ProposalCard key={p.id} p={p} live={live} busy={busy} actions={actions} />
        ))}
    </section>
  );
}

const ELIGIBILITY_LABEL: Record<
  string,
  { tone: "success" | "warning" | "danger" | "info"; text: string }
> = {
  ELIGIBLE: { tone: "success", text: "Eligible for payment" },
  AWAITING_APPROVAL: { tone: "warning", text: "Waiting for your approval" },
  BLOCKED: { tone: "danger", text: "Blocked" },
  IN_PROGRESS: { tone: "info", text: "Payment already started" },
};

function AgreementCard({
  a,
  current,
  busy,
  confirming,
  actions,
}: {
  a: AgreementView;
  current: boolean;
  busy: string | null;
  confirming: Confirming;
  actions: Actions;
}) {
  const e = a.eligibility;
  const label = e ? (ELIGIBILITY_LABEL[e.state] ?? ELIGIBILITY_LABEL.BLOCKED) : null;
  return (
    <article
      className={`agreement${current ? " agreement--current" : ""}`}
      aria-label={`Agreement version ${a.version}`}
    >
      <header className="proposal__head">
        <h4>Agreement v{a.version}</h4>
        <Chip tone={a.status === "ACTIVE" ? "success" : "neutral"}>
          {a.status === "ACTIVE"
            ? "Current"
            : a.status === "INVALIDATED"
              ? "Replaced"
              : "Cancelled"}
        </Chip>
        <span className="muted small">
          {a.sellerName} · {a.totalText} · deliver by {when(a.deliverBy)}
        </span>
      </header>
      <p>
        <Chip
          tone={
            a.approval.state === "APPROVED"
              ? "success"
              : a.approval.state === "REQUIRED"
                ? "warning"
                : a.approval.state === "REJECTED" || a.approval.state === "INVALIDATED"
                  ? "danger"
                  : "neutral"
          }
        >
          {a.approval.state === "NOT_REQUIRED"
            ? "No approval needed"
            : a.approval.state === "REQUIRED"
              ? "Approval required"
              : a.approval.state === "APPROVED"
                ? "Approved"
                : a.approval.state === "REJECTED"
                  ? "Rejected"
                  : "Approval invalidated"}
        </Chip>{" "}
        {a.approval.text}
      </p>
      {a.retired ? (
        <p className="warn">
          Retired {when(a.retired.at)}: {a.retired.reason}
        </p>
      ) : null}
      {e && label ? (
        <>
          <p>
            <Chip tone={label.tone}>{label.text}</Chip>{" "}
            <span className="muted small">
              Payment steps only start when the policy engine allows them.
            </span>
          </p>
          <PolicyBox policy={e.policy} />
        </>
      ) : null}
      {current ? (
        confirming === "approve" || confirming === "disapprove" ? (
          <div className="confirm" role="group" aria-label="Confirm decision">
            <p>
              <strong>
                {confirming === "approve"
                  ? `Approve agreement v${a.version} for ${a.totalText} to ${a.sellerName}?`
                  : `Reject agreement v${a.version}? It will be cancelled and the negotiation reopened.`}
              </strong>
            </p>
            <div className="row">
              <button
                type="button"
                className={`btn ${confirming === "approve" ? "btn--primary" : "btn--danger"}`}
                disabled={busy !== null}
                onClick={confirming === "approve" ? actions.approve : actions.disapprove}
              >
                {confirming === "approve" ? "Yes, approve" : "Yes, reject"}
              </button>
              <button
                type="button"
                className="btn btn--quiet"
                onClick={() => actions.confirm(null)}
              >
                Not yet
              </button>
            </div>
          </div>
        ) : a.approval.state === "REQUIRED" || a.approval.state === "NOT_REQUIRED" ? (
          <div className="row">
            <button
              type="button"
              className="btn btn--primary"
              disabled={busy !== null}
              onClick={() => actions.confirm("approve")}
            >
              Approve this agreement
            </button>
            <button
              type="button"
              className="btn btn--danger"
              disabled={busy !== null}
              onClick={() => actions.confirm("disapprove")}
            >
              Reject this agreement
            </button>
            <button
              type="button"
              className="btn btn--quiet"
              disabled={busy !== null}
              onClick={actions.check}
            >
              Re-check eligibility
            </button>
          </div>
        ) : (
          <div className="row">
            <button
              type="button"
              className="btn btn--quiet"
              disabled={busy !== null}
              onClick={actions.check}
            >
              Re-check eligibility
            </button>
          </div>
        )
      ) : null}
    </article>
  );
}

function ChecksLog({ checks }: { checks: PolicyCheckView[] }) {
  if (checks.length === 0) return null;
  return (
    <details className="details">
      <summary>Policy check history ({checks.length})</summary>
      <ol className="plain">
        {checks.map((c) => (
          <li key={c.id}>
            <p className="small">
              <Chip tone={c.policy.verdict === "ALLOW" ? "success" : "info"}>
                {c.policy.verdict === "ALLOW" ? "Allowed" : "Refused"}
              </Chip>{" "}
              {c.subject === "ACCEPT_OFFER"
                ? "Accepting an offer"
                : `Starting payment for agreement v${c.agreementVersion ?? "?"}`}{" "}
              · {c.policy.decidedAt ? when(c.policy.decidedAt) : ""} · by {c.actor.toLowerCase()}
            </p>
            <PolicyBox policy={c.policy} />
            {c.policy.verdict === "DENY" && c.subject === "ACCEPT_OFFER" ? (
              <p className="small">
                <a href={`/cockpit/${encodeURIComponent(`refused:${c.id}`)}`}>
                  Inspect this refusal in the Cockpit
                </a>
              </p>
            ) : null}
          </li>
        ))}
      </ol>
    </details>
  );
}

/* ------------------------------------------------------------------ the PayPal sandbox payment */

const PAYMENT_KIND: Record<PaymentView["tone"], "pending" | "done" | "failed"> = {
  info: "pending",
  warning: "pending",
  danger: "failed",
  success: "done",
};

const PAYMENT_TONE: Record<PaymentView["tone"], "success" | "warning" | "danger" | "info"> = {
  success: "success",
  warning: "warning",
  danger: "danger",
  info: "info",
};

/**
 * Shows the server's record of the payment and offers the next step. It never talks to PayPal and never decides
 * anything: every word comes from the server's view of verified state, and every button posts an EMPTY request
 * (the server takes the amount, currency, payee and agreement from its own records).
 */
function PaymentPanel({
  payment,
  busy,
  confirming,
  actions,
}: {
  payment: PaymentView;
  busy: string | null;
  confirming: Confirming;
  actions: Actions;
}) {
  const idle = busy === null;
  const { journey } = useJourney();
  const unavailable = journey?.steps.find((x) => x.id === "payment")?.status === "UNAVAILABLE";
  return (
    <Panel
      id="pay-h"
      title="PayPal sandbox payment"
      aside={
        <Chip tone={PAYMENT_TONE[payment.tone]}>
          {payment.state.replaceAll("_", " ").toLowerCase()}
        </Chip>
      }
    >
      <p className="muted small">
        {payment.environment}. A hold is not escrow and nothing here promises a refund. Only a
        capture that PayPal reports as completed counts as paid; this build never pays the seller
        out.
      </p>
      {unavailable ? (
        <div className="notice notice--info" role="note">
          <p>
            <strong>Payment cannot start on this server.</strong> It has no PayPal sandbox
            credentials, and nothing is simulated in their place. You can still inspect the
            agreement and the policy decision, open the Cockpit, and replay the attack. To pay,
            configure the sandbox credentials described in the README and restart the server.
          </p>
        </div>
      ) : null}
      {unavailable ? null : (
        <StateNote kind={PAYMENT_KIND[payment.tone]} title={payment.headline}>
          <p>{payment.detail}</p>
        </StateNote>
      )}
      <dl className="facts">
        <div>
          <dt>Amount (from the agreement)</dt>
          <dd>{payment.amountText}</dd>
        </div>
        <div>
          <dt>Agreement version</dt>
          <dd>v{payment.agreementVersion}</dd>
        </div>
        {payment.paypalOrderId ? (
          <div>
            <dt>PayPal order</dt>
            <dd>{payment.paypalOrderId}</dd>
          </div>
        ) : null}
        {payment.authorization ? (
          <div>
            <dt>Hold</dt>
            <dd>
              {payment.authorization.amountText}, held until{" "}
              {payment.authorization.honorExpiresAt
                ? when(payment.authorization.honorExpiresAt)
                : "unknown"}{" "}
              (honor period)
            </dd>
          </div>
        ) : null}
        {payment.capture ? (
          <div>
            <dt>Capture</dt>
            <dd>{payment.capture.amountText}</dd>
          </div>
        ) : null}
        <div>
          <dt>Paid (captured)</dt>
          <dd>
            {payment.moneyMoved
              ? "Yes: PayPal reports the capture completed. Nothing has been paid out to the seller."
              : "No. Nothing counts as paid."}
          </dd>
        </div>
      </dl>
      {payment.warnings.length > 0 ? (
        <div className="notice notice--warning" role="note">
          <ul>
            {payment.warnings.map((w) => (
              <li key={w}>{w}</li>
            ))}
          </ul>
        </div>
      ) : null}
      <div className="row">
        {payment.nextAction === "START" ? (
          <button
            type="button"
            className="btn"
            disabled={!idle || unavailable}
            onClick={actions.startPayment}
          >
            {busy === "pay:start" ? "Starting…" : "Start PayPal sandbox payment"}
          </button>
        ) : null}
        {payment.approveUrl ? (
          <a className="btn" href={payment.approveUrl} target="_blank" rel="noopener noreferrer">
            Open the PayPal approval page (new tab)
          </a>
        ) : null}
        {payment.nextAction === "AUTHORIZE" ? (
          <button type="button" className="btn" disabled={!idle} onClick={actions.authorizePayment}>
            {busy === "pay:authorize" ? "Authorizing…" : "Place the hold (authorize)"}
          </button>
        ) : null}
        {payment.nextAction === "CAPTURE_OR_VOID" && confirming === null ? (
          <>
            <button
              type="button"
              className="btn btn--primary"
              disabled={!idle}
              onClick={() => actions.confirm("pay-capture")}
            >
              Capture {payment.amountText} (charge the buyer)
            </button>
            <button
              type="button"
              className="btn btn--danger"
              disabled={!idle}
              onClick={() => actions.confirm("pay-void")}
            >
              Release the hold (void)
            </button>
          </>
        ) : null}
        {payment.nextAction === "CAPTURE_OR_VOID" &&
        (confirming === "pay-capture" || confirming === "pay-void") ? (
          <div className="confirm" role="group" aria-label="Confirm payment step">
            <p>
              <strong>
                {confirming === "pay-capture"
                  ? `Capture ${payment.amountText}? This charges the buyer's PayPal sandbox account (test money) and cannot be undone here.`
                  : "Release the hold? Nothing will be charged, and the hold cannot be captured afterwards."}
              </strong>
            </p>
            <div className="row">
              <button
                type="button"
                className={`btn ${confirming === "pay-capture" ? "btn--primary" : "btn--danger"}`}
                disabled={!idle}
                onClick={
                  confirming === "pay-capture" ? actions.capturePayment : actions.voidPayment
                }
              >
                {busy === "pay:capture" || busy === "pay:void"
                  ? "Sending…"
                  : confirming === "pay-capture"
                    ? "Yes, capture"
                    : "Yes, release the hold"}
              </button>
              <button
                type="button"
                className="btn btn--quiet"
                disabled={!idle}
                onClick={() => actions.confirm(null)}
              >
                Not yet
              </button>
            </div>
          </div>
        ) : null}
        {payment.nextAction !== "START" && payment.nextAction !== "NONE" ? (
          <button
            type="button"
            className="btn btn--quiet"
            disabled={!idle}
            onClick={actions.checkPayment}
          >
            {busy === "pay:check" ? "Checking…" : "Check status with PayPal"}
          </button>
        ) : null}
      </div>
      {payment.history.length > 0 ? (
        <details className="details">
          <summary>Transaction history ({payment.history.length})</summary>
          <ol className="plain small">
            {payment.history.map((e) => (
              <li key={e.seq}>
                {when(e.at)} · {e.actor.toLowerCase().replaceAll("_", " ")} · {e.title}
                {e.detail ? ` (${e.detail})` : ""}
              </li>
            ))}
          </ol>
        </details>
      ) : null}
      {payment.attempts.length > 0 ? (
        <details className="details">
          <summary>Requests sent to PayPal ({payment.attempts.length})</summary>
          <ul className="plain small">
            {payment.attempts.map((a) => (
              <li key={`${a.action}:${a.seq}`}>
                {a.action.replaceAll("_", " ").toLowerCase()} #{a.seq}:{" "}
                {a.status.toLowerCase().replaceAll("_", " ")}
                {a.httpStatus ? ` (HTTP ${a.httpStatus})` : ""}
                {a.debugId ? ` · PayPal reference ${a.debugId}` : ""}
              </li>
            ))}
          </ul>
        </details>
      ) : null}
    </Panel>
  );
}

function DetailView({
  d,
  busy,
  confirming,
  actions,
  modelAvailable,
  payment,
}: {
  payment: PaymentView | null;
  modelAvailable: boolean;
  d: NegotiationDetail;
  busy: string | null;
  confirming: Confirming;
  actions: Actions;
}) {
  const live = d.status === "OPEN" || d.status === "AGREED";
  const history = d.agreements.filter((a) => a.status !== "ACTIVE");
  return (
    <div className="stack">
      <Panel
        id="neg-h"
        title={d.request.summary}
        aside={<Chip tone={NEGOTIATION_TONE[d.status]}>{NEGOTIATION_LABEL[d.status]}</Chip>}
      >
        <p>{d.statusText}</p>
        <dl className="terms">
          <div>
            <dt>Wants</dt>
            <dd>
              {d.request.quantity} × {d.request.categoryLabel}
            </dd>
          </div>
          <div>
            <dt>Target maximum</dt>
            <dd>{d.request.maxTotalText ?? "none stated"}</dd>
          </div>
          <div>
            <dt>Needed within</dt>
            <dd>
              {d.request.neededWithinDays === null
                ? "no deadline"
                : `${d.request.neededWithinDays} days`}
            </dd>
          </div>
          <div>
            <dt>Required deliverables</dt>
            <dd>
              {d.request.requiredDeliverables.length === 0
                ? "none stated"
                : d.request.requiredDeliverables.join("; ")}
            </dd>
          </div>
          <div>
            <dt>Negotiation deadline</dt>
            <dd>{when(d.expiresAt)}</dd>
          </div>
        </dl>
        {live ? (
          <div className="row">
            <button
              type="button"
              className="btn"
              disabled={busy !== null || d.status !== "OPEN"}
              onClick={() => actions.runDemo("mock")}
              title={
                d.status !== "OPEN"
                  ? "The demo agents only work while the negotiation is open."
                  : "Runs the deterministic mock agents; they only propose."
              }
            >
              {busy === "demo" ? "Running…" : "Run the demo agents"}
            </button>
            {modelAvailable ? (
              <button
                type="button"
                className="btn"
                disabled={busy !== null || d.status !== "OPEN"}
                onClick={() => actions.runDemo("model")}
                title="Sends this negotiation's text to the configured AI model provider. The model only proposes; the server still checks everything."
              >
                {busy === "model" ? "Asking the model…" : "Run with the AI model"}
              </button>
            ) : null}
            {confirming === "close-rejected" || confirming === "close-cancelled" ? (
              <>
                <button
                  type="button"
                  className="btn btn--danger"
                  disabled={busy !== null}
                  onClick={() =>
                    actions.close(confirming === "close-rejected" ? "REJECTED" : "CANCELLED")
                  }
                >
                  Yes, {confirming === "close-rejected" ? "reject everything" : "cancel it"}
                </button>
                <button
                  type="button"
                  className="btn btn--quiet"
                  onClick={() => actions.confirm(null)}
                >
                  Not yet
                </button>
              </>
            ) : (
              <>
                <button
                  type="button"
                  className="btn btn--quiet"
                  disabled={busy !== null}
                  onClick={() => actions.confirm("close-rejected")}
                >
                  Reject all offers
                </button>
                <button
                  type="button"
                  className="btn btn--quiet"
                  disabled={busy !== null}
                  onClick={() => actions.confirm("close-cancelled")}
                >
                  Cancel negotiation
                </button>
              </>
            )}
          </div>
        ) : null}
        <p className="muted small">
          The demo agents only record offers and counter-offers. Accepting, approving and paying
          stay with you and the policy engine.
        </p>
      </Panel>

      {d.active ? (
        <Panel id="agr-h" title="Current agreement">
          <AgreementCard
            a={d.active}
            current
            busy={busy}
            confirming={confirming}
            actions={actions}
          />
          {d.pendingRevisions.length > 0 ? (
            <div className="notice notice--info" role="note">
              <p>
                <strong>A seller has proposed a change.</strong> Nothing has changed yet: payment
                still follows the agreed version above. Accepting the new version would retire this
                agreement and its approval.
              </p>
              <ul>
                {d.pendingRevisions.map((r) => (
                  <li key={r.proposalId}>
                    {r.sellerName} v{r.version}: {r.changes.join(" ")}
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
        </Panel>
      ) : null}

      {d.active && payment ? (
        <PaymentPanel payment={payment} busy={busy} confirming={confirming} actions={actions} />
      ) : null}

      <Panel id="threads-h" title="Offers and counter-offers">
        {d.sellers.map((t) => (
          <SellerThreadView key={t.sellerId} t={t} live={live} busy={busy} actions={actions} />
        ))}
      </Panel>

      {history.length > 0 ? (
        <Panel id="hist-h" title="Earlier agreement versions">
          {history.map((a) => (
            <AgreementCard
              key={a.id}
              a={a}
              current={false}
              busy={busy}
              confirming={confirming}
              actions={actions}
            />
          ))}
        </Panel>
      ) : null}

      <ChecksLog checks={d.checks} />

      <Panel id="verify-h" title="Verify and audit (step 8)">
        <p>
          Every decision and every PayPal observation is written to a hash-chained audit trail. The
          Cockpit shows the stored records, whether PayPal's own order read agrees, and whether the
          chain still verifies.
        </p>
        <div className="row">
          {d.active ? (
            <a
              className="btn"
              href={`/cockpit/${encodeURIComponent(`tx:${d.active.transactionId}`)}?n=${encodeURIComponent(d.id)}`}
            >
              Inspect this transaction in the Cockpit
            </a>
          ) : (
            <a className="btn" href={`/cockpit?n=${encodeURIComponent(d.id)}`}>
              Open the Cockpit
            </a>
          )}
          <a className="btn btn--quiet" href={`/flagship?n=${encodeURIComponent(d.id)}`}>
            Step 9: replay the budget-escalation attack (simulation)
          </a>
        </div>
      </Panel>
    </div>
  );
}

/* ------------------------------------------------------------------ the whole console */

export function ConsoleView(props: ViewProps) {
  const { phase, actions } = props;
  if (phase.kind === "loading") return <LoadingView />;
  if (phase.kind === "error") return <ErrorView message={phase.message} onRetry={actions.retry} />;
  if (phase.kind === "not_configured") return <NotConfiguredView />;
  if (phase.kind === "signed_out")
    return <LoginView error={props.loginError} busy={props.loginBusy} onLogin={actions.login} />;

  return (
    <div className="stack">
      <div className="row row--between">
        <NoticeBar notice={props.notice} />
        <div className="row">
          <button type="button" className="btn btn--quiet" onClick={actions.refresh}>
            Refresh
          </button>
          <button type="button" className="btn btn--quiet" onClick={actions.signOut}>
            Sign out
          </button>
        </div>
      </div>
      <div className="split">
        <div className="stack">
          {props.form ? (
            <OpenFormView
              overview={phase.overview}
              form={props.form}
              errors={props.formErrors}
              busy={props.busy === "open"}
              actions={actions}
            />
          ) : null}
          <NegotiationList
            overview={phase.overview}
            selectedId={props.selectedId}
            actions={actions}
          />
        </div>
        <div>
          {props.detailLoading ? (
            <Panel id="dl-h" title="Negotiation">
              <Skeleton lines={8} />
            </Panel>
          ) : props.detail ? (
            <DetailView
              d={props.detail}
              busy={props.busy}
              confirming={props.confirming}
              actions={actions}
              payment={props.payment ?? null}
              modelAvailable={
                props.phase.kind === "ready" && props.phase.overview.agents?.modelAvailable === true
              }
            />
          ) : (
            <Panel id="pick-h" title="Pick a negotiation">
              <StateNote kind="empty" title="No negotiation selected">
                Choose one from the list, or open a new one. You will see every offer and
                counter-offer as a numbered version, and the policy engine&rsquo;s answer in plain
                words.
              </StateNote>
            </Panel>
          )}
        </div>
      </div>
    </div>
  );
}
