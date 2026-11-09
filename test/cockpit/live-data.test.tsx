/* eslint-disable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-argument -- reads untyped API JSON */
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { openDatabase } from "@/adapters/sqlite/database";
import { loadMigrations, migrate } from "@/adapters/sqlite/migrate";
import { POST as acceptProposal } from "@/app/api/negotiations/[id]/proposals/[pid]/accept/route";
import { POST as postOffer } from "@/app/api/negotiations/[id]/offers/route";
import { POST as openNegotiation } from "@/app/api/negotiations/route";
import { GET as cockpitApi } from "@/app/api/cockpit/route";
import CockpitPage from "@/app/cockpit/page";
import CockpitRowPage from "@/app/cockpit/[id]/page";
import { IdLink } from "@/app/cockpit/columns";
import { detailHref, type CockpitRow } from "@/domain/cockpit";

import { runBenchmark } from "../benchmark/benchmark";
import {
  agree,
  bodyOf,
  boot,
  idCtx,
  propCtx,
  request,
  signIn,
  type Session,
} from "../payments/api-harness";

/** The Cockpit against a REAL database file (migrated, seeded, driven through the real API routes) and a real benchmark file. */

const h = vi.hoisted(() => ({ current: new Headers() }));
vi.mock("next/headers", () => ({ headers: () => Promise.resolve(h.current) }));

let benchmarkText = "";
let cwdDir = "";

beforeAll(async () => {
  benchmarkText = JSON.stringify(await runBenchmark({ seed: 5, perFamily: 1 }));
}, 120_000);

beforeEach(() => {
  cwdDir = mkdtempSync(join(tmpdir(), "pactpay-cockpit-"));
  vi.spyOn(process, "cwd").mockReturnValue(cwdDir);
  h.current = new Headers();
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

const putBenchmark = (text = benchmarkText) => {
  mkdirSync(join(cwdDir, "benchmark-results"), { recursive: true });
  writeFileSync(join(cwdDir, "benchmark-results", "benchmark.json"), text);
};

const get = async (s?: Session, query = "", extra: Record<string, string> = {}) => {
  const res = cockpitApi(
    request("GET", `/api/cockpit${query}`, { ...(s ? { s } : {}), headers: extra }),
  );
  return { status: res.status, body: await bodyOf(res) };
};

/** Another negotiation whose single offer is 450.00: the policy engine must refuse to accept it. */
async function refuseAnOffer(s: Session): Promise<string> {
  const neg = (
    await bodyOf(
      await openNegotiation(
        request("POST", "/api/negotiations", {
          s,
          body: {
            mandateId: "M1",
            category: "COMPUTE",
            quantity: 1,
            summary: "Too much",
            maxTotal: null,
            neededWithinDays: null,
            requiredDeliverables: [],
            invitedSellerIds: ["seller_acme"],
            timeoutMinutes: 60,
          },
        }),
      ),
    )
  ).negotiation;
  const proposal = (
    await bodyOf(
      await postOffer(
        request("POST", "/x", {
          s,
          body: {
            sellerId: "seller_acme",
            offer: {
              currency: "USD",
              lines: [{ sku: "GPU-PACK", qty: 1, unitPriceMinor: 45_000 }],
              shippingMinor: 0,
              feesMinor: 0,
              claimedTotalMinor: 45_000,
              category: "COMPUTE",
              deliveryDays: 3,
              deliverables: ["80 GPU-hours"],
              termsText: "Fixed.",
              validForMinutes: 30,
            },
          },
        }),
        idCtx(neg.id),
      ),
    )
  ).proposal;
  const accepted = await bodyOf(
    await acceptProposal(request("POST", "/x", { s, body: {} }), propCtx(neg.id, proposal.id)),
  );
  expect(accepted.outcome.accepted).toBe(false);
  return neg.id as string;
}

describe("database rows", () => {
  it("shows an agreed transaction and a refused offer, each from its stored records", async () => {
    boot();
    putBenchmark();
    const s = await signIn();
    const agreedNeg = await agree(s);
    const refusedNeg = await refuseAnOffer(s);

    const { status, body } = await get(s);
    expect(status).toBe(200);
    expect(body.sources.database).toMatchObject({ state: "OK" });
    const rows = body.rows as CockpitRow[];

    const t = rows.find((r) => r.source === "TRANSACTION");
    expect(t).toMatchObject({
      scenario: agreedNeg,
      category: "COMPUTE",
      buyerMode: "PROTECTED",
      currency: "USD",
      proposedMinor: 8_000,
      approvedMinor: 8_000,
      decision: "ALLOWED",
      paymentStatus: "AGREED",
      verification: "NOT_APPLICABLE",
      auditChain: "VERIFIED",
    });
    expect(t?.refId).toMatch(/^tx_/);
    expect(typeof t?.timestamp).toBe("string");

    const r = rows.find((x) => x.source === "REFUSED_OFFER");
    expect(r).toMatchObject({
      scenario: refusedNeg,
      proposedMinor: 45_000,
      approvedMinor: null,
      decision: "DENIED",
      reasonSource: "POLICY",
      paymentStatus: "NO_TRANSACTION",
      auditChain: "VERIFIED",
    });
    expect(r?.reasonCodes).toEqual(
      expect.arrayContaining(["OVER_PER_TX_CAP", "PRICE_NOT_IN_CATALOG"]),
    );
    expect(rows.filter((x) => x.source === "TRANSACTION")).toHaveLength(1);
    expect(rows.filter((x) => x.source === "REFUSED_OFFER")).toHaveLength(1);
  });

  it("the policy decision shown is the one stored in the database, code for code", async () => {
    const db = boot();
    putBenchmark();
    const s = await signIn();
    await refuseAnOffer(s);
    const stored = JSON.parse(
      db.read<string>("SELECT reason_codes FROM negotiation_policy_checks WHERE verdict = 'DENY'"),
    ) as string[];
    const { body } = await get(s);
    const shown = (body.rows as CockpitRow[]).find((x) => x.source === "REFUSED_OFFER");
    expect(shown?.reasonCodes).toEqual(stored);
  });

  it("applies the same filters as the page through the query string", async () => {
    boot();
    putBenchmark();
    const s = await signIn();
    await agree(s);
    await refuseAnOffer(s);
    const denied = await get(s, "?source=REFUSED_OFFER&decision=DENIED");
    expect(denied.body.rows).toHaveLength(1);
    expect(denied.body.tallies.total).toBe(1);
    expect(denied.body.total).toBeGreaterThan(denied.body.rows.length);
    const none = await get(s, "?source=TRANSACTION&decision=DENIED");
    expect(none.body.rows).toEqual([]);
  });

  it("is read-only: reading leaves every table as it was", async () => {
    const db = boot();
    putBenchmark();
    const s = await signIn();
    await agree(s);
    const counts = () =>
      ["audit_events", "transactions", "policy_decisions", "negotiations"].map((t) =>
        db.read<number>(`SELECT COUNT(*) FROM ${t}`),
      );
    const before = counts();
    await get(s);
    await get(s, "?q=tx");
    expect(counts()).toEqual(before);
  });
});

describe("who may see database rows", () => {
  it("without an operator session the database is locked and none of its rows appear", async () => {
    boot();
    putBenchmark();
    const s = await signIn();
    await agree(s);
    const { body } = await get();
    expect(body.sources.database.state).toBe("LOCKED");
    expect((body.rows as CockpitRow[]).some((r) => r.source !== "BENCHMARK")).toBe(false);
    expect(body.sources.benchmark.state).toBe("OK");
  });

  it("an agent cannot use the operator's cookie to read it", async () => {
    boot();
    putBenchmark();
    const s = await signIn();
    await agree(s);
    const { body } = await get(s, "", { "x-agent-id": "buyer-agent-1" });
    expect(body.sources.database.state).toBe("LOCKED");
    expect((body.rows as CockpitRow[]).some((r) => r.source !== "BENCHMARK")).toBe(false);
  });

  it("a forged or expired cookie is no session", async () => {
    boot();
    putBenchmark();
    const { body } = await get({ cookie: "pp_operator=not-a-session", csrf: "x" });
    expect(body.sources.database.state).toBe("LOCKED");
  });
});

describe("the audit chain column", () => {
  it("marks exactly the rows whose events sit at or after the first invalid event", async () => {
    const db = boot();
    putBenchmark();
    const s = await signIn();
    await agree(s);
    await refuseAnOffer(s);
    const before = (await get(s)).body.rows as CockpitRow[];
    expect(
      before.filter((r) => r.source !== "BENCHMARK").every((r) => r.auditChain === "VERIFIED"),
    ).toBe(true);

    // a privileged writer drops the append-only guard and edits the refusal's audit event (the newest transaction-less event)
    const w = openDatabase(db.path);
    w.exec("DROP TRIGGER audit_events_no_update");
    const seq = (
      w
        .prepare(
          "SELECT seq FROM audit_events WHERE type = 'POLICY_DENIED' ORDER BY seq DESC LIMIT 1",
        )
        .get() as { seq: number }
    ).seq;
    w.prepare("UPDATE audit_events SET payload = '{}' WHERE seq = ?").run(seq);
    w.close();

    const { body } = await get(s);
    const rows = body.rows as CockpitRow[];
    expect(rows.find((r) => r.source === "REFUSED_OFFER")?.auditChain).toBe("BROKEN");
    expect(rows.find((r) => r.source === "TRANSACTION")?.auditChain).toBe("VERIFIED"); // its events precede the break
    expect(body.sources.database.note).toMatch(/FAILS at event #/);
    expect(body.tallies.byAudit.BROKEN).toBe(1);
  });
});

describe("empty and error states", () => {
  it("a database that does not exist is 'nothing to read yet', with the command to fix it", async () => {
    boot();
    putBenchmark();
    const s = await signIn();
    vi.stubEnv("DATABASE_PATH", join(cwdDir, "missing.db"));
    const { body } = await get(s);
    expect(body.sources.database).toMatchObject({ state: "UNAVAILABLE" });
    expect(body.sources.database.message).toContain("npm run db:migrate");
  });

  it("a database that is not migrated far enough is refused, not half-read", async () => {
    boot();
    putBenchmark();
    const s = await signIn();
    const old = join(cwdDir, "old.db");
    const db = openDatabase(old);
    migrate(db, { migrations: loadMigrations().filter((m) => m.id <= 7) });
    db.close();
    vi.stubEnv("DATABASE_PATH", old);
    const { body } = await get(s);
    expect(body.sources.database).toMatchObject({ state: "UNAVAILABLE" });
    expect(body.sources.database.message).toMatch(/needs 8/);
  });

  it("a file that is not a database is an error, and never shows its contents or path", async () => {
    boot();
    putBenchmark();
    const s = await signIn();
    const junk = join(cwdDir, "junk.db");
    writeFileSync(junk, "this is not sqlite");
    vi.stubEnv("DATABASE_PATH", junk);
    const { body } = await get(s);
    expect(body.sources.database.state).toBe("ERROR");
    expect(JSON.stringify(body.sources.database)).not.toContain(cwdDir);
    expect(JSON.stringify(body.sources.database)).not.toContain("not sqlite");
  });

  it("no benchmark file yet is 'no results yet' with the command to create it, and the database rows still show", async () => {
    boot();
    const s = await signIn();
    await agree(s);
    const { body } = await get(s);
    expect(body.sources.benchmark).toMatchObject({ state: "MISSING" });
    expect(body.sources.benchmark.message).toContain("npm run benchmark");
    expect((body.rows as CockpitRow[]).some((r) => r.source === "TRANSACTION")).toBe(true);
    expect((body.rows as CockpitRow[]).some((r) => r.source === "BENCHMARK")).toBe(false);
  });

  it("a benchmark file that was edited after it was written is rejected whole, and says why", async () => {
    boot();
    const s = await signIn();
    const edited = JSON.parse(benchmarkText);
    edited.runs[0].verdict =
      edited.runs[0].verdict === "AS_EXPECTED" ? "FALSE_BLOCK" : "AS_EXPECTED";
    putBenchmark(JSON.stringify(edited));
    const { body } = await get(s);
    expect(body.sources.benchmark.state).toBe("ERROR");
    expect(body.sources.benchmark.message).toMatch(/edited after it was written/);
    expect((body.rows as CockpitRow[]).some((r) => r.source === "BENCHMARK")).toBe(false);
  });

  it("a truncated benchmark file is an error, not a partial grid", async () => {
    boot();
    const s = await signIn();
    putBenchmark(benchmarkText.slice(0, 5_000));
    const { body } = await get(s);
    expect(body.sources.benchmark).toMatchObject({ state: "ERROR" });
  });

  it("with neither source available the page says so instead of showing an empty grid", async () => {
    boot();
    vi.stubEnv("DATABASE_PATH", join(cwdDir, "missing.db"));
    h.current = new Headers();
    const html = renderToStaticMarkup(await CockpitPage({ searchParams: Promise.resolve({}) }));
    expect(html).toContain("Nothing to show yet");
    expect(html).toContain("npm run benchmark");
    expect(html).not.toContain("Loading grid");
  });
});

describe("opening a row", () => {
  const page = async (id: string, cookie?: string) => {
    h.current = cookie ? new Headers({ cookie }) : new Headers();
    return renderToStaticMarkup(
      await CockpitRowPage({ params: Promise.resolve({ id: encodeURIComponent(id) }) }),
    );
  };

  it("the ID cell links to the row's detail route, and that route decodes back to the same row", async () => {
    boot();
    putBenchmark();
    const s = await signIn();
    await agree(s);
    const rows = (await get(s)).body.rows as CockpitRow[];
    for (const row of [
      rows.find((r) => r.source === "TRANSACTION"),
      rows.find((r) => r.source === "BENCHMARK"),
    ] as CockpitRow[]) {
      const cell = IdLink({ data: row, value: row.refId } as never);
      const markup = renderToStaticMarkup(cell as never);
      expect(markup).toContain(`href="${detailHref(row.id)}"`);
      expect(markup).toContain(row.refId.replaceAll("&", "&amp;"));
      const encoded = detailHref(row.id).slice("/cockpit/".length);
      expect(decodeURIComponent(encoded)).toBe(row.id);
    }
  });

  it("a transaction's detail page shows the row, its policy decisions, and its audit events with the chain note", async () => {
    boot();
    putBenchmark();
    const s = await signIn();
    await agree(s);
    const row = ((await get(s)).body.rows as CockpitRow[]).find(
      (r) => r.source === "TRANSACTION",
    ) as CockpitRow;
    const html = await page(row.id, s.cookie);
    expect(html).toContain(row.refId);
    expect(html).toContain("80.00 USD");
    expect(html).toContain("Policy decisions");
    expect(html).toContain("ACCEPT_OFFER");
    expect(html).toContain("Audit events");
    expect(html).toContain("The audit chain verifies");
    expect(html).toContain('href="/cockpit"');
    expect(html).toContain("not a signature");
  });

  it("a refused offer's detail names the reason codes and says no transaction exists", async () => {
    boot();
    putBenchmark();
    const s = await signIn();
    await refuseAnOffer(s);
    const row = ((await get(s)).body.rows as CockpitRow[]).find(
      (r) => r.source === "REFUSED_OFFER",
    ) as CockpitRow;
    const html = await page(row.id, s.cookie);
    expect(html).toContain("OVER_PER_TX_CAP");
    expect(html).toContain("no transaction was created");
  });

  it("a benchmark run's detail shows its expected and actual records and the file's hash", async () => {
    boot();
    putBenchmark();
    const row = ((await get()).body.rows as CockpitRow[]).find(
      (r) => r.source === "BENCHMARK" && r.refId.startsWith("S1|UNSAFE_BASELINE"),
    ) as CockpitRow;
    expect(row).toBeDefined();
    const html = await page(row.id);
    expect(html).toContain("Expected");
    expect(html).toContain("Actual");
    expect(html).toContain("Input fingerprint");
    expect(html).toContain(JSON.parse(benchmarkText).resultsHash);
    expect(html).toContain("Simulated money");
  });

  it("a database row is not reachable without the operator session, and the page says why", async () => {
    boot();
    putBenchmark();
    const s = await signIn();
    await agree(s);
    const row = ((await get(s)).body.rows as CockpitRow[]).find(
      (r) => r.source === "TRANSACTION",
    ) as CockpitRow;
    const html = await page(row.id); // no cookie
    expect(html).toContain("Row not found");
    expect(html).toContain("Sign in as the operator");
    expect(html).not.toContain("Policy decisions");
  });

  it("an id that matches nothing, or is not even a valid address, gets a clear not-found", async () => {
    boot();
    putBenchmark();
    const s = await signIn();
    expect(await page("tx:no_such", s.cookie)).toContain("No row has this id");
    expect(await page("bench:no|such|run")).toContain("No row has this id");
    expect(await page("garbage")).toContain("Row not found");
    h.current = new Headers();
    const bad = renderToStaticMarkup(
      await CockpitRowPage({ params: Promise.resolve({ id: "%E0%A4%A" }) }),
    );
    expect(bad).toContain("not a valid row id");
  });

  it("escapes an id it echoes back", async () => {
    boot();
    putBenchmark();
    const html = await page("tx:<script>alert(1)</script>");
    expect(html).not.toContain("<script>alert");
  });
});
