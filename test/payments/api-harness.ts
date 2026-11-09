/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-return -- these helpers read untyped API JSON */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { expect, vi } from "vitest";

import { openDatabase } from "@/adapters/sqlite/database";
import { migrate } from "@/adapters/sqlite/migrate";
import { seedDevelopment } from "@/adapters/sqlite/seed";
import { POST as acceptProposal } from "@/app/api/negotiations/[id]/proposals/[pid]/accept/route";
import { POST as postOffer } from "@/app/api/negotiations/[id]/offers/route";
import { POST as openNegotiation } from "@/app/api/negotiations/route";
import { POST as login } from "@/app/api/operator/session/route";

import { TEST_CLIENT_ID, TEST_CLIENT_SECRET, TEST_MERCHANT } from "./http-paypal";

/** Shared by the payment route tests: a throwaway seeded database, an operator session, and an agreed negotiation. */
export const PASSCODE = "a-long-operator-passcode-for-tests";
export const BASE = "http://localhost:3000";

export function boot(paypal: Record<string, string> | null = null) {
  const file = join(mkdtempSync(join(tmpdir(), "pactpay-pay-api-")), "t.db");
  const db = openDatabase(file);
  migrate(db);
  seedDevelopment(db, new Date().toISOString());
  db.close();
  vi.stubEnv("DATABASE_PATH", file);
  vi.stubEnv("OPERATOR_PASSCODE", PASSCODE);
  vi.stubEnv("APP_BASE_URL", BASE);
  vi.stubEnv("PAYPAL_CLIENT_ID", "");
  vi.stubEnv("PAYPAL_CLIENT_SECRET", "");
  vi.stubEnv("PAYPAL_MERCHANT_ID", "");
  if (paypal) for (const [k, v] of Object.entries(paypal)) vi.stubEnv(k, v);
  const read = <T>(sql: string, ...p: (string | number)[]): T => {
    const d = openDatabase(file, { readOnly: true });
    try {
      const row = d.prepare(sql).get(...p) as Record<string, T> | undefined;
      return row ? (Object.values(row)[0] as T) : (undefined as T);
    } finally {
      d.close();
    }
  };
  return {
    path: file,
    read,
    state: (id: string) =>
      read<string>(
        "SELECT state FROM transactions WHERE id = (SELECT transaction_id FROM negotiation_agreements WHERE negotiation_id = ? AND status = 'ACTIVE')",
        id,
      ),
  };
}

export const CONFIGURED = {
  PAYPAL_CLIENT_ID: TEST_CLIENT_ID,
  PAYPAL_CLIENT_SECRET: TEST_CLIENT_SECRET,
  PAYPAL_MERCHANT_ID: TEST_MERCHANT,
};

export type Session = { cookie: string; csrf: string };
export function request(
  method: string,
  path: string,
  init: {
    s?: Session;
    body?: unknown;
    headers?: Record<string, string>;
    csrf?: boolean;
    contentType?: string;
  } = {},
): Request {
  const headers: Record<string, string> = { ...init.headers };
  if (init.body !== undefined) headers["content-type"] = init.contentType ?? "application/json";
  if (init.s) {
    headers.cookie = init.s.cookie;
    if (init.csrf !== false) headers["x-csrf-token"] = init.s.csrf;
  }
  if (method !== "GET" && headers.origin === undefined) headers.origin = BASE;
  return new Request(`${BASE}${path}`, {
    method,
    headers,
    ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
  });
}
export const bodyOf = async (res: Response) => (await res.json()) as Record<string, any>;
export const idCtx = (id: string) => ({ params: Promise.resolve({ id }) });
export const propCtx = (id: string, pid: string) => ({ params: Promise.resolve({ id, pid }) });

export async function signIn(): Promise<Session> {
  const res = await login(
    request("POST", "/api/operator/session", { body: { passcode: PASSCODE } }),
  );
  const cookie = (res.headers.get("set-cookie") ?? "").split(";")[0] as string;
  const { csrfToken } = (await res.json()) as { csrfToken: string };
  return { cookie, csrf: csrfToken };
}

/** Open a negotiation, receive an 80.00 offer, accept it: an agreement the seeded mandate allows without approval. */
export async function agree(s: Session): Promise<string> {
  const neg = (
    await bodyOf(
      await openNegotiation(
        request("POST", "/api/negotiations", {
          s,
          body: {
            mandateId: "M1",
            category: "COMPUTE",
            quantity: 1,
            summary: "One GPU pack",
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
              lines: [{ sku: "GPU-PACK", qty: 1, unitPriceMinor: 8000 }],
              shippingMinor: 0,
              feesMinor: 0,
              claimedTotalMinor: 8000,
              category: "COMPUTE",
              deliveryDays: 3,
              deliverables: ["80 GPU-hours"],
              termsText: "Fixed price.",
              validForMinutes: 30,
            },
          },
        }),
        idCtx(neg.id),
      ),
    )
  ).proposal;
  const accepted = await acceptProposal(
    request("POST", "/x", { s, body: {} }),
    propCtx(neg.id, proposal.id),
  );
  expect((await bodyOf(accepted)).outcome.accepted).toBe(true);
  return neg.id;
}
