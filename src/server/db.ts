import "server-only";

import { resolve } from "node:path";

import { readDatabaseStatus, type DatabaseStatus } from "@/adapters/sqlite/status";
import type { Env } from "@/config/env.schema";

/**
 * Composition root for the database. Today it only exposes a read-only status probe for the health
 * check; it never creates the file and never migrates (that is an explicit `npm run db:migrate`).
 */
export function getDatabaseStatus(env: Pick<Env, "DATABASE_PATH">): DatabaseStatus {
  return readDatabaseStatus(resolve(env.DATABASE_PATH));
}
