import { PLAIN_STEPS, type StepStatus, type StepView } from "@/domain/journey";

const STATUS_TEXT: Record<StepStatus, string> = {
  DONE: "Done",
  CURRENT: "Next",
  TODO: "To do",
  BLOCKED: "Blocked",
  UNAVAILABLE: "Unavailable",
  SIMULATION: "Simulation",
};

/** Status is words and a symbol, never colour alone. */
const STATUS_MARK: Record<StepStatus, string> = {
  DONE: "✓",
  CURRENT: "→",
  TODO: "·",
  BLOCKED: "!",
  UNAVAILABLE: "–",
  SIMULATION: "◇",
};

type Item = Pick<StepView, "id" | "number" | "short" | "title" | "href"> &
  Partial<Pick<StepView, "status" | "detail">>;

/**
 * The nine steps as one ordered list of links. Presentational and free of state, so the same markup serves the
 * loading state (plain links, no status claimed) and the real one. `currentId` marks the step the server says is next.
 */
export function StepList({
  steps = PLAIN_STEPS,
  currentId = null,
  currentPage = null,
}: {
  steps?: readonly Item[];
  currentId?: string | null;
  /** The step whose page is on screen right now, if any. */
  currentPage?: string | null;
}) {
  return (
    <ol className="journey" aria-label="Transaction journey, nine steps">
      {steps.map((s) => (
        <li
          key={s.id}
          className={`journey__step${s.status ? ` journey__step--${s.status.toLowerCase()}` : ""}${
            s.id === currentId ? " is-next" : ""
          }`}
        >
          <a
            href={s.href}
            aria-current={s.id === currentPage ? "page" : undefined}
            title={s.detail ?? s.title}
          >
            <span className="journey__num" aria-hidden="true">
              {s.status ? STATUS_MARK[s.status] : s.number}
            </span>
            <span className="journey__label">
              <span className="journey__name">
                {s.number}. {s.short}
              </span>
              {s.status ? <span className="journey__state">{STATUS_TEXT[s.status]}</span> : null}
            </span>
            <span className="sr-only">
              {s.title}.{s.detail ? ` ${s.detail}` : ""}
            </span>
          </a>
        </li>
      ))}
    </ol>
  );
}
