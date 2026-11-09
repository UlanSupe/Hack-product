import { describe, expect, it } from "vitest";

import {
  ALL,
  AUDIT_STATES,
  BUYER_MODES,
  DECISIONS,
  NO_FILTERS,
  SOURCES,
  applyFilters,
  defaultSort,
  filterOptions,
  isFiltered,
  parseFilters,
  serializeFilters,
  tally,
  type CockpitFilters,
  type CockpitRow,
} from "@/domain/cockpit";
import { makeRng } from "../benchmark/rng";

const row = (over: Partial<CockpitRow>): CockpitRow => ({
  id: "x",
  source: "TRANSACTION",
  timestamp: "2026-10-12T09:00:00.000Z",
  refId: "x",
  scenario: null,
  category: "COMPUTE",
  buyerMode: "PROTECTED",
  currency: "USD",
  proposedMinor: 8_000,
  approvedMinor: 8_000,
  movedMinor: 0,
  decision: "ALLOWED",
  reasonCodes: [],
  reasonSource: null,
  paymentStatus: "AGREED",
  verification: "NOT_APPLICABLE",
  verificationBasis: "NONE",
  auditChain: "VERIFIED",
  ...over,
});

const ROWS: CockpitRow[] = [
  row({ id: "tx:a", refId: "tx_a", scenario: "neg_1", timestamp: "2026-10-12T09:00:00.000Z" }),
  row({
    id: "tx:b",
    refId: "tx_b",
    scenario: "neg_2",
    timestamp: "2026-10-13T09:00:00.000Z",
    decision: "HELD_FOR_HUMAN",
    reasonCodes: ["APPROVAL_REQUIRED"],
    reasonSource: "POLICY",
    paymentStatus: "AGREED",
  }),
  row({
    id: "tx:c",
    refId: "tx_c",
    timestamp: "2026-10-14T09:00:00.000Z",
    paymentStatus: "CAPTURED",
    verification: "WEBHOOK_VERIFIED",
    verificationBasis: "PAYPAL",
  }),
  row({
    id: "refused:1",
    source: "REFUSED_OFFER",
    refId: "ofr_9",
    scenario: "neg_3",
    decision: "DENIED",
    reasonCodes: ["OVER_PER_TX_CAP"],
    reasonSource: "POLICY",
    paymentStatus: "NO_TRANSACTION",
    timestamp: "2026-10-15T09:00:00.000Z",
  }),
  row({
    id: "bench:S1|PROTECTED|SUSCEPTIBLE",
    source: "BENCHMARK",
    refId: "S1|PROTECTED|SUSCEPTIBLE",
    scenario: "S1",
    category: "PROMPT_INJECTION",
    decision: "DENIED",
    reasonCodes: ["OVER_CAP"],
    reasonSource: "SPEC",
    paymentStatus: "NO_PAYMENT",
    verification: "AS_EXPECTED",
    verificationBasis: "BENCHMARK",
    auditChain: "NOT_RECORDED",
    timestamp: "2026-11-04T10:00:00.000Z",
  }),
  row({
    id: "bench:S1|UNSAFE_BASELINE|SUSCEPTIBLE",
    source: "BENCHMARK",
    refId: "S1|UNSAFE_BASELINE|SUSCEPTIBLE",
    buyerMode: "UNSAFE_BASELINE",
    scenario: "S1",
    category: "PROMPT_INJECTION",
    decision: "EXECUTED_UNCHECKED",
    paymentStatus: "SIMULATED_PAID",
    verification: "UNEXPECTED_ALLOWED",
    verificationBasis: "BENCHMARK",
    auditChain: "NOT_RECORDED",
    timestamp: "2026-11-04T10:00:00.000Z",
  }),
  row({ id: "tx:broken", refId: "tx_broken", auditChain: "BROKEN", timestamp: null }),
];

const ids = (f: Partial<CockpitFilters>) =>
  applyFilters(ROWS, { ...NO_FILTERS, ...f }).map((r) => r.id);

describe("filtering", () => {
  it("no filter keeps every row, in the given order", () => {
    expect(applyFilters(ROWS, NO_FILTERS)).toEqual(ROWS);
  });

  it.each([
    [
      "source",
      { source: "BENCHMARK" },
      ["bench:S1|PROTECTED|SUSCEPTIBLE", "bench:S1|UNSAFE_BASELINE|SUSCEPTIBLE"],
    ],
    ["source", { source: "REFUSED_OFFER" }, ["refused:1"]],
    ["buyer mode", { mode: "UNSAFE_BASELINE" }, ["bench:S1|UNSAFE_BASELINE|SUSCEPTIBLE"]],
    [
      "category",
      { category: "PROMPT_INJECTION" },
      ["bench:S1|PROTECTED|SUSCEPTIBLE", "bench:S1|UNSAFE_BASELINE|SUSCEPTIBLE"],
    ],
    ["decision", { decision: "HELD_FOR_HUMAN" }, ["tx:b"]],
    ["decision", { decision: "EXECUTED_UNCHECKED" }, ["bench:S1|UNSAFE_BASELINE|SUSCEPTIBLE"]],
    ["payment status", { payment: "CAPTURED" }, ["tx:c"]],
    ["verification", { verification: "WEBHOOK_VERIFIED" }, ["tx:c"]],
    ["audit chain", { audit: "BROKEN" }, ["tx:broken"]],
    [
      "audit chain",
      { audit: "NOT_RECORDED" },
      ["bench:S1|PROTECTED|SUSCEPTIBLE", "bench:S1|UNSAFE_BASELINE|SUSCEPTIBLE"],
    ],
  ] as const)("by %s: %j", (_n, f, want) => {
    expect(ids(f as Partial<CockpitFilters>)).toEqual(want);
  });

  it("combines filters with AND", () => {
    expect(ids({ source: "BENCHMARK", decision: "DENIED" })).toEqual([
      "bench:S1|PROTECTED|SUSCEPTIBLE",
    ]);
    expect(ids({ source: "TRANSACTION", decision: "DENIED" })).toEqual([]);
    expect(ids({ mode: "PROTECTED", audit: "VERIFIED", decision: "ALLOWED" })).toEqual([
      "tx:a",
      "tx:c",
    ]);
  });

  it("searches ids, scenario, category, decision, reason codes and statuses, ignoring case and padding", () => {
    expect(ids({ q: "OVER_PER_TX" })).toEqual(["refused:1"]);
    expect(ids({ q: "  neg_2  " })).toEqual(["tx:b"]);
    expect(ids({ q: "prompt_injection" })).toHaveLength(2);
    expect(ids({ q: "simulated_paid" })).toEqual(["bench:S1|UNSAFE_BASELINE|SUSCEPTIBLE"]);
    expect(ids({ q: "held_for_human" })).toEqual(["tx:b"]);
    expect(ids({ q: "no such thing" })).toEqual([]);
  });

  it("filters an inclusive date range on the row's date, and drops rows with no timestamp when a range is set", () => {
    expect(ids({ from: "2026-10-13", to: "2026-10-14" })).toEqual(["tx:b", "tx:c"]);
    expect(ids({ from: "2026-11-04" })).toEqual([
      "bench:S1|PROTECTED|SUSCEPTIBLE",
      "bench:S1|UNSAFE_BASELINE|SUSCEPTIBLE",
    ]);
    expect(ids({ to: "2026-10-12" })).toEqual(["tx:a"]);
    expect(ids({ from: "2027-01-01" })).toEqual([]);
    expect(ids({ from: "2026-10-12", to: "2026-10-12" })).toEqual(["tx:a"]);
    expect(applyFilters(ROWS, NO_FILTERS).map((r) => r.id)).toContain("tx:broken");
  });

  it("never mutates its input", () => {
    const copy = structuredClone(ROWS);
    applyFilters(ROWS, { ...NO_FILTERS, q: "a", source: "TRANSACTION" });
    expect(ROWS).toEqual(copy);
  });
});

describe("filter menus offer only what exists", () => {
  const o = filterOptions(ROWS);
  it("lists the values in the rows and nothing else", () => {
    expect(o.sources).toEqual(["TRANSACTION", "REFUSED_OFFER", "BENCHMARK"]);
    expect(o.modes).toEqual(["PROTECTED", "UNSAFE_BASELINE"]);
    expect(o.categories).toEqual(["COMPUTE", "PROMPT_INJECTION"]);
    expect(o.decisions).toEqual(["ALLOWED", "DENIED", "HELD_FOR_HUMAN", "EXECUTED_UNCHECKED"]);
    expect(o.audits).toEqual(["VERIFIED", "BROKEN", "NOT_RECORDED"]);
    expect(o.payments).toEqual([
      "AGREED",
      "CAPTURED",
      "NO_PAYMENT",
      "NO_TRANSACTION",
      "SIMULATED_PAID",
    ]);
  });
  it("is empty for no rows", () => {
    expect(filterOptions([])).toEqual({
      sources: [],
      modes: [],
      categories: [],
      decisions: [],
      payments: [],
      verifications: [],
      audits: [],
    });
  });
  it("every offered value actually selects at least one row", () => {
    for (const s of o.sources) expect(ids({ source: s }).length).toBeGreaterThan(0);
    for (const d of o.decisions) expect(ids({ decision: d }).length).toBeGreaterThan(0);
    for (const p of o.payments) expect(ids({ payment: p }).length).toBeGreaterThan(0);
  });
});

describe("the URL query", () => {
  it("round-trips a filter set", () => {
    const f: CockpitFilters = {
      q: "neg 1",
      source: "BENCHMARK",
      mode: "PROTECTED",
      category: "PROMPT_INJECTION",
      decision: "DENIED",
      payment: "NO_PAYMENT",
      verification: "AS_EXPECTED",
      audit: "NOT_RECORDED",
      from: "2026-10-01",
      to: "2026-11-30",
    };
    const qs = serializeFilters(f);
    expect(parseFilters(Object.fromEntries(new URLSearchParams(qs)))).toEqual(f);
  });
  it("omits defaults, so no filter is the empty string", () => {
    expect(serializeFilters(NO_FILTERS)).toBe("");
    expect(isFiltered(NO_FILTERS)).toBe(false);
    expect(isFiltered({ ...NO_FILTERS, q: "x" })).toBe(true);
  });
  it("ignores anything unknown or malformed instead of trusting it", () => {
    const f = parseFilters({
      source: "DROP TABLE",
      mode: ["PROTECTED", "x"],
      decision: "allowed",
      audit: "",
      from: "2026-13-45",
      to: "yesterday",
      category: "x".repeat(200),
      q: "y".repeat(300),
      extra: "1",
    });
    expect(f).toEqual({ ...NO_FILTERS, mode: "PROTECTED", q: "y".repeat(100) });
  });
  it("takes the first of repeated parameters", () => {
    expect(parseFilters({ decision: ["DENIED", "ALLOWED"] }).decision).toBe("DENIED");
  });
  it("serialise then parse is the identity for any valid filter set (seeded random)", () => {
    const rng = makeRng(2026);
    for (let i = 0; i < 200; i++) {
      const f: CockpitFilters = {
        q: rng.pick(["", "a", "neg_1", "OVER CAP"]),
        source: rng.pick([...SOURCES, "ALL"] as const),
        mode: rng.pick([...BUYER_MODES, "ALL"] as const),
        category: rng.pick([ALL, "COMPUTE", "PROMPT_INJECTION"]),
        decision: rng.pick([...DECISIONS, "ALL"] as const),
        payment: rng.pick([ALL, "CAPTURED", "NO_PAYMENT"]),
        verification: rng.pick([ALL, "OBSERVED", "AS_EXPECTED"]),
        audit: rng.pick([...AUDIT_STATES, "ALL"] as const),
        from: rng.pick([null, "2026-10-01", "2026-02-28"]),
        to: rng.pick([null, "2026-12-31"]),
      };
      expect(parseFilters(Object.fromEntries(new URLSearchParams(serializeFilters(f))))).toEqual(f);
    }
  });
});

describe("sorting and counting", () => {
  it("orders newest first, then by id, and puts rows with no timestamp last", () => {
    const sorted = defaultSort(ROWS).map((r) => r.id);
    expect(sorted).toEqual([
      "bench:S1|PROTECTED|SUSCEPTIBLE",
      "bench:S1|UNSAFE_BASELINE|SUSCEPTIBLE",
      "refused:1",
      "tx:c",
      "tx:b",
      "tx:a",
      "tx:broken",
    ]);
  });
  it("tallies are plain counts of the rows given", () => {
    const t = tally(ROWS);
    expect(t.total).toBe(7);
    expect(t.bySource).toEqual({ TRANSACTION: 4, REFUSED_OFFER: 1, ATTACK_RUN: 0, BENCHMARK: 2 });
    expect(t.byDecision).toMatchObject({
      ALLOWED: 3,
      DENIED: 2,
      HELD_FOR_HUMAN: 1,
      EXECUTED_UNCHECKED: 1,
      MIXED: 0,
    });
    expect(t.byAudit).toMatchObject({ VERIFIED: 4, BROKEN: 1, NOT_RECORDED: 2 });
    expect(Object.values(t.byDecision).reduce((a, b) => a + b, 0)).toBe(t.total);
    expect(tally([]).total).toBe(0);
  });
});
