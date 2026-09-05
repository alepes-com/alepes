-- Provider-sync persistence: read-only financial-data synchronization state.
-- Kept SEPARATE from financial decision/execution state. PostgreSQL is the
-- authoritative store; DuckDB is not involved. No raw credentials are stored.

-- Account bindings: durable Alepes binding to one external provider account.
CREATE TABLE IF NOT EXISTS account_bindings (
  id TEXT PRIMARY KEY,
  provider_id TEXT NOT NULL,
  provider_account_ref TEXT NOT NULL,
  credential_ref TEXT NOT NULL,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- One provider account may not accidentally bind to multiple Alepes bindings.
CREATE UNIQUE INDEX IF NOT EXISTS account_bindings_provider_account_unique
  ON account_bindings (provider_id, provider_account_ref);

-- Sync checkpoints: AccountBinding -> SyncCheckpoint (1:1).
CREATE TABLE IF NOT EXISTS sync_checkpoints (
  account_binding_id TEXT PRIMARY KEY REFERENCES account_bindings(id) ON DELETE CASCADE,
  cursor TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL CHECK (status IN ('idle','syncing','reconciled','failed')),
  last_success_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Normalized observations: Alepes-owned facts + provenance. No provider JSON blobs.
CREATE TABLE IF NOT EXISTS financial_observations (
  id TEXT PRIMARY KEY,
  account_binding_id TEXT NOT NULL REFERENCES account_bindings(id) ON DELETE CASCADE,
  amount_cents BIGINT NOT NULL,
  direction TEXT NOT NULL CHECK (direction IN ('credit','debit')),
  status TEXT NOT NULL CHECK (status IN ('pending','posted')),
  first_observed_at TIMESTAMPTZ NOT NULL,
  posted_at TIMESTAMPTZ,
  description TEXT NOT NULL,
  normalization_version TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('active','removed')),
  predecessor_observation_id TEXT REFERENCES financial_observations(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS financial_observations_binding_idx
  ON financial_observations (account_binding_id);

-- External-ref mapping: integration-only. (binding, externalRef) -> observation id.
CREATE TABLE IF NOT EXISTS observation_external_refs (
  account_binding_id TEXT NOT NULL REFERENCES account_bindings(id) ON DELETE CASCADE,
  external_ref TEXT NOT NULL,
  financial_observation_id TEXT NOT NULL REFERENCES financial_observations(id) ON DELETE CASCADE,
  PRIMARY KEY (account_binding_id, external_ref)
);

-- Append-only sync audit/events (change history + provenance).
CREATE TABLE IF NOT EXISTS observation_events (
  id TEXT PRIMARY KEY,
  financial_observation_id TEXT NOT NULL REFERENCES financial_observations(id) ON DELETE CASCADE,
  sync_cycle_id TEXT NOT NULL,
  change TEXT NOT NULL CHECK (change IN ('added','modified','removed')),
  prev_state JSONB,
  new_state JSONB,
  normalization_version TEXT NOT NULL,
  at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE OR REPLACE FUNCTION observation_events_immutable() RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION 'observation_events are append-only';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS observation_events_no_update ON observation_events;
DROP TRIGGER IF EXISTS observation_events_no_delete ON observation_events;

CREATE TRIGGER observation_events_no_update BEFORE UPDATE ON observation_events
  FOR EACH ROW EXECUTE FUNCTION observation_events_immutable();
CREATE TRIGGER observation_events_no_delete BEFORE DELETE ON observation_events
  FOR EACH ROW EXECUTE FUNCTION observation_events_immutable();