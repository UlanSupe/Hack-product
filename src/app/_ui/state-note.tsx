import type { ReactNode } from "react";

import { Chip, type Tone } from "../_arena/panels";

/**
 * One vocabulary for "what state is this in", used wherever a view can be empty, loading, waiting, refused, broken or
 * finished. The words, symbol and colour for each state are defined here and nowhere else, so the same situation
 * looks the same on every page. Colour is never the only signal: every state has a word and a symbol.
 *
 *   loading  grey     the server has not answered yet
 *   empty    grey     there is nothing to show, and that is the truth (never filled with made-up rows)
 *   pending  amber    work is under way or waiting on someone
 *   denied   blue     a check refused it, as designed: this is the protection working, not a fault
 *   failed   red      something went wrong that should not have
 *   done     green    it finished, and the record says so
 */
export type StateKind = "loading" | "empty" | "pending" | "denied" | "failed" | "done";

export const STATE_STYLE: Record<
  StateKind,
  { tone: Tone; icon: string; label: string; role: "status" | "alert" }
> = {
  loading: { tone: "neutral", icon: "◌", label: "Loading", role: "status" },
  empty: { tone: "neutral", icon: "○", label: "Nothing yet", role: "status" },
  pending: { tone: "warning", icon: "…", label: "Pending", role: "status" },
  denied: { tone: "info", icon: "■", label: "Denied", role: "status" },
  failed: { tone: "danger", icon: "!", label: "Failed", role: "alert" },
  done: { tone: "success", icon: "✓", label: "Completed", role: "status" },
};

export function StateNote({
  kind,
  title,
  children,
  actions,
}: {
  kind: StateKind;
  title: ReactNode;
  children?: ReactNode;
  actions?: ReactNode;
}) {
  const s = STATE_STYLE[kind];
  return (
    <div
      className={`statenote statenote--${kind}`}
      role={s.role}
      aria-busy={kind === "loading" ? true : undefined}
    >
      <div className="statenote__label">
        <Chip tone={s.tone} icon={s.icon}>
          {s.label}
        </Chip>
      </div>
      <div className="statenote__main">
        <p className="statenote__title">{title}</p>
        {children ? <div className="statenote__body">{children}</div> : null}
        {actions ? <div className="row">{actions}</div> : null}
      </div>
    </div>
  );
}
