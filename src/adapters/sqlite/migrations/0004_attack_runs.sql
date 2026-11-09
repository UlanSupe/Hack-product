-- 0004: attack runs, their steps, and agent recommendations (advisory records).

CREATE TABLE attack_runs (
  id TEXT NOT NULL PRIMARY KEY CHECK (length(id) BETWEEN 1 AND 64),
  scenario_id TEXT NOT NULL CHECK (length(scenario_id) BETWEEN 1 AND 64),
  fixture_version TEXT NOT NULL CHECK (length(fixture_version) BETWEEN 1 AND 64),
  seed TEXT NOT NULL CHECK (length(seed) BETWEEN 1 AND 128),
  mode TEXT NOT NULL CHECK (mode IN ('UNSAFE_BASELINE', 'PROTECTED')),
  provider TEXT NOT NULL CHECK (provider IN ('SIMULATED', 'PAYPAL_SANDBOX')),
  transaction_id TEXT REFERENCES transactions (id),
  currency TEXT NOT NULL CHECK (length(currency) = 3 AND currency NOT GLOB '*[^A-Z]*'),
  mandate_cap_minor INTEGER NOT NULL CHECK (typeof(mandate_cap_minor) = 'integer' AND mandate_cap_minor > 0 AND mandate_cap_minor <= 9007199254740991),
  money_moved_minor INTEGER NOT NULL DEFAULT 0 CHECK (typeof(money_moved_minor) = 'integer' AND money_moved_minor >= 0 AND money_moved_minor <= 9007199254740991),
  -- derived, never written: whether the run moved more than the mandate cap
  cap_exceeded INTEGER GENERATED ALWAYS AS (money_moved_minor > mandate_cap_minor) VIRTUAL,
  invariants_violated TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(invariants_violated) AND json_type(invariants_violated) = 'array'),
  audit_from_seq INTEGER REFERENCES audit_events (seq),
  audit_to_seq INTEGER REFERENCES audit_events (seq),
  started_at TEXT NOT NULL CHECK (started_at GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]*Z'),
  finished_at TEXT CHECK (finished_at IS NULL OR finished_at GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]*Z'),
  -- The intentionally unsafe baseline can only ever touch the simulated ledger and never a transaction.
  CHECK (mode <> 'UNSAFE_BASELINE' OR provider = 'SIMULATED'),
  CHECK (mode <> 'UNSAFE_BASELINE' OR transaction_id IS NULL),
  CHECK ((audit_from_seq IS NULL) = (audit_to_seq IS NULL)),
  CHECK (audit_from_seq IS NULL OR audit_from_seq <= audit_to_seq),
  CHECK (finished_at IS NULL OR finished_at >= started_at)
) STRICT;

CREATE TRIGGER attack_runs_update_rules BEFORE UPDATE ON attack_runs
BEGIN
  SELECT RAISE(ABORT, 'immutable attack run column changed')
  WHERE NEW.id IS NOT OLD.id OR NEW.scenario_id IS NOT OLD.scenario_id OR NEW.fixture_version IS NOT OLD.fixture_version
     OR NEW.seed IS NOT OLD.seed OR NEW.mode IS NOT OLD.mode OR NEW.provider IS NOT OLD.provider
     OR NEW.transaction_id IS NOT OLD.transaction_id OR NEW.currency IS NOT OLD.currency
     OR NEW.mandate_cap_minor IS NOT OLD.mandate_cap_minor OR NEW.started_at IS NOT OLD.started_at;
  SELECT RAISE(ABORT, 'finished attack runs are final')
  WHERE OLD.finished_at IS NOT NULL;
END;
CREATE TRIGGER attack_runs_no_delete BEFORE DELETE ON attack_runs
BEGIN SELECT RAISE(ABORT, 'attack runs cannot be deleted'); END;

-- Advisory only: carries ids and prose, never an amount used for payment.
CREATE TABLE agent_recommendations (
  id TEXT NOT NULL PRIMARY KEY CHECK (length(id) BETWEEN 1 AND 64),
  transaction_id TEXT REFERENCES transactions (id),
  attack_run_id TEXT REFERENCES attack_runs (id),
  agent TEXT NOT NULL CHECK (agent IN ('UNSAFE_BASELINE', 'PROTECTED_BUYER', 'SELLER')),
  kind TEXT NOT NULL CHECK (kind IN ('ACCEPT_OFFER', 'COUNTER', 'REJECT', 'REQUEST_RELEASE', 'REQUEST_VOID', 'NONE')),
  offer_id TEXT REFERENCES offers (id),
  rationale TEXT NOT NULL CHECK (length(rationale) <= 2000),
  model_ref TEXT NOT NULL CHECK (length(model_ref) BETWEEN 1 AND 128),
  fixture_step TEXT CHECK (fixture_step IS NULL OR length(fixture_step) <= 128),
  created_at TEXT NOT NULL CHECK (created_at GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]*Z'),
  CHECK (transaction_id IS NOT NULL OR attack_run_id IS NOT NULL)
) STRICT;

CREATE TRIGGER agent_recommendations_insert_rules BEFORE INSERT ON agent_recommendations
BEGIN
  SELECT RAISE(ABORT, 'a recommended offer must belong to the same transaction')
  WHERE NEW.offer_id IS NOT NULL AND NEW.transaction_id IS NOT NULL
    AND NOT EXISTS (SELECT 1 FROM offers WHERE id = NEW.offer_id AND transaction_id = NEW.transaction_id);
END;
CREATE TRIGGER agent_recommendations_no_update BEFORE UPDATE ON agent_recommendations
BEGIN SELECT RAISE(ABORT, 'agent recommendations are immutable'); END;
CREATE TRIGGER agent_recommendations_no_delete BEFORE DELETE ON agent_recommendations
BEGIN SELECT RAISE(ABORT, 'agent recommendations are immutable'); END;

CREATE TABLE attack_run_steps (
  run_id TEXT NOT NULL REFERENCES attack_runs (id),
  n INTEGER NOT NULL CHECK (n >= 1),
  seller_message_ref TEXT NOT NULL CHECK (length(seller_message_ref) BETWEEN 1 AND 128),
  recommendation_id TEXT REFERENCES agent_recommendations (id),
  policy_decision_id TEXT REFERENCES policy_decisions (id),
  outcome TEXT NOT NULL CHECK (outcome IN ('EXECUTED', 'BLOCKED', 'NO_ACTION')),
  PRIMARY KEY (run_id, n),
  CHECK (outcome <> 'BLOCKED' OR policy_decision_id IS NOT NULL)
) STRICT;

CREATE TRIGGER attack_run_steps_insert_rules BEFORE INSERT ON attack_run_steps
BEGIN
  SELECT RAISE(ABORT, 'a BLOCKED step must reference a DENY policy decision')
  WHERE NEW.outcome = 'BLOCKED'
    AND NOT EXISTS (SELECT 1 FROM policy_decisions WHERE id = NEW.policy_decision_id AND verdict = 'DENY');
  SELECT RAISE(ABORT, 'step number must be the previous step + 1')
  WHERE NEW.n <> COALESCE((SELECT MAX(n) FROM attack_run_steps WHERE run_id = NEW.run_id), 0) + 1;
END;
CREATE TRIGGER attack_run_steps_no_update BEFORE UPDATE ON attack_run_steps
BEGIN SELECT RAISE(ABORT, 'attack run steps are immutable'); END;
CREATE TRIGGER attack_run_steps_no_delete BEFORE DELETE ON attack_run_steps
BEGIN SELECT RAISE(ABORT, 'attack run steps are immutable'); END;
