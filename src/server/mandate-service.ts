import "server-only";

import { randomUUID } from "node:crypto";
import { resolve } from "node:path";

import { openDatabase, type Db } from "@/adapters/sqlite/database";
import { createSqliteMandateStore } from "@/adapters/sqlite/mandate-store";
import { readDatabaseStatus } from "@/adapters/sqlite/status";
import { createMandateService, type MandateService } from "@/application/mandates";
import { getEnv } from "./env";
import { HttpError } from "./http";

/** Migration 0005 introduced the mandate policy columns and drafts. */
const REQUIRED_MIGRATIONS = 5; // the mandate feature needs 0005; later migrations are additive

type Cached = { path: string; db: Db; service: MandateService };
const KEY = Symbol.for("pactpay.mandateService");
const holder = globalThis as unknown as Record<symbol, Cached | undefined>;

/**
 * Composition root for the mandate feature: one SQLite connection per process (survives dev hot reloads),
 * wired to the real clock and random ids. Refuses to run (503) instead of creating or guessing a schema.
 */
export function getMandateService(): MandateService {
  const path = resolve(getEnv().DATABASE_PATH);
  const cached = holder[KEY];
  if (cached?.path === path) return cached.service;

  const status = readDatabaseStatus(path);
  if (status.state !== "ready" || status.migrations < REQUIRED_MIGRATIONS) {
    throw new HttpError(
      503,
      "DATABASE_NOT_READY",
      "The database is not ready. Run `npm run db:migrate` (and `npm run db:seed` for demo data).",
    );
  }
  cached?.db.close();
  const db = openDatabase(path);
  const service = createMandateService({
    store: createSqliteMandateStore(db),
    now: () => new Date(),
    newId: (prefix) => `${prefix}_${randomUUID().replaceAll("-", "").slice(0, 12)}`,
  });
  holder[KEY] = { path, db, service };
  return service;
}
