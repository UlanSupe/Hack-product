import "server-only";

import { randomUUID } from "node:crypto";
import { resolve } from "node:path";

import { openDatabase, type Db } from "@/adapters/sqlite/database";
import { createSqliteNegotiationStore } from "@/adapters/sqlite/negotiation-store";
import { readDatabaseStatus } from "@/adapters/sqlite/status";
import { createNegotiationDemo, type NegotiationDemo } from "@/application/negotiation-demo";
import { createNegotiationService, type NegotiationService } from "@/application/negotiations";
import { liveModelFrom } from "./agent-factory";
import { getEnv } from "./env";
import { HttpError } from "./http";

/** Migration 0006 added the negotiation workflow tables. */
const REQUIRED_MIGRATIONS = 6;

type Cached = { path: string; db: Db; service: NegotiationService; demo: NegotiationDemo };
const KEY = Symbol.for("pactpay.negotiationService");
const holder = globalThis as unknown as Record<symbol, Cached | undefined>;

/**
 * The one SQLite connection of this process, after the same readiness check (503 if the schema is not current).
 * Other composition roots (payments) share it instead of opening a second writer on the same file.
 */
export function getSharedDatabase(): { path: string; db: Db } {
  getNegotiation();
  const cached = holder[KEY] as Cached;
  return { path: cached.path, db: cached.db };
}

/**
 * Composition root for the negotiation workflow: one SQLite connection per process (survives dev hot
 * reloads), the real clock and random ids. Refuses to run (503) instead of creating or guessing a schema.
 */
export function getNegotiation(): { service: NegotiationService; demo: NegotiationDemo } {
  const env = getEnv();
  const path = resolve(env.DATABASE_PATH);
  const cached = holder[KEY];
  if (cached?.path === path) return cached;

  const status = readDatabaseStatus(path);
  if (status.state !== "ready" || status.migrations < REQUIRED_MIGRATIONS) {
    throw new HttpError(
      503,
      "DATABASE_NOT_READY",
      "The database is not ready for negotiations. Run `npm run db:migrate` (and `npm run db:seed` for demo data).",
    );
  }
  cached?.db.close();
  const db = openDatabase(path);
  const store = createSqliteNegotiationStore(db);
  const service = createNegotiationService({
    store,
    now: () => new Date(),
    newId: (prefix) => `${prefix}_${randomUUID().replaceAll("-", "").slice(0, 14)}`,
  });
  const next: Cached = {
    path,
    db,
    service,
    demo: createNegotiationDemo({ service, store, live: liveModelFrom(env) }),
  };
  holder[KEY] = next;
  return next;
}
