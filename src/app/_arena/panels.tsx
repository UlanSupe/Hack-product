import type { ReactNode } from "react";

export type Tone = "success" | "warning" | "danger" | "info" | "neutral";

/* Status vocabulary (used identically everywhere in the Arena):
   completed = success, pending = warning, blocked = info, violation/error = danger, none = neutral.
   Colour is never the only signal: every chip carries text, and usually an icon. */

export function Chip({ tone, icon, children }: { tone: Tone; icon?: string; children: ReactNode }) {
  return (
    <span className={`chip chip--${tone}`}>
      {icon ? <span aria-hidden="true">{icon}</span> : null}
      {children}
    </span>
  );
}

export function Skeleton({ lines = 4 }: { lines?: number }) {
  return (
    <div className="skeleton" role="status" aria-busy="true">
      <span className="sr-only">Loading…</span>
      {Array.from({ length: lines }, (_, i) => (
        <div key={i} className="skeleton__line" style={{ width: `${95 - ((i * 17) % 45)}%` }} />
      ))}
    </div>
  );
}
