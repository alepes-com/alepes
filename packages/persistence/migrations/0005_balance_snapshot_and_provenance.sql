-- Provider-sync: replace the fabricated per-transaction "balance after" with an
-- account-level balance snapshot, and persist per-observation sync-cycle provenance.
--
-- Providers (e.g. Plaid) report account balance data ALONGSIDE transactions; they
-- do NOT report a historical "balance immediately after this transaction". The
-- previous `balance_after_cents` column therefore encoded a fact that does not
-- exist. This migration:
--   1. records account balance snapshots per sync cycle (available vs current,
--      cached-vs-real-time metadata preserved),
--   2. stores the SELECTED balance (available ?? current) on each observation for
--      deterministic qualification, and
--   3. records the reconciliation cycle that last produced each observation so
--      Shadow provenance is authoritative per observation.

-- Account balance snapshots, keyed by the sync cycle that captured them.
CREATE TABLE IF NOT EXISTS account_balance_snapshots (
  sync_cycle_id TEXT PRIMARY KEY,
  account_binding_id TEXT NOT NULL REFERENCES account_bindings(id) ON DELETE CASCADE,
  available_cents BIGINT,
  current_cents BIGINT NOT NULL,
  captured_at TIMESTAMPTZ NOT NULL,
  is_cached BOOLEAN NOT NULL,
  normalization_version TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS account_balance_snapshots_binding_idx
  ON account_balance_snapshots (account_binding_id);

-- Per-observation: the selected qualification balance + the cycle that produced it.
ALTER TABLE financial_observations
  ADD COLUMN IF NOT EXISTS qualification_balance_cents BIGINT,
  ADD COLUMN IF NOT EXISTS last_reconciled_cycle_id TEXT;

-- The obsolete per-transaction "balance after" column is no longer used.
ALTER TABLE financial_observations
  DROP COLUMN IF EXISTS balance_after_cents;