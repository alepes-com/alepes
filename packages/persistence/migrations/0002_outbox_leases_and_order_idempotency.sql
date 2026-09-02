-- Step 5 schema additions: plan data JSONB storage, order idempotency.

-- Persist the full domain ExecutionPlan JSON so the execution worker can
-- reload the plan without re-running the pipeline. JSONB keeps it queryable.
ALTER TABLE execution_plans
  ADD COLUMN IF NOT EXISTS plan_data JSONB;

-- Orders: durable idempotency key, one row per key, forever.
ALTER TABLE execution_plan_orders
  ADD COLUMN IF NOT EXISTS idempotency_key TEXT;

-- A plan's order list is fixed at creation time, so the key is unique across
-- the table. Backfill existing rows deterministically (plan::order id).
DO $$
BEGIN
  -- Only backfill if there are rows with NULL idempotency_key
  UPDATE execution_plan_orders
  SET idempotency_key = execution_plan_id || '::' || id
  WHERE idempotency_key IS NULL;
END $$;

-- The idempotency key is required once populated; only then add UNIQUE.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_class WHERE relname = 'execution_plan_orders_idempotency_key_key'
  ) THEN
    ALTER TABLE execution_plan_orders
      ADD CONSTRAINT execution_plan_orders_idempotency_key_key UNIQUE (idempotency_key);
  END IF;
END $$;
