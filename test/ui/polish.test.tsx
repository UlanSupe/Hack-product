import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { formatMinor, formatMoney } from "@/domain/mandate";
import { STATE_STYLE, StateNote, type StateKind } from "@/app/_ui/state-note";
import { Explainer, PageHead } from "@/app/_ui/page-head";
import { PolicyBox } from "@/app/negotiations/views";
import type { PolicyExplanation } from "@/application/negotiation-policy";

const text = (html: string) =>
  html
    .replace(/<[^>]+>/g, " ")
    .replace(/&#x27;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();

function files(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) files(p, out);
    else if (/\.(tsx?|css)$/.test(name)) out.push(p.replaceAll("\\", "/"));
  }
  return out;
}

describe("one vocabulary for empty, loading, pending, denied, failed and completed", () => {
  const kinds: StateKind[] = ["loading", "empty", "pending", "denied", "failed", "done"];

  it("each state has its own word, symbol and colour, so no two look alike", () => {
    const labels = kinds.map((k) => STATE_STYLE[k].label);
    const icons = kinds.map((k) => STATE_STYLE[k].icon);
    expect(new Set(labels).size).toBe(kinds.length);
    expect(new Set(icons).size).toBe(kinds.length);
    expect(labels).toEqual(["Loading", "Nothing yet", "Pending", "Denied", "Failed", "Completed"]);
  });

  it("only a failure is announced as an alert; the rest are polite status messages", () => {
    for (const k of kinds) {
      const html = renderToStaticMarkup(<StateNote kind={k} title="Title" />);
      expect(html, k).toContain(`role="${k === "failed" ? "alert" : "status"}"`);
      expect(html).toContain(STATE_STYLE[k].label);
      expect(html).toContain(`statenote--${k}`);
    }
    expect(renderToStaticMarkup(<StateNote kind="loading" title="x" />)).toContain(
      'aria-busy="true"',
    );
  });

  it("a denial is the protection working (blue), never drawn as a fault (red)", () => {
    expect(STATE_STYLE.denied.tone).toBe("info");
    expect(STATE_STYLE.failed.tone).toBe("danger");
    expect(STATE_STYLE.done.tone).toBe("success");
    expect(STATE_STYLE.pending.tone).toBe("warning");
  });

  it("renders its title, body and actions", () => {
    const t = text(
      renderToStaticMarkup(
        <StateNote kind="empty" title="No negotiation selected" actions={<button>Go</button>}>
          Choose one.
        </StateNote>,
      ),
    );
    expect(t).toContain("Nothing yet");
    expect(t).toContain("No negotiation selected");
    expect(t).toContain("Choose one.");
    expect(t).toContain("Go");
  });
});

describe("a refusal explains itself concisely and consistently", () => {
  const policy: PolicyExplanation = {
    verdict: "DENY",
    headline: "Policy check refused accepting this offer for 1 reason.",
    items: [
      {
        code: "OVER_PER_TX_CAP",
        title: "Over the per-transaction limit",
        detail: "The total is more than the largest single payment your mandate allows.",
        next: "Negotiate a lower total.",
      },
    ],
    policyVersion: "pactpay-policy/1.1.0",
    reasonCodes: ["OVER_PER_TX_CAP"],
    approvalRequirement: null,
    decidedAt: "2026-11-05T10:00:00.000Z",
    source: "RECORDED",
  };
  const html = renderToStaticMarkup(<PolicyBox policy={policy} />);

  it("leads with the verdict and the headline, then the reason, its code and what to do", () => {
    const t = text(html);
    expect(t.indexOf("Refused")).toBeLessThan(t.indexOf("Policy check refused accepting"));
    expect(t.indexOf("Policy check refused accepting")).toBeLessThan(
      t.indexOf("Over the per-transaction limit"),
    );
    expect(t).toContain("(OVER_PER_TX_CAP)");
    expect(t).toContain("What you can do: Negotiate a lower total.");
    expect(t).toContain("Recorded policy check, pactpay-policy/1.1.0");
  });

  it("uses the product's 'blocked' colour, not the error colour", () => {
    expect(html).toContain("chip--info");
    expect(html).toContain("explain--deny");
    expect(html).not.toContain("chip--danger");
  });
});

describe("page structure", () => {
  it("every page has one visible title: no screen-reader-only h1 is left", () => {
    const hidden = files("src/app").filter((f) =>
      /<h1[^>]*className="sr-only"/.test(readFileSync(f, "utf8")),
    );
    expect(hidden).toEqual([]);
  });

  it("the page head is a single h1 with the lead beneath it", () => {
    const html = renderToStaticMarkup(<PageHead title="Negotiations" lead="Submit a task." />);
    expect(html.match(/<h1/g)).toHaveLength(1);
    expect(text(html)).toBe("Negotiations Submit a task.");
  });

  it("details on demand keep the full text in the page, closed by default", () => {
    const html = renderToStaticMarkup(
      <Explainer summary="How it works">
        <p>The whole explanation.</p>
      </Explainer>,
    );
    expect(html).toContain("<details");
    expect(html).not.toContain("<details open");
    expect(text(html)).toContain("The whole explanation.");
  });
});

describe("nothing on screen is invented", () => {
  const SOURCE = files("src/app").filter((f) => f.endsWith(".tsx") || f.endsWith(".ts"));

  it("no rating, score, success-rate or similar decoration exists in the interface code", () => {
    const banned =
      /risk score|trust score|reputation score|\brating\b|\bstars?\b|success rate|uptime|\bavg\.|average (order|basket|volume)/i;
    const hits = SOURCE.filter((f) => banned.test(readFileSync(f, "utf8")));
    expect(hits).toEqual([]);
  });

  it("example and simulated content is labelled where it is shown", () => {
    const start = readFileSync("src/app/page.tsx", "utf8");
    expect(start).toContain("Fixture task");
    expect(start).toContain("Simulation");
    const arena = readFileSync("src/app/_arena/experiment-panels.tsx", "utf8");
    expect(arena).toContain("SIMULATED LEDGER ONLY");
    expect(arena).toContain("UNSAFE BY DESIGN");
  });

  it("amounts are formatted from integer minor units, never by dividing a float", () => {
    const offenders = files("src")
      .filter((f) => !f.includes(".test."))
      .filter((f) => /\/\s*100\)?\.toFixed\(/.test(readFileSync(f, "utf8")));
    expect(offenders).toEqual([]);
  });
});

describe("monetary formatting", () => {
  it("shows two decimals and the currency code, from integers", () => {
    expect(formatMoney(0, "USD")).toBe("0.00 USD");
    expect(formatMoney(5, "USD")).toBe("0.05 USD");
    expect(formatMoney(45_000, "USD")).toBe("450.00 USD");
    expect(formatMoney(12_345, "EUR")).toBe("123.45 EUR");
  });

  it("respects a currency with no minor unit", () => {
    expect(formatMoney(1_500, "JPY")).toBe("1500 JPY");
    expect(formatMoney(0, "JPY")).toBe("0 JPY");
  });

  it("is exact for very large amounts, where dividing a float is off by a cent", () => {
    const n = 9_007_199_254_740_001; // a safe integer
    expect(formatMoney(n, "USD")).toBe("90071992547400.01 USD");
    expect((n / 100).toFixed(2)).toBe("90071992547400.02"); // the float path is wrong here
    expect(formatMinor(n, "USD")).toBe("90071992547400.01");
  });

  it("shows a shortfall with a sign, and refuses amounts that are not integers", () => {
    expect(formatMoney(-250, "USD")).toBe("-2.50 USD");
    expect(() => formatMoney(1.5, "USD")).toThrow(RangeError);
    expect(() => formatMoney(Number.NaN, "USD")).toThrow(RangeError);
  });

  it("shows an unlisted currency with two decimals rather than guessing", () => {
    expect(formatMoney(1_234, "CHF")).toBe("12.34 CHF");
  });
});

describe("the stylesheet keeps its accessibility and responsive contract", () => {
  const css = readFileSync("src/app/globals.css", "utf8");

  it("has a visible keyboard focus ring, a skip link, reduced-motion and forced-colours rules", () => {
    expect(css).toMatch(/:focus-visible\s*{[^}]*outline:\s*2px solid var\(--focus\)/);
    expect(css).toMatch(/\.skip:focus/);
    expect(css).toMatch(/prefers-reduced-motion:\s*reduce/);
    expect(css).toMatch(/forced-colors:\s*active/);
  });

  it("sizes touch targets for coarse pointers and tightens the layout on small screens", () => {
    expect(css).toMatch(/pointer:\s*coarse/);
    expect(css).toMatch(/max-width:\s*640px/);
  });

  it("lets grids shrink to the screen instead of forcing sideways scrolling", () => {
    expect(css).toMatch(/\.card\s*{\s*grid-template-columns:\s*minmax\(0,\s*1fr\)/);
    expect(css).toMatch(/\.tablewrap\s*{[^}]*overflow-x:\s*auto/);
  });

  it("sets tabular figures so amounts and dates line up", () => {
    expect(css).toMatch(/font-variant-numeric:\s*tabular-nums/);
  });

  it("the two buyers differ by pattern as well as colour (hazard stripes versus a solid bar)", () => {
    expect(css).toMatch(/\.pane--baseline::before\s*{[^}]*repeating-linear-gradient/);
    expect(css).toMatch(/\.pane--protected::before\s*{[^}]*background:\s*var\(--success\)/);
  });
});
