import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { sha256Hex } from "../../domain/canonical.ts";
import { all, inTransaction, type Db } from "./database.ts";

// Built from the module's own directory rather than `new URL("./migrations/", ...)`: a bundler reads the latter as an
// asset import and fails on a directory, which would stop any server module that imports `migrate` from building.
export const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), "migrations");

export type Migration = { id: number; name: string; sql: string; checksum: string };
export type AppliedMigration = { id: number; name: string; checksum: string; applied_at: string };

export class MigrationError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "MigrationError";
  }
}

/** Reads `NNNN_name.sql` files. Ids must be contiguous from 1. CRLF is normalised before hashing. */
export function loadMigrations(dir: string = MIGRATIONS_DIR): Migration[] {
  const migrations = readdirSync(dir)
    .filter((f) => f.endsWith(".sql"))
    .sort()
    .map((file): Migration => {
      const m = /^(\d{4})_([a-z0-9_]+)\.sql$/.exec(file);
      if (!m) throw new MigrationError(`bad migration file name: ${file}`);
      const sql = readFileSync(`${dir}/${file}`, "utf8").replace(/\r\n/g, "\n");
      return { id: Number(m[1]), name: m[2] as string, sql, checksum: sha256Hex(sql) };
    });
  migrations.forEach((m, i) => {
    if (m.id !== i + 1)
      throw new MigrationError(
        `migration ids must be contiguous from 1 (found ${m.id} at position ${i + 1})`,
      );
  });
  return migrations;
}

function ensureTable(db: Db): void {
  db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    checksum TEXT NOT NULL,
    applied_at TEXT NOT NULL
  ) STRICT`);
}

export function appliedMigrations(db: Db): AppliedMigration[] {
  ensureTable(db);
  return all<AppliedMigration>(
    db,
    "SELECT id, name, checksum, applied_at FROM schema_migrations ORDER BY id",
  );
}

export type MigrationStatus = { applied: AppliedMigration[]; pending: Migration[] };

/** Throws if an applied migration was edited or removed (never edit an applied migration). */
export function migrationStatus(
  db: Db,
  migrations: Migration[] = loadMigrations(),
): MigrationStatus {
  const applied = appliedMigrations(db);
  applied.forEach((a, i) => {
    const m = migrations[i];
    if (a.id !== i + 1)
      throw new MigrationError(`applied migrations have a gap at position ${i + 1}`);
    if (!m)
      throw new MigrationError(`applied migration ${a.id}_${a.name} no longer exists on disk`);
    if (m.name !== a.name || m.checksum !== a.checksum) {
      throw new MigrationError(
        `applied migration ${a.id}_${a.name} was modified after being applied; add a new migration instead`,
      );
    }
  });
  return { applied, pending: migrations.slice(applied.length) };
}

/** Applies pending migrations in order, each in its own transaction. Returns what was applied. */
export function migrate(
  db: Db,
  options: { migrations?: Migration[]; now?: string } = {},
): string[] {
  const migrations = options.migrations ?? loadMigrations();
  const { pending } = migrationStatus(db, migrations);
  const done: string[] = [];
  for (const m of pending) {
    try {
      inTransaction(db, () => {
        db.exec(m.sql);
        db.prepare(
          "INSERT INTO schema_migrations (id, name, checksum, applied_at) VALUES (?, ?, ?, ?)",
        ).run(m.id, m.name, m.checksum, options.now ?? new Date().toISOString());
      });
    } catch (err) {
      throw new MigrationError(
        `migration ${m.id}_${m.name} failed and was rolled back: ${(err as Error).message}`,
        { cause: err },
      );
    }
    done.push(`${String(m.id).padStart(4, "0")}_${m.name}`);
  }
  const violations = all<Record<string, unknown>>(db, "PRAGMA foreign_key_check");
  if (violations.length > 0)
    throw new MigrationError("foreign_key_check reported violations after migrating");
  return done;
}
