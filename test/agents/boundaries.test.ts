import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { createMockAgents } from "@/agents";
import { MandateViewSchema } from "@/domain/agent-contract";
import { mandateViewOf } from "@/domain/offer-view";

const ROOT = process.cwd();
const AGENT_FILES = readdirSync(join(ROOT, "src/agents"))
  .filter((f) => f.endsWith(".ts"))
  .map((f) => join(ROOT, "src/agents", f));
const PORT_FILES = ["agents.ts", "model-transport.ts"].map((f) => join(ROOT, "src/ports", f));

const importsOf = (file: string): string[] =>
  [...readFileSync(file, "utf8").matchAll(/^\s*(?:import|export)\s[^;]*?from\s+"([^"]+)"/gm)].map(
    (m) => m[1] as string,
  );

const code = (file: string): string =>
  readFileSync(file, "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1")
    .replace(/`(?:\\[\s\S]|[^`\\])*`/g, "``")
    .replace(/"(?:\\.|[^"\\\n])*"/g, '""');

describe("the agent layer's reach", () => {
  it("imports only zod, its own files, domain/ and ports/", () => {
    expect(AGENT_FILES.length).toBeGreaterThanOrEqual(10);
    for (const file of AGENT_FILES) {
      for (const spec of importsOf(file)) {
        const ok =
          spec === "zod" ||
          spec.startsWith("./") ||
          spec.startsWith("../domain/") ||
          spec.startsWith("../ports/");
        expect(ok, `${file} imports ${spec}`).toBe(true);
      }
    }
  });

  it("the ports it implements import only domain/", () => {
    for (const file of PORT_FILES) {
      for (const spec of importsOf(file))
        expect(spec.startsWith("../domain/"), `${file} imports ${spec}`).toBe(true);
    }
  });

  it("every file it reaches through relative imports stays inside domain/, ports/ or agents/", () => {
    const seen = new Set<string>();
    const queue = [...AGENT_FILES];
    while (queue.length > 0) {
      const file = queue.pop() as string;
      if (seen.has(file)) continue;
      seen.add(file);
      for (const spec of importsOf(file))
        if (spec.startsWith(".")) queue.push(resolve(dirname(file), spec));
    }
    for (const file of seen)
      expect(file.replaceAll("\\", "/")).toMatch(/\/src\/(agents|domain|ports)\//);
  });

  it("names nothing that moves money, changes a mandate, or decides policy", () => {
    const FORBIDDEN =
      /\b(ActionGateway|AuthorizedAction|PaymentProvider|createMandateService|requireOperator|approveDraft|revokeMandate|updateDraft|insertMandateVersion|evaluatePolicy|recordPolicyDecision|startPaymentAttempt|transitionTransaction|fetch|XMLHttpRequest|process\.env)\b/;
    for (const file of [...AGENT_FILES, ...PORT_FILES]) {
      const hit = FORBIDDEN.exec(code(file));
      expect(hit?.[0], `${file} mentions ${hit?.[0]}`).toBeUndefined();
    }
  });

  it("contains no dynamic code execution", () => {
    for (const file of AGENT_FILES) {
      expect(code(file), file).not.toMatch(/\beval\s*\(|new Function|\bimport\s*\(|\brequire\s*\(/);
    }
  });
});

describe("the agent interfaces expose proposals only", () => {
  it("a buyer can interpret and compare; nothing else", () => {
    expect(Object.keys(createMockAgents().buyer).sort()).toEqual(["compare", "interpret", "name"]);
  });

  it("a seller can open, counter and answer; nothing else", () => {
    expect(Object.keys(createMockAgents().seller).sort()).toEqual([
      "answer",
      "counter",
      "name",
      "open",
    ]);
  });

  it("neither exposes anything resembling approval, mandate, capture, payment or policy", () => {
    const { buyer, seller } = createMockAgents();
    for (const key of [...Object.keys(buyer), ...Object.keys(seller)]) {
      expect(key).not.toMatch(
        /approve|mandate|capture|authori[sz]e|release|void|pay|policy|execute|override/i,
      );
    }
  });

  it("the mandate an agent is shown is a copy: editing it cannot change the approved terms", () => {
    const terms = {
      currency: "USD" as const,
      totalBudgetMinor: 15_000,
      maxTransactionMinor: 10_000,
      approvalThresholdMinor: 5_000,
      allowedCategories: ["COMPUTE" as const],
      allowedSellerIds: ["seller_a"],
      requireReviewBeforeExecution: false,
      validDays: 30,
    };
    const shown = mandateViewOf(terms, 1234);
    shown.maxTransactionMinor = 999_999_999;
    shown.allowedCategories.push("DESIGN");
    expect(terms.maxTransactionMinor).toBe(10_000);
    expect(terms.allowedCategories).toEqual(["COMPUTE"]);
    expect(Object.keys(mandateViewOf(terms, 1)).sort()).toEqual(
      Object.keys(MandateViewSchema.shape).sort(),
    );
  });
});
