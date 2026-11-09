import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { all, openDatabase, run } from "@/adapters/sqlite/database";
import {
  appliedMigrations,
  loadMigrations,
  migrate,
  migrationStatus,
} from "@/adapters/sqlite/migrate";
import {
  RECONCILE_TARGETS,
  TRANSITIONS,
  TX_STATES,
  TERMINAL_STATES,
  IN_FLIGHT_STATES,
} from "@/domain/transaction-states";

import { T0, cell, count, expectRejected, freshDb } from "./helpers";

describe("migration runner", () => {
  it("applies every migration once, in order, and is idempotent", () => {
    const db = openDatabase(":memory:");
    const applied = migrate(db, { now: T0 });
    expect(applied).toEqual([
      "0001_reference_and_mandates",
      "0002_transactions_audit_negotiation",
      "0003_payment_attempts_idempotency",
      "0004_attack_runs",
      "0005_mandate_policy",
      "0006_negotiation_workflow",
      "0007_webhook_events",
      "0008_audit_chain_identity",
    ]);
    expect(migrate(db, { now: T0 })).toEqual([]);
    expect(appliedMigrations(db).map((a) => a.id)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(migrationStatus(db).pending).toEqual([]);
  });

  it("loads contiguous migrations with SHA-256 checksums", () => {
    const ms = loadMigrations();
    expect(ms.map((m) => m.id)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    for (const m of ms) expect(m.checksum).toMatch(/^[0-9a-f]{64}$/);
  });

  it("detects an applied migration that was edited afterwards", () => {
    const db = freshDb();
    const ms = loadMigrations().map((m) => ({ ...m }));
    ms[1]!.sql += "\n-- sneaky edit";
    ms[1]!.checksum = "f".repeat(64);
    expectRejected(() => migrationStatus(db, ms), /modified after being applied/);
  });

  it("detects an applied migration that disappeared from disk", () => {
    const db = freshDb();
    expectRejected(() => migrationStatus(db, loadMigrations().slice(0, 4)), /no longer exists/);
  });

  it("refuses migration files whose ids are not contiguous", () => {
    const dir = mkdtempSync(join(tmpdir(), "pactpay-mig-"));
    writeFileSync(join(dir, "0001_a.sql"), "CREATE TABLE a (x TEXT) STRICT;");
    writeFileSync(join(dir, "0003_c.sql"), "CREATE TABLE c (x TEXT) STRICT;");
    expectRejected(() => loadMigrations(dir), /contiguous/);
  });

  it("refuses badly named migration files", () => {
    const dir = mkdtempSync(join(tmpdir(), "pactpay-mig-"));
    writeFileSync(join(dir, "init.sql"), "SELECT 1;");
    expectRejected(() => loadMigrations(dir), /bad migration file name/);
  });

  it("rolls a failing migration back completely and records nothing", () => {
    const db = freshDb();
    const ms = loadMigrations();
    const bad = {
      id: 6,
      name: "broken",
      sql: "CREATE TABLE tmp_probe (a TEXT) STRICT; INSERT INTO missing_table VALUES (1);",
      checksum: "b".repeat(64),
    };
    expectRejected(
      () => migrate(db, { migrations: [...ms, bad] }),
      /migration 6_broken failed and was rolled back/,
    );
    expect(all(db, "SELECT name FROM sqlite_master WHERE name = 'tmp_probe'")).toEqual([]);
    expect(count(db, "schema_migrations")).toBe(8);
  });
});

describe("schema guarantees", () => {
  const db = freshDb();
  const tables = all<{ name: string }>(
    db,
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
  ).map((t) => t.name);

  it("covers every entity the persistence layer needs", () => {
    for (const t of [
      "mandates",
      "sellers",
      "seller_catalog_items",
      "offers",
      "offer_lines",
      "policy_decisions",
      "agreements",
      "transactions",
      "payment_attempts",
      "audit_events",
      "attack_runs",
      "attack_run_steps",
      "agent_recommendations",
      "idempotency_keys",
      "tx_states",
      "tx_transitions",
      "reconcile_targets",
      "schema_migrations",
    ])
      expect(tables, t).toContain(t);
  });

  it("enforces foreign keys and has no dangling references", () => {
    expect(cell(db, "PRAGMA foreign_keys")).toBe(1);
    expect(all(db, "PRAGMA foreign_key_check")).toEqual([]);
  });

  it("makes every table STRICT", () => {
    const rows = all<{ name: string; strict: number }>(db, "PRAGMA table_list").filter((r) =>
      tables.includes(r.name),
    );
    expect(rows.length).toBe(tables.length);
    for (const r of rows) expect(r.strict, r.name).toBe(1);
  });

  it("stores every *_minor column as INTEGER and pairs money with an explicit currency column", () => {
    for (const t of tables) {
      const cols = all<{ name: string; type: string }>(db, `PRAGMA table_info(${t})`);
      const money = cols.filter((c) => c.name.endsWith("_minor"));
      for (const c of money) expect(c.type, `${t}.${c.name}`).toBe("INTEGER");
      if (money.length > 0)
        expect(
          cols.map((c) => c.name),
          `${t} needs a currency column`,
        ).toContain("currency");
    }
  });

  it("has no column that could hold a secret or credential", () => {
    const secretish = /secret|token|password|passcode|credential|api_?key|card|cvv|bearer|private/i;
    for (const t of tables) {
      for (const c of all<{ name: string }>(db, `PRAGMA table_info(${t})`))
        expect(c.name, `${t}.${c.name}`).not.toMatch(secretish);
    }
  });

  it("rejects non-integer, negative, oversized and mistyped money at the database", () => {
    const row = (v: unknown) => () =>
      run(
        db,
        "INSERT INTO seller_catalog_items (seller_id, sku, unit_price_minor, currency) VALUES ('x', 'S', ?, 'USD')",
        [v as number],
      );
    // FK to a missing seller would also fail, so assert the CHECK/type error specifically with PRAGMA off:
    db.exec("PRAGMA foreign_keys = OFF");
    expectRejected(row(1.5), /cannot store REAL value in INTEGER column/);
    expectRejected(row("abc"), /cannot store TEXT value in INTEGER column/);
    expectRejected(row(-1), /CHECK constraint failed/);
    expectRejected(row(2 ** 53), /CHECK constraint failed/);
    db.exec("PRAGMA foreign_keys = ON");
  });
});

describe("state reference tables", () => {
  const db = freshDb();

  it("match src/domain/transaction-states.ts exactly (drift fails here)", () => {
    const states = all<{ state: string; is_terminal: number; is_in_flight: number }>(
      db,
      "SELECT * FROM tx_states",
    );
    expect(states.map((s) => s.state).sort()).toEqual([...TX_STATES].sort());
    expect(
      states
        .filter((s) => s.is_terminal)
        .map((s) => s.state)
        .sort(),
    ).toEqual([...TERMINAL_STATES].sort());
    expect(
      states
        .filter((s) => s.is_in_flight)
        .map((s) => s.state)
        .sort(),
    ).toEqual([...IN_FLIGHT_STATES].sort());

    const edges = all<{ from_state: string; to_state: string }>(
      db,
      "SELECT from_state, to_state FROM tx_transitions",
    ).map((e) => `${e.from_state}>${e.to_state}`);
    expect(edges.sort()).toEqual(TRANSITIONS.map(([f, t]) => `${f}>${t}`).sort());

    const rec = all<{ in_flight_state: string; to_state: string }>(
      db,
      "SELECT in_flight_state, to_state FROM reconcile_targets",
    ).map((r) => `${r.in_flight_state}>${r.to_state}`);
    expect(rec.sort()).toEqual(
      Object.entries(RECONCILE_TARGETS)
        .flatMap(([f, ts2]) => ts2.map((t) => `${f}>${t}`))
        .sort(),
    );
  });

  it("are read-only at runtime", () => {
    for (const t of ["tx_states", "tx_transitions", "reconcile_targets"]) {
      expectRejected(() => db.exec(`DELETE FROM ${t}`), /read-only/);
      expectRejected(
        () =>
          db.exec(
            `UPDATE ${t} SET ${t === "tx_states" ? "is_terminal = 1" : "to_state = 'FAILED'"}`,
          ),
        /read-only/,
      );
    }
    expectRejected(
      () =>
        db.exec(
          "INSERT INTO tx_transitions (from_state, to_state) VALUES ('VOIDED', 'AUTHORIZED')",
        ),
      /read-only/,
    );
  });
});
