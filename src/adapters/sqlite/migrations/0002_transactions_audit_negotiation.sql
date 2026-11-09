-- 0002: transactions (state machine), audit events (hash chain), offers, policy decisions, agreements.
-- Cyclic references (transactions <-> agreements <-> offers, transactions <-> audit_events) are
-- legal in SQLite and enforced at write time; triggers keep the cross-table rules consistent.

-- ---------------------------------------------------------------------------
-- Transactions. One row per negotiation->payment lifecycle ("negotiation id" == transaction id).
-- Created in NEGOTIATING; the agreement is attached on NEGOTIATING -> AGREED. Pins the exact
-- mandate (id, version) that was approved when the transaction started.
-- ---------------------------------------------------------------------------
CREATE TABLE transactions (
  id TEXT NOT NULL PRIMARY KEY CHECK (length(id) BETWEEN 1 AND 64),
  state TEXT NOT NULL REFERENCES tx_states (state),
  version INTEGER NOT NULL CHECK (version >= 1),
  reconciling_from TEXT REFERENCES tx_states (state),
  mandate_id TEXT NOT NULL,
  mandate_version INTEGER NOT NULL,
  agreement_id TEXT UNIQUE REFERENCES agreements (id),
  currency TEXT NOT NULL CHECK (length(currency) = 3 AND currency NOT GLOB '*[^A-Z]*'),
  -- PayPal object ids are identifiers, not secrets. No tokens or credentials are ever stored.
  paypal_order_id TEXT UNIQUE CHECK (paypal_order_id IS NULL OR length(paypal_order_id) BETWEEN 1 AND 64),
  paypal_authorization_id TEXT UNIQUE CHECK (paypal_authorization_id IS NULL OR length(paypal_authorization_id) BETWEEN 1 AND 64),
  paypal_capture_id TEXT UNIQUE CHECK (paypal_capture_id IS NULL OR length(paypal_capture_id) BETWEEN 1 AND 64),
  authorized_minor INTEGER CHECK (authorized_minor IS NULL OR (typeof(authorized_minor) = 'integer' AND authorized_minor >= 0 AND authorized_minor <= 9007199254740991)),
  captured_minor INTEGER CHECK (captured_minor IS NULL OR (typeof(captured_minor) = 'integer' AND captured_minor >= 0 AND captured_minor <= 9007199254740991)),
  authorized_at TEXT CHECK (authorized_at IS NULL OR authorized_at GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]*Z'),
  honor_expires_at TEXT CHECK (honor_expires_at IS NULL OR honor_expires_at GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]*Z'),
  last_event_seq INTEGER REFERENCES audit_events (seq),
  created_at TEXT NOT NULL CHECK (created_at GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]*Z'),
  updated_at TEXT NOT NULL CHECK (updated_at GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]*Z'),
  FOREIGN KEY (mandate_id, mandate_version) REFERENCES mandates (id, version),

  -- reconciliation bookkeeping
  CHECK ((state = 'NEEDS_RECONCILIATION') = (reconciling_from IS NOT NULL)),
  CHECK (reconciling_from IS NULL OR reconciling_from IN ('CREATING_ORDER', 'AUTHORIZING', 'CAPTURING', 'VOIDING')),
  -- an agreement exists from AGREED onward
  CHECK (state IN ('NEGOTIATING', 'REJECTED') OR agreement_id IS NOT NULL),
  -- PayPal ids and amounts must be present exactly when the state implies them
  CHECK (state NOT IN ('NEGOTIATING', 'AGREED', 'CREATING_ORDER')
         OR (paypal_order_id IS NULL AND paypal_authorization_id IS NULL AND paypal_capture_id IS NULL)),
  CHECK (state NOT IN ('ORDER_CREATED', 'ORDER_APPROVED', 'AUTHORIZING', 'AUTHORIZATION_PENDING', 'AUTHORIZED',
                       'CAPTURING', 'CAPTURE_PENDING', 'CAPTURED', 'VOIDING', 'REVERSED')
         OR paypal_order_id IS NOT NULL),
  CHECK (state NOT IN ('AUTHORIZED', 'CAPTURING', 'CAPTURE_PENDING', 'CAPTURED', 'VOIDING', 'REVERSED')
         OR (paypal_authorization_id IS NOT NULL AND authorized_minor IS NOT NULL AND authorized_at IS NOT NULL)),
  CHECK (state NOT IN ('CAPTURED', 'REVERSED') OR (paypal_capture_id IS NOT NULL AND captured_minor IS NOT NULL)),
  CHECK ((paypal_authorization_id IS NULL) = (authorized_minor IS NULL)),
  CHECK ((paypal_capture_id IS NULL) = (captured_minor IS NULL)),
  CHECK ((authorized_at IS NULL) = (honor_expires_at IS NULL)),
  CHECK ((authorized_at IS NULL) = (authorized_minor IS NULL)),
  CHECK (honor_expires_at IS NULL OR honor_expires_at > authorized_at),
  CHECK (captured_minor IS NULL OR (authorized_minor IS NOT NULL AND captured_minor <= authorized_minor))
) STRICT;

CREATE TRIGGER transactions_insert_rules BEFORE INSERT ON transactions
BEGIN
  SELECT RAISE(ABORT, 'new transactions must start NEGOTIATING at version 1 with no agreement, PayPal ids, amounts or event')
  WHERE NEW.state <> 'NEGOTIATING' OR NEW.version <> 1 OR NEW.agreement_id IS NOT NULL
     OR NEW.reconciling_from IS NOT NULL OR NEW.last_event_seq IS NOT NULL
     OR NEW.paypal_order_id IS NOT NULL OR NEW.paypal_authorization_id IS NOT NULL OR NEW.paypal_capture_id IS NOT NULL
     OR NEW.authorized_minor IS NOT NULL OR NEW.captured_minor IS NOT NULL
     OR NEW.authorized_at IS NOT NULL OR NEW.honor_expires_at IS NOT NULL;
  SELECT RAISE(ABORT, 'mandate must exist, be ACTIVE, be the latest version and not be expired')
  WHERE NOT EXISTS (
    SELECT 1 FROM mandates m
    WHERE m.id = NEW.mandate_id AND m.version = NEW.mandate_version AND m.status = 'ACTIVE'
      AND m.version = (SELECT MAX(version) FROM mandates WHERE id = NEW.mandate_id)
      AND NEW.created_at < m.expires_at
  );
  SELECT RAISE(ABORT, 'transaction currency must equal the mandate currency')
  WHERE NEW.currency <> (SELECT currency FROM mandates WHERE id = NEW.mandate_id AND version = NEW.mandate_version);
END;

CREATE TRIGGER transactions_update_rules BEFORE UPDATE ON transactions
BEGIN
  SELECT RAISE(ABORT, 'immutable transaction column changed')
  WHERE NEW.id <> OLD.id OR NEW.mandate_id <> OLD.mandate_id OR NEW.mandate_version <> OLD.mandate_version
     OR NEW.currency <> OLD.currency OR NEW.created_at <> OLD.created_at
     OR (OLD.agreement_id IS NOT NULL AND NEW.agreement_id IS NOT OLD.agreement_id)
     OR (OLD.paypal_order_id IS NOT NULL AND NEW.paypal_order_id IS NOT OLD.paypal_order_id)
     OR (OLD.paypal_authorization_id IS NOT NULL AND NEW.paypal_authorization_id IS NOT OLD.paypal_authorization_id)
     OR (OLD.paypal_capture_id IS NOT NULL AND NEW.paypal_capture_id IS NOT OLD.paypal_capture_id)
     OR (OLD.authorized_minor IS NOT NULL AND NEW.authorized_minor IS NOT OLD.authorized_minor)
     OR (OLD.captured_minor IS NOT NULL AND NEW.captured_minor IS NOT OLD.captured_minor)
     OR (OLD.authorized_at IS NOT NULL AND NEW.authorized_at IS NOT OLD.authorized_at)
     OR (OLD.honor_expires_at IS NOT NULL AND NEW.honor_expires_at IS NOT OLD.honor_expires_at);

  SELECT RAISE(ABORT, 'version must increase by exactly 1')
  WHERE NEW.version <> OLD.version + 1;

  SELECT RAISE(ABORT, 'illegal state transition')
  WHERE NEW.state <> OLD.state
    AND NOT EXISTS (SELECT 1 FROM tx_transitions WHERE from_state = OLD.state AND to_state = NEW.state);

  SELECT RAISE(ABORT, 'every state change must reference a newer TX_STATE_CHANGED audit event for this transaction')
  WHERE NEW.state <> OLD.state
    AND (NEW.last_event_seq IS NULL
         OR (OLD.last_event_seq IS NOT NULL AND NEW.last_event_seq <= OLD.last_event_seq)
         OR NOT EXISTS (SELECT 1 FROM audit_events e
                        WHERE e.seq = NEW.last_event_seq AND e.transaction_id = NEW.id AND e.type = 'TX_STATE_CHANGED'));

  SELECT RAISE(ABORT, 'last_event_seq may only change together with a state change')
  WHERE NEW.state = OLD.state AND NEW.last_event_seq IS NOT OLD.last_event_seq;

  SELECT RAISE(ABORT, 'NEEDS_RECONCILIATION must come from an in-flight state and record it')
  WHERE NEW.state <> OLD.state AND NEW.state = 'NEEDS_RECONCILIATION'
    AND (OLD.state NOT IN ('CREATING_ORDER', 'AUTHORIZING', 'CAPTURING', 'VOIDING') OR NEW.reconciling_from IS NOT OLD.state);

  SELECT RAISE(ABORT, 'reconciling_from may not change without leaving NEEDS_RECONCILIATION')
  WHERE NEW.state = OLD.state AND NEW.reconciling_from IS NOT OLD.reconciling_from;

  SELECT RAISE(ABORT, 'reconciliation outcome is not allowed for the in-flight state it came from')
  WHERE OLD.state = 'NEEDS_RECONCILIATION' AND NEW.state <> OLD.state
    AND NOT EXISTS (SELECT 1 FROM reconcile_targets WHERE in_flight_state = OLD.reconciling_from AND to_state = NEW.state);

  SELECT RAISE(ABORT, 'agreement may only be attached on NEGOTIATING -> AGREED')
  WHERE OLD.agreement_id IS NULL AND NEW.agreement_id IS NOT NULL AND NOT (OLD.state = 'NEGOTIATING' AND NEW.state = 'AGREED');

  SELECT RAISE(ABORT, 'agreement must belong to this transaction (offer, mandate version, currency) and its offer must be ACCEPTED')
  WHERE OLD.agreement_id IS NULL AND NEW.agreement_id IS NOT NULL
    AND NOT EXISTS (
      SELECT 1 FROM agreements a JOIN offers o ON o.id = a.offer_id
      WHERE a.id = NEW.agreement_id AND o.transaction_id = NEW.id AND o.status = 'ACCEPTED'
        AND a.mandate_id = NEW.mandate_id AND a.mandate_version = NEW.mandate_version AND a.currency = NEW.currency
    );

  SELECT RAISE(ABORT, 'authorized amount must equal the agreement total')
  WHERE NEW.authorized_minor IS NOT NULL
    AND NEW.authorized_minor <> (SELECT total_minor FROM agreements WHERE id = NEW.agreement_id);

  SELECT RAISE(ABORT, 'captured amount must equal the agreement total (full capture only)')
  WHERE NEW.captured_minor IS NOT NULL
    AND NEW.captured_minor <> (SELECT total_minor FROM agreements WHERE id = NEW.agreement_id);
END;

CREATE TRIGGER transactions_no_delete BEFORE DELETE ON transactions
BEGIN SELECT RAISE(ABORT, 'transactions cannot be deleted'); END;

-- ---------------------------------------------------------------------------
-- Audit events: append-only, hash-chained. The DB enforces gap-free seq and prev_hash linkage;
-- the application computes the SHA-256 (see audit.ts) and verifyChain() recomputes it.
-- The chain is local tamper-EVIDENCE only, not proof of external authenticity.
-- ---------------------------------------------------------------------------
CREATE TABLE audit_events (
  seq INTEGER PRIMARY KEY,
  ts TEXT NOT NULL CHECK (ts GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]*Z'),
  actor TEXT NOT NULL CHECK (actor IN ('OPERATOR', 'AGENT', 'SYSTEM', 'PAYPAL_API', 'PAYPAL_WEBHOOK')),
  type TEXT NOT NULL CHECK (length(type) BETWEEN 1 AND 64),
  subject_type TEXT NOT NULL CHECK (length(subject_type) BETWEEN 1 AND 64),
  subject_id TEXT NOT NULL CHECK (length(subject_id) BETWEEN 1 AND 128),
  transaction_id TEXT REFERENCES transactions (id),
  payload TEXT NOT NULL CHECK (json_valid(payload) AND length(payload) <= 16384),
  prev_hash TEXT NOT NULL CHECK (length(prev_hash) = 64 AND prev_hash NOT GLOB '*[^0-9a-f]*'),
  hash TEXT NOT NULL UNIQUE CHECK (length(hash) = 64 AND hash NOT GLOB '*[^0-9a-f]*')
) STRICT;

CREATE INDEX audit_events_by_transaction ON audit_events (transaction_id, seq);

CREATE TRIGGER audit_events_insert_rules BEFORE INSERT ON audit_events
BEGIN
  SELECT RAISE(ABORT, 'audit seq must be the previous seq + 1')
  WHERE NEW.seq IS NOT NULL AND NEW.seq <> COALESCE((SELECT MAX(seq) FROM audit_events), 0) + 1;
  SELECT RAISE(ABORT, 'audit prev_hash must equal the hash of the previous event')
  WHERE NEW.prev_hash <> COALESCE((SELECT hash FROM audit_events ORDER BY seq DESC LIMIT 1),
                                  '0000000000000000000000000000000000000000000000000000000000000000');
END;

CREATE TRIGGER audit_events_no_update BEFORE UPDATE ON audit_events
BEGIN SELECT RAISE(ABORT, 'audit events are append-only'); END;
CREATE TRIGGER audit_events_no_delete BEFORE DELETE ON audit_events
BEGIN SELECT RAISE(ABORT, 'audit events are append-only'); END;

-- ---------------------------------------------------------------------------
-- Offers. Seller terms are UNTRUSTED input and immutable once stored: a seller "revision" is a
-- new row (revision + 1) that supersedes the previous one. Only status may change, once.
-- ---------------------------------------------------------------------------
CREATE TABLE offers (
  id TEXT NOT NULL PRIMARY KEY CHECK (length(id) BETWEEN 1 AND 64),
  transaction_id TEXT NOT NULL REFERENCES transactions (id),
  seller_id TEXT NOT NULL REFERENCES sellers (id),
  revision INTEGER NOT NULL CHECK (revision >= 1),
  supersedes_offer_id TEXT REFERENCES offers (id),
  currency TEXT NOT NULL CHECK (length(currency) = 3 AND currency NOT GLOB '*[^A-Z]*'),
  shipping_minor INTEGER NOT NULL CHECK (typeof(shipping_minor) = 'integer' AND shipping_minor >= 0 AND shipping_minor <= 9007199254740991),
  fees_minor INTEGER NOT NULL CHECK (typeof(fees_minor) = 'integer' AND fees_minor >= 0 AND fees_minor <= 9007199254740991),
  claimed_total_minor INTEGER NOT NULL CHECK (typeof(claimed_total_minor) = 'integer' AND claimed_total_minor >= 0 AND claimed_total_minor <= 9007199254740991),
  server_total_minor INTEGER NOT NULL CHECK (typeof(server_total_minor) = 'integer' AND server_total_minor >= 0 AND server_total_minor <= 9007199254740991),
  terms_text TEXT NOT NULL CHECK (length(terms_text) <= 4000),
  terms_hash TEXT NOT NULL CHECK (length(terms_hash) = 64 AND terms_hash NOT GLOB '*[^0-9a-f]*'),
  valid_until TEXT NOT NULL CHECK (valid_until GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]*Z'),
  status TEXT NOT NULL CHECK (status IN ('OPEN', 'SUPERSEDED', 'EXPIRED', 'ACCEPTED', 'REJECTED')),
  created_at TEXT NOT NULL CHECK (created_at GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]*Z'),
  UNIQUE (transaction_id, revision),
  CHECK (supersedes_offer_id IS NULL OR supersedes_offer_id <> id),
  CHECK ((revision = 1) = (supersedes_offer_id IS NULL))
) STRICT;

CREATE TABLE offer_lines (
  offer_id TEXT NOT NULL REFERENCES offers (id),
  line_no INTEGER NOT NULL CHECK (line_no >= 1),
  sku TEXT NOT NULL CHECK (length(sku) BETWEEN 1 AND 64),
  description TEXT NOT NULL CHECK (length(description) <= 500),
  qty INTEGER NOT NULL CHECK (typeof(qty) = 'integer' AND qty BETWEEN 1 AND 1000000),
  unit_price_minor INTEGER NOT NULL CHECK (typeof(unit_price_minor) = 'integer' AND unit_price_minor >= 0 AND unit_price_minor <= 9007199254740991),
  -- explicit, and must equal the offer's currency (a line can never be priced in another currency)
  currency TEXT NOT NULL CHECK (length(currency) = 3 AND currency NOT GLOB '*[^A-Z]*'),
  PRIMARY KEY (offer_id, line_no)
) STRICT;

CREATE TRIGGER offers_insert_rules BEFORE INSERT ON offers
BEGIN
  SELECT RAISE(ABORT, 'offers can only be added while the transaction is NEGOTIATING')
  WHERE NOT EXISTS (SELECT 1 FROM transactions WHERE id = NEW.transaction_id AND state = 'NEGOTIATING');
  SELECT RAISE(ABORT, 'new offers must be OPEN')
  WHERE NEW.status <> 'OPEN';
  SELECT RAISE(ABORT, 'offer revision must be the previous revision + 1')
  WHERE NEW.revision <> COALESCE((SELECT MAX(revision) FROM offers WHERE transaction_id = NEW.transaction_id), 0) + 1;
  SELECT RAISE(ABORT, 'supersedes_offer_id must be the previous revision of the same transaction')
  WHERE NEW.supersedes_offer_id IS NOT NULL
    AND NOT EXISTS (SELECT 1 FROM offers WHERE id = NEW.supersedes_offer_id
                    AND transaction_id = NEW.transaction_id AND revision = NEW.revision - 1);
END;

CREATE TRIGGER offers_update_rules BEFORE UPDATE ON offers
BEGIN
  SELECT RAISE(ABORT, 'offer terms are immutable; only status may change')
  WHERE NEW.id IS NOT OLD.id OR NEW.transaction_id IS NOT OLD.transaction_id OR NEW.seller_id IS NOT OLD.seller_id
     OR NEW.revision IS NOT OLD.revision OR NEW.supersedes_offer_id IS NOT OLD.supersedes_offer_id
     OR NEW.currency IS NOT OLD.currency OR NEW.shipping_minor IS NOT OLD.shipping_minor
     OR NEW.fees_minor IS NOT OLD.fees_minor OR NEW.claimed_total_minor IS NOT OLD.claimed_total_minor
     OR NEW.server_total_minor IS NOT OLD.server_total_minor OR NEW.terms_text IS NOT OLD.terms_text
     OR NEW.terms_hash IS NOT OLD.terms_hash OR NEW.valid_until IS NOT OLD.valid_until
     OR NEW.created_at IS NOT OLD.created_at;
  SELECT RAISE(ABORT, 'offer status may only move from OPEN to a final status')
  WHERE OLD.status <> 'OPEN' OR NEW.status = 'OPEN';
  SELECT RAISE(ABORT, 'an offer can only be ACCEPTED once an agreement exists for it')
  WHERE NEW.status = 'ACCEPTED' AND NOT EXISTS (SELECT 1 FROM agreements WHERE offer_id = NEW.id);
END;

CREATE TRIGGER offers_no_delete BEFORE DELETE ON offers
BEGIN SELECT RAISE(ABORT, 'offers cannot be deleted'); END;

CREATE TRIGGER offer_lines_insert_rules BEFORE INSERT ON offer_lines
BEGIN
  SELECT RAISE(ABORT, 'lines can only be added to an OPEN offer')
  WHERE NOT EXISTS (SELECT 1 FROM offers WHERE id = NEW.offer_id AND status = 'OPEN');
  SELECT RAISE(ABORT, 'line currency must equal the offer currency')
  WHERE NEW.currency <> (SELECT currency FROM offers WHERE id = NEW.offer_id);
END;
CREATE TRIGGER offer_lines_no_update BEFORE UPDATE ON offer_lines
BEGIN SELECT RAISE(ABORT, 'offer lines are immutable'); END;
CREATE TRIGGER offer_lines_no_delete BEFORE DELETE ON offer_lines
BEGIN SELECT RAISE(ABORT, 'offer lines are immutable'); END;

-- ---------------------------------------------------------------------------
-- Policy decisions: every ALLOW/DENY with its reason codes. Immutable.
-- ---------------------------------------------------------------------------
CREATE TABLE policy_decisions (
  id TEXT NOT NULL PRIMARY KEY CHECK (length(id) BETWEEN 1 AND 64),
  subject TEXT NOT NULL CHECK (subject IN ('ACCEPT_OFFER', 'CREATE_ORDER', 'AUTHORIZE', 'CAPTURE', 'VOID')),
  transaction_id TEXT NOT NULL REFERENCES transactions (id),
  verdict TEXT NOT NULL CHECK (verdict IN ('ALLOW', 'DENY')),
  reason_codes TEXT NOT NULL CHECK (json_valid(reason_codes) AND json_type(reason_codes) = 'array'),
  inputs_hash TEXT NOT NULL CHECK (length(inputs_hash) = 64 AND inputs_hash NOT GLOB '*[^0-9a-f]*'),
  mandate_id TEXT NOT NULL,
  mandate_version INTEGER NOT NULL,
  decided_at TEXT NOT NULL CHECK (decided_at GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]*Z'),
  FOREIGN KEY (mandate_id, mandate_version) REFERENCES mandates (id, version),
  CHECK (verdict = 'DENY' OR json_array_length(reason_codes) = 0),
  CHECK (verdict = 'ALLOW' OR json_array_length(reason_codes) >= 1)
) STRICT;

CREATE TRIGGER policy_decisions_insert_rules BEFORE INSERT ON policy_decisions
BEGIN
  SELECT RAISE(ABORT, 'an ALLOW decision must reference the mandate version pinned by its transaction')
  WHERE NEW.verdict = 'ALLOW'
    AND NOT EXISTS (SELECT 1 FROM transactions t WHERE t.id = NEW.transaction_id
                    AND t.mandate_id = NEW.mandate_id AND t.mandate_version = NEW.mandate_version);
END;
CREATE TRIGGER policy_decisions_no_update BEFORE UPDATE ON policy_decisions
BEGIN SELECT RAISE(ABORT, 'policy decisions are immutable'); END;
CREATE TRIGGER policy_decisions_no_delete BEFORE DELETE ON policy_decisions
BEGIN SELECT RAISE(ABORT, 'policy decisions are immutable'); END;

-- ---------------------------------------------------------------------------
-- Agreements: the frozen contract. The only source of amount/payee/currency for payment.
-- The trigger re-derives every field from the offer, catalog, mandate and decision, so a caller
-- cannot persist an agreement that disagrees with them.
-- ---------------------------------------------------------------------------
CREATE TABLE agreements (
  id TEXT NOT NULL PRIMARY KEY CHECK (length(id) BETWEEN 1 AND 64),
  offer_id TEXT NOT NULL UNIQUE REFERENCES offers (id),
  terms_hash TEXT NOT NULL CHECK (length(terms_hash) = 64 AND terms_hash NOT GLOB '*[^0-9a-f]*'),
  mandate_id TEXT NOT NULL,
  mandate_version INTEGER NOT NULL,
  payee_ref TEXT NOT NULL CHECK (length(payee_ref) BETWEEN 1 AND 64),
  total_minor INTEGER NOT NULL CHECK (typeof(total_minor) = 'integer' AND total_minor > 0 AND total_minor <= 9007199254740991),
  currency TEXT NOT NULL CHECK (length(currency) = 3 AND currency NOT GLOB '*[^A-Z]*'),
  policy_decision_id TEXT NOT NULL UNIQUE REFERENCES policy_decisions (id),
  created_at TEXT NOT NULL CHECK (created_at GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]*Z'),
  FOREIGN KEY (mandate_id, mandate_version) REFERENCES mandates (id, version)
) STRICT;

CREATE TRIGGER agreements_insert_rules BEFORE INSERT ON agreements
BEGIN
  SELECT RAISE(ABORT, 'the offer must be OPEN to be agreed')
  WHERE NOT EXISTS (SELECT 1 FROM offers WHERE id = NEW.offer_id AND status = 'OPEN');

  SELECT RAISE(ABORT, 'agreement terms_hash must equal the offer terms_hash')
  WHERE NEW.terms_hash IS NOT (SELECT terms_hash FROM offers WHERE id = NEW.offer_id);

  SELECT RAISE(ABORT, 'agreement total and currency must equal the offer server total and currency')
  WHERE NEW.total_minor IS NOT (SELECT server_total_minor FROM offers WHERE id = NEW.offer_id)
     OR NEW.currency IS NOT (SELECT currency FROM offers WHERE id = NEW.offer_id);

  SELECT RAISE(ABORT, 'offer server total must equal lines + shipping + fees (and the offer must have lines)')
  WHERE NOT EXISTS (SELECT 1 FROM offer_lines WHERE offer_id = NEW.offer_id)
     OR (SELECT server_total_minor FROM offers WHERE id = NEW.offer_id) IS NOT
        (SELECT o.shipping_minor + o.fees_minor
                + COALESCE((SELECT SUM(l.qty * l.unit_price_minor) FROM offer_lines l WHERE l.offer_id = o.id), 0)
         FROM offers o WHERE o.id = NEW.offer_id);

  SELECT RAISE(ABORT, 'payee_ref must come from the offer seller catalog entry')
  WHERE NEW.payee_ref IS NOT (SELECT s.payee_ref FROM offers o JOIN sellers s ON s.id = o.seller_id WHERE o.id = NEW.offer_id);

  SELECT RAISE(ABORT, 'mandate must be the latest ACTIVE version, unexpired, same currency, and allow the seller')
  WHERE NOT EXISTS (
    SELECT 1 FROM mandates m JOIN offers o ON o.id = NEW.offer_id
    WHERE m.id = NEW.mandate_id AND m.version = NEW.mandate_version AND m.status = 'ACTIVE'
      AND m.version = (SELECT MAX(version) FROM mandates WHERE id = m.id)
      AND m.currency = NEW.currency AND NEW.created_at < m.expires_at
      AND EXISTS (SELECT 1 FROM json_each(m.allowed_seller_ids) j WHERE j.value = o.seller_id)
  );

  SELECT RAISE(ABORT, 'agreement total exceeds the mandate per-transaction cap')
  WHERE NEW.total_minor > (SELECT per_tx_cap_minor FROM mandates WHERE id = NEW.mandate_id AND version = NEW.mandate_version);

  SELECT RAISE(ABORT, 'policy decision must be an ALLOW for ACCEPT_OFFER on the same transaction and mandate version')
  WHERE NOT EXISTS (
    SELECT 1 FROM policy_decisions d JOIN offers o ON o.id = NEW.offer_id
    WHERE d.id = NEW.policy_decision_id AND d.verdict = 'ALLOW' AND d.subject = 'ACCEPT_OFFER'
      AND d.transaction_id = o.transaction_id
      AND d.mandate_id = NEW.mandate_id AND d.mandate_version = NEW.mandate_version
  );
END;
CREATE TRIGGER agreements_no_update BEFORE UPDATE ON agreements
BEGIN SELECT RAISE(ABORT, 'agreements are immutable'); END;
CREATE TRIGGER agreements_no_delete BEFORE DELETE ON agreements
BEGIN SELECT RAISE(ABORT, 'agreements are immutable'); END;
