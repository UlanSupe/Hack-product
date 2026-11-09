import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { deriveJourney, NO_FACTS } from "@/domain/journey";
import ErrorPage from "@/app/error";
import Loading from "@/app/loading";
import NotFound from "@/app/not-found";
import StartPage from "@/app/page";
import { JourneyHeader, type PageId } from "@/app/_journey/journey-header";
import { StepList } from "@/app/_journey/step-list";

const text = (html: string) =>
  html
    .replace(/<[^>]+>/g, " ")
    .replace(/&#x27;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ");

function files(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) files(p, out);
    else if (/\.tsx?$/.test(name)) out.push(p.replaceAll("\\", "/"));
  }
  return out;
}

describe("the start page", () => {
  const html = renderToStaticMarkup(<StartPage />);
  const t = text(html);

  it("starts the journey and lists all nine steps, with the ninth marked as a simulation", () => {
    expect(t).toContain("Start a transaction scenario");
    for (const title of [
      "Start a transaction scenario",
      "Review or configure the financial mandate",
      "Submit the task",
      "Compare seller offers",
      "Observe the agent negotiation",
      "Inspect the agreement and policy decision",
      "Run the protected payment workflow",
      "Inspect verification and audit history",
      "Replay the budget-escalation attack",
    ])
      expect(t).toContain(title);
    expect(t).toContain("(simulation, not your transaction)");
  });

  it("labels each scenario as a fixture or a simulation, and says what a scenario does not do", () => {
    expect(t).toContain("Fixture task · real records");
    expect(t).toContain("Simulation · throwaway data");
    expect(t).toContain("A scenario only pre-fills the task form with made-up values");
    expect(t).toContain("nothing is simulated in its place");
  });

  it("links the scenarios to the console form and to the replay", () => {
    expect(html).toContain('href="/negotiations?scenario=compute-within-budget"');
    expect(html).toContain('href="/flagship"');
  });

  it("shows a loading state (not a made-up status) until the server has answered", () => {
    expect(t).toContain("Your place in the journey");
    expect(html).toContain('aria-busy="true"');
    expect(t).not.toContain("Mandate approved");
    expect(t).not.toContain("No approved mandate");
  });
});

describe("the shared header", () => {
  const pages: [PageId, string][] = [
    ["start", "Start"],
    ["mandate", "Mandate"],
    ["negotiations", "Negotiations"],
    ["cockpit", "Cockpit"],
    ["flagship", "Replay attack"],
    ["arena", "Arena (simulation)"],
    ["livemodel", "Live model"],
  ];

  it.each(pages)(
    "%s: one navigation, the current page marked once, every page reachable",
    (page, label) => {
      const html = renderToStaticMarkup(<JourneyHeader current={page} />);
      expect(html.match(/<nav /g)).toHaveLength(1);
      const marked = [...html.matchAll(/<a href="([^"]*)" aria-current="page">([^<]*)</g)];
      expect(marked.map((m) => m[2])).toContain(label);
      for (const href of [
        "/",
        "/mandate",
        "/negotiations",
        "/cockpit",
        "/flagship",
        "/arena",
        "/live-model",
      ])
        expect(html).toContain(`href="${href}"`);
      expect(text(html)).toContain("PayPal Sandbox only");
      expect(text(html)).toContain("Synthetic data");
    },
  );

  it("while loading, the nine steps are plain links that claim no status", () => {
    const html = renderToStaticMarkup(<JourneyHeader current="start" />);
    expect(html.match(/class="journey__step/g)).toHaveLength(9);
    expect(html).not.toMatch(/journey__step--(done|current|blocked|todo)/);
    expect(text(html)).toContain("Checking your progress");
  });

  it("is the only header: no page or view declares its own top bar", () => {
    const own = files("src/app").filter((f) => /className="topbar"/.test(readFileSync(f, "utf8")));
    expect(own).toEqual(["src/app/_journey/journey-header.tsx"]);
    const stale = files("src").filter((f) => /\bTopbar\b/.test(readFileSync(f, "utf8")));
    expect(stale).toEqual([]);
  });

  it("every page uses it", () => {
    for (const f of [
      "src/app/page.tsx",
      "src/app/arena/page.tsx",
      "src/app/mandate/page.tsx",
      "src/app/negotiations/page.tsx",
      "src/app/flagship/page.tsx",
      "src/app/cockpit/cockpit-view.tsx",
      "src/app/cockpit/detail-view.tsx",
      "src/app/not-found.tsx",
    ])
      expect(readFileSync(f, "utf8"), f).toMatch(/JourneyHeader|_arena\/arena/);
    expect(readFileSync("src/app/_arena/arena.tsx", "utf8")).toContain("JourneyHeader");
  });
});

describe("the step list shows state in words, not colour alone", () => {
  const journey = deriveJourney({
    ...NO_FACTS,
    mandateApproved: true,
    paypalConfigured: false,
    negotiation: {
      id: "neg_1",
      status: "AGREED",
      offers: 1,
      counters: 0,
      agentProposals: 1,
      refusal: null,
      pendingRevisions: 0,
      agreement: {
        version: 1,
        totalText: "80.00 USD",
        approval: "NOT_REQUIRED",
        eligibility: "ELIGIBLE",
        eligibilityHeadline: null,
        transactionId: "tx_1",
      },
    },
  });
  const html = renderToStaticMarkup(
    <StepList steps={journey.steps} currentId={journey.currentId} currentPage="payment" />,
  );

  it("names each status, marks the page you are on and the step that is next", () => {
    const t = text(html);
    expect(t).toContain("Done");
    expect(t).toContain("Unavailable");
    expect(t).toContain("Simulation");
    expect(html).toContain('aria-current="page"');
    expect(html).toContain("is-next");
    expect(html).toContain('aria-label="Transaction journey, nine steps"');
  });

  it("gives screen readers the full title and reason for every step", () => {
    expect(html).toContain("Run the protected payment workflow. This server has no PayPal sandbox");
    expect(html).toContain("A fixture on throwaway data");
  });
});

describe("error, loading and not-found pages are recoveries, not dead ends", () => {
  it("the error page never prints the error's own text, says nothing was paid, and offers retry and a way back", () => {
    const error = Object.assign(new Error("secret path C:\\app\\db.sqlite and a token"), {
      digest: "abc123",
    });
    const html = renderToStaticMarkup(<ErrorPage error={error} reset={() => undefined} />);
    const t = text(html);
    expect(t).not.toContain("secret path");
    expect(t).not.toContain("db.sqlite");
    expect(t).toContain("Nothing was paid or changed by this error");
    expect(t).toContain("Try again");
    expect(html).toContain('href="/"');
    expect(html).toContain('role="alert"');
    expect(t).toContain("abc123");
  });

  it("the loading page announces itself", () => {
    const html = renderToStaticMarkup(<Loading />);
    expect(html).toContain('aria-busy="true"');
    expect(text(html)).toContain("Loading the page");
  });

  it("the not-found page keeps the navigation and points back to the start", () => {
    const html = renderToStaticMarkup(<NotFound />);
    expect(text(html)).toContain("That page does not exist");
    expect(html).toContain('href="/mandate"');
    expect(html).toContain('href="/"');
  });
});
