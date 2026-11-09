import type { ReactNode } from "react";

import type { DraftView, MandateSummary, Overview } from "@/application/mandates";
import {
  SERVICE_CATEGORIES,
  SUPPORTED_CURRENCIES,
  describeRules,
  formatMinor,
  parseDecimalAmount,
  validateMandateInput,
  type FieldError,
  type SupportedCurrency,
} from "@/domain/mandate";
import { StateNote } from "../_ui/state-note";
import { Chip, Skeleton } from "../_arena/panels";
import { fieldsFromForm, type FormState } from "./form";

/* ------------------------------------------------------------------ state shapes (owned by the container) */

export type Phase =
  | { kind: "loading" }
  | { kind: "error"; message: string }
  | { kind: "not_configured" }
  | { kind: "signed_out" }
  | { kind: "ready"; overview: Overview };

export type Editing =
  | { mode: "new" }
  | { mode: "newVersion"; mandateId: string; baseVersion: number }
  | {
      mode: "draft";
      draftId: string;
      revision: number;
      mandateId: string;
      baseVersion: number | null;
    };

export type Notice = { tone: "success" | "danger" | "info"; text: string };

export type EditorState = {
  editing: Editing;
  form: FormState;
  errors: FieldError[];
  /** The last draft the server accepted for this editing session. */
  saved: DraftView | null;
  dirty: boolean;
  busy: null | "save" | "approve" | "discard";
  confirming: boolean;
};

export type Actions = {
  retry: () => void;
  login: (passcode: string) => void;
  signOut: () => void;
  startNew: () => void;
  startNewVersion: (m: MandateSummary) => void;
  continueDraft: (d: DraftView) => void;
  change: (patch: Partial<FormState>) => void;
  save: () => void;
  askApprove: () => void;
  cancelApprove: () => void;
  approve: () => void;
  discard: () => void;
  closeEditor: () => void;
  askRevoke: (mandateId: string) => void;
  cancelRevoke: () => void;
  revoke: (m: MandateSummary) => void;
};

export type ViewProps = {
  phase: Phase;
  loginError: string | null;
  loginBusy: boolean;
  editor: EditorState | null;
  notice: Notice | null;
  revoking: string | null;
  revokeBusy: boolean;
  actions: Actions;
};

/* ------------------------------------------------------------------ small pieces */

const money = (minor: string, currency: string) => `${minor} ${currency}`;
const categoryLabel = (code: string) =>
  code in SERVICE_CATEGORIES ? SERVICE_CATEGORIES[code as keyof typeof SERVICE_CATEGORIES] : code;
const when = (iso: string) => iso.slice(0, 10);

export function NoticeBar({ notice }: { notice: Notice | null }) {
  return (
    <div className="notice-slot" aria-live="polite">
      {notice ? <p className={`notice notice--${notice.tone}`}>{notice.text}</p> : null}
    </div>
  );
}

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

/* ------------------------------------------------------------------ gate states */

export function LoadingView() {
  return (
    <Panel id="loading-h" title="Mandates">
      <Skeleton lines={6} />
    </Panel>
  );
}

export function ErrorView({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <Panel id="error-h" title="Could not load mandates">
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
        Mandates can only be configured by the human operator. This server has no operator passcode
        yet, so nobody can sign in.
      </p>
      <ol className="steps">
        <li>
          Add a passcode of at least 16 characters to <code className="code">.env.local</code>:
          <pre className="pre">OPERATOR_PASSCODE=&lt;a long random passcode&gt;</pre>
        </li>
        <li>
          Create the database if you have not:{" "}
          <code className="code">npm run db:migrate &amp;&amp; npm run db:seed</code>
        </li>
        <li>Restart the server and reload this page.</li>
      </ol>
      <p className="muted small">
        The passcode never leaves the server and is never shown to, or usable by, an AI agent.
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
        Only the human operator can create, approve or revoke a mandate. AI agents have no access.
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

/* ------------------------------------------------------------------ mandates list */

function MandateCard({
  m,
  revoking,
  revokeBusy,
  actions,
}: {
  m: MandateSummary;
  revoking: boolean;
  revokeBusy: boolean;
  actions: Actions;
}) {
  const f = m.latest.fields;
  const revoked = m.latest.status === "REVOKED";
  const headingId = `mandate-${m.id}`;
  return (
    <article className="mcard" aria-labelledby={headingId}>
      <header className="mcard__head">
        <h3 id={headingId}>
          <code className="code">{m.id}</code>
        </h3>
        <div className="chips">
          {revoked ? (
            <Chip tone="danger" icon="■">
              Revoked
            </Chip>
          ) : (
            <Chip tone="success" icon="✓">
              Active
            </Chip>
          )}
          <Chip tone="neutral">Version {m.latest.version}</Chip>
          {m.openDraft ? <Chip tone="warning">Draft open</Chip> : null}
        </div>
      </header>
      <dl className="kv">
        <div>
          <dt>Total budget</dt>
          <dd className="num strong">{money(f.totalBudget, f.currency)}</dd>
        </div>
        <div>
          <dt>Max per transaction</dt>
          <dd className="num strong">{money(f.maxTransactionAmount, f.currency)}</dd>
        </div>
        <div>
          <dt>Human approval</dt>
          <dd>
            {f.requireReviewBeforeExecution
              ? "Every transaction"
              : `Above ${money(f.approvalThreshold, f.currency)}`}
          </dd>
        </div>
        <div>
          <dt>Expires</dt>
          <dd>{when(m.latest.expiresAt)}</dd>
        </div>
        <div className="kv__wide">
          <dt>Allowed categories</dt>
          <dd>{f.allowedCategories.map(categoryLabel).join(", ") || "none"}</dd>
        </div>
        <div className="kv__wide">
          <dt>Allowed sellers</dt>
          <dd>{f.allowedSellerIds.join(", ")}</dd>
        </div>
      </dl>

      <details className="details">
        <summary>Exact rules (version {m.latest.version})</summary>
        <ul className="rules">
          {m.latest.rules.map((r) => (
            <li key={r}>{r}</li>
          ))}
        </ul>
      </details>
      <details className="details">
        <summary>Version history ({m.versions.length})</summary>
        <ol className="versions">
          {m.versions.map((v) => (
            <li key={v.version}>
              <span className="strong">v{v.version}</span> ·{" "}
              {v.status === "REVOKED" ? "revoked" : "active"} · {when(v.createdAt)} ·{" "}
              <code className="code" title={v.contentHash}>
                {v.contentHash.slice(0, 10)}
              </code>
              {v.sourceDraftId ? <span className="muted small"> · from a draft</span> : null}
            </li>
          ))}
        </ol>
        <p className="muted small">
          Approved versions are immutable. Each is kept forever and transactions remember the
          version they started under.
        </p>
      </details>

      {revoking ? (
        <div className="confirm" role="group" aria-label={`Confirm revoking ${m.id}`}>
          <p className="strong">Revoke {m.id}?</p>
          <p className="small">
            Revocation is final. No new transaction can start under this mandate, and negotiations
            that have not reached an agreement stop. To continue, create a new mandate.
          </p>
          <div className="actions__row">
            <button
              type="button"
              className="btn btn--danger"
              disabled={revokeBusy}
              onClick={() => actions.revoke(m)}
            >
              {revokeBusy ? "Revoking…" : "Yes, revoke permanently"}
            </button>
            <button
              type="button"
              className="btn"
              disabled={revokeBusy}
              onClick={actions.cancelRevoke}
            >
              Cancel
            </button>
          </div>
        </div>
      ) : (
        <div className="actions__row">
          {revoked ? (
            <p className="muted small">This mandate is revoked and can no longer change.</p>
          ) : m.openDraft ? (
            <button
              type="button"
              className="btn"
              onClick={() => actions.continueDraft(m.openDraft as DraftView)}
            >
              Continue draft
            </button>
          ) : (
            <button type="button" className="btn" onClick={() => actions.startNewVersion(m)}>
              Edit as new version
            </button>
          )}
          {!revoked ? (
            <button
              type="button"
              className="btn btn--quiet"
              onClick={() => actions.askRevoke(m.id)}
            >
              Revoke…
            </button>
          ) : null}
        </div>
      )}
    </article>
  );
}

function MandatesPanel({
  overview,
  revoking,
  revokeBusy,
  actions,
}: {
  overview: Overview;
  revoking: string | null;
  revokeBusy: boolean;
  actions: Actions;
}) {
  const empty = overview.mandates.length === 0 && overview.drafts.length === 0;
  return (
    <Panel
      id="mandates-h"
      title="Approved mandates"
      aside={
        <button type="button" className="btn btn--primary" onClick={actions.startNew}>
          New mandate
        </button>
      }
    >
      {overview.sellers.length === 0 ? (
        <p className="notice notice--info">
          No sellers exist yet, so a mandate has nobody to allow. Run{" "}
          <code className="code">npm run db:seed</code> for synthetic demo sellers.
        </p>
      ) : null}
      {empty ? (
        <div className="state state--empty">
          <p className="state__title">No mandates yet</p>
          <p className="muted">
            A mandate sets the budget, limits and rules every purchase must follow. Create the first
            one.
          </p>
        </div>
      ) : null}
      {overview.mandates.map((m) => (
        <MandateCard
          key={m.id}
          m={m}
          revoking={revoking === m.id}
          revokeBusy={revokeBusy}
          actions={actions}
        />
      ))}
      {overview.drafts.length > 0 ? (
        <>
          <h3 className="subhead">Drafts of new mandates (not active)</h3>
          <ul className="draftlist">
            {overview.drafts.map((d) => (
              <li key={d.id}>
                <span>
                  <code className="code">{d.mandateId}</code> · revision {d.revision} ·{" "}
                  {money(d.fields.totalBudget, d.fields.currency)}
                </span>
                <button type="button" className="btn" onClick={() => actions.continueDraft(d)}>
                  Continue
                </button>
              </li>
            ))}
          </ul>
        </>
      ) : null}
    </Panel>
  );
}

/* ------------------------------------------------------------------ editor */

const AMOUNT_FIELDS = [
  {
    key: "totalBudget",
    label: "Total spending budget",
    help: "The most that can be spent across all transactions under this mandate.",
  },
  {
    key: "maxTransactionAmount",
    label: "Maximum transaction amount",
    help: "No single transaction may exceed this. It cannot be more than the budget.",
  },
  {
    key: "approvalThreshold",
    label: "Human approval threshold",
    help: "A transaction above this amount waits for your approval. Equal to it does not. 0 means everything needs approval; it cannot exceed the maximum.",
  },
] as const;

function amountHint(value: string, currency: string): string | null {
  const v = value.trim();
  if (v === "" || !(currency in SUPPORTED_CURRENCIES)) return null;
  const r = parseDecimalAmount(v, currency as SupportedCurrency);
  return r.ok
    ? `Reads as ${formatMinor(r.minor, currency as SupportedCurrency)} ${currency} (${r.minor.toLocaleString("en-US")} minor units)`
    : `Not valid yet: ${r.reason}`;
}

function CheckGroup({
  legend,
  name,
  options,
  selected,
  error,
  onToggle,
  empty,
}: {
  legend: string;
  name: string;
  options: { value: string; label: string }[];
  selected: string[];
  error: string | undefined;
  onToggle: (value: string, on: boolean) => void;
  empty?: string;
}) {
  const errId = `err-${name}`;
  return (
    <fieldset
      className="field checkgroup"
      id={`field-${name}`}
      aria-describedby={error ? errId : undefined}
    >
      <legend>{legend}</legend>
      {options.length === 0 ? <p className="muted small">{empty}</p> : null}
      <div className="checks">
        {options.map((o) => (
          <label key={o.value} className="check">
            <input
              type="checkbox"
              name={name}
              value={o.value}
              checked={selected.includes(o.value)}
              onChange={(e) => onToggle(o.value, e.target.checked)}
            />
            <span>{o.label}</span>
          </label>
        ))}
      </div>
      {error ? (
        <p id={errId} className="field-error">
          {error}
        </p>
      ) : null}
    </fieldset>
  );
}

function RulePreview({ form }: { form: FormState }) {
  const r = validateMandateInput(fieldsFromForm(form));
  return (
    <div className="preview" aria-live="polite">
      <h3 className="subhead">Preview of the exact rules</h3>
      {r.ok ? (
        <ul className="rules">
          {describeRules(r.terms).map((line) => (
            <li key={line}>{line}</li>
          ))}
        </ul>
      ) : (
        <p className="muted small">
          Complete every field correctly to see the exact rules. (The server re-checks everything
          when you save.)
        </p>
      )}
    </div>
  );
}

function Editor({
  overview,
  editor,
  notice,
  actions,
}: {
  overview: Overview;
  editor: EditorState;
  notice: Notice | null;
  actions: Actions;
}) {
  const { form, errors, saved, busy, confirming, dirty } = editor;
  const byField = new Map<string, string>();
  for (const e of errors) if (!byField.has(e.field)) byField.set(e.field, e.message);
  const title =
    editor.editing.mode === "new"
      ? "New mandate"
      : editor.editing.mode === "newVersion"
        ? `New version of ${editor.editing.mandateId}`
        : editor.editing.baseVersion === null
          ? `Draft of ${editor.editing.mandateId}`
          : `Draft of ${editor.editing.mandateId} (from version ${editor.editing.baseVersion})`;
  const nextVersion =
    editor.editing.mode === "draft" && editor.editing.baseVersion !== null
      ? editor.editing.baseVersion + 1
      : editor.editing.mode === "newVersion"
        ? editor.editing.baseVersion + 1
        : 1;
  const canApprove = saved !== null && !dirty && busy === null;
  const field = (name: string) => ({
    "aria-invalid": byField.has(name) ? true : undefined,
    "aria-describedby": byField.has(name) ? `err-${name}` : `help-${name}`,
  });

  return (
    <Panel
      id="editor-h"
      title={title}
      aside={
        <Chip tone="warning">{saved ? `Draft · revision ${saved.revision}` : "Not saved"}</Chip>
      }
    >
      <p className="muted small">
        This is a draft. It changes nothing until you approve it, and approving creates a new
        immutable version; existing transactions keep the rules they started with.
      </p>
      <NoticeBar notice={notice} />

      {errors.length > 0 ? (
        <div id="editor-errors" className="error-summary" role="alert" tabIndex={-1}>
          <p className="strong">
            {errors.length === 1
              ? "1 field needs attention"
              : `${errors.length} fields need attention`}
          </p>
          <ul>
            {errors.map((e, i) => (
              <li key={`${e.field}-${i}`}>
                <a href={`#field-${e.field}`}>{e.field}</a>: {e.message}
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      <form
        className="stack"
        noValidate
        onSubmit={(e) => {
          e.preventDefault();
          actions.save();
        }}
      >
        <div className="formgrid">
          <div className="field">
            <label htmlFor="field-currency">Currency</label>
            <select
              id="field-currency"
              value={form.currency}
              onChange={(e) => actions.change({ currency: e.target.value })}
              {...field("currency")}
            >
              {overview.currencies.map((c) => (
                <option key={c.code} value={c.code}>
                  {c.code} · {c.label}
                </option>
              ))}
              {overview.currencies.some((c) => c.code === form.currency) ? null : (
                <option value={form.currency}>{form.currency}</option>
              )}
            </select>
            <p id="help-currency" className="hint">
              {form.currency in SUPPORTED_CURRENCIES
                ? SUPPORTED_CURRENCIES[form.currency as SupportedCurrency].exponent === 0
                  ? `${form.currency} has no decimal places.`
                  : `Amounts use up to ${SUPPORTED_CURRENCIES[form.currency as SupportedCurrency].exponent} decimal places.`
                : "Choose a supported currency."}
            </p>
            {byField.has("currency") ? (
              <p id="err-currency" className="field-error">
                {byField.get("currency")}
              </p>
            ) : null}
          </div>

          <div className="field">
            <label htmlFor="field-validDays">Valid for (days)</label>
            <input
              id="field-validDays"
              className="input"
              inputMode="numeric"
              autoComplete="off"
              value={form.validDays}
              onChange={(e) => actions.change({ validDays: e.target.value })}
              {...field("validDays")}
            />
            <p id="help-validDays" className="hint">
              From approval, 1 to 365 days.
            </p>
            {byField.has("validDays") ? (
              <p id="err-validDays" className="field-error">
                {byField.get("validDays")}
              </p>
            ) : null}
          </div>

          {AMOUNT_FIELDS.map(({ key, label, help }) => {
            const hint = amountHint(form[key], form.currency);
            return (
              <div className="field" key={key}>
                <label htmlFor={`field-${key}`}>{label}</label>
                <input
                  id={`field-${key}`}
                  className="input num"
                  inputMode="decimal"
                  autoComplete="off"
                  placeholder={
                    SUPPORTED_CURRENCIES[form.currency as SupportedCurrency]?.exponent === 0
                      ? "e.g. 500"
                      : "e.g. 100.00"
                  }
                  value={form[key]}
                  onChange={(e) => actions.change({ [key]: e.target.value })}
                  {...field(key)}
                />
                <p id={`help-${key}`} className="hint">
                  {help}
                  {hint ? <span className="hint__live"> {hint}</span> : null}
                </p>
                {byField.has(key) ? (
                  <p id={`err-${key}`} className="field-error">
                    {byField.get(key)}
                  </p>
                ) : null}
              </div>
            );
          })}
        </div>

        <CheckGroup
          legend="Allowed service categories"
          name="allowedCategories"
          options={overview.categories.map((c) => ({ value: c.code, label: c.label }))}
          selected={form.allowedCategories}
          error={byField.get("allowedCategories")}
          onToggle={(v, on) =>
            actions.change({
              allowedCategories: on
                ? [...form.allowedCategories, v]
                : form.allowedCategories.filter((x) => x !== v),
            })
          }
        />
        <CheckGroup
          legend="Allowed sellers"
          name="allowedSellerIds"
          options={overview.sellers.map((s) => ({
            value: s.id,
            label: `${s.displayName} (${s.id})`,
          }))}
          selected={form.allowedSellerIds}
          error={byField.get("allowedSellerIds")}
          empty="No sellers exist. Run npm run db:seed for synthetic demo sellers."
          onToggle={(v, on) =>
            actions.change({
              allowedSellerIds: on
                ? [...form.allowedSellerIds, v]
                : form.allowedSellerIds.filter((x) => x !== v),
            })
          }
        />

        <div className="field" id="field-requireReviewBeforeExecution">
          <label className="check check--block">
            <input
              type="checkbox"
              checked={form.requireReviewBeforeExecution}
              onChange={(e) => actions.change({ requireReviewBeforeExecution: e.target.checked })}
              aria-describedby="help-requireReviewBeforeExecution"
            />
            <span>
              <span className="strong">Review every transaction before it is executed</span>
              <span id="help-requireReviewBeforeExecution" className="hint block">
                When on, every transaction waits for your approval, whatever its amount, and the
                threshold above no longer matters.
              </span>
            </span>
          </label>
          {byField.has("requireReviewBeforeExecution") ? (
            <p className="field-error">{byField.get("requireReviewBeforeExecution")}</p>
          ) : null}
        </div>

        <RulePreview form={form} />

        {confirming && saved ? (
          <div className="confirm" role="group" aria-label="Confirm approval">
            <p className="strong">
              Approve and activate version {nextVersion} of {saved.mandateId}?
            </p>
            <ul className="rules">
              {saved.rules.map((r) => (
                <li key={r}>{r}</li>
              ))}
            </ul>
            <p className="small">
              This is permanent: version {nextVersion} can never be edited, only replaced by a newer
              version or revoked. Transactions already started keep their rules; negotiations still
              open on an older version must start again.
            </p>
            <div className="actions__row">
              <button
                type="button"
                className="btn btn--primary"
                disabled={busy !== null}
                onClick={actions.approve}
              >
                {busy === "approve" ? "Approving…" : "Approve and activate"}
              </button>
              <button
                type="button"
                className="btn"
                disabled={busy !== null}
                onClick={actions.cancelApprove}
              >
                Cancel
              </button>
            </div>
          </div>
        ) : (
          <div className="actions">
            <div className="actions__row">
              <button type="submit" className="btn btn--primary" disabled={busy !== null}>
                {busy === "save" ? "Saving…" : saved ? "Save changes" : "Save draft"}
              </button>
              <button
                type="button"
                className="btn"
                disabled={!canApprove}
                aria-describedby="approve-why"
                onClick={actions.askApprove}
              >
                Review and approve…
              </button>
              {saved ? (
                <button
                  type="button"
                  className="btn btn--quiet"
                  disabled={busy !== null}
                  onClick={actions.discard}
                >
                  Discard draft
                </button>
              ) : null}
              <button
                type="button"
                className="btn btn--quiet"
                disabled={busy !== null}
                onClick={actions.closeEditor}
              >
                Close
              </button>
            </div>
            <p id="approve-why" className="muted small">
              {saved === null
                ? "Save the draft first; only a saved draft can be approved."
                : dirty
                  ? "You have unsaved changes. Save them first so the version you approve is exactly what you see."
                  : "Ready: approving shows the exact rules once more before anything changes."}
            </p>
          </div>
        )}
      </form>
    </Panel>
  );
}

function EditorPlaceholder() {
  return (
    <Panel id="editor-empty-h" title="Editor">
      <div className="state state--empty">
        <p className="state__title">Nothing being edited</p>
        <p className="muted">
          Choose “New mandate”, or “Edit as new version” on an existing one. Edits are saved as a
          draft and never change an approved mandate.
        </p>
      </div>
    </Panel>
  );
}

/* ------------------------------------------------------------------ the whole console */

export function ConsoleView({
  phase,
  loginError,
  loginBusy,
  editor,
  notice,
  revoking,
  revokeBusy,
  actions,
}: ViewProps) {
  switch (phase.kind) {
    case "loading":
      return <LoadingView />;
    case "error":
      return <ErrorView message={phase.message} onRetry={actions.retry} />;
    case "not_configured":
      return <NotConfiguredView />;
    case "signed_out":
      return <LoginView error={loginError} busy={loginBusy} onLogin={actions.login} />;
    case "ready":
      return (
        <>
          <div className="toolbar">
            <p className="muted small">Signed in as the operator.</p>
            <button type="button" className="btn btn--quiet" onClick={actions.signOut}>
              Sign out
            </button>
          </div>
          {editor === null ? <NoticeBar notice={notice} /> : null}
          {phase.overview.mandates.some((m) => m.latest.status === "ACTIVE") ? (
            <div className="card next-card">
              <p>
                <strong>A mandate is in force.</strong> Review it below, or go on to step 3 and
                submit a task. Existing transactions keep the mandate version they started under.
              </p>
              <p>
                <a className="btn btn--primary" href="/negotiations?scenario=compute-within-budget">
                  Next: submit a task
                </a>
              </p>
            </div>
          ) : (
            <div className="card next-card">
              <p>
                <strong>No approved mandate yet.</strong> Choose “New mandate”, fill in the limits,
                save, and approve it. Nothing can be bought until one is approved.
              </p>
            </div>
          )}
          <div className="mandate-layout">
            <MandatesPanel
              overview={phase.overview}
              revoking={revoking}
              revokeBusy={revokeBusy}
              actions={actions}
            />
            {editor ? (
              <Editor overview={phase.overview} editor={editor} notice={notice} actions={actions} />
            ) : (
              <EditorPlaceholder />
            )}
          </div>
        </>
      );
  }
}
