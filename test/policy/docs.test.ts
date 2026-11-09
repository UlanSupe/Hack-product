import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { POLICY_SUBJECTS, POLICY_VERSION, REASON_CODES } from "@/domain/policy";
import { TX_STATES } from "@/domain/transaction-states";

const doc = readFileSync("docs/POLICY_ENGINE.md", "utf8");
const between = (from: string, to: string) => doc.split(from)[1]?.split(to)[0] ?? "";

describe("docs/POLICY_ENGINE.md stays in step with the code", () => {
  const rows = [
    ...between("## 5. Reason codes", "## 6.").matchAll(/^\| `([A-Z_]+)` +\| (.+?) +\|$/gm),
  ];

  it("lists exactly the reason codes the engine defines, with the same wording", () => {
    expect(rows.map((m) => m[1]).sort()).toEqual(Object.keys(REASON_CODES).sort());
    for (const m of rows) {
      expect(m[2], m[1]).toBe(REASON_CODES[m[1] as keyof typeof REASON_CODES]);
    }
  });

  it("names the current policy version", () => {
    expect(doc).toContain(POLICY_VERSION);
  });

  it("every reason code named in the rules section exists", () => {
    const notCodes = new Set<string>([
      "REJECTED",
      "APPROVED",
      "NOT_REQUIRED",
      ...POLICY_SUBJECTS,
      ...TX_STATES,
    ]);
    const named = [...between("## 4. Rules", "## 5.").matchAll(/`([A-Z][A-Z_]*[A-Z])`/g)]
      .map((m) => m[1] as string)
      .filter((c) => !notCodes.has(c));
    expect(named.length).toBeGreaterThan(20);
    for (const c of named) expect(Object.keys(REASON_CODES), c).toContain(c);
  });
});
