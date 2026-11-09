/**
 * Persistence for verified webhook deliveries. A row exists only for an event PayPal verified, so a forged delivery can
 * never squat an event id. `transaction` is atomic and synchronous; never call PayPal inside it.
 */

export type WebhookStatus = "PROCESSING" | "PROCESSED" | "IGNORED" | "FAILED";

export type WebhookRecord = {
  id: string;
  paypalEventId: string;
  eventType: string;
  resourceId: string | null;
  paypalOrderId: string | null;
  transactionId: string | null;
  payloadHash: string;
  status: WebhookStatus;
  reason: string | null;
  attempts: number;
  deliveries: number;
  receivedAt: string;
  updatedAt: string;
  processedAt: string | null;
};

export type ClaimInput = {
  id: string;
  paypalEventId: string;
  eventType: string;
  resourceId: string | null;
  paypalOrderId: string | null;
  transmissionId: string;
  payloadHash: string;
  now: string;
  /** A PROCESSING claim last touched before this is considered abandoned. */
  staleBefore: string;
};

export type ClaimResult =
  /** First sight of this event, or a redelivery after a failure, or an abandoned claim taken over: process it. */
  | { kind: "CLAIMED"; record: WebhookRecord; redelivery: boolean }
  /** Already PROCESSED or IGNORED: nothing to do. */
  | { kind: "DUPLICATE"; record: WebhookRecord }
  /** Another worker is processing it right now. */
  | { kind: "BUSY"; record: WebhookRecord }
  /** Same event id, different content: never processed. */
  | { kind: "HASH_MISMATCH"; record: WebhookRecord };

export interface WebhookOps {
  claim(input: ClaimInput): ClaimResult;
  finish(a: {
    id: string;
    status: "PROCESSED" | "IGNORED" | "FAILED";
    reason: string;
    transactionId?: string | null;
    now: string;
  }): void;
  audit(a: {
    ts: string;
    type: string;
    subjectId: string;
    transactionId?: string | null;
    payload: Record<string, unknown>;
  }): void;
  find(paypalEventId: string): WebhookRecord | undefined;
}

export interface WebhookStore {
  transaction<T>(fn: (ops: WebhookOps) => T): T;
}
