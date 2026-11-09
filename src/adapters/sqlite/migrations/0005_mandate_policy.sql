-- 0005: financial mandate policy.
--   * mandates gain: allowed categories, human-approval threshold, review-before-execution flag, source draft
--   * service categories (read-only reference list) and categories on catalog items / offer lines
--   * mandate_drafts: the ONLY mutable place a mandate can be edited. Approving a draft inserts a new
--     immutable mandate version; editing a draft can never change an approved mandate.
--   * transaction_approvals + a gate: execution of a transaction that needs human approval is impossible
--     without a recorded operator approval.
-- Legacy rows (created before this migration) get the SAFEST defaults: no allowed categories (so no line can
-- be agreed), threshold 0 and review required (so every transaction would need approval).

-- ---------------------------------------------------------------------------
-- Service categories (mirrors CATEGORY_CODES in src/domain/mandate.ts; a test checks they agree).
-- ---------------------------------------------------------------------------
CREATE TABLE service_categories (
  code TEXT NOT NULL PRIMARY KEY CHECK (length(code) BETWEEN 1 AND 32 AND code NOT GLOB '*[^A-Z_]*'),
  label TEXT NOT NULL CHECK (length(label) BETWEEN 1 AND 64)
) STRICT;

INSERT INTO service_categories (code, label) VALUES
  ('COMPUTE', 'Compute & GPU'),
  ('STORAGE', 'Storage & backup'),
  ('DATA', 'Data services'),
  ('SOFTWARE', 'Software subscriptions'),
  ('DESIGN', 'Design & creative'),
  ('CONSULTING', 'Consulting');

CREATE TRIGGER service_categories_readonly_ins BEFORE INSERT ON service_categories
BEGIN SELECT RAISE(ABORT, 'reference table is read-only; change it with a new migration'); END;
CREATE TRIGGER service_categories_readonly_upd BEFORE UPDATE ON service_categories
BEGIN SELECT RAISE(ABORT, 'reference table is read-only; change it with a new migration'); END;
CREATE TRIGGER service_categories_readonly_del BEFORE DELETE ON service_categories
BEGIN SELECT RAISE(ABORT, 'reference table is read-only; change it with a new migration'); END;

ALTER TABLE seller_catalog_items ADD COLUMN category TEXT REFERENCES service_categories (code);
ALTER TABLE offer_lines ADD COLUMN category TEXT REFERENCES service_categories (code);

-- ---------------------------------------------------------------------------
-- Drafts: mutable, versioned by `revision`, one open draft per mandate lineage.
-- ---------------------------------------------------------------------------
CREATE TABLE mandate_drafts (
  id TEXT NOT NULL PRIMARY KEY CHECK (length(id) BETWEEN 1 AND 64),
  mandate_id TEXT NOT NULL CHECK (length(mandate_id) BETWEEN 1 AND 64),
  base_version INTEGER CHECK (base_version IS NULL OR base_version >= 1),
  owner_id TEXT NOT NULL CHECK (length(owner_id) BETWEEN 1 AND 64),
  revision INTEGER NOT NULL CHECK (revision >= 1),
  status TEXT NOT NULL CHECK (status IN ('DRAFT', 'APPROVED', 'DISCARDED')),
  currency TEXT NOT NULL CHECK (length(currency) = 3 AND currency NOT GLOB '*[^A-Z]*'),
  total_budget_minor INTEGER NOT NULL CHECK (typeof(total_budget_minor) = 'integer' AND total_budget_minor > 0 AND total_budget_minor <= 9007199254740991),
  per_tx_cap_minor INTEGER NOT NULL CHECK (typeof(per_tx_cap_minor) = 'integer' AND per_tx_cap_minor > 0 AND per_tx_cap_minor <= total_budget_minor),
  approval_threshold_minor INTEGER NOT NULL CHECK (typeof(approval_threshold_minor) = 'integer' AND approval_threshold_minor >= 0 AND approval_threshold_minor <= per_tx_cap_minor),
  require_review INTEGER NOT NULL CHECK (require_review IN (0, 1)),
  allowed_categories TEXT NOT NULL CHECK (json_valid(allowed_categories) AND json_type(allowed_categories) = 'array' AND json_array_length(allowed_categories) BETWEEN 1 AND 6),
  allowed_seller_ids TEXT NOT NULL CHECK (json_valid(allowed_seller_ids) AND json_type(allowed_seller_ids) = 'array' AND json_array_length(allowed_seller_ids) BETWEEN 1 AND 20),
  valid_days INTEGER NOT NULL CHECK (typeof(valid_days) = 'integer' AND valid_days BETWEEN 1 AND 365),
  approved_version INTEGER CHECK (approved_version IS NULL OR approved_version >= 1),
  created_at TEXT NOT NULL CHECK (created_at GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]*Z'),
  updated_at TEXT NOT NULL CHECK (updated_at GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]*Z'),
  FOREIGN KEY (mandate_id, base_version) REFERENCES mandates (id, version),
  CHECK ((status = 'APPROVED') = (approved_version IS NOT NULL))
) STRICT;

CREATE UNIQUE INDEX mandate_drafts_one_open_per_mandate ON mandate_drafts (mandate_id) WHERE status = 'DRAFT';

CREATE TRIGGER mandate_drafts_insert_rules BEFORE INSERT ON mandate_drafts
BEGIN
  SELECT RAISE(ABORT, 'new drafts must be DRAFT at revision 1')
  WHERE NEW.status <> 'DRAFT' OR NEW.revision <> 1 OR NEW.approved_version IS NOT NULL;
  SELECT RAISE(ABORT, 'draft categories must all be supported')
  WHERE EXISTS (SELECT 1 FROM json_each(NEW.allowed_categories) j
                WHERE j.type <> 'text' OR NOT EXISTS (SELECT 1 FROM service_categories c WHERE c.code = j.value));
  SELECT RAISE(ABORT, 'draft sellers must all exist')
  WHERE EXISTS (SELECT 1 FROM json_each(NEW.allowed_seller_ids) j
                WHERE j.type <> 'text' OR NOT EXISTS (SELECT 1 FROM sellers s WHERE s.id = j.value));
  SELECT RAISE(ABORT, 'a draft for a new mandate must not reuse an existing mandate id')
  WHERE NEW.base_version IS NULL AND EXISTS (SELECT 1 FROM mandates WHERE id = NEW.mandate_id);
  SELECT RAISE(ABORT, 'a draft must be based on the latest ACTIVE version of its mandate')
  WHERE NEW.base_version IS NOT NULL
    AND NOT EXISTS (SELECT 1 FROM mandates m WHERE m.id = NEW.mandate_id AND m.version = NEW.base_version
                    AND m.status = 'ACTIVE' AND m.version = (SELECT MAX(version) FROM mandates WHERE id = NEW.mandate_id));
END;

CREATE TRIGGER mandate_drafts_update_rules BEFORE UPDATE ON mandate_drafts
BEGIN
  SELECT RAISE(ABORT, 'immutable draft column changed')
  WHERE NEW.id IS NOT OLD.id OR NEW.mandate_id IS NOT OLD.mandate_id OR NEW.base_version IS NOT OLD.base_version
     OR NEW.owner_id IS NOT OLD.owner_id OR NEW.created_at IS NOT OLD.created_at;
  SELECT RAISE(ABORT, 'only an open DRAFT can change; approved and discarded drafts are final')
  WHERE OLD.status <> 'DRAFT';
  SELECT RAISE(ABORT, 'draft revision must increase by exactly 1')
  WHERE NEW.revision <> OLD.revision + 1;
  SELECT RAISE(ABORT, 'draft categories must all be supported')
  WHERE EXISTS (SELECT 1 FROM json_each(NEW.allowed_categories) j
                WHERE j.type <> 'text' OR NOT EXISTS (SELECT 1 FROM service_categories c WHERE c.code = j.value));
  SELECT RAISE(ABORT, 'draft sellers must all exist')
  WHERE EXISTS (SELECT 1 FROM json_each(NEW.allowed_seller_ids) j
                WHERE j.type <> 'text' OR NOT EXISTS (SELECT 1 FROM sellers s WHERE s.id = j.value));
  SELECT RAISE(ABORT, 'an approved draft must match the mandate version that was created from it')
  WHERE NEW.status = 'APPROVED'
    AND NOT EXISTS (
      SELECT 1 FROM mandates m
      WHERE m.id = NEW.mandate_id AND m.version = NEW.approved_version AND m.source_draft_id = NEW.id AND m.status = 'ACTIVE'
        AND m.currency = NEW.currency AND m.total_budget_minor = NEW.total_budget_minor
        AND m.per_tx_cap_minor = NEW.per_tx_cap_minor AND m.approval_threshold_minor = NEW.approval_threshold_minor
        AND m.require_review = NEW.require_review AND m.allowed_categories = NEW.allowed_categories
        AND m.allowed_seller_ids = NEW.allowed_seller_ids
    );
END;

CREATE TRIGGER mandate_drafts_no_delete BEFORE DELETE ON mandate_drafts
BEGIN SELECT RAISE(ABORT, 'drafts cannot be deleted'); END;

-- ---------------------------------------------------------------------------
-- Mandates: new policy fields (immutable like every other mandate column).
-- ---------------------------------------------------------------------------
ALTER TABLE mandates ADD COLUMN allowed_categories TEXT NOT NULL DEFAULT '[]'
  CHECK (json_valid(allowed_categories) AND json_type(allowed_categories) = 'array');
ALTER TABLE mandates ADD COLUMN approval_threshold_minor INTEGER NOT NULL DEFAULT 0
  CHECK (typeof(approval_threshold_minor) = 'integer' AND approval_threshold_minor >= 0 AND approval_threshold_minor <= 9007199254740991);
ALTER TABLE mandates ADD COLUMN require_review INTEGER NOT NULL DEFAULT 1 CHECK (require_review IN (0, 1));
ALTER TABLE mandates ADD COLUMN source_draft_id TEXT REFERENCES mandate_drafts (id);

CREATE TRIGGER mandates_policy_insert_rules BEFORE INSERT ON mandates
BEGIN
  SELECT RAISE(ABORT, 'allowed_categories must be a non-empty list of supported categories')
  WHERE json_array_length(NEW.allowed_categories) < 1
     OR EXISTS (SELECT 1 FROM json_each(NEW.allowed_categories) j
                WHERE j.type <> 'text' OR NOT EXISTS (SELECT 1 FROM service_categories c WHERE c.code = j.value));
  SELECT RAISE(ABORT, 'approval threshold must not exceed the per-transaction cap')
  WHERE NEW.approval_threshold_minor > NEW.per_tx_cap_minor;
  SELECT RAISE(ABORT, 'a version created from a draft must be ACTIVE and match that draft exactly')
  WHERE NEW.source_draft_id IS NOT NULL
    AND NOT EXISTS (
      SELECT 1 FROM mandate_drafts d
      WHERE d.id = NEW.source_draft_id AND d.status = 'DRAFT' AND d.mandate_id = NEW.id AND NEW.status = 'ACTIVE'
        AND d.currency = NEW.currency AND d.total_budget_minor = NEW.total_budget_minor
        AND d.per_tx_cap_minor = NEW.per_tx_cap_minor AND d.approval_threshold_minor = NEW.approval_threshold_minor
        AND d.require_review = NEW.require_review AND d.allowed_categories = NEW.allowed_categories
        AND d.allowed_seller_ids = NEW.allowed_seller_ids
    );
END;

-- ---------------------------------------------------------------------------
-- Categories are enforced on what is actually bought: a line's category comes from the seller catalog
-- (never from the offer), and every line of an agreed offer must be in a category the mandate allows.
-- ---------------------------------------------------------------------------
CREATE TRIGGER offer_lines_category_rules BEFORE INSERT ON offer_lines
BEGIN
  SELECT RAISE(ABORT, 'line category must come from the seller catalog (NULL for an unknown sku)')
  WHERE NEW.category IS NOT (
    SELECT c.category FROM offers o JOIN seller_catalog_items c ON c.seller_id = o.seller_id AND c.sku = NEW.sku
    WHERE o.id = NEW.offer_id
  );
END;

CREATE TRIGGER agreements_category_rules BEFORE INSERT ON agreements
BEGIN
  SELECT RAISE(ABORT, 'every offer line must be in a category the mandate allows')
  WHERE EXISTS (
    SELECT 1 FROM offer_lines l
    WHERE l.offer_id = NEW.offer_id
      AND (l.category IS NULL
           OR NOT EXISTS (SELECT 1 FROM mandates m, json_each(m.allowed_categories) j
                          WHERE m.id = NEW.mandate_id AND m.version = NEW.mandate_version AND j.value = l.category))
  );
END;

-- ---------------------------------------------------------------------------
-- Human approval before execution.
-- ---------------------------------------------------------------------------
CREATE TABLE transaction_approvals (
  id TEXT NOT NULL PRIMARY KEY CHECK (length(id) BETWEEN 1 AND 64),
  transaction_id TEXT NOT NULL UNIQUE REFERENCES transactions (id),
  agreement_id TEXT NOT NULL UNIQUE REFERENCES agreements (id),
  decision TEXT NOT NULL CHECK (decision IN ('APPROVED', 'REJECTED')),
  decided_by TEXT NOT NULL CHECK (decided_by = 'OPERATOR'),
  reason TEXT CHECK (reason IS NULL OR length(reason) <= 500),
  decided_at TEXT NOT NULL CHECK (decided_at GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]*Z')
) STRICT;

CREATE TRIGGER transaction_approvals_insert_rules BEFORE INSERT ON transaction_approvals
BEGIN
  SELECT RAISE(ABORT, 'an approval must be recorded for the agreed transaction while it is AGREED')
  WHERE NOT EXISTS (SELECT 1 FROM transactions t
                    WHERE t.id = NEW.transaction_id AND t.state = 'AGREED' AND t.agreement_id = NEW.agreement_id);
END;
CREATE TRIGGER transaction_approvals_no_update BEFORE UPDATE ON transaction_approvals
BEGIN SELECT RAISE(ABORT, 'approvals are immutable'); END;
CREATE TRIGGER transaction_approvals_no_delete BEFORE DELETE ON transaction_approvals
BEGIN SELECT RAISE(ABORT, 'approvals are immutable'); END;

-- Gate: AGREED -> CREATING_ORDER (the first step that can move money) requires an APPROVED decision whenever
-- the pinned mandate says every transaction is reviewed, or the agreement total is ABOVE its threshold.
CREATE TRIGGER transactions_approval_gate BEFORE UPDATE ON transactions
WHEN OLD.state = 'AGREED' AND NEW.state = 'CREATING_ORDER'
BEGIN
  SELECT RAISE(ABORT, 'human approval is required before this transaction can be executed')
  WHERE (SELECT m.require_review = 1 OR a.total_minor > m.approval_threshold_minor
         FROM agreements a JOIN mandates m ON m.id = a.mandate_id AND m.version = a.mandate_version
         WHERE a.id = OLD.agreement_id)
    AND NOT EXISTS (SELECT 1 FROM transaction_approvals t
                    WHERE t.transaction_id = OLD.id AND t.agreement_id = OLD.agreement_id AND t.decision = 'APPROVED');
END;
