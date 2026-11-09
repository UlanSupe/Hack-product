import type {
  ClaimInput,
  ClaimResult,
  WebhookOps,
  WebhookRecord,
  WebhookStore,
} from "../../ports/webhook-store.ts";
import { appendAuditEvent } from "./audit.ts";
import { inTransaction, one, run, type Db } from "./database.ts";

type Row = {
  id: string;
  paypal_event_id: string;
  event_type: string;
  resource_id: string | null;
  paypal_order_id: string | null;
  transaction_id: string | null;
  payload_hash: string;
  status: WebhookRecord["status"];
  reason: string | null;
  attempts: number;
  deliveries: number;
  received_at: string;
  updated_at: string;
  processed_at: string | null;
};

const toRecord = (r: Row): WebhookRecord => ({
  id: r.id,
  paypalEventId: r.paypal_event_id,
  eventType: r.event_type,
  resourceId: r.resource_id,
  paypalOrderId: r.paypal_order_id,
  transactionId: r.transaction_id,
  payloadHash: r.payload_hash,
  status: r.status,
  reason: r.reason,
  attempts: r.attempts,
  deliveries: r.deliveries,
  receivedAt: r.received_at,
  updatedAt: r.updated_at,
  processedAt: r.processed_at,
});

/** SQLite implementation: one table (`webhook_events`) plus the shared, hash-chained audit trail. */
export function createSqliteWebhookStore(db: Db): WebhookStore {
  const find = (eventId: string): Row | undefined =>
    one<Row>(db, "SELECT * FROM webhook_events WHERE paypal_event_id = ?", [eventId]);

  const ops: WebhookOps = {
    find: (eventId) => {
      const r = find(eventId);
      return r && toRecord(r);
    },

    claim(a: ClaimInput): ClaimResult {
      const existing = find(a.paypalEventId);
      if (existing === undefined) {
        run(
          db,
          `INSERT INTO webhook_events (id, paypal_event_id, event_type, resource_id, paypal_order_id, transmission_id,
             payload_hash, status, attempts, deliveries, received_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, 'PROCESSING', 1, 1, ?, ?)`,
          [
            a.id,
            a.paypalEventId,
            a.eventType,
            a.resourceId,
            a.paypalOrderId,
            a.transmissionId,
            a.payloadHash,
            a.now,
            a.now,
          ],
        );
        return {
          kind: "CLAIMED",
          record: toRecord(find(a.paypalEventId) as Row),
          redelivery: false,
        };
      }
      // Every delivery is counted, whatever happens next.
      run(db, "UPDATE webhook_events SET deliveries = deliveries + 1 WHERE id = ?", [existing.id]);
      if (existing.payload_hash !== a.payloadHash) {
        return { kind: "HASH_MISMATCH", record: toRecord(find(a.paypalEventId) as Row) };
      }
      if (existing.status === "PROCESSED" || existing.status === "IGNORED") {
        return { kind: "DUPLICATE", record: toRecord(find(a.paypalEventId) as Row) };
      }
      if (existing.status === "PROCESSING" && existing.updated_at >= a.staleBefore) {
        return { kind: "BUSY", record: toRecord(find(a.paypalEventId) as Row) };
      }
      // FAILED (PayPal redelivered after our non-2xx) or an abandoned claim: take it over.
      run(
        db,
        "UPDATE webhook_events SET status = 'PROCESSING', reason = NULL, attempts = attempts + 1, updated_at = ? WHERE id = ?",
        [a.now, existing.id],
      );
      return {
        kind: "CLAIMED",
        record: toRecord(find(a.paypalEventId) as Row),
        redelivery: true,
      };
    },

    finish(a) {
      const done = a.status === "PROCESSED" || a.status === "IGNORED";
      const r = run(
        db,
        `UPDATE webhook_events SET status = ?, reason = ?, transaction_id = COALESCE(transaction_id, ?),
           updated_at = ?, processed_at = ? WHERE id = ? AND status = 'PROCESSING'`,
        [a.status, a.reason, a.transactionId ?? null, a.now, done ? a.now : null, a.id],
      );
      if (r.changes !== 1) throw new Error("webhook event is not being processed");
    },

    audit(a) {
      appendAuditEvent(db, {
        ts: a.ts,
        actor: "PAYPAL_WEBHOOK",
        type: a.type,
        subjectType: "webhook",
        subjectId: a.subjectId,
        transactionId: a.transactionId ?? null,
        payload: a.payload,
      });
    },
  };

  return { transaction: (fn) => inTransaction(db, () => fn(ops)) };
}
