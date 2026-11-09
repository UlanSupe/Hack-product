/**
 * Transaction states and legal transitions (docs/TRANSACTION_STATE_MACHINE.md section 2 and 4.2).
 * The SQLite schema carries a frozen copy of this table (migration 0001) and a test fails if the
 * two ever disagree, so a change here requires a new migration.
 */

export const TX_STATES = [
  "NEGOTIATING",
  "AGREED",
  "CREATING_ORDER",
  "ORDER_CREATED",
  "ORDER_APPROVED",
  "AUTHORIZING",
  "AUTHORIZATION_PENDING",
  "AUTHORIZED",
  "CAPTURING",
  "CAPTURE_PENDING",
  "CAPTURED",
  "VOIDING",
  "VOIDED",
  "REJECTED",
  "CANCELLED",
  "FAILED",
  "NEEDS_RECONCILIATION",
  "REVERSED",
] as const;

export type TxState = (typeof TX_STATES)[number];

/** States in which an outbound PayPal call is (or may be) in flight. */
export const IN_FLIGHT_STATES = ["CREATING_ORDER", "AUTHORIZING", "CAPTURING", "VOIDING"] as const;
export type InFlightState = (typeof IN_FLIGHT_STATES)[number];

export const TERMINAL_STATES = ["VOIDED", "REJECTED", "CANCELLED", "FAILED", "REVERSED"] as const;

type Edge = readonly [from: TxState, to: TxState];

export const TRANSITIONS: readonly Edge[] = [
  ["NEGOTIATING", "AGREED"],
  ["NEGOTIATING", "REJECTED"],
  ["AGREED", "CREATING_ORDER"],
  ["AGREED", "CANCELLED"],
  ["CREATING_ORDER", "ORDER_CREATED"],
  ["CREATING_ORDER", "FAILED"],
  ["CREATING_ORDER", "NEEDS_RECONCILIATION"],
  ["ORDER_CREATED", "ORDER_APPROVED"],
  ["ORDER_CREATED", "CANCELLED"],
  ["ORDER_APPROVED", "AUTHORIZING"],
  ["ORDER_APPROVED", "CANCELLED"],
  ["AUTHORIZING", "AUTHORIZED"],
  ["AUTHORIZING", "AUTHORIZATION_PENDING"],
  ["AUTHORIZING", "FAILED"],
  ["AUTHORIZING", "NEEDS_RECONCILIATION"],
  ["AUTHORIZATION_PENDING", "AUTHORIZED"],
  ["AUTHORIZATION_PENDING", "FAILED"],
  ["AUTHORIZATION_PENDING", "VOIDED"],
  ["AUTHORIZED", "CAPTURING"],
  ["AUTHORIZED", "VOIDING"],
  ["CAPTURING", "CAPTURED"],
  ["CAPTURING", "CAPTURE_PENDING"],
  ["CAPTURING", "AUTHORIZED"],
  ["CAPTURING", "NEEDS_RECONCILIATION"],
  ["CAPTURE_PENDING", "CAPTURED"],
  ["CAPTURE_PENDING", "AUTHORIZED"],
  ["CAPTURE_PENDING", "FAILED"],
  ["VOIDING", "VOIDED"],
  ["VOIDING", "CAPTURED"],
  ["VOIDING", "NEEDS_RECONCILIATION"],
  ["NEEDS_RECONCILIATION", "ORDER_CREATED"],
  ["NEEDS_RECONCILIATION", "ORDER_APPROVED"],
  ["NEEDS_RECONCILIATION", "AUTHORIZATION_PENDING"],
  ["NEEDS_RECONCILIATION", "AUTHORIZED"],
  ["NEEDS_RECONCILIATION", "CAPTURE_PENDING"],
  ["NEEDS_RECONCILIATION", "CAPTURED"],
  ["NEEDS_RECONCILIATION", "VOIDED"],
  ["NEEDS_RECONCILIATION", "FAILED"],
  ["CAPTURED", "REVERSED"],
];

/** Where NEEDS_RECONCILIATION may resolve to, by the in-flight state it came from (state machine 4.2). */
export const RECONCILE_TARGETS: Record<InFlightState, readonly TxState[]> = {
  CREATING_ORDER: ["ORDER_CREATED", "FAILED"],
  AUTHORIZING: ["AUTHORIZED", "AUTHORIZATION_PENDING", "FAILED", "ORDER_APPROVED"],
  CAPTURING: ["CAPTURED", "CAPTURE_PENDING", "AUTHORIZED", "FAILED"],
  VOIDING: ["VOIDED", "CAPTURED", "AUTHORIZED"],
};

export function canTransition(from: TxState, to: TxState): boolean {
  return TRANSITIONS.some(([f, t]) => f === from && t === to);
}
