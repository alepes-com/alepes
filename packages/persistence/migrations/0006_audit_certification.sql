-- Audit + Certification persistence: durable evidence layer for certification runs.
-- Three folded tables per ADR §4.1. PostgreSQL is the authoritative store.
-- No raw credentials, no float money, no separate gate/artifact tables.

-- Certification runs: one row per certification run (immutable after creation).
CREATE TABLE IF NOT EXISTS certification_runs (
  run_id TEXT PRIMARY KEY,
  correlation_id TEXT NOT NULL,
  milestone TEXT NOT NULL,
  provider TEXT NOT NULL,
  environment TEXT NOT NULL,
  source_commit TEXT NOT NULL,
  branch TEXT,
  harness TEXT NOT NULL,
  harness_version TEXT NOT NULL,
  schema_version TEXT NOT NULL,
  started_at TIMESTAMPTZ NOT NULL,
  completed_at TIMESTAMPTZ,
  result TEXT CHECK (result IS NULL OR result IN ('PASS','FAIL','ABORTED')),
  failure_code TEXT CHECK (failure_code IN (
    'configuration.missing_secret',
    'configuration.invalid_environment',
    'provider.invalid_request',
    'provider.authentication_failed',
    'provider.item_login_required',
    'provider.product_not_enabled',
    'provider.rate_limited',
    'provider.unavailable',
    'persistence.unavailable',
    'sync.cursor_conflict',
    'sync.restart_required',
    'sync.no_qualifying_event',
    'policy.no_match',
    'safety.execution_surface_reachable',
    'safety.provider_mutation_detected',
    'redaction.violation',
    'internal.unexpected'
  )),
  evidence_boundary JSONB NOT NULL,
  gates JSONB NOT NULL DEFAULT '[]'::jsonb,
  mutation_counts JSONB NOT NULL DEFAULT '{"transfer":0,"order":0,"providerMutation":0}'::jsonb,
  final_state TEXT NOT NULL DEFAULT 'clean' CHECK (final_state IN ('clean','dirty')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS certification_runs_correlation_idx ON certification_runs (correlation_id);
CREATE INDEX IF NOT EXISTS certification_runs_started_idx ON certification_runs (started_at);
CREATE INDEX IF NOT EXISTS certification_runs_provider_env_idx ON certification_runs (provider, environment);

-- Append-only audit events: immutable event stream per run.
CREATE TABLE IF NOT EXISTS audit_events (
  event_id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES certification_runs(run_id) ON DELETE RESTRICT,
  correlation_id TEXT NOT NULL,
  causation_id TEXT,
  sequence BIGINT NOT NULL,
  occurred_at TIMESTAMPTZ NOT NULL,
  phase TEXT NOT NULL CHECK (phase IN ('preflight','provider','observation','normalization','persistence','qualification','policy','execution','reconciliation','reporting')),
  type TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('started','succeeded','failed','skipped')),
  actor TEXT NOT NULL CHECK (actor IN ('system','provider','human')),
  provider TEXT,
  attempt BIGINT,
  mutated BOOLEAN,
  verified BOOLEAN,
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Deterministic ordering: unique sequence per run, ordered inserts.
CREATE UNIQUE INDEX IF NOT EXISTS audit_events_run_sequence_unique ON audit_events (run_id, sequence);
CREATE INDEX IF NOT EXISTS audit_events_correlation_idx ON audit_events (correlation_id);
CREATE INDEX IF NOT EXISTS audit_events_occurred_idx ON audit_events (occurred_at);
CREATE INDEX IF NOT EXISTS audit_events_type_idx ON audit_events (type);
CREATE INDEX IF NOT EXISTS audit_events_phase_idx ON audit_events (phase);

-- Internal Alepes references for reconstruction (ADR §4.1).
CREATE INDEX IF NOT EXISTS audit_events_observation_idx ON audit_events ((payload->>'observationId'));
CREATE INDEX IF NOT EXISTS audit_events_cash_event_idx ON audit_events ((payload->>'cashEventId'));
CREATE INDEX IF NOT EXISTS audit_events_capital_plan_idx ON audit_events ((payload->>'capitalPlanId'));
CREATE INDEX IF NOT EXISTS audit_events_allocation_plan_idx ON audit_events ((payload->>'allocationPlanId'));
CREATE INDEX IF NOT EXISTS audit_events_execution_plan_idx ON audit_events ((payload->>'executionPlanId'));
CREATE INDEX IF NOT EXISTS audit_events_outbox_idx ON audit_events ((payload->>'outboxEventId'));
CREATE INDEX IF NOT EXISTS audit_events_audit_record_idx ON audit_events ((payload->>'auditRecordId'));

-- Append-only enforcement: prevent UPDATE/DELETE on audit_events.
CREATE OR REPLACE FUNCTION audit_events_immutable() RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION 'audit_events are append-only';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS audit_events_no_update ON audit_events;
DROP TRIGGER IF EXISTS audit_events_no_delete ON audit_events;

CREATE TRIGGER audit_events_no_update BEFORE UPDATE ON audit_events
  FOR EACH ROW EXECUTE FUNCTION audit_events_immutable();
CREATE TRIGGER audit_events_no_delete BEFORE DELETE ON audit_events
  FOR EACH ROW EXECUTE FUNCTION audit_events_immutable();

-- Provider call evidence: safe structured record of provider interactions.
CREATE TABLE IF NOT EXISTS provider_call_evidence (
  evidence_id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES certification_runs(run_id) ON DELETE RESTRICT,
  correlation_id TEXT NOT NULL,
  occurred_at TIMESTAMPTZ NOT NULL,
  operation TEXT NOT NULL,
  http_status BIGINT,
  plaid_error_type TEXT,
  plaid_error_code TEXT,
  plaid_request_id TEXT,
  failure_code TEXT CHECK (failure_code IN (
    'configuration.missing_secret',
    'configuration.invalid_environment',
    'provider.invalid_request',
    'provider.authentication_failed',
    'provider.item_login_required',
    'provider.product_not_enabled',
    'provider.rate_limited',
    'provider.unavailable',
    'persistence.unavailable',
    'sync.cursor_conflict',
    'sync.restart_required',
    'sync.no_qualifying_event',
    'policy.no_match',
    'safety.execution_surface_reachable',
    'safety.provider_mutation_detected',
    'redaction.violation',
    'internal.unexpected'
  )),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS provider_call_evidence_run_idx ON provider_call_evidence (run_id);
CREATE INDEX IF NOT EXISTS provider_call_evidence_correlation_idx ON provider_call_evidence (correlation_id);
CREATE INDEX IF NOT EXISTS provider_call_evidence_occurred_idx ON provider_call_evidence (occurred_at);
CREATE INDEX IF NOT EXISTS provider_call_evidence_operation_idx ON provider_call_evidence (operation);

-- Append-only enforcement for provider_call_evidence.
CREATE OR REPLACE FUNCTION provider_call_evidence_immutable() RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION 'provider_call_evidence are append-only';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS provider_call_evidence_no_update ON provider_call_evidence;
DROP TRIGGER IF EXISTS provider_call_evidence_no_delete ON provider_call_evidence;

CREATE TRIGGER provider_call_evidence_no_update BEFORE UPDATE ON provider_call_evidence
  FOR EACH ROW EXECUTE FUNCTION provider_call_evidence_immutable();
CREATE TRIGGER provider_call_evidence_no_delete BEFORE DELETE ON provider_call_evidence
  FOR EACH ROW EXECUTE FUNCTION provider_call_evidence_immutable();