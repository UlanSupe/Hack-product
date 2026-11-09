import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { createSqliteMandateStore } from "@/adapters/sqlite/mandate-store";
import { createMandateService, type DraftView, type Overview } from "@/application/mandates";
import { emptyForm, formFromFields, type FormState } from "@/app/mandate/form";
import { ConsoleView, type Actions, type EditorState, type ViewProps } from "@/app/mandate/views";
import type { FieldError } from "@/domain/mandate";

import { worldDb } from "../persistence/helpers";

const noop = () => undefined;
const actions: Actions = {
  retry: noop,
  login: noop,
  signOut: noop,
  startNew: noop,
  startNewVersion: noop,
  continueDraft: noop,
  change: noop,
  save: noop,
  askApprove: noop,
  cancelApprove: noop,
  approve: noop,
  discard: noop,
  closeEditor: noop,
  askRevoke: noop,
  cancelRevoke: noop,
  revoke: noop,
};

const OPERATOR = { kind: "OPERATOR", id: "demo_operator" } as const;

/** Real service output (not hand-built), so the UI is tested against exactly what the API sends. */
function realOverview(): { overview: Overview; draft: DraftView } {
  const db = worldDb();
  let n = 0;
  const service = createMandateService({
    store: createSqliteMandateStore(db),
    now: () => new Date("2026-02-01T00:00:00.000Z"),
    newId: (p) => `${p}_${++n}`,
  });
  const created = service.createDraft(OPERATOR, {
    basedOn: { mandateId: "M1", version: 1 },
    fields: {
      currency: "USD",
      totalBudget: "300.00",
      maxTransactionAmount: "120.00",
      approvalThreshold: "100.00",
      allowedCategories: ["COMPUTE"],
      allowedSellerIds: ["seller_acme"],
      requireReviewBeforeExecution: false,
      validDays: 30,
    },
  });
  if (!created.ok) throw new Error("setup");
  return { overview: service.overview(OPERATOR), draft: created.value };
}

const base = (over: Partial<ViewProps> = {}): ViewProps => ({
  phase: { kind: "loading" },
  loginError: null,
  loginBusy: false,
  editor: null,
  notice: null,
  revoking: null,
  revokeBusy: false,
  actions,
  ...over,
});
const html = (over: Partial<ViewProps> = {}) =>
  renderToStaticMarkup(<ConsoleView {...base(over)} />);

const editorState = (
  over: Partial<EditorState> = {},
  form: Partial<FormState> = {},
): EditorState => ({
  editing: { mode: "new" },
  form: { ...emptyForm(), ...form },
  errors: [],
  saved: null,
  dirty: false,
  busy: null,
  confirming: false,
  ...over,
});

describe("gate states", () => {
  it("loading: an accessible skeleton, no data", () => {
    const out = html({ phase: { kind: "loading" } });
    expect(out).toContain('aria-busy="true"');
    expect(out).toContain("Loading");
    expect(out).not.toContain("Approved mandates");
  });

  it("error: an alert with the reason and a working Retry", () => {
    const out = html({
      phase: { kind: "error", message: "The database is not ready. Run `npm run db:migrate`." },
    });
    expect(out).toContain('role="alert"');
    expect(out).toContain("db:migrate");
    expect(out).toContain(">Retry</button>");
  });

  it("not configured: tells the operator exactly how to enable access, offers no sign-in form", () => {
    const out = html({ phase: { kind: "not_configured" } });
    expect(out).toContain("OPERATOR_PASSCODE");
    expect(out).toContain("at least 16 characters");
    expect(out).not.toContain('type="password"');
    expect(out).toMatch(/never leaves the server/);
  });

  it("signed out: a labelled password field, and server errors are announced", () => {
    const out = html({ phase: { kind: "signed_out" }, loginError: "Incorrect passcode." });
    expect(out).toMatch(/<label for="passcode">Operator passcode<\/label>/);
    expect(out).toContain('type="password"');
    expect(out).toMatch(/autocomplete="current-password"/i);
    expect(out).toMatch(/id="login-error"[^>]*role="alert"[^>]*>Incorrect passcode\./);
    expect(out).toContain('aria-invalid="true"');
    expect(html({ phase: { kind: "signed_out" }, loginBusy: true })).toMatch(
      /disabled=""[^>]*>Signing in…/,
    );
  });
});

describe("ready: mandates list", () => {
  it("empty: explains what a mandate is, and warns when there are no sellers to allow", () => {
    const out = html({
      phase: {
        kind: "ready",
        overview: { mandates: [], drafts: [], sellers: [], currencies: [], categories: [] },
      },
    });
    expect(out).toContain("No mandates yet");
    expect(out).toContain("npm run db:seed");
    expect(out).toContain(">New mandate</button>");
    expect(out).toContain("Nothing being edited");
  });

  it("shows each mandate's status, version, limits, approval rule and exact rules", () => {
    const { overview } = realOverview();
    const out = html({ phase: { kind: "ready", overview } });
    expect(out).toContain("Active");
    expect(out).toContain("Version 1");
    expect(out).toContain("150.00 USD"); // total budget
    expect(out).toContain("100.00 USD"); // maximum per transaction
    expect(out).toContain("Above 100.00 USD"); // approval rule
    expect(out).toContain("Compute &amp; GPU");
    expect(out).toContain("Exact rules (version 1)");
    expect(out).toContain("Version history (1)");
    expect(out).toContain("immutable");
    expect(out).toContain("Signed in as the operator");
  });

  it("shows 'Continue draft' (not a second editor path) when a draft is open, and marks it", () => {
    const { overview } = realOverview();
    const out = html({ phase: { kind: "ready", overview } });
    expect(out).toContain("Draft open");
    expect(out).toContain(">Continue draft</button>");
    expect(out).not.toContain(">Edit as new version</button>");
  });

  it("revoke asks for confirmation and says it is final", () => {
    const { overview } = realOverview();
    const out = html({ phase: { kind: "ready", overview }, revoking: "M1" });
    expect(out).toContain("Revoke M1?");
    expect(out).toContain("Revocation is final");
    expect(out).toContain("Yes, revoke permanently");
    expect(
      html({ phase: { kind: "ready", overview }, revoking: "M1", revokeBusy: true }),
    ).toContain("Revoking…");
  });

  it("a revoked mandate offers no edit or revoke", () => {
    const { overview } = realOverview();
    const m = overview.mandates[0]!;
    const revoked = {
      ...overview,
      mandates: [
        { ...m, latest: { ...m.latest, status: "REVOKED" as const, version: 2 }, openDraft: null },
      ],
    };
    const out = html({ phase: { kind: "ready", overview: revoked } });
    expect(out).toContain("Revoked");
    expect(out).toContain("revoked and can no longer change");
    expect(out).not.toContain(">Edit as new version</button>");
    expect(out).not.toContain("Revoke…");
  });

  it("renders hostile seller and mandate text as inert text", () => {
    const { overview } = realOverview();
    const m = overview.mandates[0]!;
    const hostile = {
      ...overview,
      sellers: [
        { id: "x", displayName: '<img src=x onerror="alert(1)"><script>alert(2)</script>' },
      ],
      mandates: [
        {
          ...m,
          latest: {
            ...m.latest,
            fields: { ...m.latest.fields, allowedSellerIds: ["<b>bold</b>"] },
          },
          openDraft: null,
        },
      ],
    };
    const out = html({ phase: { kind: "ready", overview: hostile }, editor: editorState() });
    expect(out).not.toContain("<script>");
    expect(out).not.toContain("<img");
    expect(out).not.toContain("<b>bold</b>");
    expect(out).toContain("&lt;script&gt;");
  });
});

describe("the editor", () => {
  const ready = () => ({ kind: "ready" as const, overview: realOverview().overview });

  it("a new mandate starts empty with every control labelled and a hint under each money field", () => {
    const out = html({ phase: ready(), editor: editorState() });
    for (const label of [
      "Currency",
      "Valid for (days)",
      "Total spending budget",
      "Maximum transaction amount",
      "Human approval threshold",
      "Allowed service categories",
      "Allowed sellers",
      "Review every transaction before it is executed",
    ]) {
      expect(out, label).toContain(label);
    }
    expect(out).toMatch(/<label for="field-totalBudget">/);
    expect(out).toMatch(/inputmode="decimal"/i);
    expect(out).toContain("Equal to it does not");
    expect(out).toContain("Not saved");
    expect(out).toContain("Complete every field correctly to see the exact rules");
  });

  it("explains the draft/approve model up front", () => {
    const out = html({ phase: ready(), editor: editorState() });
    expect(out).toMatch(/changes nothing until you approve/);
    expect(out).toMatch(/existing transactions keep the rules they started with/);
  });

  it("shows live, decimal-safe hints as the operator types (and says why an amount is not valid yet)", () => {
    const out = html({
      phase: ready(),
      editor: editorState(
        {},
        { totalBudget: "100", maxTransactionAmount: "-5", approvalThreshold: "1.234" },
      ),
    });
    expect(out).toContain("Reads as 100.00 USD (10,000 minor units)");
    expect(out).toContain("Not valid yet: must not be negative");
    expect(out).toContain("Not valid yet: USD allows at most 2 decimal places");
    const jpy = html({
      phase: ready(),
      editor: editorState({}, { currency: "JPY", totalBudget: "500.5" }),
    });
    expect(jpy).toContain("JPY has no decimal places");
  });

  it("previews the exact rules once every field is valid", () => {
    const out = html({
      phase: ready(),
      editor: editorState(
        {},
        {
          totalBudget: "300.00",
          maxTransactionAmount: "120.00",
          approvalThreshold: "100.00",
          allowedCategories: ["COMPUTE"],
          allowedSellerIds: ["seller_acme"],
        },
      ),
    });
    expect(out).toContain("Total spending budget: 300.00 USD.");
    expect(out).toMatch(/Transactions above 100\.00 USD need human approval/);
    expect(out).not.toContain("Complete every field correctly");
  });

  it("shows server field errors: a summary with links, per-field messages, aria-invalid and aria-describedby", () => {
    const errors: FieldError[] = [
      { field: "totalBudget", message: "must not be negative" },
      {
        field: "currency",
        message: '"BTC" is not supported; use one of USD, EUR, GBP, JPY (uppercase)',
      },
      { field: "allowedCategories", message: 'unsupported categories: "CRYPTO"' },
      { field: "approvalThreshold", message: "is required" },
    ];
    const out = html({
      phase: ready(),
      editor: editorState({ errors }, { totalBudget: "-5", currency: "BTC" }),
    });
    expect(out).toMatch(/id="editor-errors"[^>]*role="alert"[^>]*tabindex="-1"/);
    expect(out).toContain("4 fields need attention");
    expect(out).toContain('href="#field-totalBudget"');
    expect(out).toContain('id="err-totalBudget"');
    expect(out).toContain("must not be negative");
    expect(out).toContain("unsupported categories: &quot;CRYPTO&quot;");
    expect(out).toMatch(
      /id="field-totalBudget"[^>]*aria-invalid="true"[^>]*aria-describedby="err-totalBudget"/,
    );
    expect(out).toMatch(
      /id="field-allowedCategories"[^>]*aria-describedby="err-allowedCategories"/,
    );
    expect(out).toContain(
      "1 field needs attention".replace("1 field needs attention", "4 fields need attention"),
    );
  });

  it("singular summary wording", () => {
    const out = html({
      phase: ready(),
      editor: editorState({
        errors: [{ field: "validDays", message: "must be a whole number of days from 1 to 365" }],
      }),
    });
    expect(out).toContain("1 field needs attention");
  });

  it("approval is disabled with a visible reason until a draft is saved and clean", () => {
    const { overview, draft } = realOverview();
    const phase = { kind: "ready" as const, overview };
    const unsaved = html({ phase, editor: editorState() });
    expect(unsaved).toMatch(
      /<button[^>]*disabled=""[^>]*aria-describedby="approve-why"[^>]*>Review and approve…/,
    );
    expect(unsaved).toContain("Save the draft first");

    const form = formFromFields(draft.fields);
    const dirty = html({
      phase,
      editor: editorState(
        {
          saved: draft,
          dirty: true,
          editing: {
            mode: "draft",
            draftId: draft.id,
            revision: draft.revision,
            mandateId: "M1",
            baseVersion: 1,
          },
        },
        form,
      ),
    });
    expect(dirty).toMatch(
      /<button[^>]*disabled=""[^>]*aria-describedby="approve-why"[^>]*>Review and approve…/,
    );
    expect(dirty).toContain("You have unsaved changes");
    expect(dirty).toContain("Save changes");

    const clean = html({
      phase,
      editor: editorState(
        {
          saved: draft,
          editing: {
            mode: "draft",
            draftId: draft.id,
            revision: draft.revision,
            mandateId: "M1",
            baseVersion: 1,
          },
        },
        form,
      ),
    });
    expect(clean).not.toMatch(/<button[^>]*disabled=""[^>]*aria-describedby="approve-why"/);
    expect(clean).toContain("Draft · revision 1");
    expect(clean).toContain("Discard draft");
  });

  it("the approval confirmation restates the exact rules and the permanence, and names the next version", () => {
    const { overview, draft } = realOverview();
    const out = html({
      phase: { kind: "ready", overview },
      editor: editorState(
        {
          saved: draft,
          confirming: true,
          editing: {
            mode: "draft",
            draftId: draft.id,
            revision: draft.revision,
            mandateId: "M1",
            baseVersion: 1,
          },
        },
        formFromFields(draft.fields),
      ),
    });
    expect(out).toContain("Approve and activate version 2 of M1?");
    expect(out).toContain("Total spending budget: 300.00 USD.");
    expect(out).toMatch(/permanent: version 2 can never be edited/);
    expect(out).toMatch(/Transactions already started keep their rules/);
    expect(out).toContain("Approve and activate</button>");
    expect(out).not.toContain("Review and approve…");
  });

  it("busy states disable the controls and say what is happening", () => {
    const { overview, draft } = realOverview();
    const phase = { kind: "ready" as const, overview };
    const saving = html({ phase, editor: editorState({ busy: "save" }) });
    expect(saving).toContain("Saving…");
    const approving = html({
      phase,
      editor: editorState({
        busy: "approve",
        confirming: true,
        saved: draft,
        editing: { mode: "draft", draftId: draft.id, revision: 1, mandateId: "M1", baseVersion: 1 },
      }),
    });
    expect(approving).toContain("Approving…");
  });

  it("the review-everything flag is a real checkbox with its consequence spelled out", () => {
    const out = html({
      phase: ready(),
      editor: editorState({}, { requireReviewBeforeExecution: true }),
    });
    const flag = out.slice(out.indexOf('id="field-requireReviewBeforeExecution"'));
    expect(flag.slice(0, flag.indexOf("</label>"))).toMatch(/checked=""/);
    expect(flag).toContain('aria-describedby="help-requireReviewBeforeExecution"');
    expect(out).toMatch(/every transaction waits for your approval, whatever its amount/);
  });

  it("with no sellers the seller group explains how to get some", () => {
    const { overview } = realOverview();
    const out = html({
      phase: { kind: "ready", overview: { ...overview, sellers: [] } },
      editor: editorState(),
    });
    expect(out).toContain("No sellers exist. Run npm run db:seed");
  });

  it("notices are announced politely, per tone", () => {
    const { overview } = realOverview();
    for (const tone of ["success", "danger", "info"] as const) {
      const out = html({
        phase: { kind: "ready", overview },
        notice: { tone, text: `msg-${tone}` },
      });
      expect(out).toMatch(
        new RegExp(`aria-live="polite"[^>]*><p class="notice notice--${tone}">msg-${tone}`),
      );
    }
  });
});
