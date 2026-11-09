import { SCENARIOS_BY_CATEGORY } from "./fixtures";
import type { Scenario, Step } from "./types";

/**
 * Renders docs/ADVERSARIAL_CATALOG.md from the fixtures, so the documented scenarios can never drift from the ones
 * that run. Plain headings and bullets only (no tables), so the file is stable under Prettier.
 */

/** JSON, with any long string (a 300 KB webhook body, say) summarised so the catalog stays readable. */
const json = (v: unknown): string =>
  JSON.stringify(v, (_k, x: unknown) =>
    typeof x === "string" && x.length > 100 ? `${x.slice(0, 40)}... (${x.length} characters)` : x,
  );
const code = (v: unknown): string => `\`${json(v)}\``;

function step(s: Step): string {
  const { do: kind, ...rest } = s as { do: string } & Record<string, unknown>;
  const args = Object.keys(rest).length === 0 ? "" : ` ${json(rest)}`;
  return `\`${kind}${args}\``;
}

function scenario(s: Scenario): string[] {
  const out: string[] = [];
  out.push(`#### ${s.id}: ${s.title}`);
  out.push("");
  out.push(`- **Goal.** ${s.goal}`);
  if (s.limitation) out.push(`- **Known limitation.** ${s.limitation}`);
  const m = s.initial.mandate;
  out.push(
    `- **Initial state.** ${
      m ? `mandate overrides ${code(m)}; ` : "default mandate; "
    }${s.initial.paypalPayee !== undefined ? `PayPal reports payee ${code(s.initial.paypalPayee)}; ` : ""}${
      s.initial.steps.length === 0 ? "no setup steps." : "setup steps:"
    }`,
  );
  for (const x of s.initial.steps) out.push(`  - ${step(x)}`);
  out.push("- **Attack input.**");
  for (const x of s.attack) out.push(`  - ${step(x)}`);
  out.push(`- **Expected outcome of the last attack step.** ${code(s.expect.outcome)}`);
  out.push(`- **Expected transaction states.** ${code(s.expect.txStates)}`);
  out.push(
    `- **Money moved at the fake PayPal.** ${s.expect.capturedMinor ?? 0} minor units; money-moving calls: ${code(s.expect.paypalCalls ?? [])}`,
  );
  if (s.expect.audit.length === 0)
    out.push("- **Expected audit events.** none (the attack must record nothing).");
  else {
    out.push("- **Expected audit events, in order.**");
    for (const a of s.expect.audit) out.push(`  - ${code(a)}`);
  }
  if (s.expect.forbidAudit?.length)
    out.push(`- **Must not appear in the audit trail.** ${code(s.expect.forbidAudit)}`);
  if (s.expect.rows?.length) {
    out.push("- **Stored state checks.**");
    for (const r of s.expect.rows) out.push(`  - ${code(r.sql)} must equal ${code(r.equals)}`);
  }
  out.push("");
  return out;
}

export function renderCatalog(): string {
  const total = SCENARIOS_BY_CATEGORY.reduce((n, [, l]) => n + l.length, 0);
  const lines: string[] = [
    "# Adversarial scenario catalog",
    "",
    "Generated from `test/adversarial/fixtures` by `npm run adversarial:catalog`. Do not edit by hand: a test fails when this file and the fixtures disagree. How the suite works, what it proves and what it does not: [ADVERSARIAL_SUITE.md](ADVERSARIAL_SUITE.md).",
    "",
    `${total} scenarios in ${SCENARIOS_BY_CATEGORY.length} attack categories. Amounts are minor units (cents). Default world: mandate \`M1\` allows COMPUTE from \`seller_acme\` and \`seller_other\`, caps one transaction at 10000, the total at 15000, and asks for a human approval above 5000; \`GPU-PACK\` sells at 8000 (acme) and 7500 (other).`,
    "",
  ];
  for (const [category, list] of SCENARIOS_BY_CATEGORY) {
    lines.push(`## ${category} (${list.length})`, "");
    for (const s of list) lines.push(...scenario(s));
  }
  return (
    lines
      .join("\n")
      .replace(/\n{3,}/g, "\n\n")
      .trimEnd() + "\n"
  );
}
