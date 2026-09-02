-- Alepes PostgreSQL schema for execution-plan persistence.
-- Correctness constraints are enforced at the database level, not just in the
-- domain code.

-- Core plan row: one line per financial action, plus the provenance needed to
-- reproduce it later.
CREATE TABLE IF NOT EXISTS execution_plans (
  id TEXT PRIMARY KEY,
  user_id TEXT,
  portfolio_id TEXT NOT NULL,
  cash_event_id TEXT NOT NULL UNIQUE,
  rule_version_id TEXT NOT NULL,
  portfolio_version_id TEXT NOT NULL,
  calculation_version TEXT NOT NULL,
  input_snapshot_hash TEXT NOT NULL,
  deployable_cents BIGINT NOT NULL CHECK (deployable_cents >= 0),
  disposition TEXT NOT NULL CHECK (disposition IN (
    'shadow', 'approval_required', 'approved', 'executing', 'executed', 'rejected', 'failed'
  )),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- One CashEvent (an observed deposit) may never create more than one
-- executable plan. A rule-version change may produce a new *draft* plan,
-- but it must not silently create a second financial action. If multiple
-- destinations are ever required explicitly, introduce a stable destination key
-- ((cash_event_id, allocation_destination_id)) rather than loosening dedup.

CREATE TABLE IF NOT EXISTS execution_plan_orders (
  id TEXT PRIMARY KEY,
  execution_plan_id TEXT NOT NULL REFERENCES execution_plans(id) ON DELETE CASCADE,
  symbol TEXT NOT NULL,
  amount_cents BIGINT NOT NULL CHECK (amount_cents >= 0),
  side TEXT NOT NULL CHECK (side IN ('buy')),
  shares DOUBLE PRECISION NOT NULL CHECK (shares >= 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_execution_plan_orders__plan ON execution_plan_orders(execution_plan_id);

-- Append-only audit events. UPDATE and DELETE are errors; once written, an
-- event cannot be altered or removed.
CREATE TABLE IF NOT EXISTS execution_plan_events (
  id TEXT PRIMARY KEY,
  execution_plan_id TEXT NOT NULL REFERENCES execution_plans(id) ON DELETE CASCADE,
  at TIMESTAMPTZ NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN (
    'plan.created', 'policy.evaluated', 'approval.requested', 'approval.granted',
    'execution.started', 'order.submitted', 'order.filled',
    'execution.completed', 'execution.failed'
  )),
  summary TEXT NOT NULL,
  detail TEXT NOT NULL,
  amount_cents BIGINT NOT NULL CHECK (amount_cents >= 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Append-only: any UPDATE or DELETE of an audit event fails explicitly.
CREATE OR REPLACE FUNCTION audit_immutable() RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION 'execution_plan_events are immutable';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER execution_plan_events_no_update BEFORE UPDATE ON execution_plan_events
  FOR EACH ROW EXECUTE FUNCTION audit_immutable();

CREATE TRIGGER execution_plan_events_no_delete BEFORE DELETE ON execution_plan_events
  FOR EACH ROW EXECUTE FUNCTION audit_immutable();

-- Only `disposition` may change on execution_plans after creation. All other
-- fields are immutable. This trigger enforces that.
CREATE OR REPLACE FUNCTION execution_plans_lifecycle_guard() RETURNS TRIGGER AS $$
BEGIN
  IF OLD.disposition <> NEW.disposition THEN
    IF OLD.id = NEW.id
       AND OLD.cash_event_id = NEW.cash_event_id
       AND OLD.rule_version_id = NEW.rule_version_id
       AND OLD.portfolio_version_id = NEW.portfolio_version_id
       AND OLD.calculation_version = NEW.calculation_version
       AND OLD.input_snapshot_hash = NEW.input_snapshot_hash
       AND OLD.deployable_cents = NEW.deployable_cents
       AND OLD.created_at = NEW.created_at THEN
      RETURN NEW;
    END IF;
  END IF;
  RAISE EXCEPTION 'execution_plans are immutable after creation (only disposition may change)';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER execution_plans_disposition_guard BEFORE UPDATE ON execution_plans
  FOR EACH ROW EXECUTE FUNCTION execution_plans_lifecycle_guard();

CREATE OR REPLACE RULE execution_plans_no_delete AS
  ON DELETE TO execution_plans DO INSTEAD NOTHING;

-- Outbox: transactional events a worker can safely pick up.
CREATE TABLE IF NOT EXISTS outbox (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL,
  payload JSONB NOT NULL,
  claimed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_outbox_pending ON outbox (claimed_at) WHERE claimed_at IS NULL;