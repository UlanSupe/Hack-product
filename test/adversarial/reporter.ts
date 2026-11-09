import type { Reporter, TestCase, TestModule } from "vitest/node";

import { LIMITATION_TAG } from "./types";

/**
 * `npm run adversarial` prints this instead of vitest's per-test list: pass/fail per attack category, then every
 * failure with the one command that reproduces it. It reads the category from the describe() name and the scenario
 * id from the start of the test name, and it counts scenarios marked "[KNOWN LIMITATION]" separately: they pass
 * because the product behaves as documented, which is not the same as "the attack is fully prevented".
 */
type Row = { total: number; passed: number; failed: number; skipped: number; limits: number };

export default class CategoryReporter implements Reporter {
  onTestRunEnd(testModules: ReadonlyArray<TestModule>): void {
    const rows = new Map<string, Row>();
    const failures: { id: string; message: string }[] = [];
    let other = 0;

    for (const mod of testModules) {
      for (const test of mod.children.allTests() as Iterable<TestCase>) {
        const parent = test.parent;
        const group = parent.type === "suite" ? parent.name : "(file level)";
        const isScenario = /^[A-Z]+-\d+ /.test(test.name);
        if (!isScenario) {
          other += 1;
          const r = test.result();
          if (r.state === "failed")
            failures.push({ id: test.name, message: r.errors?.[0]?.message ?? "failed" });
          continue;
        }
        const row = rows.get(group) ?? { total: 0, passed: 0, failed: 0, skipped: 0, limits: 0 };
        rows.set(group, row);
        row.total += 1;
        if (test.name.includes(LIMITATION_TAG)) row.limits += 1;
        const result = test.result();
        if (result.state === "passed") row.passed += 1;
        else if (result.state === "failed") {
          row.failed += 1;
          failures.push({
            id: test.name.split(" ")[0] ?? test.name,
            message: result.errors?.[0]?.message ?? "failed",
          });
        } else row.skipped += 1;
      }
    }

    const names = [...rows.keys()];
    const width = Math.max(8, ...names.map((n) => n.length));
    const pad = (s: string | number, n: number) => String(s).padStart(n);
    const out: string[] = [];
    out.push("");
    out.push("PactPay adversarial suite: deterministic scenarios against the real policy engine,");
    out.push(
      "services and database, with a scripted fake PayPal (no real or sandbox payment account).",
    );
    out.push("");
    out.push(
      `${"CATEGORY".padEnd(width)}  ${pad("SCENARIOS", 9)}  ${pad("PASSED", 6)}  ${pad("FAILED", 6)}  ${pad("KNOWN LIMITS", 12)}`,
    );
    const sum: Row = { total: 0, passed: 0, failed: 0, skipped: 0, limits: 0 };
    for (const name of names) {
      const r = rows.get(name) as Row;
      out.push(
        `${name.padEnd(width)}  ${pad(r.total, 9)}  ${pad(r.passed, 6)}  ${pad(r.failed, 6)}  ${pad(r.limits, 12)}`,
      );
      for (const k of Object.keys(sum) as (keyof Row)[]) sum[k] += r[k];
    }
    out.push(
      `${"TOTAL".padEnd(width)}  ${pad(sum.total, 9)}  ${pad(sum.passed, 6)}  ${pad(sum.failed, 6)}  ${pad(sum.limits, 12)}`,
    );
    if (sum.skipped > 0) out.push(`(${sum.skipped} scenario(s) were filtered out of this run)`);
    out.push(`Suite integrity checks (determinism, isolation, catalog): ${other} test(s) run.`);
    if (sum.limits > 0)
      out.push(
        `"Known limits" are scenarios where the product behaves as documented but does not fully prevent the attack by itself; see docs/ADVERSARIAL_SUITE.md.`,
      );
    if (failures.length > 0) {
      out.push("");
      out.push("FAILURES");
      for (const f of failures)
        out.push(
          f.message
            .split("\n")
            .map((l) => `  ${l}`)
            .join("\n"),
        );
      out.push("");
      out.push(
        "Re-run one scenario: npm run adversarial -- -t <ID>    one category: npm run adversarial -- -t <CATEGORY>",
      );
    } else if (sum.total > 0) {
      out.push("");
      out.push("All selected scenarios behaved as specified.");
    }
    out.push("");
    process.stdout.write(out.join("\n"));
  }
}
