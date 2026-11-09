import type {
  AttackRunFacts,
  BenchmarkFile,
  ChainFacts,
  RefusedOfferFacts,
  TransactionFacts,
} from "../domain/cockpit.ts";

/**
 * What the Cockpit reads. Everything is read-only and already materialised, so the application layer works on plain
 * values and a source can fail as a whole without leaving a half-built grid.
 */

export type LiveFacts = {
  transactions: TransactionFacts[];
  refusedOffers: RefusedOfferFacts[];
  attackRuns: AttackRunFacts[];
  /** The state of the audit hash chain as a whole. */
  chain: ChainFacts;
};

/** The database half. LOCKED = not allowed to look (no operator session); UNAVAILABLE = nothing to read yet. */
export type LiveResult =
  | { state: "OK"; facts: LiveFacts }
  | { state: "LOCKED" | "UNAVAILABLE" | "ERROR"; message: string };

/** The persisted benchmark file half. MISSING = never run; ERROR = unreadable, malformed or failing its integrity check. */
export type BenchmarkResult =
  { state: "OK"; file: BenchmarkFile } | { state: "MISSING" | "ERROR"; message: string };

export type BenchmarkFileRead =
  { kind: "MISSING" } | { kind: "TEXT"; text: string } | { kind: "ERROR"; message: string };
