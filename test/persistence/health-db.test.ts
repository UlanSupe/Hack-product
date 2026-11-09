import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { openDatabase } from "@/adapters/sqlite/database";
import { migrate } from "@/adapters/sqlite/migrate";
import { GET } from "@/app/api/health/route";

// Lives under test/ (not src/app) because it touches adapters directly, which the app layer may not do.
afterEach(() => {
  vi.unstubAllEnvs();
});

const tmp = () => mkdtempSync(join(tmpdir(), "pactpay-health-"));

describe("GET /api/health database status", () => {
  it("reports the database as uninitialized without creating the file", async () => {
    const file = join(tmp(), "absent.db");
    vi.stubEnv("DATABASE_PATH", file);
    const body = (await GET().json()) as { database: unknown };
    expect(body.database).toEqual({ state: "uninitialized" });
    expect(() => openDatabase(file, { readOnly: true })).toThrow(); // still absent: the probe never creates it
  });

  it("reports a created-but-unmigrated database as uninitialized", async () => {
    const file = join(tmp(), "empty.db");
    openDatabase(file).close();
    vi.stubEnv("DATABASE_PATH", file);
    const body = (await GET().json()) as { database: unknown };
    expect(body.database).toEqual({ state: "uninitialized" });
  });

  it("reports a migrated database as ready", async () => {
    const file = join(tmp(), "ready.db");
    const db = openDatabase(file);
    migrate(db);
    db.close();
    vi.stubEnv("DATABASE_PATH", file);
    const body = (await GET().json()) as { database: unknown };
    expect(body.database).toEqual({
      state: "ready",
      migrations: 8,
      latest: "0008_audit_chain_identity",
    });
  });

  it("reports an unreadable database as an error without leaking its path or message", async () => {
    const dir = tmp();
    const file = join(dir, "corrupt.db");
    writeFileSync(file, "this is not a sqlite database, just text".repeat(50));
    vi.stubEnv("DATABASE_PATH", file);
    const res = GET();
    const text = await res.text();
    // a broken database means the service cannot serve: 503 "degraded", so a platform can act on it
    expect(res.status).toBe(503);
    expect(JSON.parse(text)).toMatchObject({ status: "degraded", database: { state: "error" } });
    expect(text).not.toContain(dir);
    expect(text).not.toContain("corrupt.db");
  });
});
