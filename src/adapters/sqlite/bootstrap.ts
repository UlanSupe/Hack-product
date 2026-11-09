import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

import { verifyChain } from "./audit.ts";
import { openDatabase } from "./database.ts";
import { migrate } from "./migrate.ts";
import { seedDevelopment } from "./seed.ts";

/**
 * What a hosted instance does before it serves: create the database file if it is missing, apply every pending
 * migration (they are idempotent and ordered), and, only when asked, add the synthetic demo data (two made-up sellers
 * and one mandate; idempotent, no credentials, no PayPal identifiers). Returns what happened, as counts and flags only.
 *
 * Migrations run at startup, in the one process that owns the file, never from a request.
 */
export type BootstrapResult = {
  applied: string[];
  seeded: boolean;
  chain: "VERIFIED" | "FAILED";
  auditEvents: number;
};

export function prepareDatabase(
  path: string,
  options: { seed: boolean; now: string },
): BootstrapResult {
  mkdirSync(dirname(path), { recursive: true });
  const db = openDatabase(path);
  try {
    const applied = migrate(db);
    const seeded = options.seed ? seedDevelopment(db, options.now).seeded : false;
    const chain = verifyChain(db);
    return {
      applied,
      seeded,
      chain: chain.status === "VERIFIED" ? "VERIFIED" : "FAILED",
      auditEvents: chain.status === "VERIFIED" ? chain.count : 0,
    };
  } finally {
    db.close();
  }
}
