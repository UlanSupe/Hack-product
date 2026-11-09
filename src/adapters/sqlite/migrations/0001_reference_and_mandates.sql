-- 0001: reference data, sellers/catalog, versioned mandates.
-- Conventions for every migration:
--   * STRICT tables; TEXT primary keys are NOT NULL.
--   * Money: INTEGER minor units, CHECK typeof='integer' and 0..2^53-1; an explicit 3-letter currency column beside it.
--   * Timestamps: ISO-8601 UTC text (...Z), supplied by the application clock (no DB defaults).
--   * Hashes: 64 lowercase hex characters (SHA-256).
--   * Immutable facts are protected by triggers that RAISE on UPDATE/DELETE.
-- Never edit an applied migration (checksums are verified); add a new one.

-- ---------------------------------------------------------------------------
-- Transaction state machine reference data (frozen copy of src/domain/transaction-states.ts;
-- a test fails if they disagree). Read-only at runtime: change it with a new migration.
-- ---------------------------------------------------------------------------
CREATE TABLE tx_states (
  state TEXT NOT NULL PRIMARY KEY,
  is_terminal INTEGER NOT NULL CHECK (is_terminal IN (0, 1)),
  is_in_flight INTEGER NOT NULL CHECK (is_in_flight IN (0, 1))
) STRICT;

CREATE TABLE tx_transitions (
  from_state TEXT NOT NULL REFERENCES tx_states (state),
  to_state TEXT NOT NULL REFERENCES tx_states (state),
  PRIMARY KEY (from_state, to_state)
) STRICT;

-- Where NEEDS_RECONCILIATION may resolve to, by the in-flight state it came from.
CREATE TABLE reconcile_targets (
  in_flight_state TEXT NOT NULL REFERENCES tx_states (state),
  to_state TEXT NOT NULL REFERENCES tx_states (state),
  PRIMARY KEY (in_flight_state, to_state)
) STRICT;

INSERT INTO tx_states (state, is_terminal, is_in_flight) VALUES
  ('NEGOTIATING', 0, 0),
  ('AGREED', 0, 0),
  ('CREATING_ORDER', 0, 1),
  ('ORDER_CREATED', 0, 0),
  ('ORDER_APPROVED', 0, 0),
  ('AUTHORIZING', 0, 1),
  ('AUTHORIZATION_PENDING', 0, 0),
  ('AUTHORIZED', 0, 0),
  ('CAPTURING', 0, 1),
  ('CAPTURE_PENDING', 0, 0),
  ('CAPTURED', 0, 0),
  ('VOIDING', 0, 1),
  ('VOIDED', 1, 0),
  ('REJECTED', 1, 0),
  ('CANCELLED', 1, 0),
  ('FAILED', 1, 0),
  ('NEEDS_RECONCILIATION', 0, 0),
  ('REVERSED', 1, 0);

INSERT INTO tx_transitions (from_state, to_state) VALUES
  ('NEGOTIATING', 'AGREED'),
  ('NEGOTIATING', 'REJECTED'),
  ('AGREED', 'CREATING_ORDER'),
  ('AGREED', 'CANCELLED'),
  ('CREATING_ORDER', 'ORDER_CREATED'),
  ('CREATING_ORDER', 'FAILED'),
  ('CREATING_ORDER', 'NEEDS_RECONCILIATION'),
  ('ORDER_CREATED', 'ORDER_APPROVED'),
  ('ORDER_CREATED', 'CANCELLED'),
  ('ORDER_APPROVED', 'AUTHORIZING'),
  ('ORDER_APPROVED', 'CANCELLED'),
  ('AUTHORIZING', 'AUTHORIZED'),
  ('AUTHORIZING', 'AUTHORIZATION_PENDING'),
  ('AUTHORIZING', 'FAILED'),
  ('AUTHORIZING', 'NEEDS_RECONCILIATION'),
  ('AUTHORIZATION_PENDING', 'AUTHORIZED'),
  ('AUTHORIZATION_PENDING', 'FAILED'),
  ('AUTHORIZATION_PENDING', 'VOIDED'),
  ('AUTHORIZED', 'CAPTURING'),
  ('AUTHORIZED', 'VOIDING'),
  ('CAPTURING', 'CAPTURED'),
  ('CAPTURING', 'CAPTURE_PENDING'),
  ('CAPTURING', 'AUTHORIZED'),
  ('CAPTURING', 'NEEDS_RECONCILIATION'),
  ('CAPTURE_PENDING', 'CAPTURED'),
  ('CAPTURE_PENDING', 'AUTHORIZED'),
  ('CAPTURE_PENDING', 'FAILED'),
  ('VOIDING', 'VOIDED'),
  ('VOIDING', 'CAPTURED'),
  ('VOIDING', 'NEEDS_RECONCILIATION'),
  ('NEEDS_RECONCILIATION', 'ORDER_CREATED'),
  ('NEEDS_RECONCILIATION', 'ORDER_APPROVED'),
  ('NEEDS_RECONCILIATION', 'AUTHORIZATION_PENDING'),
  ('NEEDS_RECONCILIATION', 'AUTHORIZED'),
  ('NEEDS_RECONCILIATION', 'CAPTURE_PENDING'),
  ('NEEDS_RECONCILIATION', 'CAPTURED'),
  ('NEEDS_RECONCILIATION', 'VOIDED'),
  ('NEEDS_RECONCILIATION', 'FAILED'),
  ('CAPTURED', 'REVERSED');

INSERT INTO reconcile_targets (in_flight_state, to_state) VALUES
  ('CREATING_ORDER', 'ORDER_CREATED'),
  ('CREATING_ORDER', 'FAILED'),
  ('AUTHORIZING', 'AUTHORIZED'),
  ('AUTHORIZING', 'AUTHORIZATION_PENDING'),
  ('AUTHORIZING', 'FAILED'),
  ('AUTHORIZING', 'ORDER_APPROVED'),
  ('CAPTURING', 'CAPTURED'),
  ('CAPTURING', 'CAPTURE_PENDING'),
  ('CAPTURING', 'AUTHORIZED'),
  ('CAPTURING', 'FAILED'),
  ('VOIDING', 'VOIDED'),
  ('VOIDING', 'CAPTURED'),
  ('VOIDING', 'AUTHORIZED');

CREATE TRIGGER tx_states_readonly_ins BEFORE INSERT ON tx_states
BEGIN SELECT RAISE(ABORT, 'reference table is read-only; change it with a new migration'); END;
CREATE TRIGGER tx_states_readonly_upd BEFORE UPDATE ON tx_states
BEGIN SELECT RAISE(ABORT, 'reference table is read-only; change it with a new migration'); END;
CREATE TRIGGER tx_states_readonly_del BEFORE DELETE ON tx_states
BEGIN SELECT RAISE(ABORT, 'reference table is read-only; change it with a new migration'); END;
CREATE TRIGGER tx_transitions_readonly_ins BEFORE INSERT ON tx_transitions
BEGIN SELECT RAISE(ABORT, 'reference table is read-only; change it with a new migration'); END;
CREATE TRIGGER tx_transitions_readonly_upd BEFORE UPDATE ON tx_transitions
BEGIN SELECT RAISE(ABORT, 'reference table is read-only; change it with a new migration'); END;
CREATE TRIGGER tx_transitions_readonly_del BEFORE DELETE ON tx_transitions
BEGIN SELECT RAISE(ABORT, 'reference table is read-only; change it with a new migration'); END;
CREATE TRIGGER reconcile_targets_readonly_ins BEFORE INSERT ON reconcile_targets
BEGIN SELECT RAISE(ABORT, 'reference table is read-only; change it with a new migration'); END;
CREATE TRIGGER reconcile_targets_readonly_upd BEFORE UPDATE ON reconcile_targets
BEGIN SELECT RAISE(ABORT, 'reference table is read-only; change it with a new migration'); END;
CREATE TRIGGER reconcile_targets_readonly_del BEFORE DELETE ON reconcile_targets
BEGIN SELECT RAISE(ABORT, 'reference table is read-only; change it with a new migration'); END;

-- ---------------------------------------------------------------------------
-- Sellers and catalog. Sellers are logical, synthetic identities; payee_ref is a catalog key,
-- never a PayPal credential (the real sandbox merchant is configuration, not data).
-- ---------------------------------------------------------------------------
CREATE TABLE sellers (
  id TEXT NOT NULL PRIMARY KEY CHECK (length(id) BETWEEN 1 AND 64),
  display_name TEXT NOT NULL CHECK (length(display_name) BETWEEN 1 AND 128),
  payee_ref TEXT NOT NULL UNIQUE CHECK (length(payee_ref) BETWEEN 1 AND 64),
  created_at TEXT NOT NULL CHECK (created_at GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]*Z')
) STRICT;

CREATE TABLE seller_catalog_items (
  seller_id TEXT NOT NULL REFERENCES sellers (id),
  sku TEXT NOT NULL CHECK (length(sku) BETWEEN 1 AND 64),
  unit_price_minor INTEGER NOT NULL CHECK (typeof(unit_price_minor) = 'integer' AND unit_price_minor >= 0 AND unit_price_minor <= 9007199254740991),
  currency TEXT NOT NULL CHECK (length(currency) = 3 AND currency NOT GLOB '*[^A-Z]*'),
  PRIMARY KEY (seller_id, sku)
) STRICT;

-- ---------------------------------------------------------------------------
-- Mandates: immutable and versioned. (id, version) is the identity. A change, including a
-- revocation, is a NEW row with version + 1. Transactions pin the exact (id, version).
-- ---------------------------------------------------------------------------
CREATE TABLE mandates (
  id TEXT NOT NULL CHECK (length(id) BETWEEN 1 AND 64),
  version INTEGER NOT NULL CHECK (version >= 1),
  owner_id TEXT NOT NULL CHECK (length(owner_id) BETWEEN 1 AND 64),
  per_tx_cap_minor INTEGER NOT NULL CHECK (typeof(per_tx_cap_minor) = 'integer' AND per_tx_cap_minor > 0 AND per_tx_cap_minor <= 9007199254740991),
  total_budget_minor INTEGER NOT NULL CHECK (typeof(total_budget_minor) = 'integer' AND total_budget_minor >= per_tx_cap_minor AND total_budget_minor <= 9007199254740991),
  currency TEXT NOT NULL CHECK (length(currency) = 3 AND currency NOT GLOB '*[^A-Z]*'),
  allowed_seller_ids TEXT NOT NULL CHECK (json_valid(allowed_seller_ids) AND json_type(allowed_seller_ids) = 'array' AND json_array_length(allowed_seller_ids) >= 1),
  expires_at TEXT NOT NULL CHECK (expires_at GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]*Z'),
  status TEXT NOT NULL CHECK (status IN ('ACTIVE', 'REVOKED')),
  created_by TEXT NOT NULL CHECK (created_by = 'OPERATOR'),
  content_hash TEXT NOT NULL CHECK (length(content_hash) = 64 AND content_hash NOT GLOB '*[^0-9a-f]*'),
  created_at TEXT NOT NULL CHECK (created_at GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]*Z'),
  PRIMARY KEY (id, version)
) STRICT;

CREATE TRIGGER mandates_insert_rules BEFORE INSERT ON mandates
BEGIN
  SELECT RAISE(ABORT, 'mandate version must equal the previous version + 1')
  WHERE NEW.version <> COALESCE((SELECT MAX(version) FROM mandates WHERE id = NEW.id), 0) + 1;
  SELECT RAISE(ABORT, 'revoked mandates are final; create a new mandate id')
  WHERE EXISTS (SELECT 1 FROM mandates WHERE id = NEW.id AND status = 'REVOKED');
  SELECT RAISE(ABORT, 'allowed_seller_ids must be text ids of existing sellers')
  WHERE EXISTS (
    SELECT 1 FROM json_each(NEW.allowed_seller_ids) j
    WHERE j.type <> 'text' OR NOT EXISTS (SELECT 1 FROM sellers s WHERE s.id = j.value)
  );
END;

CREATE TRIGGER mandates_no_update BEFORE UPDATE ON mandates
BEGIN SELECT RAISE(ABORT, 'mandates are immutable; insert a new version'); END;
CREATE TRIGGER mandates_no_delete BEFORE DELETE ON mandates
BEGIN SELECT RAISE(ABORT, 'mandates cannot be deleted'); END;
