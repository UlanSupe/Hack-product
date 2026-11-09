import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { GET } from "./route";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("GET /api/health", () => {
  it("returns 200 with no-store and never leaks secret values", async () => {
    vi.stubEnv("PAYPAL_CLIENT_ID", "id-should-not-appear-123");
    vi.stubEnv("PAYPAL_CLIENT_SECRET", "secret-should-not-appear-456");
    vi.stubEnv("DATABASE_PATH", join(mkdtempSync(join(tmpdir(), "pactpay-health-")), "none.db"));
    const res = GET();
    const text = await res.text();

    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(JSON.parse(text)).toMatchObject({ status: "ok", paypal: { credentials: "present" } });
    expect(text).not.toContain("should-not-appear");
  });

  it("returns 503 naming the bad variable (never its value) when configuration is invalid", async () => {
    vi.stubEnv("PAYPAL_ENV", "live-secret-looking-value");
    const res = GET();
    const text = await res.text();

    expect(res.status).toBe(503);
    expect(JSON.parse(text)).toMatchObject({ status: "error", issues: [{ path: "PAYPAL_ENV" }] });
    expect(text).not.toContain("live-secret-looking-value");
  });
});
