-- Release-contract hardening:
--  (a) plans gain an explicit, REQUIRED `execution_mode` column. The legacy
--      derivation `disposition === 'shadow' ? 'shadow' : 'execute'` was not
--      fail-closed: any non-shadow lifecycle state (approval_required,
--      rejected, failed, ...) silently mapped to 'execute'. Disposition is
--      lifecycle state; executionMode is execution capability. They MUST
--      not be conflated.
--  (b) execution_plan_events gains a 'shadow.order.filled' kind so simulated
--      shadow fills are unambiguously distinguishable from real provider
--      fills (which remain 'order.filled').
--
-- This migration is IDEMPOTENT-SAFE for Alepes's `runMigrations` runner,
-- which applies every .sql file inside one DB connection against every test
-- database (and therefore may race another test process doing the same
-- thing on a SHARED database). Avoid bare `DROP CONSTRAINT` / `ADD
-- CONSTRAINT` (they raise `tuple concurrently updated` under concurrency);
-- use the `IF NOT EXISTS` forms that PG provides and wrap the remaining
-- non-idempotent statements in a guarded DO block.

-- Serialize this entire file across concurrent migration runners. The
-- `runMigrations` helper applies a migration file inside ONE connection's
-- implicit transaction, so a single transaction-scoped lock here covers
-- every DDL statement below. Any competing concurrent runner blocks on
-- the same lock; once we commit, their `IF NOT EXISTS` / information_schema
-- probes see the finished schema and short-circuit.
DO $$ BEGIN PERFORM pg_advisory_xact_lock(727401); END $$;

-- ---------------------------------------------------------------------------
-- STEP 0 (order matters): DROP the existing lifecycle trigger BEFORE we add
-- the execution_mode column (the function we will install references
-- OLD.execution_mode, which only exists after the column exists). The old
-- pre-0007 trigger also raised unconditionally whenever
-- `OLD.disposition = NEW.disposition`, which would have tripped on the
-- backfill UPDATE below. After the column exists we re-create the function
-- and the trigger with correct semantics: refuse ONLY when an immutable
-- column actually changed; disposition is the only column permitted to
-- move.
-- ---------------------------------------------------------------------------
DROP TRIGGER IF EXISTS execution_plans_disposition_guard ON execution_plans;

-- ---------------------------------------------------------------------------
-- execution_plans.execution_mode
-- ---------------------------------------------------------------------------
-- Wrap column+backfill+NOT NULL+CHECK in a single advisory-locked DO block.
-- Alepes's `runMigrations` runner applies every .sql file inside one DB
-- connection against every test database; under parallel vitest processes
-- targeting the SAME database, two concurrent runs can race on
-- `ALTER TABLE` / catalog updates and fail with `tuple concurrently
-- updated`. Taking a single transaction-scoped advisory lock serializes
-- any competing 0007 application without forcing every migration in the
-- repo to do its own lock dance, and `pg_advisory_xact_lock` releases
-- automatically at statement end.
DO $$
BEGIN
  PERFORM pg_advisory_xact_lock(727401); -- stable id for migration 0007

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = current_schema()
       AND table_name = 'execution_plans'
       AND column_name = 'execution_mode'
  ) THEN
    ALTER TABLE execution_plans ADD COLUMN execution_mode TEXT;
  END IF;

  -- Backfill any pre-existing rows: every pre-fix row was effectively shadow
  -- (the old code mapped every non-shadow disposition to "execute" in the
  -- payload but the durable plan had no broker interaction in v0.5). Marking
  -- them 'shadow' preserves fail-closed semantics: any past plan that ever
  -- really submitted broker work would need a deliberate operator migration,
  -- not a silent re-classification.
  UPDATE execution_plans
     SET execution_mode = 'shadow'
   WHERE execution_mode IS NULL;

  BEGIN
    ALTER TABLE execution_plans ALTER COLUMN execution_mode SET NOT NULL;
  EXCEPTION
    WHEN duplicate_object THEN NULL; -- already SET NOT NULL elsewhere
    WHEN others THEN
      -- In PG, "SET NOT NULL" on a column that is already NOT NULL is a
      -- no-op. The "others" arm guards against races under concurrent
      -- migration where a competing run's ALTER arrives between our
      -- information_schema check and this statement.
      IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
         WHERE table_schema = current_schema()
           AND table_name = 'execution_plans'
           AND column_name = 'execution_mode'
           AND is_nullable = 'NO'
      ) THEN
        RAISE;
      END IF;
  END;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'execution_plans_execution_mode_check'
  ) THEN
    ALTER TABLE execution_plans
      ADD CONSTRAINT execution_plans_execution_mode_check
        CHECK (execution_mode IN ('shadow', 'execute'));
  END IF;
END$$;

-- Rebuild the trigger function with the new column included.
CREATE OR REPLACE FUNCTION execution_plans_lifecycle_guard() RETURNS TRIGGER AS $$
BEGIN
  IF OLD.id IS DISTINCT FROM NEW.id
     OR OLD.cash_event_id IS DISTINCT FROM NEW.cash_event_id
     OR OLD.rule_version_id IS DISTINCT FROM NEW.rule_version_id
     OR OLD.portfolio_version_id IS DISTINCT FROM NEW.portfolio_version_id
     OR OLD.calculation_version IS DISTINCT FROM NEW.calculation_version
     OR OLD.input_snapshot_hash IS DISTINCT FROM NEW.input_snapshot_hash
     OR OLD.deployable_cents IS DISTINCT FROM NEW.deployable_cents
     OR OLD.execution_mode IS DISTINCT FROM NEW.execution_mode
     OR OLD.created_at IS DISTINCT FROM NEW.created_at THEN
    RAISE EXCEPTION 'execution_plans are immutable after creation (only disposition may change)';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE TRIGGER execution_plans_disposition_guard BEFORE UPDATE ON execution_plans
  FOR EACH ROW EXECUTE FUNCTION execution_plans_lifecycle_guard();

-- ---------------------------------------------------------------------------
-- execution_plan_events.kind CHECK — add 'shadow.order.filled'
-- ---------------------------------------------------------------------------
-- PostgreSQL has no "ALTER TABLE ... ADD CONSTRAINT IF NOT EXISTS" for CHECK
-- constraints that we want to extend; we must drop the existing inline
-- constraint and re-add the widened one. Doing this under concurrency is
-- unsafe, so take a short advisory lock first.
DO $$
DECLARE
  existing_def text;
BEGIN
  PERFORM pg_advisory_xact_lock(727401); -- arbitrary stable key for migration 0007

  SELECT pg_get_constraintdef(c.oid) INTO existing_def
    FROM pg_constraint c
    JOIN pg_class t ON c.conrelid = t.oid
   WHERE t.relname = 'execution_plan_events'
     AND c.conname = 'execution_plan_events_kind_check';

  IF existing_def IS NULL OR existing_def NOT LIKE '%shadow.order.filled%' THEN
    IF existing_def IS NOT NULL THEN
      EXECUTE 'ALTER TABLE execution_plan_events DROP CONSTRAINT execution_plan_events_kind_check';
    END IF;
    EXECUTE $q$
      ALTER TABLE execution_plan_events
        ADD CONSTRAINT execution_plan_events_kind_check
          CHECK (kind IN (
            'plan.created', 'policy.evaluated', 'approval.requested', 'approval.granted',
            'execution.started', 'order.submitted', 'order.filled',
            'shadow.order.filled',
            'execution.completed', 'execution.failed'
          ))
    $q$;
  END IF;
END$$;
