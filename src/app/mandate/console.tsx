"use client";

import { useCallback, useEffect, useMemo, useState } from "react";

import type { DraftView, MandateSummary, Overview } from "@/application/mandates";
import type { FieldError } from "@/domain/mandate";
import { emptyForm, fieldsFromForm, formFromFields, sameForm, type FormState } from "./form";
import { ConsoleView, type Actions, type EditorState, type Notice, type Phase } from "./views";
import { announceJourneyChange } from "../_journey/journey-context";

type ApiBody = {
  message?: unknown;
  configured?: boolean;
  authenticated?: boolean;
  csrfToken?: string;
  draft?: DraftView;
  mandate?: { id: string; version: number };
  fields?: FieldError[];
};
type ApiResult = { status: number; data: ApiBody | null };

async function call(
  path: string,
  init: { method?: string; csrf?: string | null; body?: unknown } = {},
): Promise<ApiResult> {
  const headers: Record<string, string> = {};
  if (init.body !== undefined) headers["content-type"] = "application/json";
  if (init.csrf) headers["x-csrf-token"] = init.csrf;
  const res = await fetch(path, {
    method: init.method ?? "GET",
    credentials: "same-origin",
    headers,
    ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
  });
  const data = (await res.json().catch(() => null)) as ApiBody | null;
  return { status: res.status, data };
}

const messageOf = (r: ApiResult, fallback: string) =>
  typeof r.data?.message === "string" ? r.data.message : fallback;

const blankEditor = (
  editing: EditorState["editing"],
  form: FormState,
  saved: DraftView | null,
): EditorState => ({
  editing,
  form,
  errors: [],
  saved,
  dirty: false,
  busy: null,
  confirming: false,
});

export function MandateConsole() {
  const [phase, setPhase] = useState<Phase>({ kind: "loading" });
  const [csrf, setCsrf] = useState<string | null>(null);
  const [loginError, setLoginError] = useState<string | null>(null);
  const [loginBusy, setLoginBusy] = useState(false);
  const [editor, setEditor] = useState<EditorState | null>(null);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [revoking, setRevoking] = useState<string | null>(null);
  const [revokeBusy, setRevokeBusy] = useState(false);

  /** Re-reads the overview. `quiet` keeps what is on screen while it loads. */
  const loadOverview = useCallback(async (quiet: boolean): Promise<void> => {
    if (!quiet) setPhase({ kind: "loading" });
    try {
      const r = await call("/api/mandates");
      if (r.status === 200 && r.data) {
        setPhase({ kind: "ready", overview: r.data as unknown as Overview });
        announceJourneyChange();
      } else if (r.status === 401) setPhase({ kind: "signed_out" });
      else
        setPhase({
          kind: "error",
          message: messageOf(r, "The server could not load the mandates."),
        });
    } catch {
      setPhase({ kind: "error", message: "Could not reach the server." });
    }
  }, []);

  /** First check (and Retry): who am I, then load. No setState before the first await. */
  const check = useCallback(async (): Promise<void> => {
    try {
      const s = await call("/api/operator/session");
      if (s.status !== 200 || !s.data)
        return setPhase({ kind: "error", message: "Could not check your sign-in." });
      if (!s.data.configured) return setPhase({ kind: "not_configured" });
      if (!s.data.authenticated) return setPhase({ kind: "signed_out" });
      setCsrf(s.data.csrfToken ?? null);
      await loadOverview(false);
    } catch {
      setPhase({ kind: "error", message: "Could not reach the server." });
    }
  }, [loadOverview]);

  const start = useCallback((): void => {
    setPhase({ kind: "loading" });
    void check();
  }, [check]);

  useEffect(() => {
    // Fetch on mount: state is only set after the awaited request resolves, never synchronously.
    // eslint-disable-next-line react-hooks/set-state-in-effect -- the rule cannot see the await boundary
    void check();
  }, [check]);

  // Move focus to the error summary after a failed save so keyboard and screen-reader users land on it.
  const errorCount = editor?.errors.length ?? 0;
  useEffect(() => {
    if (errorCount > 0) document.getElementById("editor-errors")?.focus();
  }, [errorCount, editor?.saved?.revision]);

  const patchEditor = (patch: Partial<EditorState>) =>
    setEditor((e) => (e ? { ...e, ...patch } : e));

  const actions: Actions = useMemo(() => {
    const failure = (r: ApiResult, fallback: string) => {
      if (r.status === 401) {
        setPhase({ kind: "signed_out" });
        return;
      }
      setNotice({ tone: "danger", text: messageOf(r, fallback) });
      if (r.status === 409 || r.status === 404) void loadOverview(true);
    };

    return {
      retry: start,

      login: (passcode) => {
        setLoginBusy(true);
        setLoginError(null);
        void call("/api/operator/session", { method: "POST", body: { passcode } })
          .then(async (r) => {
            if (r.status === 200 && r.data) {
              setCsrf(r.data.csrfToken ?? null);
              await loadOverview(false);
            } else {
              setLoginError(messageOf(r, "Could not sign in."));
            }
          })
          .catch(() => setLoginError("Could not reach the server."))
          .finally(() => setLoginBusy(false));
      },

      signOut: () => {
        void call("/api/operator/session", { method: "DELETE", csrf }).finally(() => {
          setCsrf(null);
          setEditor(null);
          setNotice(null);
          setPhase({ kind: "signed_out" });
        });
      },

      startNew: () => {
        setNotice(null);
        setEditor(blankEditor({ mode: "new" }, emptyForm(), null));
      },

      startNewVersion: (m: MandateSummary) => {
        setNotice(null);
        setEditor(
          blankEditor(
            { mode: "newVersion", mandateId: m.id, baseVersion: m.latest.version },
            formFromFields(m.latest.fields),
            null,
          ),
        );
      },

      continueDraft: (d: DraftView) => {
        setNotice(null);
        setEditor(
          blankEditor(
            {
              mode: "draft",
              draftId: d.id,
              revision: d.revision,
              mandateId: d.mandateId,
              baseVersion: d.baseVersion,
            },
            formFromFields(d.fields),
            d,
          ),
        );
      },

      change: (patch) =>
        setEditor((e) => {
          if (!e) return e;
          const form = { ...e.form, ...patch };
          const changed = new Set(Object.keys(patch));
          return {
            ...e,
            form,
            errors: e.errors.filter((x) => !changed.has(x.field)),
            dirty: e.saved ? !sameForm(form, formFromFields(e.saved.fields)) : false,
            confirming: false,
          };
        }),

      save: () => {
        if (!editor || editor.busy) return;
        const { editing, form, saved } = editor;
        patchEditor({ busy: "save", confirming: false });
        setNotice(null);
        const fields = fieldsFromForm(form);
        const req =
          editing.mode === "draft"
            ? call(`/api/mandates/drafts/${editing.draftId}`, {
                method: "PUT",
                csrf,
                body: { revision: saved?.revision ?? editing.revision, fields },
              })
            : call("/api/mandates/drafts", {
                method: "POST",
                csrf,
                body:
                  editing.mode === "newVersion"
                    ? {
                        basedOn: { mandateId: editing.mandateId, version: editing.baseVersion },
                        fields,
                      }
                    : { fields },
              });
        void req
          .then((r) => {
            if ((r.status === 200 || r.status === 201) && r.data?.draft) {
              const d = r.data.draft;
              setEditor({
                ...blankEditor(
                  {
                    mode: "draft",
                    draftId: d.id,
                    revision: d.revision,
                    mandateId: d.mandateId,
                    baseVersion: d.baseVersion,
                  },
                  formFromFields(d.fields),
                  d,
                ),
              });
              setNotice({
                tone: "success",
                text: `Draft saved (revision ${d.revision}). It has no effect until you approve it.`,
              });
              void loadOverview(true);
            } else if (r.status === 422 && Array.isArray(r.data?.fields)) {
              patchEditor({ busy: null, errors: r.data.fields });
            } else {
              patchEditor({ busy: null });
              failure(r, "The draft could not be saved.");
            }
          })
          .catch(() => {
            patchEditor({ busy: null });
            setNotice({ tone: "danger", text: "Could not reach the server." });
          });
      },

      askApprove: () =>
        setEditor((e) => (e && e.saved && !e.dirty ? { ...e, confirming: true } : e)),
      cancelApprove: () => patchEditor({ confirming: false }),

      approve: () => {
        if (!editor?.saved || editor.busy) return;
        const draft = editor.saved;
        patchEditor({ busy: "approve" });
        void call(`/api/mandates/drafts/${draft.id}/approve`, {
          method: "POST",
          csrf,
          body: { revision: draft.revision },
        })
          .then((r) => {
            if (r.status === 200 && r.data?.mandate) {
              const m = r.data.mandate;
              setEditor(null);
              setNotice({
                tone: "success",
                text: `Version ${m.version} of ${m.id} is now active. Earlier versions are unchanged.`,
              });
              void loadOverview(true);
            } else {
              patchEditor({ busy: null, confirming: false });
              failure(r, "The draft could not be approved.");
            }
          })
          .catch(() => {
            patchEditor({ busy: null });
            setNotice({ tone: "danger", text: "Could not reach the server." });
          });
      },

      discard: () => {
        if (!editor?.saved || editor.busy) return;
        const draft = editor.saved;
        patchEditor({ busy: "discard" });
        void call(`/api/mandates/drafts/${draft.id}/discard`, {
          method: "POST",
          csrf,
          body: { revision: draft.revision },
        })
          .then((r) => {
            if (r.status === 200) {
              setEditor(null);
              setNotice({ tone: "info", text: "Draft discarded. No mandate changed." });
              void loadOverview(true);
            } else {
              patchEditor({ busy: null });
              failure(r, "The draft could not be discarded.");
            }
          })
          .catch(() => patchEditor({ busy: null }));
      },

      closeEditor: () => {
        if (
          editor &&
          (editor.dirty || (editor.saved === null && !sameForm(editor.form, emptyForm()))) &&
          !window.confirm("Close the editor? Unsaved changes will be lost.")
        )
          return;
        setEditor(null);
      },

      askRevoke: (id) => setRevoking(id),
      cancelRevoke: () => setRevoking(null),

      revoke: (m: MandateSummary) => {
        setRevokeBusy(true);
        void call(`/api/mandates/${m.id}/revoke`, {
          method: "POST",
          csrf,
          body: { expectedVersion: m.latest.version },
        })
          .then((r) => {
            if (r.status === 200) {
              setNotice({
                tone: "success",
                text: `${m.id} is revoked. No new transactions can start under it.`,
              });
              void loadOverview(true);
            } else failure(r, "The mandate could not be revoked.");
          })
          .catch(() => setNotice({ tone: "danger", text: "Could not reach the server." }))
          .finally(() => {
            setRevokeBusy(false);
            setRevoking(null);
          });
      },
    };
  }, [csrf, editor, loadOverview, start]);

  return (
    <ConsoleView
      phase={phase}
      loginError={loginError}
      loginBusy={loginBusy}
      editor={editor}
      notice={notice}
      revoking={revoking}
      revokeBusy={revokeBusy}
      actions={actions}
    />
  );
}
