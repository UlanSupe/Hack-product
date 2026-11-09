/* eslint-disable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-return -- these tests inspect untyped API JSON structurally */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { openDatabase } from "@/adapters/sqlite/database";
import { migrate } from "@/adapters/sqlite/migrate";
import { seedDevelopment } from "@/adapters/sqlite/seed";
import { POST as login } from "@/app/api/operator/session/route";
import { GET as overview, POST as openNegotiation } from "@/app/api/negotiations/route";
import { GET as detail } from "@/app/api/negotiations/[id]/route";
import { POST as postOffer } from "@/app/api/negotiations/[id]/offers/route";
import { POST as postCounter } from "@/app/api/negotiations/[id]/counters/route";
import { POST as runDemo } from "@/app/api/negotiations/[id]/demo/route";
import { POST as acceptProposal } from "@/app/api/negotiations/[id]/proposals/[pid]/accept/route";
import { POST as rejectProposal } from "@/app/api/negotiations/[id]/proposals/[pid]/reject/route";
import { POST as approve } from "@/app/api/negotiations/[id]/approve/route";
import { POST as disapprove } from "@/app/api/negotiations/[id]/disapprove/route";
import { POST as eligibility } from "@/app/api/negotiations/[id]/eligibility/route";
import { POST as close } from "@/app/api/negotiations/[id]/close/route";
import { loginThrottle } from "@/server/operator-guard";

const PASSCODE = "a-long-operator-passcode-for-tests";
const BASE = "http://localhost:3000";

afterEach(() => {
  vi.unstubAllEnvs();
  loginThrottle.reset();
});

function boot() {
  const file = join(mkdtempSync(join(tmpdir(), "pactpay-neg-api-")), "t.db");
  const db = openDatabase(file);
  migrate(db);
  seedDevelopment(db, new Date().toISOString());
  db.close();
  vi.stubEnv("DATABASE_PATH", file);
  vi.stubEnv("OPERATOR_PASSCODE", PASSCODE);
  return {
    count: (table: string) => {
      const d = openDatabase(file, { readOnly: true });
      const n = (d.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
      d.close();
      return n;
    },
  };
}

type Init = {
  cookie?: string;
  csrf?: string;
  origin?: string | null;
  headers?: Record<string, string>;
  body?: unknown;
  contentType?: string | null;
};
function request(method: string, path: string, init: Init = {}): Request {
  const headers: Record<string, string> = { ...init.headers };
  if (init.contentType !== null && init.body !== undefined)
    headers["content-type"] = init.contentType ?? "application/json";
  if (init.cookie) headers.cookie = init.cookie;
  if (init.csrf) headers["x-csrf-token"] = init.csrf;
  if (init.origin !== null && method !== "GET") headers.origin = init.origin ?? BASE;
  return new Request(`${BASE}${path}`, {
    method,
    headers,
    ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
  });
}

const idCtx = (id: string) => ({ params: Promise.resolve({ id }) });
const propCtx = (id: string, pid: string) => ({ params: Promise.resolve({ id, pid }) });
const bodyOf = async (res: Response) => (await res.json()) as Record<string, any>;

async function signIn() {
  const res = await login(
    request("POST", "/api/operator/session", { body: { passcode: PASSCODE } }),
  );
  const cookie = (res.headers.get("set-cookie") ?? "").split(";")[0] as string;
  const { csrfToken } = (await res.json()) as { csrfToken: string };
  return { cookie, csrf: csrfToken };
}

const openBody = (over: Record<string, unknown> = {}) => ({
  mandateId: "M1",
  category: "COMPUTE",
  quantity: 1,
  summary: "One GPU pack",
  maxTotal: null,
  neededWithinDays: null,
  requiredDeliverables: [],
  invitedSellerIds: ["seller_acme"],
  timeoutMinutes: 60,
  ...over,
});
const offerBody = (over: Record<string, unknown> = {}) => ({
  sellerId: "seller_acme",
  offer: {
    currency: "USD",
    lines: [{ sku: "GPU-PACK", qty: 1, unitPriceMinor: 8000 }],
    shippingMinor: 0,
    feesMinor: 0,
    claimedTotalMinor: 8000,
    category: "COMPUTE",
    deliveryDays: 3,
    deliverables: ["80 GPU-hours"],
    termsText: "Fixed price.",
    validForMinutes: 30,
    ...over,
  },
});

describe("access: only the signed-in human operator", () => {
  it("anonymous requests are 401 on every route and change nothing", async () => {
    const db = boot();
    expect((await overview(request("GET", "/api/negotiations"))).status).toBe(401);
    expect((await detail(request("GET", "/api/negotiations/x"), idCtx("x"))).status).toBe(401);
    expect(
      (await openNegotiation(request("POST", "/api/negotiations", { body: openBody() }))).status,
    ).toBe(401);
    expect(
      (await acceptProposal(request("POST", "/x", { body: {} }), propCtx("x", "y"))).status,
    ).toBe(401);
    expect((await approve(request("POST", "/x", { body: {} }), idCtx("x"))).status).toBe(401);
    expect(db.count("negotiations")).toBe(0);
  });

  it("anything that declares itself an agent is refused, even with a valid operator session", async () => {
    const db = boot();
    const s = await signIn();
    for (const headers of [{ "x-agent-id": "buyer-1" }, { authorization: "Bearer agent-token" }]) {
      const res = await openNegotiation(
        request("POST", "/api/negotiations", { ...s, headers, body: openBody() }),
      );
      expect(res.status).toBe(403);
      expect((await bodyOf(res)).error).toBe("FORBIDDEN");
      expect((await overview(request("GET", "/api/negotiations", { ...s, headers }))).status).toBe(
        403,
      );
    }
    expect(db.count("negotiations")).toBe(0);
  });

  it("writes need the CSRF token, a same-origin request, and a JSON body", async () => {
    boot();
    const s = await signIn();
    expect(
      (
        await openNegotiation(
          request("POST", "/api/negotiations", { cookie: s.cookie, body: openBody() }),
        )
      ).status,
    ).toBe(403);
    expect(
      (
        await openNegotiation(
          request("POST", "/api/negotiations", {
            ...s,
            origin: "https://evil.example",
            body: openBody(),
          }),
        )
      ).status,
    ).toBe(403);
    expect(
      (
        await openNegotiation(
          request("POST", "/api/negotiations", {
            ...s,
            contentType: "application/x-www-form-urlencoded",
            body: openBody(),
          }),
        )
      ).status,
    ).toBe(415);
  });
});

describe("the workflow over HTTP", () => {
  it("open → offer → accept → approve → eligible, each step explained", async () => {
    const db = boot();
    const s = await signIn();
    const opened = await openNegotiation(
      request("POST", "/api/negotiations", { ...s, body: openBody({ maxTotal: "90.00" }) }),
    );
    expect(opened.status).toBe(201);
    const neg = (await bodyOf(opened)).negotiation;
    expect(neg.status).toBe("OPEN");
    expect(neg.request.maxTotalText).toBe("90.00 USD");

    const offered = await postOffer(
      request("POST", "/x", { ...s, body: offerBody() }),
      idCtx(neg.id),
    );
    expect(offered.status).toBe(201);
    const proposal = (await bodyOf(offered)).proposal;
    expect(proposal).toMatchObject({ kind: "SELLER_OFFER", version: 1, status: "OPEN" });
    expect(proposal.policy).toMatchObject({ verdict: "ALLOW", source: "PREVIEW" }); // seeded mandate: threshold 90.00, cap 100.00

    const accepted = await acceptProposal(
      request("POST", "/x", { ...s, body: {} }),
      propCtx(neg.id, proposal.id),
    );
    expect(accepted.status).toBe(200);
    const outcome = (await bodyOf(accepted)).outcome;
    expect(outcome).toMatchObject({ accepted: true });
    expect(outcome.negotiation.active).toMatchObject({ version: 1, totalText: "80.00 USD" });

    const checked = await eligibility(request("POST", "/x", { ...s, body: {} }), idCtx(neg.id));
    expect((await bodyOf(checked)).eligibility.state).toBe("ELIGIBLE");
    const approved = await approve(
      request("POST", "/x", { ...s, body: { reason: "ok" } }),
      idCtx(neg.id),
    );
    expect(approved.status).toBe(200);
    expect(db.count("transaction_approvals")).toBe(1);

    const again = await acceptProposal(
      request("POST", "/x", { ...s, body: {} }),
      propCtx(neg.id, proposal.id),
    );
    expect(again.status).toBe(409);
    expect((await detail(request("GET", "/x", s), idCtx(neg.id))).status).toBe(200);
  });

  it("a refusal is a normal 200 answer with the reasons in words, not an error", async () => {
    boot();
    const s = await signIn();
    const neg = (
      await bodyOf(
        await openNegotiation(request("POST", "/api/negotiations", { ...s, body: openBody() })),
      )
    ).negotiation;
    const p = (
      await bodyOf(
        await postOffer(
          request("POST", "/x", { ...s, body: offerBody({ currency: "EUR" }) }),
          idCtx(neg.id),
        ),
      )
    ).proposal;
    const res = await acceptProposal(
      request("POST", "/x", { ...s, body: {} }),
      propCtx(neg.id, p.id),
    );
    expect(res.status).toBe(200);
    const outcome = (await bodyOf(res)).outcome;
    expect(outcome.accepted).toBe(false);
    expect(outcome.policy.headline).toBe(
      "Policy check refused accepting this offer: Wrong currency.",
    );
    expect(outcome.policy.items[0].next).toMatch(/quote in the mandate's currency/);
  });

  it("a payee in the body is refused with an explanation, and nothing is stored", async () => {
    const db = boot();
    const s = await signIn();
    const neg = (
      await bodyOf(
        await openNegotiation(request("POST", "/api/negotiations", { ...s, body: openBody() })),
      )
    ).negotiation;
    const res = await postOffer(
      request("POST", "/x", { ...s, body: { ...offerBody(), payeeRef: "payee_attacker" } }),
      idCtx(neg.id),
    );
    expect(res.status).toBe(422);
    const fields = (await bodyOf(res)).fields as { field: string; message: string }[];
    expect(fields[0]).toMatchObject({ field: "payeeRef" });
    expect(fields[0]?.message).toMatch(/seller catalog/);
    expect(db.count("negotiation_proposals")).toBe(0);
  });

  it("ids come from the URL: a body cannot retarget another negotiation or proposal", async () => {
    boot();
    const s = await signIn();
    const a = (
      await bodyOf(
        await openNegotiation(request("POST", "/api/negotiations", { ...s, body: openBody() })),
      )
    ).negotiation;
    const b = (
      await bodyOf(
        await openNegotiation(request("POST", "/api/negotiations", { ...s, body: openBody() })),
      )
    ).negotiation;
    const p = (
      await bodyOf(
        await postOffer(
          request("POST", "/x", { ...s, body: { ...offerBody(), negotiationId: b.id } }),
          idCtx(a.id),
        ),
      )
    ).proposal;
    const da = (await bodyOf(await detail(request("GET", "/x", s), idCtx(a.id)))).negotiation;
    const db_ = (await bodyOf(await detail(request("GET", "/x", s), idCtx(b.id)))).negotiation;
    expect(da.sellers[0].offers.map((o: any) => o.id)).toEqual([p.id]);
    expect(db_.sellers[0].offers).toEqual([]);
    const res = await acceptProposal(
      request("POST", "/x", { ...s, body: { proposalId: p.id } }),
      propCtx(b.id, "ofr_other"),
    );
    expect(res.status).toBe(404);
  });

  it("unknown or authority-looking fields in a request are refused", async () => {
    boot();
    const s = await signIn();
    const neg = (
      await bodyOf(
        await openNegotiation(request("POST", "/api/negotiations", { ...s, body: openBody() })),
      )
    ).negotiation;
    const p = (
      await bodyOf(
        await postOffer(request("POST", "/x", { ...s, body: offerBody() }), idCtx(neg.id)),
      )
    ).proposal;
    for (const extra of [
      { verdict: "ALLOW" },
      { force: true },
      { reasonCodes: [] },
      { approved: true },
    ]) {
      const res = await acceptProposal(
        request("POST", "/x", { ...s, body: extra }),
        propCtx(neg.id, p.id),
      );
      expect(res.status, JSON.stringify(extra)).toBe(422);
    }
  });

  it("counter-offers, rejection, disapproval and closing work, and the close outcome is validated", async () => {
    const db = boot();
    const s = await signIn();
    const neg = (
      await bodyOf(
        await openNegotiation(request("POST", "/api/negotiations", { ...s, body: openBody() })),
      )
    ).negotiation;
    const p = (
      await bodyOf(
        await postOffer(request("POST", "/x", { ...s, body: offerBody() }), idCtx(neg.id)),
      )
    ).proposal;
    const counter = await postCounter(
      request("POST", "/x", {
        ...s,
        body: {
          sellerId: "seller_acme",
          currency: "USD",
          category: "COMPUTE",
          targetTotalMinor: 7000,
          deliverables: ["80 GPU-hours"],
          deliveryDays: 3,
          note: "please",
          validForMinutes: 30,
        },
      }),
      idCtx(neg.id),
    );
    expect(counter.status).toBe(201);
    expect((await bodyOf(counter)).proposal).toMatchObject({ kind: "BUYER_COUNTER", version: 1 });
    expect(
      (
        await rejectProposal(
          request("POST", "/x", { ...s, body: { reason: "no" } }),
          propCtx(neg.id, p.id),
        )
      ).status,
    ).toBe(200);
    expect(
      (await close(request("POST", "/x", { ...s, body: { outcome: "BANANA" } }), idCtx(neg.id)))
        .status,
    ).toBe(422);
    const closed = await close(
      request("POST", "/x", { ...s, body: { outcome: "REJECTED", reason: "No deal" } }),
      idCtx(neg.id),
    );
    expect((await bodyOf(closed)).negotiation.status).toBe("REJECTED");
    expect(
      (await disapprove(request("POST", "/x", { ...s, body: {} }), idCtx(neg.id))).status,
    ).toBe(409);
    expect(db.count("negotiation_policy_checks")).toBe(0);
  });

  it("the demo agents record offers; the operator decides", async () => {
    const db = boot();
    const s = await signIn();
    const neg = (
      await bodyOf(
        await openNegotiation(
          request("POST", "/api/negotiations", {
            ...s,
            body: openBody({ invitedSellerIds: ["seller_acme", "seller_backup_demo"] }),
          }),
        ),
      )
    ).negotiation;
    const res = await runDemo(request("POST", "/x", { ...s, body: {} }), idCtx(neg.id));
    expect(res.status).toBe(200);
    const body = await bodyOf(res);
    expect(body.demo.recorded.offers).toBeGreaterThanOrEqual(1);
    expect(body.negotiation.status).toBe("OPEN");
    expect(db.count("negotiation_agreements")).toBe(0);
    expect(db.count("transaction_approvals")).toBe(0);
  });

  it("the overview lists what the open form needs", async () => {
    boot();
    const s = await signIn();
    const body = await bodyOf(await overview(request("GET", "/api/negotiations", s)));
    expect(body.mandates[0]).toMatchObject({ id: "M1", currency: "USD" });
    expect(body.sellers.map((x: any) => x.id)).toEqual(["seller_acme", "seller_backup_demo"]);
    expect(body.negotiations).toEqual([]);
  });
});
