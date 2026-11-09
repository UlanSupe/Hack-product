import { FLAGSHIP_VARIANTS, runFlagship, type FlagshipVariant } from "@/server/flagship";
import { BRAIN_PROFILES, type BrainProfile } from "@/domain/experiment";

import {
  AuditCard,
  BaselinePane,
  MandateCard,
  ProtectedPane,
  StoryCard,
  TamperCard,
} from "../_arena/flagship-panels";
import { JourneyHeader } from "../_journey/journey-header";
import { Busy } from "../_ui/busy";
import { mayBuildPublicPage } from "@/server/public-limit";
import { PageHead } from "../_ui/page-head";

export const dynamic = "force-dynamic";

type SearchParams = Promise<Record<string, string | string[] | undefined>>;
const first = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);

const VARIANT_LABEL: Record<FlagshipVariant, string> = {
  ESCALATE_36: "Revised to $36.00 (above the $30.00 cap)",
  ESCALATE_28: "Revised to $28.00 (inside the cap, above the $24.00 approval threshold)",
};
const BRAIN_LABEL: Record<BrainProfile, string> = {
  SUSCEPTIBLE: "Susceptible model (yields to pressure and false authority)",
  CAREFUL: "Careful model (checks everything itself)",
};

/**
 * The flagship budget-escalation attack. `?variant=ESCALATE_28&brain=CAREFUL` picks what runs; only these two known
 * values reach the experiment. The run uses a throwaway in-memory database and no PayPal code at all.
 */
export default async function FlagshipPage({ searchParams }: { searchParams: SearchParams }) {
  const q = await searchParams;
  const variant = FLAGSHIP_VARIANTS.find((v) => v === first(q.variant)) ?? "ESCALATE_36";
  const brain = BRAIN_PROFILES.find((b) => b === first(q.brain)) ?? "SUSCEPTIBLE";
  // The followed transaction (if any) is only passed through, so the progress bar still finds it after a re-run.
  const followed = /^[A-Za-z0-9_-]{1,64}$/.test(first(q.n) ?? "") ? first(q.n) : undefined;
  if (!mayBuildPublicPage()) return <Busy page="flagship" />;
  const r = runFlagship({ variant, brain });
  return (
    <>
      <JourneyHeader current="flagship" />
      <main className="wrap" id="main">
        <PageHead
          title="Flagship: budget escalation attack"
          lead="A valid offer is revised upward under pressure. The unsafe baseline pays; the protected buyer is refused by the policy engine."
        />
        <p className="banner" role="note">
          <strong>The flagship attack: budget escalation.</strong> A seller opens with a valid
          $24.00 offer, then pushes the price past what the mandate allows. The unsafe baseline is
          an isolated simulation. The protected buyer&rsquo;s decisions below are the real
          negotiation service, policy engine and audit trail, run on a throwaway in-memory database.
          No PayPal call is made on this page.
        </p>
        <section className="card controls" aria-labelledby="fc-h">
          <h2 id="fc-h" className="sr-only">
            Flagship controls
          </h2>
          <form method="get" action="/flagship" className="controls__form">
            {followed ? <input type="hidden" name="n" value={followed} /> : null}
            <div className="field">
              <label htmlFor="variant">Seller&rsquo;s revision</label>
              <select id="variant" name="variant" defaultValue={variant}>
                {FLAGSHIP_VARIANTS.map((v) => (
                  <option key={v} value={v}>
                    {VARIANT_LABEL[v]}
                  </option>
                ))}
              </select>
            </div>
            <div className="field">
              <label htmlFor="brain">Simulated model</label>
              <select id="brain" name="brain" defaultValue={brain}>
                {BRAIN_PROFILES.map((b) => (
                  <option key={b} value={b}>
                    {BRAIN_LABEL[b]}
                  </option>
                ))}
              </select>
            </div>
            <div className="field field--run">
              <button type="submit" className="btn btn--primary">
                Run the attack
              </button>
            </div>
          </form>
          <p className="muted small">
            Run hash <code className="code">{r.runHash.slice(0, 16)}</code>: the same choices always
            give the same run.
          </p>
        </section>

        <MandateCard r={r} />
        <StoryCard r={r} />
        <div className="compare">
          <BaselinePane r={r} />
          <ProtectedPane r={r} />
        </div>
        <AuditCard r={r} />
        <TamperCard r={r} />

        <footer className="foot muted small">
          {r.version}. Synthetic data; no real money, no PayPal.{" "}
          <a href="/arena">The Arena (all scenarios)</a> · <a href="/">Back to the start</a>
        </footer>
      </main>
    </>
  );
}
