-- 0007: verified PayPal webhook deliveries and what was done about them.
--
-- A row exists ONLY for an event whose signature PayPal itself verified (a forged or unverifiable delivery never
-- creates a row, so nobody can squat an event id and block the real event). The raw payload is not stored: only its
-- hash and the identifiers needed to find the transaction. A webhook is a trigger to look; the state change comes from a
-- fresh authenticated read of the order (docs/PAYPAL_INTEGRATION.md section 8).
--
--   PROCESSING -> PROCESSED | IGNORED | FAILED     (one worker claimed it)
--   FAILED     -> PROCESSING                       (PayPal redelivered after we answered non-2xx)
--   PROCESSING -> PROCESSING                       (an abandoned claim taken over; attempts + 1)
--   PROCESSED and IGNORED are final.

CREATE TABLE webhook_events (
  id TEXT NOT NULL PRIMARY KEY CHECK (length(id) BETWEEN 1 AND 64),
  paypal_event_id TEXT NOT NULL UNIQUE CHECK (length(paypal_event_id) BETWEEN 1 AND 128),
  event_type TEXT NOT NULL CHECK (length(event_type) BETWEEN 1 AND 80),
  resource_id TEXT CHECK (resource_id IS NULL OR length(resource_id) BETWEEN 1 AND 128),
  paypal_order_id TEXT CHECK (paypal_order_id IS NULL OR length(paypal_order_id) BETWEEN 1 AND 64),
  transaction_id TEXT REFERENCES transactions (id),
  transmission_id TEXT NOT NULL CHECK (length(transmission_id) BETWEEN 1 AND 128),
  payload_hash TEXT NOT NULL CHECK (length(payload_hash) = 64 AND payload_hash NOT GLOB '*[^0-9a-f]*'),
  status TEXT NOT NULL CHECK (status IN ('PROCESSING', 'PROCESSED', 'IGNORED', 'FAILED')),
  reason TEXT CHECK (reason IS NULL OR (length(reason) BETWEEN 1 AND 64 AND reason NOT GLOB '*[^A-Z0-9_]*')),
  attempts INTEGER NOT NULL CHECK (typeof(attempts) = 'integer' AND attempts >= 1),
  deliveries INTEGER NOT NULL CHECK (typeof(deliveries) = 'integer' AND deliveries >= 1),
  received_at TEXT NOT NULL CHECK (received_at GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]*Z'),
  updated_at TEXT NOT NULL CHECK (updated_at GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]*Z'),
  processed_at TEXT CHECK (processed_at IS NULL OR processed_at GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]*Z'),
  CHECK ((status IN ('PROCESSED', 'IGNORED')) = (processed_at IS NOT NULL)),
  CHECK (status = 'PROCESSING' OR reason IS NOT NULL)
) STRICT;

CREATE INDEX webhook_events_by_transaction ON webhook_events (transaction_id, received_at);

CREATE TRIGGER webhook_events_insert_rules BEFORE INSERT ON webhook_events
BEGIN
  SELECT RAISE(ABORT, 'a new webhook event must be PROCESSING with one attempt and one delivery')
  WHERE NEW.status <> 'PROCESSING' OR NEW.attempts <> 1 OR NEW.deliveries <> 1
     OR NEW.reason IS NOT NULL OR NEW.processed_at IS NOT NULL;
END;

CREATE TRIGGER webhook_events_update_rules BEFORE UPDATE ON webhook_events
BEGIN
  SELECT RAISE(ABORT, 'immutable webhook event column changed')
  WHERE NEW.id IS NOT OLD.id OR NEW.paypal_event_id IS NOT OLD.paypal_event_id
     OR NEW.event_type IS NOT OLD.event_type OR NEW.payload_hash IS NOT OLD.payload_hash
     OR NEW.transmission_id IS NOT OLD.transmission_id OR NEW.received_at IS NOT OLD.received_at
     OR (OLD.resource_id IS NOT NULL AND NEW.resource_id IS NOT OLD.resource_id)
     OR (OLD.paypal_order_id IS NOT NULL AND NEW.paypal_order_id IS NOT OLD.paypal_order_id)
     OR (OLD.transaction_id IS NOT NULL AND NEW.transaction_id IS NOT OLD.transaction_id);
  SELECT RAISE(ABORT, 'PROCESSED and IGNORED webhook events are final (only the delivery count may rise)')
  WHERE OLD.status IN ('PROCESSED', 'IGNORED')
    AND (NEW.status <> OLD.status OR NEW.reason IS NOT OLD.reason OR NEW.attempts <> OLD.attempts
         OR NEW.processed_at IS NOT OLD.processed_at);
  SELECT RAISE(ABORT, 'illegal webhook event status change')
  WHERE NEW.status <> OLD.status
    AND NOT (OLD.status = 'PROCESSING' AND NEW.status IN ('PROCESSED', 'IGNORED', 'FAILED'))
    AND NOT (OLD.status = 'FAILED' AND NEW.status = 'PROCESSING');
  SELECT RAISE(ABORT, 'attempts rises by exactly 1 when a claim is taken, otherwise it is unchanged')
  WHERE NOT (NEW.attempts = OLD.attempts OR (NEW.attempts = OLD.attempts + 1 AND NEW.status = 'PROCESSING'));
  SELECT RAISE(ABORT, 'deliveries never decreases')
  WHERE NEW.deliveries < OLD.deliveries;
END;

CREATE TRIGGER webhook_events_no_delete BEFORE DELETE ON webhook_events
BEGIN SELECT RAISE(ABORT, 'webhook events cannot be deleted'); END;
