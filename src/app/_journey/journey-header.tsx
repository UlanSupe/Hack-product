import type { StepId } from "@/domain/journey";
import { Chip } from "../_arena/panels";
import { JourneyProgress } from "./journey-progress";

export type PageId =
  "start" | "mandate" | "negotiations" | "flagship" | "cockpit" | "arena" | "livemodel";

/** The step each page shows, so the progress bar can mark where you are. */
const PAGE_STEP: Record<PageId, StepId | null> = {
  start: "scenario",
  mandate: "mandate",
  negotiations: "task",
  flagship: "replay",
  cockpit: "verify",
  arena: null,
  livemodel: null,
};

/** The one header and navigation for every page. Replaces the three hand-copied variants. */
export function JourneyHeader({ current }: { current: PageId }) {
  const link = (page: PageId, href: string, label: string) => (
    <a href={href} aria-current={current === page ? "page" : undefined}>
      {label}
    </a>
  );
  return (
    <header className="topbar">
      <div className="wrap topbar__in">
        <div>
          <p className="brand">
            <a href="/">PactPay Arena</a>
          </p>
          <p className="muted small">Agents negotiate. Code enforces. PayPal settles.</p>
        </div>
        <nav className="nav" aria-label="Primary">
          {link("start", "/", "Start")}
          {link("mandate", "/mandate", "Mandate")}
          {link("negotiations", "/negotiations", "Negotiations")}
          {link("cockpit", "/cockpit", "Cockpit")}
          {link("flagship", "/flagship", "Replay attack")}
          {link("arena", "/arena", "Arena (simulation)")}
          {link("livemodel", "/live-model", "Live model")}
        </nav>
        <div className="chips">
          <Chip tone="info">PayPal Sandbox only</Chip>
          <Chip tone="warning">Synthetic data</Chip>
          {process.env.DEPLOY_MODE === "demo" ? <Chip tone="neutral">Public demo</Chip> : null}
        </div>
      </div>
      <div className="wrap">
        <JourneyProgress page={PAGE_STEP[current]} />
      </div>
    </header>
  );
}
