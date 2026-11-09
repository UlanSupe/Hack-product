import { DatabaseSync } from "node:sqlite";

export type Db = DatabaseSync;
export type SqlParam = string | number | bigint | null;

/**
 * Opens a SQLite database with the pragmas the schema's guarantees depend on.
 * Foreign keys are OFF by default in SQLite per connection, so this verifies they are on.
 */
export function openDatabase(path: string, options: { readOnly?: boolean } = {}): Db {
  const readOnly = options.readOnly ?? false;
  const db = new DatabaseSync(path, { readOnly });
  try {
    db.exec("PRAGMA foreign_keys = ON");
    db.exec("PRAGMA busy_timeout = 5000");
    if (!readOnly && path !== ":memory:") db.exec("PRAGMA journal_mode = WAL");
    const fk = db.prepare("PRAGMA foreign_keys").get() as { foreign_keys: number } | undefined;
    if (fk?.foreign_keys !== 1)
      throw new Error("SQLite foreign key enforcement could not be enabled");
  } catch (err) {
    db.close();
    throw err;
  }
  return db;
}

export function one<T>(db: Db, sql: string, params: SqlParam[] = []): T | undefined {
  return db.prepare(sql).get(...params) as T | undefined;
}

export function all<T>(db: Db, sql: string, params: SqlParam[] = []): T[] {
  return db.prepare(sql).all(...params) as T[];
}

export function run(db: Db, sql: string, params: SqlParam[] = []): { changes: number } {
  const r = db.prepare(sql).run(...params);
  return { changes: Number(r.changes) };
}

let savepointCounter = 0;

/**
 * Runs `fn` atomically. Top level: BEGIN IMMEDIATE (takes the write lock up front, so
 * read-check-write sequences cannot interleave). Nested: a SAVEPOINT. Any throw rolls back.
 * Never call a remote service inside `fn`.
 */
export function inTransaction<T>(db: Db, fn: () => T): T {
  if (db.isTransaction) {
    const sp = `sp_${++savepointCounter}`;
    db.exec(`SAVEPOINT ${sp}`);
    try {
      const result = fn();
      db.exec(`RELEASE ${sp}`);
      return result;
    } catch (err) {
      db.exec(`ROLLBACK TO ${sp}`);
      db.exec(`RELEASE ${sp}`);
      throw err;
    }
  }
  db.exec("BEGIN IMMEDIATE");
  try {
    const result = fn();
    db.exec("COMMIT");
    return result;
  } catch (err) {
    if (db.isTransaction) db.exec("ROLLBACK");
    throw err;
  }
}
