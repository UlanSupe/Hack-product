import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { SCENARIOS_BY_CATEGORY } from "./fixtures";
import { LIMITATION_TAG } from "./types";
import { runScenario } from "./run";

/**
 * The adversarial suite: every scenario fixture, run against the real services on an in-memory database and a
 * scripted fake PayPal. Run it with `npm run adversarial` (a pass/fail table per attack category); re-run one
 * scenario or one category with `npm run adversarial -- -t HOOK-07` or `-- -t WEBHOOK_FORGERY`.
 *
 * The network is trapped for the whole file: a single call to fetch fails the run, so nothing here can reach a
 * payment account, real or sandbox.
 */

const fetchTrap = vi.fn(() => {
  throw new Error("adversarial suite: network access is forbidden");
});

beforeAll(() => {
  vi.stubGlobal("fetch", fetchTrap);
});
afterAll(() => {
  expect(fetchTrap).not.toHaveBeenCalled();
  vi.unstubAllGlobals();
});

for (const [category, scenarios] of SCENARIOS_BY_CATEGORY) {
  describe(category, () => {
    for (const s of scenarios) {
      it(`${s.id} ${s.title}${s.limitation ? ` ${LIMITATION_TAG}` : ""}`, async () => {
        const result = await runScenario(s);
        if (!result.pass) {
          expect.fail(
            [
              `${s.id} FAILED: ${s.title}`,
              `  goal: ${s.goal}`,
              ...result.failures.map((f) => `  - ${f}`),
              `  reproduce: npm run adversarial -- -t ${s.id}`,
            ].join("\n"),
          );
        }
        expect(result.failures).toEqual([]);
      });
    }
  });
}
