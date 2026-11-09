-- 0008: audit events gain a stable event id, the mandate and agreement versions in force, a provenance
-- (observed external fact vs local decision) and a hash version.
--
-- Existing rows are append-only and were hashed over the original nine fields, so they are NOT rewritten:
-- they get hash_version = 1 (the default) and NULL in every new column, and the verifier checks them under the
-- original form. Every event appended from now on is hash_version = 2, whose hash covers all of the new
-- columns too (src/domain/audit.ts, docs/AUDIT_CHAIN.md). This is a hash chain, not a signature.

ALTER TABLE audit_events ADD COLUMN hash_version INTEGER NOT NULL DEFAULT 1 CHECK (hash_version IN (1, 2));
ALTER TABLE audit_events ADD COLUMN event_id TEXT CHECK (event_id IS NULL OR length(event_id) BETWEEN 1 AND 64);
ALTER TABLE audit_events ADD COLUMN mandate_id TEXT CHECK (mandate_id IS NULL OR length(mandate_id) BETWEEN 1 AND 64);
ALTER TABLE audit_events ADD COLUMN mandate_version INTEGER CHECK (mandate_version IS NULL OR mandate_version >= 1);
ALTER TABLE audit_events ADD COLUMN agreement_id TEXT CHECK (agreement_id IS NULL OR length(agreement_id) BETWEEN 1 AND 64);
ALTER TABLE audit_events ADD COLUMN agreement_version INTEGER CHECK (agreement_version IS NULL OR agreement_version >= 1);
ALTER TABLE audit_events ADD COLUMN provenance TEXT CHECK (provenance IS NULL OR provenance IN ('LOCAL_DECISION', 'OBSERVED_EXTERNAL'));

-- NULLs (the legacy rows) are distinct in a UNIQUE index, so only real ids are constrained.
CREATE UNIQUE INDEX audit_events_event_id ON audit_events (event_id);

-- Same two rules as 0002, plus what a version-2 event must look like. Recreated rather than added so the
-- existing rules still run first.
DROP TRIGGER audit_events_insert_rules;
CREATE TRIGGER audit_events_insert_rules BEFORE INSERT ON audit_events
BEGIN
  SELECT RAISE(ABORT, 'audit seq must be the previous seq + 1')
  WHERE NEW.seq IS NOT NULL AND NEW.seq <> COALESCE((SELECT MAX(seq) FROM audit_events), 0) + 1;
  SELECT RAISE(ABORT, 'audit prev_hash must equal the hash of the previous event')
  WHERE NEW.prev_hash <> COALESCE((SELECT hash FROM audit_events ORDER BY seq DESC LIMIT 1),
                                  '0000000000000000000000000000000000000000000000000000000000000000');
  SELECT RAISE(ABORT, 'new audit events must use hash version 2')
  WHERE NEW.hash_version <> 2;
  SELECT RAISE(ABORT, 'a version-2 audit event needs an event id and a provenance')
  WHERE NEW.event_id IS NULL OR NEW.provenance IS NULL;
  SELECT RAISE(ABORT, 'only a PayPal actor can record an observed external fact')
  WHERE NEW.provenance = 'OBSERVED_EXTERNAL' AND NEW.actor NOT IN ('PAYPAL_API', 'PAYPAL_WEBHOOK');
  SELECT RAISE(ABORT, 'a version needs its mandate or agreement id')
  WHERE (NEW.mandate_version IS NOT NULL AND NEW.mandate_id IS NULL)
     OR (NEW.agreement_version IS NOT NULL AND NEW.agreement_id IS NULL);
END;
