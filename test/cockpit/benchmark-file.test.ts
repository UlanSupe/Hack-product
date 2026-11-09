/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-return, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-argument -- edits untyped JSON */
import { beforeAll, describe, expect, it } from "vitest";

import { benchmarkResultFromRead, buildCockpit, findDetail } from "@/application/cockpit";
import {
  AUDIT_STATES,
  DECISIONS,
  SOURCES,
  benchmarkHashOf,
  mapBenchmark,
  parseBenchmarkFile,
  type BenchmarkFile,
} from "@/domain/cockpit";

import { resultsHashOf, type Report } from "../benchmark/aggregate";
import { runBenchmark } from "../benchmark/benchmark";

/** The persisted benchmark file, written by the real benchmark and read back by the Cockpit's own parser. */

let report: Report;
let text: string;
let file: BenchmarkFile;

beforeAll(async () => {
  report = await runBenchmark({ seed: 3, perFamily: 1 });
  text = JSON.stringify(report, null, 2);
  const parsed = parseBenchmarkFile(text);
  if (!parsed.ok) throw new Error(parsed.message);
  file = parsed.file;
}, 120_000);

describe("reading the file", () => {
  it("accepts what the benchmark wrote, with the metadata and every run", () => {
    expect(file.runs).toHaveLength(report.runs.length);
    expect(file).toMatchObject({
      seed: 3,
      perFamily: 1,
      resultsHash: report.resultsHash,
      generatedAt: report.meta.generatedAt,
    });
  });

  it("computes the integrity hash exactly as the benchmark does (two independent implementations agree)", () => {
    expect(benchmarkHashOf(report.runs)).toBe(report.resultsHash);
    expect(benchmarkHashOf(report.runs)).toBe(resultsHashOf(report.runs));
    expect(benchmarkHashOf([...report.runs].reverse())).toBe(report.resultsHash);
  });

  it("rejects an edited result, a removed run and an added run: the file is refused whole", () => {
    const edit = (f: (r: any) => void) => {
      const copy = JSON.parse(text);
      f(copy);
      return parseBenchmarkFile(JSON.stringify(copy));
    };
    expect(
      edit(
        (r) =>
          (r.runs[0].verdict = r.runs[0].verdict === "AS_EXPECTED" ? "FALSE_BLOCK" : "AS_EXPECTED"),
      ),
    ).toMatchObject({ ok: false, code: "HASH_MISMATCH" });
    expect(edit((r) => r.runs.pop())).toMatchObject({ ok: false, code: "HASH_MISMATCH" });
    expect(edit((r) => r.runs.push({ ...r.runs[0], runId: "forged" }))).toMatchObject({
      ok: false,
      code: "HASH_MISMATCH",
    });
    expect(edit((r) => (r.runs[3].metrics.moneyMovedMinor += 1))).toMatchObject({
      ok: false,
      code: "HASH_MISMATCH",
    });
    expect(edit((r) => (r.runs[3].actual = { forged: true }))).toMatchObject({
      ok: false,
      code: "HASH_MISMATCH",
    });
  });

  it("states its limit: someone who also recomputes the hash passes, so the check shows 'not edited after writing', nothing more", () => {
    const copy = JSON.parse(text);
    copy.runs[0].verdict = "FALSE_BLOCK";
    copy.resultsHash = benchmarkHashOf(copy.runs);
    expect(parseBenchmarkFile(JSON.stringify(copy)).ok).toBe(true);
  });

  it.each([
    ["not JSON", "{oops", "INVALID_JSON"],
    ["empty", "", "INVALID_JSON"],
    ["JSON of the wrong type", "[1,2,3]", "INVALID_SHAPE"],
    [
      "an object with no runs",
      JSON.stringify({ schemaVersion: "pactpay-benchmark/1" }),
      "INVALID_SHAPE",
    ],
    [
      "another schema version",
      JSON.stringify({ ...JSON.parse("{}"), schemaVersion: "other/9" }),
      "INVALID_SHAPE",
    ],
  ])("rejects a file that is %s", (_n, body, code) => {
    expect(parseBenchmarkFile(body)).toMatchObject({ ok: false, code });
  });

  it("rejects a run with a missing or mistyped field, naming it and never a stack or a path", () => {
    const copy = JSON.parse(text);
    delete copy.runs[2].caseId;
    const r = parseBenchmarkFile(JSON.stringify(copy));
    expect(r).toMatchObject({ ok: false, code: "INVALID_SHAPE" });
    if (!r.ok) expect(r.message).toMatch(/run 2 is malformed \(caseId\)/);
    copy.runs[2].caseId = "x";
    copy.runs[2].metrics = "no";
    expect(parseBenchmarkFile(JSON.stringify(copy))).toMatchObject({
      ok: false,
      code: "INVALID_SHAPE",
    });
  });

  it("turns a missing, unreadable or corrupt file into a status, never an exception", () => {
    expect(benchmarkResultFromRead({ kind: "MISSING" })).toMatchObject({ state: "MISSING" });
    expect(benchmarkResultFromRead({ kind: "ERROR", message: "boom" })).toEqual({
      state: "ERROR",
      message: "boom",
    });
    expect(benchmarkResultFromRead({ kind: "TEXT", text: "{" })).toMatchObject({ state: "ERROR" });
    expect(benchmarkResultFromRead({ kind: "TEXT", text })).toMatchObject({ state: "OK" });
  });
});

describe("the rows built from the real file", () => {
  it("has one row per run, unique ids, and only known values", () => {
    const rows = mapBenchmark(file);
    expect(rows).toHaveLength(file.runs.length);
    expect(new Set(rows.map((r) => r.id)).size).toBe(rows.length);
    for (const r of rows) {
      expect(SOURCES).toContain(r.source);
      expect(DECISIONS).toContain(r.decision);
      expect(AUDIT_STATES).toContain(r.auditChain);
      expect(r.timestamp).toBe(file.generatedAt);
      expect(r.auditChain).toBe("NOT_RECORDED");
      for (const n of [r.proposedMinor, r.approvedMinor])
        if (n !== null) expect(Number.isSafeInteger(n) && n >= 0).toBe(true);
    }
  });

  it("agrees with the run records it came from, one fact at a time", () => {
    const rows = new Map(mapBenchmark(file).map((r) => [r.refId, r]));
    for (const run of file.runs) {
      const row = rows.get(run.runId);
      expect(row, run.runId).toBeDefined();
      expect(row?.scenario).toBe(run.caseId);
      expect(row?.category).toBe(run.mechanism);
      expect(row?.buyerMode).toBe(run.mode);
      if (run.status === "COMPLETED") expect(row?.verification).toBe(run.verdict);
      else expect(row?.verification).toBe(run.status);
      if (run.status === "COMPLETED" && run.layer === "ARENA") {
        expect(row?.movedMinor).toBe(run.metrics.moneyMovedMinor);
        // only a protected run has an approval; the unsafe baseline executes unchecked, so nothing was approved
        expect(row?.approvedMinor).toBe(
          run.mode === "PROTECTED" ? run.metrics.moneyMovedMinor : null,
        );
      }
    }
  });

  it("shows the unsafe baseline paying where the benchmark recorded it paying, and the protected buyer not", () => {
    const rows = mapBenchmark(file);
    const baselinePaid = file.runs.filter(
      (r) =>
        r.layer === "ARENA" &&
        r.mode === "UNSAFE_BASELINE" &&
        r.status === "COMPLETED" &&
        r.metrics.moneyMovedMinor > 0,
    ).length;
    expect(rows.filter((r) => r.decision === "EXECUTED_UNCHECKED").length).toBeGreaterThan(0);
    expect(
      rows.filter((r) => r.buyerMode === "UNSAFE_BASELINE" && r.paymentStatus === "SIMULATED_PAID"),
    ).toHaveLength(baselinePaid);
    expect(
      rows.filter((r) => r.buyerMode === "PROTECTED" && r.decision === "EXECUTED_UNCHECKED"),
    ).toHaveLength(0);
  });

  it("carries the benchmark's own verdicts: a protected run that leaked would show as UNEXPECTED_ALLOWED, and none does", () => {
    const rows = mapBenchmark(file);
    expect(
      rows.filter((r) => r.buyerMode === "PROTECTED" && r.verification === "UNEXPECTED_ALLOWED"),
    ).toHaveLength(
      report.summary.protected.arena.verdicts.UNEXPECTED_ALLOWED +
        report.summary.protected.system.verdicts.UNEXPECTED_ALLOWED,
    );
    expect(rows.filter((r) => r.verification === "SKIPPED")).toHaveLength(
      file.runs.filter((r) => r.status === "SKIPPED").length,
    );
  });

  it("maps system scenarios from their recorded outcome (a spot check on real records)", () => {
    const rows = new Map(mapBenchmark(file).map((r) => [r.refId, r]));
    expect(rows.get("APR-01|PROTECTED|-")).toMatchObject({
      decision: "HELD_FOR_HUMAN",
      reasonCodes: ["APPROVAL_REQUIRED"],
      paymentStatus: "AGREED",
    });
    expect(rows.get("HOOK-01|PROTECTED|-")).toMatchObject({
      decision: "DENIED",
      reasonSource: "OUTCOME",
    });
    expect(rows.get("DUP-04|PROTECTED|-")).toMatchObject({
      paymentStatus: "CAPTURED",
      approvedMinor: 8_000,
    });
  });

  it("builds the whole cockpit from file alone, newest first, and finds every row's detail", () => {
    const data = buildCockpit({
      live: { state: "LOCKED", message: "locked" },
      benchmark: { state: "OK", file },
    });
    expect(data.sources.database).toMatchObject({ state: "LOCKED" });
    expect(data.sources.benchmark).toMatchObject({
      state: "OK",
      rows: file.runs.length,
      resultsHash: file.resultsHash,
    });
    expect(data.rows).toHaveLength(file.runs.length);
    for (const r of data.rows.slice(0, 40)) {
      const d = findDetail(
        { live: { state: "LOCKED", message: "" }, benchmark: { state: "OK", file } },
        r.id,
      );
      expect(d?.row.id).toBe(r.id);
      expect(d?.sections.length).toBeGreaterThan(2);
    }
    expect(
      findDetail(
        { live: { state: "LOCKED", message: "" }, benchmark: { state: "OK", file } },
        "bench:nope",
      ),
    ).toBeUndefined();
    expect(
      findDetail(
        { live: { state: "LOCKED", message: "" }, benchmark: { state: "MISSING", message: "" } },
        data.rows[0]?.id ?? "",
      ),
    ).toBeUndefined();
  });
});
