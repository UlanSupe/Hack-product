"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import type { NegotiationDetail } from "@/application/negotiation-views";
import type { NegotiationOverview } from "@/application/negotiations";
import type { PaymentView } from "@/application/payment-views";
import { scenarioById, type ScenarioFixture } from "@/domain/journey";
import type { FieldError } from "@/domain/mandate";
import { announceJourneyChange, useJourney } from "../_journey/journey-context";
import type { Notice } from "../mandate/views";
import { ConsoleView, type Actions, type Confirming, type OpenForm, type Phase } from "./views";

type ApiBody = {
  message?: unknown;
  configured?: boolean;
  authenticated?: boolean;
  csrfToken?: string;
  fields?: FieldError[];
  negotiation?: NegotiationDetail;
  outcome?: { accepted: boolean; policy: { headline: string }; negotiation: NegotiationDetail };
  eligibility?: { negotiation: NegotiationDetail; policy: { headline: string } | null };
  payment?: PaymentView;
  result?: { performed: boolean; notes: string[]; policy: { headline: string } | null };
  demo?: {
    source: "mock" | "model";
    headline: string;
    recorded: { offers: number; counters: number };
    problems: string[];
  };
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

const blankForm = (overview: NegotiationOverview): OpenForm => ({
  mandateId: overview.mandates[0]?.id ?? "",
  category: "COMPUTE",
  quantity: "1",
  summary: "",
  maxTotal: "",
  neededWithinDays: "",
  deliverables: "",
  sellers: overview.sellers.map((s) => s.id).slice(0, 2),
  timeoutMinutes: "60",
});

/**
 * The task form pre-filled from a FIXTURE scenario. Only fills the form: the operator still submits it, and the server
 * validates every field as usual. Returns null when there is no approved mandate to attach the task to.
 */
function scenarioForm(overview: NegotiationOverview, scenario: ScenarioFixture): OpenForm | null {
  const t = scenario.task;
  if (!t || overview.mandates.length === 0) return null;
  const known = new Set(overview.sellers.map((x) => x.id));
  const sellers = t.sellerIds.filter((id) => known.has(id));
  const mandate =
    overview.mandates.find(
      (m) =>
        m.allowedCategories.includes(t.category) &&
        sellers.every((id) => m.allowedSellerIds.includes(id)),
    ) ?? overview.mandates[0];
  const blank = blankForm(overview);
  return {
    ...blank,
    mandateId: mandate?.id ?? "",
    category: t.category,
    quantity: String(t.quantity),
    summary: t.summary,
    maxTotal: t.maxTotal,
    neededWithinDays: String(t.neededWithinDays),
    deliverables: t.deliverables.join("\n"),
    sellers: sellers.length > 0 ? sellers : blank.sellers,
  };
}

const ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

/** Builds the API body. Empty optional fields become null; numbers that are not numbers go through and are refused by the server. */
function openBody(f: OpenForm): Record<string, unknown> {
  const int = (s: string) =>
    s.trim() === "" ? null : /^[0-9]+$/.test(s.trim()) ? Number(s.trim()) : s;
  return {
    mandateId: f.mandateId,
    category: f.category,
    quantity: int(f.quantity) ?? 1,
    summary: f.summary,
    maxTotal: f.maxTotal.trim() === "" ? null : f.maxTotal.trim(),
    neededWithinDays: int(f.neededWithinDays),
    requiredDeliverables: f.deliverables
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l !== ""),
    invitedSellerIds: f.sellers,
    timeoutMinutes: int(f.timeoutMinutes) ?? 60,
  };
}

export function NegotiationConsole() {
  const [phase, setPhase] = useState<Phase>({ kind: "loading" });
  const [csrf, setCsrf] = useState<string | null>(null);
  const [loginError, setLoginError] = useState<string | null>(null);
  const [loginBusy, setLoginBusy] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<NegotiationDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [payment, setPayment] = useState<PaymentView | null>(null);
  const [form, setForm] = useState<OpenForm | null>(null);
  const [formErrors, setFormErrors] = useState<FieldError[]>([]);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [confirming, setConfirming] = useState<Confirming>(null);
  const { follow } = useJourney();
  const started = useRef(false);
  // The address as it was when the page opened: the journey bar may tidy it (drop a stale id) before the data is in.
  const openedWith = useRef<string | null>(null);
  useEffect(() => {
    openedWith.current = window.location.search;
  }, []);

  const loadOverview = useCallback(async (quiet: boolean): Promise<void> => {
    if (!quiet) setPhase({ kind: "loading" });
    try {
      const r = await call("/api/negotiations");
      if (r.status === 200 && r.data)
        setPhase({ kind: "ready", overview: r.data as unknown as NegotiationOverview });
      else if (r.status === 401) setPhase({ kind: "signed_out" });
      else
        setPhase({
          kind: "error",
          message: messageOf(r, "The server could not load the negotiations."),
        });
    } catch {
      setPhase({ kind: "error", message: "Could not reach the server." });
    }
  }, []);

  const loadDetail = useCallback(
    async (id: string, quiet: boolean): Promise<void> => {
      if (!quiet) setDetailLoading(true);
      try {
        const r = await call(`/api/negotiations/${encodeURIComponent(id)}`);
        if (r.status === 200 && r.data?.negotiation) setDetail(r.data.negotiation);
        else if (r.status === 401) setPhase({ kind: "signed_out" });
        else if (r.status === 404) {
          // Recovery: a stale or mistyped link. Forget it and go back to the list.
          setSelectedId(null);
          follow(null);
          setNotice({
            tone: "danger",
            text: "That negotiation was not found. Pick one from the list, or start a new scenario.",
          });
        } else
          setNotice({ tone: "danger", text: messageOf(r, "Could not load that negotiation.") });
      } catch {
        setNotice({ tone: "danger", text: "Could not reach the server." });
      } finally {
        setDetailLoading(false);
      }
    },
    [follow],
  );

  const loadPayment = useCallback(async (id: string): Promise<void> => {
    try {
      const r = await call(`/api/negotiations/${encodeURIComponent(id)}/payment`);
      setPayment(r.status === 200 && r.data?.payment ? r.data.payment : null);
    } catch {
      setPayment(null);
    }
  }, []);

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

  // The payment panel follows the active agreement of the selected negotiation (server state; no PayPal call).
  const activeAgreementId = detail?.active?.id ?? null;
  const detailId = detail?.id ?? null;
  useEffect(() => {
    if (detailId === null || activeAgreementId === null) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- reset when there is nothing to pay
      setPayment(null);
      return;
    }
    void loadPayment(detailId);
  }, [detailId, activeAgreementId, loadPayment]);

  // Coming back from PayPal: the redirect only says "look again"; the panel shows what the server verified.
  useEffect(() => {
    const flag = new URLSearchParams(window.location.search).get("payment");
    if (flag === null) return;
    const text =
      flag === "checked"
        ? "Back from PayPal. The server asked PayPal what happened; the payment panel shows the state the server read back."
        : flag === "unavailable"
          ? "Back from PayPal, but PayPal could not be reached to check. Use “Check status with PayPal”."
          : flag === "signin"
            ? "Back from PayPal. Sign in as the operator, then use “Check status with PayPal”: nothing has been read from PayPal yet."
            : "Back from PayPal, but the payment could not be matched. Nothing was changed.";
    // eslint-disable-next-line react-hooks/set-state-in-effect -- one-time notice from the URL
    setNotice({ tone: flag === "checked" || flag === "signin" ? "info" : "danger", text });
    const rest = new URLSearchParams(window.location.search);
    rest.delete("payment");
    const q = rest.toString();
    window.history.replaceState(null, "", `${window.location.pathname}${q ? `?${q}` : ""}`);
  }, []);

  // Once the overview is loaded: open the transaction named in the address (?n=), or a fixture scenario (?scenario=).
  const readyOverview = phase.kind === "ready" ? phase.overview : null;
  useEffect(() => {
    if (readyOverview === null || started.current) return;
    started.current = true;
    const q = new URLSearchParams(openedWith.current ?? window.location.search);
    const n = q.get("n");
    const scenario = scenarioById(q.get("scenario"));
    if (n !== null && ID_PATTERN.test(n)) {
      setSelectedId(n);
      void loadDetail(n, false);
    } else if (scenario?.task) {
      const prefilled = scenarioForm(readyOverview, scenario);
      if (prefilled) setForm(prefilled);
      else
        setNotice({
          tone: "danger",
          text: "There is no approved mandate yet, so the task cannot be attached to one. Approve a mandate first (step 2), then start the scenario again.",
        });
    }
    if (q.has("scenario")) {
      q.delete("scenario");
      const rest = q.toString();
      window.history.replaceState(null, "", `${window.location.pathname}${rest ? `?${rest}` : ""}`);
    }
  }, [readyOverview, loadDetail]);

  useEffect(() => {
    // Fetch on mount: state is only set after the awaited request resolves, never synchronously.
    // eslint-disable-next-line react-hooks/set-state-in-effect -- the rule cannot see the await boundary
    void check();
  }, [check]);

  // After a failed submit, move focus to the first invalid field so keyboard and screen-reader users land on it.
  const errorCount = formErrors.length;
  useEffect(() => {
    if (errorCount > 0) document.querySelector<HTMLElement>("[aria-invalid='true']")?.focus();
  }, [errorCount, formErrors]);

  const actions: Actions = useMemo(() => {
    /** Runs one write, refreshes what is on screen, and reports. */
    const act = async (
      key: string,
      path: string,
      body: unknown,
      done: (r: ApiResult) => string | null,
      id?: string,
    ): Promise<void> => {
      setBusy(key);
      setConfirming(null);
      try {
        const r = await call(path, { method: "POST", csrf, body });
        if (r.status === 401) return setPhase({ kind: "signed_out" });
        const success = r.status >= 200 && r.status < 300;
        const text = success ? done(r) : null;
        setNotice(
          success
            ? { tone: "success", text: text ?? "Done." }
            : { tone: "danger", text: messageOf(r, "That did not work.") },
        );
        const next =
          r.data?.outcome?.negotiation ?? r.data?.eligibility?.negotiation ?? r.data?.negotiation;
        if (next) setDetail(next);
        else if (id) await loadDetail(id, true);
        await loadOverview(true);
      } catch {
        setNotice({ tone: "danger", text: "Could not reach the server." });
      } finally {
        setBusy(null);
        announceJourneyChange();
      }
    };
    const base = (id: string) => `/api/negotiations/${encodeURIComponent(id)}`;
    /** A payment step: an EMPTY POST. The server decides the amount, currency, payee and agreement. */
    const payAct = (
      key: "start" | "check" | "authorize" | "capture" | "void",
      suffix: string,
    ): void => {
      const id = cur();
      if (!id) return;
      setBusy(`pay:${key}`);
      setConfirming(null);
      void call(`${base(id)}/payment${suffix}`, { method: "POST", csrf, body: {} })
        .then((r) => {
          if (r.status === 401) return setPhase({ kind: "signed_out" });
          if (r.data?.payment) setPayment(r.data.payment);
          const ok = r.status >= 200 && r.status < 300;
          const notes = r.data?.result?.notes ?? [];
          const policy = r.data?.result?.policy?.headline;
          setNotice({
            tone: ok ? (r.data?.payment?.tone === "danger" ? "danger" : "info") : "danger",
            text: ok
              ? [policy, ...notes].filter(Boolean).join(" ") || "Done."
              : messageOf(r, "That did not work."),
          });
        })
        .catch(() => setNotice({ tone: "danger", text: "Could not reach the server." }))
        .finally(() => {
          setBusy(null);
          announceJourneyChange();
        });
    };
    const cur = () => selectedId;

    return {
      retry: () => {
        setPhase({ kind: "loading" });
        void check();
      },
      login: (passcode) => {
        setLoginBusy(true);
        setLoginError(null);
        void call("/api/operator/session", { method: "POST", body: { passcode } })
          .then(async (r) => {
            if (r.status === 200 && r.data) {
              setCsrf(r.data.csrfToken ?? null);
              await loadOverview(false);
              announceJourneyChange();
            } else setLoginError(messageOf(r, "Could not sign in."));
          })
          .catch(() => setLoginError("Could not reach the server."))
          .finally(() => setLoginBusy(false));
      },
      signOut: () => {
        void call("/api/operator/session", { method: "DELETE", csrf }).finally(() => {
          setCsrf(null);
          setDetail(null);
          setSelectedId(null);
          setNotice(null);
          setPhase({ kind: "signed_out" });
          announceJourneyChange();
        });
      },
      select: (id) => {
        setSelectedId(id);
        setConfirming(null);
        setNotice(null);
        setDetail(null);
        follow(id);
        if (id) void loadDetail(id, false);
      },
      refresh: () => {
        void loadOverview(true);
        const id = cur();
        if (id) void loadDetail(id, true);
      },
      toggleOpen: () => {
        setNotice(null);
        setFormErrors([]);
        setForm((f) => (f ? null : phase.kind === "ready" ? blankForm(phase.overview) : null));
      },
      changeForm: (patch) => setForm((f) => (f ? { ...f, ...patch } : f)),
      submitOpen: () => {
        if (!form) return;
        setBusy("open");
        setFormErrors([]);
        void call("/api/negotiations", { method: "POST", csrf, body: openBody(form) })
          .then(async (r) => {
            if (r.status === 201 && r.data?.negotiation) {
              setForm(null);
              setSelectedId(r.data.negotiation.id);
              setDetail(r.data.negotiation);
              follow(r.data.negotiation.id);
              setNotice({
                tone: "success",
                text: "Negotiation opened. Sellers can now make offers; you can also run the demo agents.",
              });
              await loadOverview(true);
            } else if (r.status === 422 && r.data?.fields) {
              setFormErrors(r.data.fields);
              setNotice({ tone: "danger", text: "Some fields need attention." });
            } else if (r.status === 401) setPhase({ kind: "signed_out" });
            else
              setNotice({ tone: "danger", text: messageOf(r, "Could not open the negotiation.") });
          })
          .catch(() => setNotice({ tone: "danger", text: "Could not reach the server." }))
          .finally(() => setBusy(null));
      },
      startPayment: () => payAct("start", ""),
      checkPayment: () => payAct("check", "/refresh"),
      authorizePayment: () => payAct("authorize", "/authorize"),
      capturePayment: () => payAct("capture", "/capture"),
      voidPayment: () => payAct("void", "/void"),
      runDemo: (agents) => {
        const id = cur();
        if (id)
          void act(agents === "model" ? "model" : "demo", `${base(id)}/demo`, { agents }, (r) => {
            const d = r.data?.demo;
            return d
              ? `${d.source === "model" ? "AI model run. " : "Demo agents. "}${d.headline} Recorded ${d.recorded.offers} offer(s) and ${d.recorded.counters} counter-offer(s).${d.problems.length > 0 ? ` Problems: ${d.problems.join("; ")}` : ""}`
              : null;
          });
      },
      accept: (pid) => {
        const id = cur();
        if (id)
          void act(
            `accept:${pid}`,
            `${base(id)}/proposals/${encodeURIComponent(pid)}/accept`,
            {},
            (r) =>
              r.data?.outcome?.accepted
                ? "Accepted: the policy check passed and agreement was created."
                : (r.data?.outcome?.policy.headline ?? "The policy check refused this offer."),
          );
      },
      reject: (pid) => {
        const id = cur();
        if (id)
          void act(
            `reject:${pid}`,
            `${base(id)}/proposals/${encodeURIComponent(pid)}/reject`,
            {},
            () => "Proposal rejected.",
          );
      },
      check: () => {
        const id = cur();
        if (id)
          void act(
            "check",
            `${base(id)}/eligibility`,
            {},
            (r) => r.data?.eligibility?.policy?.headline ?? "Checked.",
          );
      },
      confirm: (what) => setConfirming(what),
      approve: () => {
        const id = cur();
        if (id)
          void act(
            "approve",
            `${base(id)}/approve`,
            {},
            () => "Approved. The policy engine was asked again; see the result below.",
          );
      },
      disapprove: () => {
        const id = cur();
        if (id)
          void act(
            "disapprove",
            `${base(id)}/disapprove`,
            {},
            () => "Agreement rejected and cancelled. The negotiation is open again.",
          );
      },
      close: (outcome) => {
        const id = cur();
        if (id)
          void act("close", `${base(id)}/close`, { outcome }, () =>
            outcome === "REJECTED"
              ? "Every offer rejected; negotiation closed."
              : "Negotiation cancelled.",
          );
      },
    };
  }, [csrf, check, follow, form, loadDetail, loadOverview, phase, selectedId]);

  return (
    <ConsoleView
      phase={phase}
      loginError={loginError}
      loginBusy={loginBusy}
      selectedId={selectedId}
      detail={detail}
      detailLoading={detailLoading}
      form={form}
      formErrors={formErrors}
      notice={notice}
      busy={busy}
      confirming={confirming}
      payment={payment}
      actions={actions}
    />
  );
}
