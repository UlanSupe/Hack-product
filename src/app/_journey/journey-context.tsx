"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";

import type { RecentNegotiation } from "@/application/journey";
import type { JourneyState } from "@/domain/journey";

/**
 * The ONE client-side copy of "where is the operator in the journey". It holds nothing the server did not say: it
 * asks `GET /api/journey`, which derives everything from stored state. Which transaction is being followed lives in
 * the address (`?n=`) and nowhere else, so a reload, a shared link or the browser's back button all agree.
 */

export type JourneyStatus = "loading" | "ready" | "signed_out" | "not_configured" | "error";

export type JourneyContextValue = {
  status: JourneyStatus;
  journey: JourneyState | null;
  recent: RecentNegotiation[];
  /** A recovery message to show (for example "that transaction was not found"), or null. */
  message: string | null;
  negotiationId: string | null;
  refresh: () => void;
  /** Follow a transaction (or none). Updates the address without adding a history entry. */
  follow: (id: string | null) => void;
};

/** Other parts of the page announce "something changed on the server" with this event; the bar re-reads. */
export const JOURNEY_CHANGED = "pactpay:journey-changed";
export const announceJourneyChange = () => window.dispatchEvent(new Event(JOURNEY_CHANGED));

const NOOP: JourneyContextValue = {
  status: "loading",
  journey: null,
  recent: [],
  message: null,
  negotiationId: null,
  refresh: () => undefined,
  follow: () => undefined,
};
const Ctx = createContext<JourneyContextValue>(NOOP);
export const useJourney = () => useContext(Ctx);

type Body = {
  journey?: JourneyState;
  recent?: RecentNegotiation[];
  error?: string;
  message?: string;
};

const ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

const readId = () => {
  try {
    const n = new URLSearchParams(window.location.search).get("n");
    return n !== null && ID_PATTERN.test(n) ? n : null;
  } catch {
    return null;
  }
};

type Snapshot = Omit<JourneyContextValue, "refresh" | "follow">;
const INITIAL: Snapshot = {
  status: "loading",
  journey: null,
  recent: [],
  message: null,
  negotiationId: null,
};

async function load(id: string | null): Promise<Snapshot> {
  try {
    // Who am I? This endpoint always answers 200, so a visitor who is not signed in (most visitors) makes no failing request
    // (a 401 here would show up as an error in every browser console). Only a signed-in operator asks for the journey.
    const who = await fetch("/api/operator/session", {
      credentials: "same-origin",
      cache: "no-store",
    });
    const me = (await who.json().catch(() => null)) as {
      configured?: boolean;
      authenticated?: boolean;
    } | null;
    if (who.status === 200 && me?.configured === false)
      return { ...INITIAL, status: "not_configured", negotiationId: id };
    if (who.status === 200 && me?.authenticated === false)
      return { ...INITIAL, status: "signed_out", negotiationId: id };
    const res = await fetch(`/api/journey${id ? `?negotiation=${encodeURIComponent(id)}` : ""}`, {
      credentials: "same-origin",
      cache: "no-store",
    });
    const body = (await res.json().catch(() => null)) as Body | null;
    if (res.status === 200 && body?.journey)
      return {
        status: "ready",
        journey: body.journey,
        recent: body.recent ?? [],
        message: null,
        negotiationId: id,
      };
    if (res.status === 401) return { ...INITIAL, status: "signed_out", negotiationId: id };
    if (res.status === 404 && id !== null) {
      // The followed transaction is gone or never existed: drop it and show where the operator is without it.
      const again = await load(null);
      return { ...again, message: "That transaction was not found, so the journey starts fresh." };
    }
    if (res.status === 503 && body?.error === "OPERATOR_NOT_CONFIGURED")
      return { ...INITIAL, status: "not_configured", negotiationId: id };
    return {
      ...INITIAL,
      status: "error",
      negotiationId: id,
      message: body?.message ?? "The server could not report your progress.",
    };
  } catch {
    return {
      ...INITIAL,
      status: "error",
      negotiationId: id,
      message: "Could not reach the server.",
    };
  }
}

export function JourneyProvider({ children }: { children: ReactNode }) {
  const [snap, setSnap] = useState<Snapshot>(INITIAL);
  const [id, setId] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  const [ready, setReady] = useState(false);
  // A recovery message that must survive the re-read that follows dropping a stale id.
  const [note, setNote] = useState<string | null>(null);

  // The address is read after mount (never during render) so the server and client first paint agree.
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- one-time read of the address after mount
    setId(readId());
    setReady(true);
    const onPop = () => setId(readId());
    const onChanged = () => setTick((t) => t + 1);
    window.addEventListener("popstate", onPop);
    window.addEventListener(JOURNEY_CHANGED, onChanged);
    return () => {
      window.removeEventListener("popstate", onPop);
      window.removeEventListener(JOURNEY_CHANGED, onChanged);
    };
  }, []);

  useEffect(() => {
    if (!ready) return;
    let live = true;
    void load(id).then((next) => {
      if (!live) return;
      setSnap(next);
      // A 404 fell back to "no transaction": make the address say so too.
      if (id !== null && next.negotiationId === null) {
        setNote(next.message);
        try {
          const url = new URL(window.location.href);
          url.searchParams.delete("n");
          window.history.replaceState(null, "", `${url.pathname}${url.search}${url.hash}`);
        } catch {
          /* the address is a convenience */
        }
        setId(null);
      }
    });
    return () => {
      live = false;
    };
  }, [ready, id, tick]);

  const follow = useCallback((next: string | null) => {
    try {
      const url = new URL(window.location.href);
      if (next === null) url.searchParams.delete("n");
      else url.searchParams.set("n", next);
      window.history.replaceState(null, "", `${url.pathname}${url.search}${url.hash}`);
    } catch {
      /* the address is a convenience; the state below is still right */
    }
    setNote(null);
    setId(next);
    setTick((t) => t + 1);
  }, []);

  const refresh = useCallback(() => setTick((t) => t + 1), []);

  const value = useMemo<JourneyContextValue>(
    () => ({ ...snap, message: snap.message ?? note, refresh, follow }),
    [snap, note, refresh, follow],
  );
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}
