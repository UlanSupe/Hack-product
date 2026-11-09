import { existsSync } from "node:fs";

import { all, one, openDatabase, type Db } from "./database.ts";

export type DatabaseStatus =
  | { state: "uninitialized" }
  | { state: "ready"; migrations: number; latest: string }
  | { state: "error" };

/**
 * Read-only probe used by the health check. Never creates or modifies the file, and never
 * returns error text (which could contain paths).
 */
export function readDatabaseStatus(path: string): DatabaseStatus {
  if (!existsSync(path)) return { state: "uninitialized" };
  let db: Db | undefined;
  try {
    db = openDatabase(path, { readOnly: true });
    const table = one(
      db,
      "SELECT 1 AS x FROM sqlite_master WHERE type = 'table' AND name = 'schema_migrations'",
    );
    if (!table) return { state: "uninitialized" };
    const rows = all<{ id: number; name: string }>(
      db,
      "SELECT id, name FROM schema_migrations ORDER BY id",
    );
    const last = rows[rows.length - 1];
    if (!last) return { state: "uninitialized" };
    return {
      state: "ready",
      migrations: rows.length,
      latest: `${String(last.id).padStart(4, "0")}_${last.name}`,
    };
  } catch {
    return { state: "error" };
  } finally {
    db?.close();
  }
}
