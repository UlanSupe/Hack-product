import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { AGENT_RUNTIME_LIMITS } from "@/domain/agent-contract";
import {
  AGREEMENT_STATUSES,
  CHANGE_KINDS,
  NEGOTIATION_STATUSES,
  PROPOSAL_STATUSES,
} from "@/domain/negotiation";
import { AGENT_FAILURES } from "@/ports/agents";

const negotiation = readFileSync("docs/NEGOTIATION.md", "utf8");
const agents = readFileSync("docs/AGENTS.md", "utf8");

describe("the docs name everything the code defines", () => {
  it("NEGOTIATION.md mentions every status and every kind of change", () => {
    for (const word of [
      ...NEGOTIATION_STATUSES,
      ...PROPOSAL_STATUSES,
      ...AGREEMENT_STATUSES,
      ...CHANGE_KINDS,
    ]) {
      expect(negotiation, word).toContain(word);
    }
  });

  it("AGENTS.md mentions every failure kind", () => {
    for (const kind of AGENT_FAILURES) expect(agents, kind).toContain(kind);
  });

  it("AGENTS.md states the real runtime limits", () => {
    const L = AGENT_RUNTIME_LIMITS;
    expect(agents).toContain(`${L.maxOutputChars.toLocaleString("en-US")} characters`);
    expect(agents).toMatch(new RegExp(`${L.maxAttempts.min} – ${L.maxAttempts.max}`));
    expect(agents).toMatch(new RegExp(`${L.maxRounds.min} – ${L.maxRounds.max}`));
    expect(agents).toContain("AGENT_TIMEOUT_MS");
    expect(agents).toContain("AGENT_MAX_ATTEMPTS");
  });

  it("both documents say, plainly, what has not been verified", () => {
    expect(agents).toMatch(/never calls a real model/);
    expect(negotiation).toMatch(/Sellers are not authenticated/);
    expect(negotiation).toMatch(/Nothing here talks to PayPal/);
  });
});
