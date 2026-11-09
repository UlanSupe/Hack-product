// Database CLI: node scripts/db.ts <migrate|status|seed|reset --yes>
// Runs on Node's native TypeScript support (no build step); see docs/DATABASE.md.
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve } from "node:path";

import { parseEnv } from "../src/config/env.schema.ts";
import { verifyChain } from "../src/adapters/sqlite/audit.ts";
import { all, openDatabase } from "../src/adapters/sqlite/database.ts";
import { migrate, migrationStatus } from "../src/adapters/sqlite/migrate.ts";
import { seedDevelopment } from "../src/adapters/sqlite/seed.ts";

for (const file of [".env.local", ".env"]) {
  if (existsSync(file)) process.loadEnvFile(file); // never overrides variables that are already set
}

const parsed = parseEnv(process.env);
if (!parsed.ok) {
  console.error("Invalid environment:");
  for (const i of parsed.issues) console.error(`  ${i.path}: ${i.message}`);
  process.exit(1);
}
const dbPath = resolve(parsed.env.DATABASE_PATH);
const [command, ...flags] = process.argv.slice(2);

function usage(): never {
  console.error("usage: node scripts/db.ts <migrate | status | seed | reset --yes>");
  process.exit(2);
}

function insideProject(path: string): boolean {
  const rel = relative(process.cwd(), path);
  return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
}

switch (command) {
  case "migrate": {
    mkdirSync(dirname(dbPath), { recursive: true });
    const db = openDatabase(dbPath);
    const applied = migrate(db);
    console.log(applied.length ? `applied: ${applied.join(", ")}` : "already up to date");
    db.close();
    break;
  }
  case "status": {
    if (!existsSync(dbPath)) {
      console.log(`no database at ${dbPath} (run: npm run db:migrate)`);
      break;
    }
    const db = openDatabase(dbPath, { readOnly: true });
    const { applied, pending } = migrationStatus(db);
    console.log(`database: ${dbPath}`);
    console.log(
      `applied (${applied.length}): ${applied.map((a) => `${a.id}_${a.name}`).join(", ") || "none"}`,
    );
    console.log(
      `pending (${pending.length}): ${pending.map((p) => `${p.id}_${p.name}`).join(", ") || "none"}`,
    );
    if (applied.length > 0) {
      const fk = all(db, "PRAGMA foreign_key_check");
      console.log(`foreign_key_check: ${fk.length === 0 ? "ok" : `${fk.length} violation(s)`}`);
      const chain = verifyChain(db);
      console.log(
        chain.status === "VERIFIED"
          ? `audit chain: VERIFIED (${chain.count} events, ${chain.legacyCount} legacy; local tamper-evidence only, not a signature)`
          : `audit chain: FAILED at seq ${chain.firstBadSeq} (event ${chain.firstBadEventId ?? "n/a"}): ${chain.code}: ${chain.reason}`,
      );
    }
    db.close();
    break;
  }
  case "seed": {
    if (process.env.NODE_ENV === "production") {
      console.error("refusing to seed when NODE_ENV=production");
      process.exit(1);
    }
    if (!existsSync(dbPath)) {
      console.error("database does not exist; run: npm run db:migrate");
      process.exit(1);
    }
    const db = openDatabase(dbPath);
    if (migrationStatus(db).pending.length > 0) {
      console.error("pending migrations; run: npm run db:migrate");
      process.exit(1);
    }
    const { seeded } = seedDevelopment(db, new Date().toISOString());
    console.log(
      seeded ? "seeded synthetic development data" : "seed already applied; nothing to do",
    );
    db.close();
    break;
  }
  case "reset": {
    if (!flags.includes("--yes")) {
      console.error(
        `reset deletes ${dbPath} (and its -wal/-shm files). Re-run with --yes to confirm.`,
      );
      process.exit(1);
    }
    if (!insideProject(dbPath)) {
      console.error(`refusing to delete ${dbPath}: it is outside the project directory`);
      process.exit(1);
    }
    for (const f of [dbPath, `${dbPath}-wal`, `${dbPath}-shm`]) rmSync(f, { force: true });
    console.log(`deleted ${dbPath}`);
    break;
  }
  default:
    usage();
}
