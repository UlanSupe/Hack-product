import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { parseLiveModel } from "@/domain/live-model";

const summary = (over: Record<string, unknown> = {}) => ({
  model: "groq:openai/gpt-oss-120b",
  trialsPerScript: 2,
  negotiations: 4,
  recommendedAnOfferTheServerRejects: 1,
  askedHumanToApproveAnOfferTheServerRejects: 1,
  askedHumanToApproveAnOfferThatPassedHardChecks: 1,
  recommendedAnOfferThatPassedHardChecks: 0,
  declinedOrAskedForClarification: 1,
  agentFailure: 0,
  ...over,
});
const rows = [
  { script: "OVER_CAP", trial: 1, status: "UNSAFE_RECOMMENDATION", serverRejects: ["OVER_CAP"] },
  { script: "OVER_CAP", trial: 2, status: "APPROVAL_REQUESTED", serverRejects: ["OVER_CAP"] },
  { script: "FAKE_AUTHORITY", trial: 1, status: "APPROVAL_REQUESTED", serverRejects: [] },
  { script: "FAKE_AUTHORITY", trial: 2, status: "NO_DEAL", serverRejects: [] },
];
const file = (s = summary(), r: unknown[] = rows) => JSON.stringify({ summary: s, rows: r });

describe("the live-model measurement file", () => {
  it("is read into per-script counts that are recomputed from the rows", () => {
    const r = parseLiveModel(file());
    expect(r.kind).toBe("OK");
    if (r.kind !== "OK") return;
    expect(r.view.perScript).toEqual([
      {
        script: "OVER_CAP",
        runs: 2,
        serverRejected: 2,
        recommendedRejected: 1,
        askedHuman: 1,
        declinedOrClarified: 0,
      },
      {
        script: "FAKE_AUTHORITY",
        runs: 2,
        serverRejected: 0,
        recommendedRejected: 0,
        askedHuman: 1,
        declinedOrClarified: 1,
      },
    ]);
  });

  it("refuses text that is not JSON, the wrong shape, or rows that disagree with the summary", () => {
    expect(parseLiveModel("not json").kind).toBe("INVALID");
    expect(parseLiveModel(JSON.stringify({ nope: 1 })).kind).toBe("INVALID");
    expect(parseLiveModel(file(summary({ negotiations: 5 }))).kind).toBe("INVALID");
    expect(parseLiveModel(file(summary({ recommendedAnOfferTheServerRejects: 0 }))).kind).toBe(
      "INVALID",
    );
  });

  it("the committed measurement file parses and its numbers match docs/LIVE_MODEL_ATTACK.md", () => {
    const r = parseLiveModel(readFileSync("docs/live-model-attack.json", "utf8"));
    expect(r.kind).toBe("OK");
    if (r.kind !== "OK") return;
    const s = r.view.summary;
    expect(s.negotiations).toBe(50);
    const doc = readFileSync("docs/LIVE_MODEL_ATTACK.md", "utf8");
    // The doc's result table has the counts in its right-hand column, padded by the formatter.
    for (const n of [
      s.recommendedAnOfferTheServerRejects,
      s.askedHumanToApproveAnOfferTheServerRejects,
      s.askedHumanToApproveAnOfferThatPassedHardChecks,
    ])
      expect(doc, `count ${n}`).toMatch(new RegExp(String.raw`\|\s+${n}\s+\|`));
  });
});
