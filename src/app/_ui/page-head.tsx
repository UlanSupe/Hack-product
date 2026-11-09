import type { ReactNode } from "react";

/**
 * The visible title of a page and one sentence saying what it is for. Every page has exactly one, so there is a single
 * clear starting point on screen (and one h1 for assistive technology). Longer explanation goes in <Explainer>, closed
 * by default, so the page is not a wall of text.
 */
export function PageHead({
  title,
  lead,
  aside,
}: {
  title: ReactNode;
  lead?: ReactNode;
  aside?: ReactNode;
}) {
  return (
    <div className="pagehead">
      <div>
        <h1 className="pagehead__title">{title}</h1>
        {lead ? <p className="pagehead__lead">{lead}</p> : null}
      </div>
      {aside ? <div className="pagehead__aside">{aside}</div> : null}
    </div>
  );
}

/** Details on demand: the full explanation is one click away, and is always in the page for readers who want it. */
export function Explainer({ summary, children }: { summary: string; children: ReactNode }) {
  return (
    <details className="explainer">
      <summary>{summary}</summary>
      <div className="explainer__body">{children}</div>
    </details>
  );
}
