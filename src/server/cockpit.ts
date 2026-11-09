import "server-only";

import { join, resolve } from "node:path";

import { readBenchmarkFile } from "@/adapters/benchmark/file";
import { openDatabase } from "@/adapters/sqlite/database";
import { readLiveFacts } from "@/adapters/sqlite/cockpit-store";
import { readDatabaseStatus } from "@/adapters/sqlite/status";
import {
  benchmarkResultFromRead,
  buildCockpit,
  type CockpitData,
  type CockpitInput,
} from "@/application/cockpit";
import type { LiveResult } from "@/ports/cockpit-source";
import { getEnv } from "./env";
import { HttpError } from "./http";
import { authenticateOperator } from "./operator-guard";

/** Migration 0008 added the audit provenance column the Cockpit reads. */
const REQUIRED_MIGRATIONS = 8;

function liveFor(headers: Headers): LiveResult {
  // Database rows are the operator's: the same session as the other operator consoles, read-only (no CSRF needed).
  try {
    authenticateOperator(new Request("http://cockpit.local/", { headers }), { mutating: false });
  } catch (err) {
    const message =
      err instanceof HttpError && err.code === "OPERATOR_NOT_CONFIGURED"
        ? "Operator access is not configured on this server, so database rows are not shown."
        : "Sign in as the operator (on the Negotiations page) to include database rows.";
    return { state: "LOCKED", message };
  }

  let path: string;
  try {
    path = resolve(getEnv().DATABASE_PATH);
  } catch {
    return {
      state: "ERROR",
      message: "The server configuration is invalid, so the database could not be located.",
    };
  }
  const status = readDatabaseStatus(path);
  if (status.state === "uninitialized")
    return {
      state: "UNAVAILABLE",
      message:
        "The database does not exist yet. Run `npm run db:migrate` (and `npm run db:seed` for demo data).",
    };
  if (status.state === "error")
    return { state: "ERROR", message: "The database could not be opened." };
  if (status.migrations < REQUIRED_MIGRATIONS)
    return {
      state: "UNAVAILABLE",
      message: `The database is at migration ${status.latest}; the Cockpit needs ${REQUIRED_MIGRATIONS}. Run \`npm run db:migrate\`.`,
    };

  const db = openDatabase(path, { readOnly: true });
  try {
    return { state: "OK", facts: readLiveFacts(db) };
  } catch {
    return { state: "ERROR", message: "The database could not be read." };
  } finally {
    db.close();
  }
}

/** Reads both sources for one request. Never throws: a source that fails becomes a status the page shows. */
export function loadCockpitInput(headers: Headers): CockpitInput {
  return {
    live: liveFor(headers),
    benchmark: benchmarkResultFromRead(
      readBenchmarkFile(join(process.cwd(), "benchmark-results", "benchmark.json")),
    ),
  };
}

export function loadCockpit(headers: Headers): CockpitData {
  return buildCockpit(loadCockpitInput(headers));
}
