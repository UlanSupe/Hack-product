import { describe, expect, it } from "vitest";

import {
  correctiveText,
  execute,
  resolveRuntime,
  type AttemptContext,
  type AttemptResult,
  type RuntimeEvent,
} from "@/agents/runtime";
import { TransportError } from "@/ports/model-transport";

import { manualClock } from "./helpers";

const OK = (value: string): AttemptResult<string> => ({ ok: true, value });
const FAIL = (
  kind: Extract<AttemptResult<string>, { ok: false }>["kind"],
  retry: "NO" | "BACKOFF" | "CORRECTIVE",
  issues: string[] = [],
): AttemptResult<string> => ({ ok: false, kind, retry, message: `${kind} happened`, issues });

const opts = (over = {}) =>
  resolveRuntime({
    timeoutMs: 100,
    maxAttempts: 3,
    backoffBaseMs: 250,
    backoffMaxMs: 2000,
    ...over,
  });

describe("resolveRuntime clamps every setting into hard limits", () => {
  it("applies defaults", () => {
    expect(resolveRuntime()).toEqual({
      timeoutMs: 15_000,
      maxAttempts: 3,
      totalDeadlineMs: 45_000,
      backoffBaseMs: 250,
      backoffMaxMs: 2_000,
    });
  });
  it.each([
    [{ maxAttempts: 99 }, "maxAttempts", 5],
    [{ maxAttempts: 0 }, "maxAttempts", 1],
    [{ maxAttempts: -4 }, "maxAttempts", 1],
    [{ maxAttempts: 2.9 }, "maxAttempts", 2],
    [{ maxAttempts: NaN }, "maxAttempts", 3],
    [{ maxAttempts: Infinity }, "maxAttempts", 3],
    [{ maxAttempts: "9" as unknown as number }, "maxAttempts", 3],
    [{ timeoutMs: 1 }, "timeoutMs", 100],
    [{ timeoutMs: 10 ** 9 }, "timeoutMs", 120_000],
    [{ totalDeadlineMs: 10 ** 12 }, "totalDeadlineMs", 600_000],
    [{ backoffMaxMs: 10 ** 9 }, "backoffMaxMs", 60_000],
    [{ backoffBaseMs: -5 }, "backoffBaseMs", 0],
  ])("%j", (input, key, expected) => {
    expect(resolveRuntime(input)[key as keyof ReturnType<typeof resolveRuntime>]).toBe(expected);
  });
});

describe("execute: success, retry and bounds", () => {
  it("returns the value on the first attempt without waiting", async () => {
    const clock = manualClock();
    const r = await execute(() => Promise.resolve(OK("fine")), opts(), { clock });
    expect(r).toEqual({ ok: true, value: "fine", attempts: 1 });
    expect(clock.slept).toEqual([]);
  });

  it("retries retryable failures with exponential, capped backoff, then succeeds", async () => {
    const clock = manualClock();
    let n = 0;
    const r = await execute(
      () => Promise.resolve(++n < 4 ? FAIL("TRANSPORT", "BACKOFF") : OK("late")),
      opts({ maxAttempts: 5, backoffBaseMs: 100, backoffMaxMs: 250 }),
      { clock },
    );
    expect(r).toEqual({ ok: true, value: "late", attempts: 4 });
    expect(clock.slept).toEqual([100, 200, 250]);
  });

  it("never makes more attempts than the cap, whatever happens", async () => {
    for (const max of [1, 2, 3, 5]) {
      let calls = 0;
      const r = await execute(
        () => {
          calls++;
          return Promise.resolve(FAIL("TRANSPORT", "BACKOFF"));
        },
        opts({ maxAttempts: max }),
        { clock: manualClock() },
      );
      expect(calls).toBe(max);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.failure.attempts).toBe(max);
    }
  });

  it("does not retry when told not to (refusal-style failures)", async () => {
    let calls = 0;
    const r = await execute(
      () => {
        calls++;
        return Promise.resolve(FAIL("REFUSED", "NO"));
      },
      opts(),
      { clock: manualClock() },
    );
    expect(calls).toBe(1);
    expect(r.ok === false && r.failure.kind).toBe("REFUSED");
  });

  it("gives an invalid reply exactly one corrective re-ask, carrying our own description of the problem", async () => {
    const seen: (string | null)[] = [];
    const clock = manualClock();
    const r = await execute(
      (ctx: AttemptContext) => {
        seen.push(ctx.corrective);
        return Promise.resolve(FAIL("MALFORMED", "CORRECTIVE", ["offerId: wrong"]));
      },
      opts({ maxAttempts: 5 }),
      { clock },
    );
    expect(seen).toHaveLength(2);
    expect(seen[0]).toBeNull();
    expect(seen[1]).toBe(correctiveText(["offerId: wrong"]));
    expect(seen[1]).toContain("offerId: wrong");
    expect(clock.slept).toEqual([]); // re-asked at once
    expect(r.ok === false && r.failure.kind).toBe("MALFORMED");
  });

  it("a corrective retry that succeeds is reported with both attempts", async () => {
    let n = 0;
    const r = await execute(
      () => Promise.resolve(++n === 1 ? FAIL("MALFORMED", "CORRECTIVE", ["x"]) : OK("fixed")),
      opts(),
      { clock: manualClock() },
    );
    expect(r).toEqual({ ok: true, value: "fixed", attempts: 2 });
  });

  it("reports each attempt to the observer without any content", async () => {
    const events: RuntimeEvent[] = [];
    let n = 0;
    await execute(
      () => Promise.resolve(++n === 1 ? FAIL("TRANSPORT", "BACKOFF") : OK("x")),
      opts(),
      { clock: manualClock(), onEvent: (e) => events.push(e) },
    );
    expect(events.map((e) => [e.attempt, e.outcome])).toEqual([
      [1, "TRANSPORT"],
      [2, "OK"],
    ]);
    expect(JSON.stringify(events)).not.toContain("happened");
  });
});

describe("execute: timeouts", () => {
  it("times out an attempt that never answers, aborts its signal, and reports TIMEOUT after the allowed attempts", async () => {
    let aborted = 0;
    const clock = manualClock();
    const r = await execute(
      (ctx) =>
        new Promise<AttemptResult<string>>(() => {
          ctx.signal.addEventListener("abort", () => aborted++);
        }),
      opts({ maxAttempts: 2 }),
      { clock },
    );
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.failure.kind).toBe("TIMEOUT");
      expect(r.failure.attempts).toBe(2);
      expect(r.failure.message).toContain("100 ms");
    }
    expect(aborted).toBe(2);
    expect(clock.slept).toEqual([250]);
  });

  it("is not held hostage by an attempt that ignores its abort signal and answers late", async () => {
    const t0 = Date.now();
    const r = await execute(
      () =>
        new Promise<AttemptResult<string>>((resolve) =>
          setTimeout(() => resolve(OK("too late")), 400),
        ),
      opts({ maxAttempts: 1 }),
      { clock: manualClock() },
    );
    expect(r.ok === false && r.failure.kind).toBe("TIMEOUT");
    expect(Date.now() - t0).toBeLessThan(350);
    await new Promise((r2) => setTimeout(r2, 450)); // the late answer arrives; nothing must blow up
  });

  it("a late rejection after a timeout does not become an unhandled rejection", async () => {
    const seen: unknown[] = [];
    const onUnhandled = (e: unknown) => seen.push(e);
    process.on("unhandledRejection", onUnhandled);
    try {
      await execute(
        () =>
          new Promise<AttemptResult<string>>((_res, rej) =>
            setTimeout(() => rej(new Error("late boom")), 250),
          ),
        opts({ maxAttempts: 1 }),
        { clock: manualClock() },
      );
      await new Promise((r) => setTimeout(r, 400));
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
    expect(seen).toEqual([]);
  });

  it("honours the overall deadline: no attempt starts that cannot finish, and the last failure is reported", async () => {
    const clock = manualClock();
    let calls = 0;
    const r = await execute(
      () => {
        calls++;
        clock.advance(30_000);
        return Promise.resolve(FAIL("TRANSPORT", "BACKOFF"));
      },
      opts({ maxAttempts: 5, totalDeadlineMs: 45_000, backoffBaseMs: 0 }),
      { clock },
    );
    expect(calls).toBe(2); // 30s, 60s: the deadline is gone
    expect(r.ok === false && r.failure.kind).toBe("TRANSPORT");
  });

  it("will not sleep past the deadline", async () => {
    const clock = manualClock();
    const r = await execute(
      () => {
        clock.advance(900);
        return Promise.resolve(FAIL("TRANSPORT", "BACKOFF"));
      },
      opts({ maxAttempts: 5, totalDeadlineMs: 1000, backoffBaseMs: 500, backoffMaxMs: 500 }),
      { clock },
    );
    expect(clock.slept).toEqual([]);
    expect(r.ok).toBe(false);
  });
});

describe("execute: errors are classified, contained and never leak", () => {
  it("retries retryable transport errors and gives up at once on the rest", async () => {
    for (const [kind, expectedCalls] of [
      ["RATE_LIMITED", 3],
      ["UNAVAILABLE", 3],
      ["NETWORK", 3],
      ["UNAUTHORIZED", 1],
      ["BAD_REQUEST", 1],
    ] as const) {
      let calls = 0;
      const r = await execute(
        () => {
          calls++;
          throw new TransportError(kind, "sk-ant-SECRET-KEY leaked in a message");
        },
        opts(),
        { clock: manualClock() },
      );
      expect(calls, kind).toBe(expectedCalls);
      expect(r.ok).toBe(false);
      if (!r.ok) {
        expect(r.failure.kind).toBe("TRANSPORT");
        expect(JSON.stringify(r.failure)).not.toContain("SECRET");
        expect(r.failure.message).toContain(kind);
      }
    }
  });

  it("treats any other thrown value as a retryable transport failure and never copies its text", async () => {
    for (const thrown of [
      new Error("Bearer abc.def.ghi at https://api.example/v1"),
      "a string",
      42,
      null,
      undefined,
      { secret: "x" },
    ]) {
      let calls = 0;
      const r = await execute(
        () => {
          calls++;
          // eslint-disable-next-line @typescript-eslint/only-throw-error -- the point: adapters may throw non-Errors
          throw thrown;
        },
        opts({ maxAttempts: 2 }),
        { clock: manualClock() },
      );
      expect(calls).toBe(2);
      expect(r.ok === false && r.failure.kind).toBe("TRANSPORT");
      expect(JSON.stringify(r)).not.toMatch(/Bearer|api\.example|secret/);
    }
  });

  it("sanitizes and bounds the issues it reports", async () => {
    const issues = Array.from({ length: 30 }, (_, i) => `field${i}: ${"y".repeat(500)}`);
    const r = await execute(() => Promise.resolve(FAIL("MALFORMED", "NO", issues)), opts(), {
      clock: manualClock(),
    });
    if (r.ok) throw new Error("expected failure");
    expect(r.failure.issues).toHaveLength(8);
    expect(r.failure.issues.every((i) => i.length <= 160)).toBe(true);
  });
});

describe("execute: cancellation", () => {
  it("does nothing if already cancelled", async () => {
    const ctl = new AbortController();
    ctl.abort();
    let calls = 0;
    const r = await execute(
      () => {
        calls++;
        return Promise.resolve(OK("x"));
      },
      opts(),
      { clock: manualClock(), signal: ctl.signal },
    );
    expect(calls).toBe(0);
    expect(r.ok === false && r.failure.kind).toBe("ABORTED");
    expect(r.ok === false && r.failure.attempts).toBe(0);
  });

  it("stops an attempt in flight and does not retry", async () => {
    const ctl = new AbortController();
    let calls = 0;
    const p = execute(
      () => {
        calls++;
        return new Promise<AttemptResult<string>>(() => {});
      },
      opts({ timeoutMs: 5000 }),
      { clock: manualClock(), signal: ctl.signal },
    );
    setTimeout(() => ctl.abort(), 20);
    const r = await p;
    expect(calls).toBe(1);
    expect(r.ok === false && r.failure.kind).toBe("ABORTED");
  });
});
