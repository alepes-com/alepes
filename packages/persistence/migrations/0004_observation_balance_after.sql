-- Provider-sync: persist the provider-reported balance-after fact so downstream
-- CashEvent qualification is reproducible from reconciled Alepes-owned state.
-- qualifyCashEvent requires a checking balance after the event; without this
-- column the persisted observation could never qualify.
ALTER TABLE financial_observations
  ADD COLUMN IF NOT EXISTS balance_after_cents BIGINT;