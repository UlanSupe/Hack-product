import { JourneyHeader, type PageId } from "../_journey/journey-header";
import { StateNote } from "./state-note";

/** Shown instead of a public page when the global cap on public pages is reached (see src/server/public-limit.ts). */
export function Busy({ page }: { page: PageId }) {
  return (
    <>
      <JourneyHeader current={page} />
      <main className="wrap" id="main">
        <StateNote kind="pending" title="This public page is busy">
          Too many people are asking for it right now. Nothing is wrong and nothing was changed;
          reload in a few seconds.
        </StateNote>
      </main>
    </>
  );
}
