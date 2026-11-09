import type { CockpitRow } from "@/domain/cockpit";

/**
 * AG Studio: investigation notes and a data adapter, kept apart from the Cockpit on purpose. NOTHING in the Cockpit
 * imports Studio, the Studio packages are not installed, and no licence key exists in this repository. What follows
 * was read from the AG Grid documentation and npm metadata on 2026-11-04; none of it has been run, because running it
 * needs a licence this project does not have.
 *
 * Facts found (see docs/COCKPIT.md section 8 for the sources):
 *  - AG Studio is a commercial product built on AG Grid and AG Charts (npm packages `ag-studio`, `ag-studio-react`,
 *    both listed with the licence "Commercial"). It needs an Enterprise licence; the vendor offers a free trial. A trial
 *    key must never be committed, so none is used here.
 *  - React: `import { AgStudio } from "ag-studio-react"`, rendered as `<AgStudio data={data} mode="edit" />` inside a sized
 *    parent, with `data = { sources: [{ id, data: rows }] }` (plain objects).
 *  - The Studio Agent Framework (`AgStudioAiModule` from `ag-studio`) lets users build dashboards in natural language with
 *    a model YOU supply. Studio ships no model adapters (an example is copied from `ag-studio-harness`, which is not on
 *    npm), and its documentation calls the provider from the browser, which would expose a key; in production requests
 *    must go through the application's own server. The AI feature must be included in the licence key.
 *  - The documentation found for the Agent Framework quick start is written for Angular; no React variant of that page
 *    was found.
 */

export const STUDIO = {
  packages: ["ag-studio-react", "ag-studio"] as const,
  license: "Commercial (Enterprise licence required; trial offered by the vendor)",
  docs: {
    reactQuickStart: "https://www.ag-grid.com/studio/react/quick-start/",
    reactData: "https://www.ag-grid.com/studio/react/data/",
    agentFramework: "https://www.ag-grid.com/studio/angular/ai-quickstart/",
  },
} as const;

export type StudioStatus = {
  enabled: false;
  reason: string;
  /** What someone with a licence would do. Unverified here. */
  steps: string[];
};

/** The Cockpit asks this to decide what to say in its footer. It is always "not enabled" until someone wires a licensed Studio in. */
export function studioStatus(): StudioStatus {
  return {
    enabled: false,
    reason:
      "AG Studio is a separate commercial product; it is not installed and no licence key is configured.",
    steps: [
      "Obtain an AG Studio licence (or the vendor's trial) and install ag-studio-react in YOUR checkout; never commit the key.",
      "Create a client component that renders <AgStudio data={studioData(rows)} /> next to the grid.",
      "For the Agent Framework: register AgStudioAiModule, write an adapter for your model, and route its requests through a server route, not the browser.",
    ],
  };
}

export type StudioDataSources = {
  sources: { id: string; data: Record<string, string | number | boolean | null>[] }[];
};

/**
 * The Cockpit rows as the plain-object source AG Studio's React `data` prop documents. Scalars only (Studio sources are
 * arrays of flat objects), amounts kept as integer minor units with their currency beside them, nothing derived.
 */
export function studioData(rows: readonly CockpitRow[]): StudioDataSources {
  return {
    sources: [
      {
        id: "cockpit",
        data: rows.map((r) => ({
          id: r.id,
          source: r.source,
          timestamp: r.timestamp,
          refId: r.refId,
          scenario: r.scenario,
          category: r.category,
          buyerMode: r.buyerMode,
          currency: r.currency,
          proposedMinor: r.proposedMinor,
          approvedMinor: r.approvedMinor,
          movedMinor: r.movedMinor,
          decision: r.decision,
          reasonCodes: r.reasonCodes.join(","),
          reasonSource: r.reasonSource,
          paymentStatus: r.paymentStatus,
          verification: r.verification,
          auditChain: r.auditChain,
        })),
      },
    ],
  };
}
