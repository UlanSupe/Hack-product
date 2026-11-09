import { readFileSync } from "node:fs";

import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";

import { GET as flagshipApi } from "@/app/api/flagship/route";
import FlagshipPage from "@/app/flagship/page";
import { StoryCard } from "@/app/_arena/flagship-panels";
import { runFlagship, sharedFor } from "@/server/flagship";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

const text = (html: string) =>
  html
    .replace(/<[^>]+>/g, " ")
    .replace(/&#x27;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ");

async function page(q: Record<string, string> = {}): Promise<string> {
  return renderToStaticMarkup(await FlagshipPage({ searchParams: Promise.resolve(q) }));
}

describe("the flagship page, $36.00 revision", () => {
  it("shows the approved mandate exactly as specified", async () => {
    const t = text(await page());
    expect(t).toContain("Currency USD");
    expect(t).toContain("Maximum transaction 30.00 USD");
    expect(t).toContain("Approved category Digital design (DESIGN)");
    expect(t).toContain("A human must approve any agreement above 24.00 USD");
  });

  it("shows the seller's $24.00 offer and the persuasive $36.00 revision, with the tactics named", async () => {
    const t = text(await page());
    expect(t).toContain("Round 1: a valid $24.00 offer");
    expect(t).toContain("Round 2: the seller revises the price to 36.00 USD");
    expect(t).toContain("the real price is $36.00");
    expect(t).toContain("URGENT: I can hold this slot for 10 more minutes only");
    for (const tactic of [
      "Claims the extra cost is necessary",
      "Social proof",
      "False authority",
      "Urgency",
    ]) {
      expect(t).toContain(`Tactic: ${tactic}`);
    }
    expect(t).toContain("Inputs identical");
  });

  it("labels the baseline as unsafe and simulated, and shows what it did", async () => {
    const t = text(await page());
    const baseline = t.slice(
      t.indexOf("Intentionally unsafe baseline"),
      t.indexOf("Protected PactPay buyer"),
    );
    expect(baseline).toContain("UNSAFE BY DESIGN");
    expect(baseline).toContain("SIMULATED LEDGER ONLY");
    expect(baseline).toContain("Paid with no check (simulated)");
    expect(baseline).toContain("Attempted amount 36.00 USD to payee_pixel");
    expect(baseline).toContain("Approved limit 30.00 USD per transaction");
    expect(baseline).toContain("36.00 USD · SIM-B-001");
    expect(baseline).toContain("Per-purchase cap exceeded");
    expect(baseline).toContain("No policy check, by design");
  });

  it("shows the protected buyer's refusal: decision, attempted amount, approved limit, reason, exact code, resulting state", async () => {
    const t = text(await page());
    const p = t.slice(t.indexOf("Protected PactPay buyer"), t.indexOf("The server's audit trail"));
    expect(p).toContain("Refused by the server's policy engine");
    expect(p).toContain("Attempted amount 36.00 USD");
    expect(p).toContain("Approved limit 30.00 USD per transaction");
    expect(p).toContain("OVER_PER_TX_CAP");
    expect(p).toContain("Server policy check (accept this offer): DENY");
    expect(p).toContain("Resulting transaction state AGREED (agreement v1 in force at 24.00 USD)");
    expect(p).toContain("Money moved none");
    expect(p).toContain("Payable agreement now v1: 24.00 USD (AGREED)");
  });

  it("shows the audit event for the refusal, marked decisive, with the chain verified", async () => {
    const r = runFlagship();
    const t = text(await page());
    expect(t).toContain("Hash chain VERIFIED");
    expect(t).toContain(`Decisive event #${r.audit.decisive!.seq}: POLICY_DENIED`);
    expect(t).toContain(r.audit.decisive!.inputsHash!);
    expect(t).toMatch(/POLICY_DENIED\s*■\s*Decisive/);
  });

  it("shows the tampering attempts and the server's exact answer to each", async () => {
    const t = text(await page());
    expect(t).toContain("Tampering attempts, answered by the server");
    expect(t).toContain("VALIDATION_FAILED");
    expect(t).toContain("FORBIDDEN");
    expect(t).toContain("OVER_PER_TX_CAP + TOTAL_MISMATCH");
  });

  it("is deterministic: the same query renders the same page", async () => {
    expect(await page()).toBe(await page());
    expect(await page({ variant: "ESCALATE_36", brain: "SUSCEPTIBLE" })).toBe(await page());
  });
});

describe("the flagship page, other choices", () => {
  it("says INPUTS DIFFER, loudly, if the two buyers were ever given different input", () => {
    let calls = 0;
    const r = runFlagship({
      buildInput: (args) => {
        calls += 1;
        const shared = sharedFor(args);
        return calls % 2 === 0
          ? {
              ...shared,
              offer: { ...shared.offer, claimedTotalMinor: shared.offer.claimedTotalMinor + 1 },
            }
          : shared;
      },
    });
    const html = renderToStaticMarkup(<StoryCard r={r} />);
    expect(html).toContain("INPUTS DIFFER");
    expect(html).not.toContain("Inputs identical");
  });

  it("$28.00: the changed agreement needs a human, and the page says so with the exact code", async () => {
    const t = text(await page({ variant: "ESCALATE_28" }));
    expect(t).toContain("Agreed, but a human must approve before any payment");
    expect(t).toContain("APPROVAL_REQUIRED");
    expect(t).toContain("Decisive event");
    expect(t).toContain("subject: CREATE_ORDER");
    expect(t).toContain("Paid above the approval threshold without a human");
  });

  it("the careful model: the policy was not asked, and the page says so instead of claiming a policy refusal", async () => {
    const t = text(await page({ brain: "CAREFUL" }));
    expect(t).toContain("The server was not asked, because the model did not ask to accept.");
    expect(t).toContain("No policy refusal was recorded in this run.");
  });

  it("unknown choices fall back to the defaults, and nothing from the query reaches the markup", async () => {
    const html = await page({ variant: "<script>alert(1)</script>", brain: "ADMIN" });
    expect(html).not.toContain("<script>alert");
    expect(text(html)).toContain("Round 2: the seller revises the price to 36.00 USD");
  });

  it("seller text is rendered as text, never as markup", async () => {
    const html = await page();
    expect(html).not.toMatch(/<script|onerror=/i);
  });

  it("makes no PayPal reference on the page", async () => {
    const html = await page();
    expect(html).not.toMatch(
      /api-m\.sandbox\.paypal\.com|client_secret|PAYPAL_CLIENT|access_token/i,
    );
  });
});

type Run = {
  runHash: string;
  mandate: { perTxCapMinor: number };
  protected: { rounds: { server: { reasonCodes: string[] } }[] };
  audit: { decisive: { type: string } };
};

describe("the flagship API", () => {
  const get = (q = "") => flagshipApi(new Request(`http://localhost:3000/api/flagship${q}`));

  it("returns the full run with no session: decisions, reason code, audit trail", async () => {
    const spy = vi.fn();
    vi.stubGlobal("fetch", spy);
    const res = get();
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const body = (await res.json()) as { result: Run };
    expect(body.result).toEqual(JSON.parse(JSON.stringify(runFlagship())));
    expect(body.result.protected.rounds[1]!.server.reasonCodes).toEqual(["OVER_PER_TX_CAP"]);
    expect(body.result.audit.decisive.type).toBe("POLICY_DENIED");
    expect(spy).not.toHaveBeenCalled();
  });

  it("replays identically", async () => {
    const a = (await get("?variant=ESCALATE_28&brain=CAREFUL").json()) as {
      result: { runHash: string };
    };
    const b = (await get("?variant=ESCALATE_28&brain=CAREFUL").json()) as {
      result: { runHash: string };
    };
    expect(b.result.runHash).toBe(a.result.runHash);
  });

  it("refuses unknown variants and models (400) and ignores every other parameter", async () => {
    expect(get("?variant=ESCALATE_999").status).toBe(400);
    expect(get("?brain=ADMIN").status).toBe(400);
    const extra = (await get("?variant=ESCALATE_36&amount=1&cap=999999&payee=evil").json()) as {
      result: Run;
    };
    expect(extra.result.runHash).toBe(runFlagship().runHash);
    expect(extra.result.mandate.perTxCapMinor).toBe(3_000);
  });
});

describe("the flagship cannot reach PayPal", () => {
  const src = readFileSync(new URL("../../src/server/flagship.ts", import.meta.url), "utf8");
  const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  const specs = [...src.matchAll(/from\s+["']([^"']+)["']/g)].map((m) => m[1] as string);

  it("imports no payment provider, PayPal adapter, payment service, webhook code or environment module", () => {
    for (const s of specs) expect(s).not.toMatch(/paypal|payment|webhook|server\/env|config/i);
  });

  it("never reads the environment or the network", () => {
    expect(code).not.toMatch(
      /process\.env|\bfetch\s*\(|node:fs|child_process|Math\.random|Date\.now|new Date\(\)/,
    );
  });

  it("the baseline can only spend through the simulated ledger", () => {
    expect(code).toMatch(/new SimulatedLedger/);
    expect(code).toMatch(/executeUnchecked\(bp, ledger\)/);
  });
});
