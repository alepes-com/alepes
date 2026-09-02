-- Alepes PostgreSQL schema for execution-plan persistence.
-- Everything in this migration is designed to enforce correctness at the
-- database level, not just in the domain layer.

-- Table: cash_events (observed cash movements)
-- Note: we use TEXT for ids today; a migration to ULID at the persistence
-- boundary adds the durable chain identity separately.

CREATE TABLE IF NOT EXISTS execution_plans (
  id TEXT PRIMARY KEY,
  user_id TEXT,
  portfolio_id TEXT NOT NULL,
  cash_event_id TEXT NOT NULL,
  rule_version_id TEXT NOT NULL,
  portfolio_version_id TEXT NOT NULL,
  calculation_version TEXT NOT NULL,
  input_snapshot_hash TEXT NOT NULL,
  deployable_cents BIGINT NOT NULL CHECK (deployable_cents >= 0),
  disposition TEXT NOT NULL CHECK (disposition IN (
    'shadow', 'approval_required', 'approved', 'executing', 'executed', 'rejected', 'failed'
  )),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (cash_event_id, rule_version_id)
);

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

-- Append-only audit events. No UPDATE or DELETE is allowed.
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

-- Prevent updates or deletes on execution_plan_events (append-only).
CREATE OR REPLACE FUNCTION noop_audit_guard() RETURNS TRIGGER AS $$
BEGIN
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE RULE execution_plan_events_no_update AS
  ON UPDATE TO execution_plan_events DO NOTHING;

CREATE OR REPLACE RULE execution_plan_events_no_delete AS
  ON DELETE TO execution_plan_events DO NOTHING;

-- Outbox: transactional events that a worker can safely pick up.
CREATE TABLE IF NOT EXISTS outbox (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL,
  payload JSONB NOT NULL,
  claimed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_outbox_pending ON outbox (claimed_at) WHERE claimed_at IS NULL;