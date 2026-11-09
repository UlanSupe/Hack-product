-- Negotiation and agreement workflow (docs/NEGOTIATION.md).
--
-- A negotiation holds a buyer request, a timeout, and any number of sellers. Every offer and counter-offer is a
-- stored, immutable VERSION (a proposal); a change is a new row, never an edit. An accepted proposal passes the
-- policy engine and becomes an agreement VERSION that pins a core transaction. A different accepted proposal retires
-- the previous agreement and its approval. The core tables (offers, agreements, transactions, approvals) are reused
-- unchanged for the executable part of the deal.

-- ---------------------------------------------------------------------------
-- Negotiations: the buyer's request and constraints are immutable; only status can move.
-- ---------------------------------------------------------------------------
CREATE TABLE negotiations (
  id TEXT NOT NULL PRIMARY KEY CHECK (length(id) BETWEEN 1 AND 64),
  owner_id TEXT NOT NULL CHECK (length(owner_id) BETWEEN 1 AND 64),
  mandate_id TEXT NOT NULL CHECK (length(mandate_id) BETWEEN 1 AND 64),
  status TEXT NOT NULL CHECK (status IN ('OPEN', 'AGREED', 'REJECTED', 'TIMED_OUT', 'CANCELLED')),
  currency TEXT NOT NULL CHECK (length(currency) = 3 AND currency NOT GLOB '*[^A-Z]*'),
  category TEXT NOT NULL REFERENCES service_categories (code),
  quantity INTEGER NOT NULL CHECK (typeof(quantity) = 'integer' AND quantity BETWEEN 1 AND 1000),
  summary TEXT NOT NULL CHECK (length(summary) BETWEEN 1 AND 300),
  max_total_minor INTEGER CHECK (max_total_minor IS NULL OR (typeof(max_total_minor) = 'integer' AND max_total_minor BETWEEN 0 AND 9007199254740991)),
  needed_within_days INTEGER CHECK (needed_within_days IS NULL OR (typeof(needed_within_days) = 'integer' AND needed_within_days BETWEEN 0 AND 365)),
  required_deliverables TEXT NOT NULL CHECK (json_valid(required_deliverables) AND json_type(required_deliverables) = 'array'),
  invited_seller_ids TEXT NOT NULL CHECK (json_valid(invited_seller_ids) AND json_type(invited_seller_ids) = 'array' AND json_array_length(invited_seller_ids) BETWEEN 1 AND 5),
  expires_at TEXT NOT NULL CHECK (expires_at GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]*Z'),
  closed_reason TEXT CHECK (closed_reason IS NULL OR length(closed_reason) <= 500),
  version INTEGER NOT NULL CHECK (version >= 1),
  created_at TEXT NOT NULL CHECK (created_at GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]*Z'),
  updated_at TEXT NOT NULL CHECK (updated_at GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]*Z'),
  CHECK (updated_at >= created_at AND expires_at > created_at)
) STRICT;

CREATE TRIGGER negotiations_insert_rules BEFORE INSERT ON negotiations
BEGIN
  SELECT RAISE(ABORT, 'a negotiation starts OPEN at version 1')
  WHERE NEW.status <> 'OPEN' OR NEW.version <> 1;
  SELECT RAISE(ABORT, 'the mandate does not exist')
  WHERE NOT EXISTS (SELECT 1 FROM mandates WHERE id = NEW.mandate_id);
  SELECT RAISE(ABORT, 'every invited seller must exist')
  WHERE EXISTS (SELECT 1 FROM json_each(NEW.invited_seller_ids) j WHERE j.value NOT IN (SELECT id FROM sellers));
END;

CREATE TRIGGER negotiations_update_rules BEFORE UPDATE ON negotiations
BEGIN
  SELECT RAISE(ABORT, 'the request and its constraints are immutable; only the status can change')
  WHERE NEW.id IS NOT OLD.id OR NEW.owner_id IS NOT OLD.owner_id OR NEW.mandate_id IS NOT OLD.mandate_id
     OR NEW.currency IS NOT OLD.currency OR NEW.category IS NOT OLD.category OR NEW.quantity IS NOT OLD.quantity
     OR NEW.summary IS NOT OLD.summary OR NEW.max_total_minor IS NOT OLD.max_total_minor
     OR NEW.needed_within_days IS NOT OLD.needed_within_days OR NEW.required_deliverables IS NOT OLD.required_deliverables
     OR NEW.invited_seller_ids IS NOT OLD.invited_seller_ids OR NEW.expires_at IS NOT OLD.expires_at
     OR NEW.created_at IS NOT OLD.created_at;
  SELECT RAISE(ABORT, 'illegal negotiation status change')
  WHERE NEW.status = OLD.status
     OR NOT ((OLD.status = 'OPEN' AND NEW.status IN ('AGREED', 'REJECTED', 'TIMED_OUT', 'CANCELLED'))
          OR (OLD.status = 'AGREED' AND NEW.status IN ('OPEN', 'CANCELLED')));
  SELECT RAISE(ABORT, 'version must grow by exactly 1')
  WHERE NEW.version <> OLD.version + 1;
  SELECT RAISE(ABORT, 'a closed negotiation needs a reason')
  WHERE NEW.status IN ('REJECTED', 'TIMED_OUT', 'CANCELLED') AND NEW.closed_reason IS NULL;
END;
CREATE TRIGGER negotiations_no_delete BEFORE DELETE ON negotiations
BEGIN SELECT RAISE(ABORT, 'negotiations cannot be deleted'); END;

-- ---------------------------------------------------------------------------
-- Proposals: every offer and counter-offer, as an immutable version. The payee is a snapshot that the schema
-- forces to equal the seller's catalog payee at submission, so a proposal can never name another payee.
-- ---------------------------------------------------------------------------
CREATE TABLE negotiation_proposals (
  id TEXT NOT NULL PRIMARY KEY CHECK (length(id) BETWEEN 1 AND 64),
  negotiation_id TEXT NOT NULL REFERENCES negotiations (id),
  seq INTEGER NOT NULL CHECK (seq >= 1),
  seller_id TEXT NOT NULL REFERENCES sellers (id),
  kind TEXT NOT NULL CHECK (kind IN ('SELLER_OFFER', 'BUYER_COUNTER')),
  version INTEGER NOT NULL CHECK (version >= 1),
  supersedes_id TEXT REFERENCES negotiation_proposals (id),
  responds_to_id TEXT REFERENCES negotiation_proposals (id),
  status TEXT NOT NULL CHECK (status IN ('OPEN', 'SUPERSEDED', 'ACCEPTED', 'REJECTED', 'EXPIRED', 'WITHDRAWN')),
  status_reason TEXT CHECK (status_reason IS NULL OR length(status_reason) <= 500),
  decided_at TEXT CHECK (decided_at IS NULL OR decided_at GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]*Z'),
  currency TEXT NOT NULL CHECK (length(currency) = 3 AND currency NOT GLOB '*[^A-Z]*'),
  category TEXT NOT NULL REFERENCES service_categories (code),
  lines TEXT CHECK (lines IS NULL OR (json_valid(lines) AND json_type(lines) = 'array' AND json_array_length(lines) BETWEEN 1 AND 20)),
  shipping_minor INTEGER NOT NULL CHECK (typeof(shipping_minor) = 'integer' AND shipping_minor BETWEEN 0 AND 9007199254740991),
  fees_minor INTEGER NOT NULL CHECK (typeof(fees_minor) = 'integer' AND fees_minor BETWEEN 0 AND 9007199254740991),
  claimed_total_minor INTEGER CHECK (claimed_total_minor IS NULL OR (typeof(claimed_total_minor) = 'integer' AND claimed_total_minor BETWEEN 0 AND 9007199254740991)),
  total_minor INTEGER NOT NULL CHECK (typeof(total_minor) = 'integer' AND total_minor BETWEEN 0 AND 9007199254740991),
  deliverables TEXT NOT NULL CHECK (json_valid(deliverables) AND json_type(deliverables) = 'array' AND json_array_length(deliverables) BETWEEN 1 AND 10),
  delivery_days INTEGER NOT NULL CHECK (typeof(delivery_days) = 'integer' AND delivery_days BETWEEN 0 AND 365),
  deliver_by TEXT NOT NULL CHECK (deliver_by GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]*Z'),
  terms_text TEXT NOT NULL CHECK (length(terms_text) <= 1000),
  payee_ref TEXT NOT NULL CHECK (length(payee_ref) BETWEEN 1 AND 64),
  valid_until TEXT NOT NULL CHECK (valid_until GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]*Z'),
  terms_hash TEXT NOT NULL CHECK (length(terms_hash) = 64 AND terms_hash NOT GLOB '*[^0-9a-f]*'),
  changes TEXT NOT NULL CHECK (json_valid(changes) AND json_type(changes) = 'array'),
  actor TEXT NOT NULL CHECK (actor IN ('OPERATOR', 'AGENT', 'SYSTEM')),
  created_at TEXT NOT NULL CHECK (created_at GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]*Z'),
  UNIQUE (negotiation_id, seq),
  UNIQUE (negotiation_id, seller_id, kind, version),
  CHECK (valid_until > created_at),
  CHECK ((version = 1) = (supersedes_id IS NULL)),
  CHECK (supersedes_id IS NULL OR supersedes_id <> id),
  CHECK ((status = 'OPEN') = (decided_at IS NULL)),
  -- an offer states lines and a claimed total; a counter-offer states only a target total
  CHECK (kind <> 'SELLER_OFFER' OR (lines IS NOT NULL AND claimed_total_minor IS NOT NULL)),
  CHECK (kind <> 'BUYER_COUNTER' OR (lines IS NULL AND claimed_total_minor IS NULL AND shipping_minor = 0 AND fees_minor = 0)),
  CHECK (kind = 'SELLER_OFFER' OR status <> 'ACCEPTED')
) STRICT;

CREATE TRIGGER negotiation_proposals_insert_rules BEFORE INSERT ON negotiation_proposals
BEGIN
  SELECT RAISE(ABORT, 'proposals can only be added to an OPEN or AGREED negotiation')
  WHERE NOT EXISTS (SELECT 1 FROM negotiations WHERE id = NEW.negotiation_id AND status IN ('OPEN', 'AGREED'));
  SELECT RAISE(ABORT, 'new proposals must be OPEN')
  WHERE NEW.status <> 'OPEN';
  SELECT RAISE(ABORT, 'the seller was not invited to this negotiation')
  WHERE NOT EXISTS (SELECT 1 FROM negotiations n, json_each(n.invited_seller_ids) j
                    WHERE n.id = NEW.negotiation_id AND j.value = NEW.seller_id);
  SELECT RAISE(ABORT, 'seq must be the previous seq + 1')
  WHERE NEW.seq <> COALESCE((SELECT MAX(seq) FROM negotiation_proposals WHERE negotiation_id = NEW.negotiation_id), 0) + 1;
  SELECT RAISE(ABORT, 'version must be the previous version of this chain + 1')
  WHERE NEW.version <> COALESCE((SELECT MAX(version) FROM negotiation_proposals
                                 WHERE negotiation_id = NEW.negotiation_id AND seller_id = NEW.seller_id AND kind = NEW.kind), 0) + 1;
  SELECT RAISE(ABORT, 'supersedes_id must be the previous version of the same seller and kind')
  WHERE NEW.supersedes_id IS NOT NULL
    AND NOT EXISTS (SELECT 1 FROM negotiation_proposals
                    WHERE id = NEW.supersedes_id AND negotiation_id = NEW.negotiation_id AND seller_id = NEW.seller_id
                      AND kind = NEW.kind AND version = NEW.version - 1);
  SELECT RAISE(ABORT, 'the payee must be the seller catalog payee: a proposal cannot name another payee')
  WHERE NEW.payee_ref IS NOT (SELECT payee_ref FROM sellers WHERE id = NEW.seller_id);
  SELECT RAISE(ABORT, 'responds_to_id must be a proposal of the same negotiation and seller, of the other kind')
  WHERE NEW.responds_to_id IS NOT NULL
    AND NOT EXISTS (SELECT 1 FROM negotiation_proposals
                    WHERE id = NEW.responds_to_id AND negotiation_id = NEW.negotiation_id
                      AND seller_id = NEW.seller_id AND kind <> NEW.kind);
END;

CREATE TRIGGER negotiation_proposals_update_rules BEFORE UPDATE ON negotiation_proposals
BEGIN
  SELECT RAISE(ABORT, 'proposal terms are immutable; only the status may change, once')
  WHERE NEW.id IS NOT OLD.id OR NEW.negotiation_id IS NOT OLD.negotiation_id OR NEW.seq IS NOT OLD.seq
     OR NEW.seller_id IS NOT OLD.seller_id OR NEW.kind IS NOT OLD.kind OR NEW.version IS NOT OLD.version
     OR NEW.supersedes_id IS NOT OLD.supersedes_id OR NEW.responds_to_id IS NOT OLD.responds_to_id
     OR NEW.currency IS NOT OLD.currency OR NEW.category IS NOT OLD.category OR NEW.lines IS NOT OLD.lines
     OR NEW.shipping_minor IS NOT OLD.shipping_minor OR NEW.fees_minor IS NOT OLD.fees_minor
     OR NEW.claimed_total_minor IS NOT OLD.claimed_total_minor OR NEW.total_minor IS NOT OLD.total_minor
     OR NEW.deliverables IS NOT OLD.deliverables OR NEW.delivery_days IS NOT OLD.delivery_days
     OR NEW.deliver_by IS NOT OLD.deliver_by OR NEW.terms_text IS NOT OLD.terms_text
     OR NEW.payee_ref IS NOT OLD.payee_ref OR NEW.valid_until IS NOT OLD.valid_until
     OR NEW.terms_hash IS NOT OLD.terms_hash OR NEW.changes IS NOT OLD.changes
     OR NEW.actor IS NOT OLD.actor OR NEW.created_at IS NOT OLD.created_at;
  SELECT RAISE(ABORT, 'a proposal can only move from OPEN to a final status')
  WHERE OLD.status <> 'OPEN' OR NEW.status = 'OPEN';
END;
CREATE TRIGGER negotiation_proposals_no_delete BEFORE DELETE ON negotiation_proposals
BEGIN SELECT RAISE(ABORT, 'proposals cannot be deleted'); END;

-- ---------------------------------------------------------------------------
-- Agreement versions: each links an accepted proposal to the core agreement and transaction it created.
-- At most one is ACTIVE. Retiring one records why, and whether an approval on file was invalidated.
-- ---------------------------------------------------------------------------
CREATE TABLE negotiation_agreements (
  id TEXT NOT NULL PRIMARY KEY CHECK (length(id) BETWEEN 1 AND 64),
  negotiation_id TEXT NOT NULL REFERENCES negotiations (id),
  version INTEGER NOT NULL CHECK (version >= 1),
  proposal_id TEXT NOT NULL UNIQUE REFERENCES negotiation_proposals (id),
  proposal_hash TEXT NOT NULL CHECK (length(proposal_hash) = 64 AND proposal_hash NOT GLOB '*[^0-9a-f]*'),
  transaction_id TEXT NOT NULL UNIQUE REFERENCES transactions (id),
  agreement_id TEXT NOT NULL UNIQUE REFERENCES agreements (id),
  policy_decision_id TEXT NOT NULL UNIQUE REFERENCES policy_decisions (id),
  status TEXT NOT NULL CHECK (status IN ('ACTIVE', 'INVALIDATED', 'CANCELLED')),
  invalidated_reason TEXT CHECK (invalidated_reason IS NULL OR length(invalidated_reason) <= 500),
  invalidated_by_proposal_id TEXT REFERENCES negotiation_proposals (id),
  approval_was_valid INTEGER CHECK (approval_was_valid IS NULL OR approval_was_valid IN (0, 1)),
  invalidated_at TEXT CHECK (invalidated_at IS NULL OR invalidated_at GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]*Z'),
  created_at TEXT NOT NULL CHECK (created_at GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]*Z'),
  UNIQUE (negotiation_id, version),
  CHECK ((status = 'ACTIVE') = (invalidated_at IS NULL)),
  CHECK (status = 'ACTIVE' OR invalidated_reason IS NOT NULL)
) STRICT;
CREATE UNIQUE INDEX negotiation_agreements_one_active ON negotiation_agreements (negotiation_id) WHERE status = 'ACTIVE';

CREATE TRIGGER negotiation_agreements_insert_rules BEFORE INSERT ON negotiation_agreements
BEGIN
  SELECT RAISE(ABORT, 'a new agreement version must be ACTIVE')
  WHERE NEW.status <> 'ACTIVE';
  SELECT RAISE(ABORT, 'agreement version must be the previous version + 1')
  WHERE NEW.version <> COALESCE((SELECT MAX(version) FROM negotiation_agreements WHERE negotiation_id = NEW.negotiation_id), 0) + 1;
  SELECT RAISE(ABORT, 'only an ACCEPTED seller offer of this negotiation can become an agreement, and its hash must match')
  WHERE NOT EXISTS (SELECT 1 FROM negotiation_proposals p
                    WHERE p.id = NEW.proposal_id AND p.negotiation_id = NEW.negotiation_id
                      AND p.kind = 'SELLER_OFFER' AND p.status = 'ACCEPTED' AND p.terms_hash = NEW.proposal_hash);
  SELECT RAISE(ABORT, 'the transaction must be the one carrying this core agreement')
  WHERE NOT EXISTS (SELECT 1 FROM transactions t WHERE t.id = NEW.transaction_id AND t.agreement_id = NEW.agreement_id);
  SELECT RAISE(ABORT, 'the core agreement must be the one created from the accepted proposal total, currency and payee')
  WHERE NOT EXISTS (SELECT 1 FROM agreements a JOIN negotiation_proposals p ON p.id = NEW.proposal_id
                    WHERE a.id = NEW.agreement_id AND a.total_minor = p.total_minor
                      AND a.currency = p.currency AND a.payee_ref = p.payee_ref);
END;

CREATE TRIGGER negotiation_agreements_update_rules BEFORE UPDATE ON negotiation_agreements
BEGIN
  SELECT RAISE(ABORT, 'agreement versions are immutable; only ACTIVE can be retired, once')
  WHERE NEW.id IS NOT OLD.id OR NEW.negotiation_id IS NOT OLD.negotiation_id OR NEW.version IS NOT OLD.version
     OR NEW.proposal_id IS NOT OLD.proposal_id OR NEW.proposal_hash IS NOT OLD.proposal_hash
     OR NEW.transaction_id IS NOT OLD.transaction_id OR NEW.agreement_id IS NOT OLD.agreement_id
     OR NEW.policy_decision_id IS NOT OLD.policy_decision_id OR NEW.created_at IS NOT OLD.created_at
     OR OLD.status <> 'ACTIVE' OR NEW.status = 'ACTIVE';
END;
CREATE TRIGGER negotiation_agreements_no_delete BEFORE DELETE ON negotiation_agreements
BEGIN SELECT RAISE(ABORT, 'agreement versions cannot be deleted'); END;

-- ---------------------------------------------------------------------------
-- Every policy evaluation made for this workflow, ALLOW or DENY, with its reason codes and the hash of its inputs.
-- ---------------------------------------------------------------------------
CREATE TABLE negotiation_policy_checks (
  id TEXT NOT NULL PRIMARY KEY CHECK (length(id) BETWEEN 1 AND 64),
  negotiation_id TEXT NOT NULL REFERENCES negotiations (id),
  proposal_id TEXT REFERENCES negotiation_proposals (id),
  agreement_link_id TEXT REFERENCES negotiation_agreements (id),
  subject TEXT NOT NULL CHECK (subject IN ('ACCEPT_OFFER', 'CREATE_ORDER')),
  verdict TEXT NOT NULL CHECK (verdict IN ('ALLOW', 'DENY')),
  reason_codes TEXT NOT NULL CHECK (json_valid(reason_codes) AND json_type(reason_codes) = 'array'),
  explanation TEXT NOT NULL CHECK (length(explanation) <= 1500),
  policy_version TEXT NOT NULL CHECK (length(policy_version) BETWEEN 1 AND 64),
  inputs_hash TEXT NOT NULL CHECK (length(inputs_hash) = 64 AND inputs_hash NOT GLOB '*[^0-9a-f]*'),
  mandate_id TEXT,
  mandate_version INTEGER,
  actor TEXT NOT NULL CHECK (actor IN ('OPERATOR', 'AGENT', 'SYSTEM')),
  decided_at TEXT NOT NULL CHECK (decided_at GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]*Z'),
  CHECK (verdict = 'DENY' OR json_array_length(reason_codes) = 0),
  CHECK (verdict = 'ALLOW' OR json_array_length(reason_codes) >= 1),
  CHECK (proposal_id IS NOT NULL OR agreement_link_id IS NOT NULL)
) STRICT;
CREATE INDEX negotiation_policy_checks_by_negotiation ON negotiation_policy_checks (negotiation_id, decided_at);
CREATE TRIGGER negotiation_policy_checks_no_update BEFORE UPDATE ON negotiation_policy_checks
BEGIN SELECT RAISE(ABORT, 'policy checks are immutable'); END;
CREATE TRIGGER negotiation_policy_checks_no_delete BEFORE DELETE ON negotiation_policy_checks
BEGIN SELECT RAISE(ABORT, 'policy checks are immutable'); END;
