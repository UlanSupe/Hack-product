-- 0003: payment attempts (outbound PayPal calls, write-ahead) and inbound idempotency keys.
-- Nothing here can hold a credential: only identifiers, hashes, statuses and timestamps.

-- ---------------------------------------------------------------------------
-- One row per outbound money-relevant call. The row is written BEFORE the call (IN_FLIGHT) in the
-- same DB transaction that moves the transaction into the matching in-flight state.
--   * at most ONE live attempt (anything except FAILED_DEFINITE) per (transaction, action)
--   * a new attempt (seq + 1, max 3) exists only after a definite failure
--   * the PayPal-Request-Id is derived from the row: pp:{transaction}:{action}:{seq}
-- ---------------------------------------------------------------------------
CREATE TABLE payment_attempts (
  id TEXT NOT NULL PRIMARY KEY CHECK (length(id) BETWEEN 1 AND 64),
  transaction_id TEXT NOT NULL REFERENCES transactions (id),
  action TEXT NOT NULL CHECK (action IN ('CREATE_ORDER', 'AUTHORIZE', 'CAPTURE', 'VOID')),
  seq INTEGER NOT NULL CHECK (seq BETWEEN 1 AND 3),
  request_id TEXT NOT NULL UNIQUE,
  request_hash TEXT NOT NULL CHECK (length(request_hash) = 64 AND request_hash NOT GLOB '*[^0-9a-f]*'),
  status TEXT NOT NULL CHECK (status IN ('IN_FLIGHT', 'SUCCEEDED', 'FAILED_DEFINITE', 'UNKNOWN')),
  tries INTEGER NOT NULL CHECK (tries BETWEEN 1 AND 10),
  http_status INTEGER CHECK (http_status IS NULL OR (typeof(http_status) = 'integer' AND http_status BETWEEN 100 AND 599)),
  paypal_debug_id TEXT CHECK (paypal_debug_id IS NULL OR length(paypal_debug_id) BETWEEN 1 AND 128),
  started_at TEXT NOT NULL CHECK (started_at GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]*Z'),
  finished_at TEXT CHECK (finished_at IS NULL OR finished_at GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]*Z'),
  UNIQUE (transaction_id, action, seq),
  CHECK (request_id = 'pp:' || transaction_id || ':' || action || ':' || seq),
  CHECK ((status = 'IN_FLIGHT') = (finished_at IS NULL)),
  CHECK (finished_at IS NULL OR finished_at >= started_at)
) STRICT;

CREATE UNIQUE INDEX payment_attempts_one_live_per_action
  ON payment_attempts (transaction_id, action) WHERE status <> 'FAILED_DEFINITE';

CREATE TRIGGER payment_attempts_insert_rules BEFORE INSERT ON payment_attempts
BEGIN
  SELECT RAISE(ABORT, 'new payment attempts must be IN_FLIGHT with tries = 1')
  WHERE NEW.status <> 'IN_FLIGHT' OR NEW.tries <> 1 OR NEW.http_status IS NOT NULL OR NEW.paypal_debug_id IS NOT NULL;
  SELECT RAISE(ABORT, 'attempt seq must be the previous seq + 1 for this transaction and action')
  WHERE NEW.seq <> COALESCE((SELECT MAX(seq) FROM payment_attempts WHERE transaction_id = NEW.transaction_id AND action = NEW.action), 0) + 1;
  SELECT RAISE(ABORT, 'payment attempt action does not match the transaction state')
  WHERE NOT EXISTS (
    SELECT 1 FROM transactions t
    WHERE t.id = NEW.transaction_id
      AND t.state = CASE NEW.action
        WHEN 'CREATE_ORDER' THEN 'CREATING_ORDER'
        WHEN 'AUTHORIZE' THEN 'AUTHORIZING'
        WHEN 'CAPTURE' THEN 'CAPTURING'
        WHEN 'VOID' THEN 'VOIDING'
      END
  );
END;

CREATE TRIGGER payment_attempts_update_rules BEFORE UPDATE ON payment_attempts
BEGIN
  SELECT RAISE(ABORT, 'immutable payment attempt column changed')
  WHERE NEW.id IS NOT OLD.id OR NEW.transaction_id IS NOT OLD.transaction_id OR NEW.action IS NOT OLD.action
     OR NEW.seq IS NOT OLD.seq OR NEW.request_id IS NOT OLD.request_id
     OR NEW.request_hash IS NOT OLD.request_hash OR NEW.started_at IS NOT OLD.started_at;
  SELECT RAISE(ABORT, 'SUCCEEDED and FAILED_DEFINITE attempts are final')
  WHERE OLD.status IN ('SUCCEEDED', 'FAILED_DEFINITE');
  SELECT RAISE(ABORT, 'illegal payment attempt status change')
  WHERE NOT (
    (OLD.status = 'IN_FLIGHT' AND NEW.status IN ('SUCCEEDED', 'FAILED_DEFINITE', 'UNKNOWN'))
    OR (OLD.status = 'UNKNOWN' AND NEW.status IN ('IN_FLIGHT', 'SUCCEEDED', 'FAILED_DEFINITE'))
  );
  SELECT RAISE(ABORT, 'tries increases by exactly 1 when an UNKNOWN attempt is retried, otherwise it is unchanged')
  WHERE NEW.tries <> OLD.tries + CASE WHEN OLD.status = 'UNKNOWN' AND NEW.status = 'IN_FLIGHT' THEN 1 ELSE 0 END;
END;

CREATE TRIGGER payment_attempts_no_delete BEFORE DELETE ON payment_attempts
BEGIN SELECT RAISE(ABORT, 'payment attempts cannot be deleted'); END;

-- ---------------------------------------------------------------------------
-- Inbound idempotency keys (client Idempotency-Key header). Same key + same request hash replays
-- the stored response; same key + different hash is a conflict (decided by the application).
-- ---------------------------------------------------------------------------
CREATE TABLE idempotency_keys (
  idem_key TEXT NOT NULL PRIMARY KEY CHECK (length(idem_key) BETWEEN 8 AND 128),
  scope TEXT NOT NULL CHECK (length(scope) BETWEEN 1 AND 64),
  request_hash TEXT NOT NULL CHECK (length(request_hash) = 64 AND request_hash NOT GLOB '*[^0-9a-f]*'),
  response_status INTEGER CHECK (response_status IS NULL OR (typeof(response_status) = 'integer' AND response_status BETWEEN 100 AND 599)),
  response_body TEXT CHECK (response_body IS NULL OR length(response_body) <= 65536),
  created_at TEXT NOT NULL CHECK (created_at GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]*Z'),
  CHECK ((response_status IS NULL) = (response_body IS NULL))
) STRICT;

-- The stored response may be recorded once; identity columns never change. (Rows may be deleted
-- by a retention job.)
CREATE TRIGGER idempotency_keys_update_rules BEFORE UPDATE ON idempotency_keys
BEGIN
  SELECT RAISE(ABORT, 'idempotency key identity is immutable')
  WHERE NEW.idem_key IS NOT OLD.idem_key OR NEW.scope IS NOT OLD.scope
     OR NEW.request_hash IS NOT OLD.request_hash OR NEW.created_at IS NOT OLD.created_at;
  SELECT RAISE(ABORT, 'the stored response can only be recorded once')
  WHERE OLD.response_status IS NOT NULL;
END;
