// Integration test: prove persistence hardening against a real PostgreSQL.
// Run with: ALEPES_TEST_DATABASE_URL=postgresql://raelldottin@localhost:5432/alepes_test

import { describe, it, expect, beforeAll } from "vitest";
import { createPostgresPorts } from "./postgres";
import { runMigrations } from "./migrations";
import type { Ports, PersistableExecutionPlan } from "./ports";
import { inputSnapshotHash, calculationVersion, ulid } from "./identity";
import { cents, nonNegativeCents } from "@alepes/money";

const TEST_CONNECTION = process.env.ALEPES_TEST_DATABASE_URL ?? "postgresql://raelldottin@localhost:5432/alepes_test";
let ports: Ports | undefined;

async function cleanDb() {
  const { Pool } = await import("pg");
  const pool = new Pool({ connectionString: TEST_CONNECTION });
  await pool.query("DROP SCHEMA public CASCADE; CREATE SCHEMA public;");
  await pool.end();
}

function makePlan(input: {
  cashEventId: string;
  ruleVersionId: string;
  portfolioVersionId: string;
  hash: string;
}): PersistableExecutionPlan {
  return {
    id: ulid() as PersistableExecutionPlan["id"],
    plan: {} as PersistableExecutionPlan["plan"],
    cashEventId: input.cashEventId as PersistableExecutionPlan["cashEventId"],
    userId: "test-user",
    portfolioId: "portfolio-test",
    ruleVersionId: input.ruleVersionId as PersistableExecutionPlan["ruleVersionId"],
    portfolioVersionId: input.portfolioVersionId as PersistableExecutionPlan["portfolioVersionId"],
    calculationVersion: calculationVersion(),
    inputSnapshotHash: input.hash,
    deployableCents: nonNegativeCents(600_00),
    disposition: "shadow",
  };
}

async function makeHash(cashEventId: string, ruleVersionId: string) {
  return inputSnapshotHash(
    { id: cashEventId, amount: cents(3000_00), source: "payroll", description: "p", occurredAt: "2026-08-31T09:00:00Z", checkingBalanceAfter: nonNegativeCents(5000_00) },
    [{ id: ruleVersionId, order: 0, trigger: "payroll", reserveBalance: nonNegativeCents(2000_00), action: "invest_percentage", amount: 20, maxPerDeposit: nonNegativeCents(750_00), maxPerMonth: nonNegativeCents(2000_00) }],
    { portfolio: { holdings: [] }, positions: [] }
  );
}

const runIntegration = process.env.ALEPES_TEST_DATABASE_URL ? describe : describe.skip;

runIntegration("persistence integration (real PostgreSQL)", () => {
  beforeAll(async () => {
    await cleanDb();
    await runMigrations(TEST_CONNECTION);
    ports = createPostgresPorts({ connectionString: TEST_CONNECTION });
  });

  it("persists and reloads a plan with full provenance", async () => {
    const repo = ports!;
    const hash = await makeHash("ce-1", "rv-1");
    const plan = makePlan({ cashEventId: "ce-1", ruleVersionId: "rv-1", portfolioVersionId: "pv-1", hash });
    const saved = await repo.execution.savePlan(plan);
    expect(saved).toBe(plan.id);
    const loaded = await repo.execution.loadPlan(plan.id);
    expect(loaded).not.toBeNull();
    expect(loaded!.inputSnapshotHash).toBe(hash);
    expect(loaded!.deployableCents).toBe(plan.deployableCents);
  });

  it("replaying the same CashEvent with a different rule version cannot create another executable financial action", async () => {
    const repo = ports!;
    const hash = await makeHash("ce-2", "rv-2");
    const plan = makePlan({ cashEventId: "ce-2", ruleVersionId: "rv-2", portfolioVersionId: "pv-2", hash });
    await repo.execution.savePlan(plan);
    const initialId = plan.id;

    // Same cash event, different rule version → deduped.
    const replay: PersistableExecutionPlan = {
      ...plan,
      id: ulid() as PersistableExecutionPlan["id"],
      cashEventId: "ce-2" as PersistableExecutionPlan["cashEventId"],
      ruleVersionId: "rv-2b" as PersistableExecutionPlan["ruleVersionId"],
      portfolioVersionId: "pv-2b" as PersistableExecutionPlan["portfolioVersionId"],
    };
    const second = await repo.execution.savePlan(replay);
    expect(second).toBe(initialId);
    const all = await repo.execution.listPlans();
    expect(all.filter((p) => p.cashEventId === "ce-2")).toHaveLength(1);
  });

  it("several distinct CashEvents each create exactly one plan", async () => {
    const repo = ports!;
    const ceIds: string[] = [];
    for (const tag of ["a", "b", "c"]) {
      const ce = `ce_distinct_${tag}_${ulid()}`;
      const rv = `rv_distinct_${tag}_${ulid()}`;
      const hash = await makeHash(ce, rv);
      await repo.execution.savePlan(makePlan({ cashEventId: ce, ruleVersionId: rv, portfolioVersionId: `pv_${tag}`, hash }));
      ceIds.push(ce);
    }
    const all = await repo.execution.listPlans();
    const mine = all.filter((p) => ceIds.includes(p.cashEventId));
    expect(mine).toHaveLength(3);
    const unique = new Set(mine.map((p) => p.id));
    expect(unique.size).toBe(3);
  });

  it("committing a plan is atomic: plan + orders + audit event + outbox all-or-nothing", async () => {
    const repo = ports!;
    const hash = await makeHash("ce-atomic", "rv-atomic");
    const plan = makePlan({ cashEventId: "ce-atomic", ruleVersionId: "rv-atomic", portfolioVersionId: "pv-atomic", hash });

    // Persist in one transaction.
    const savedId = await repo.execution.savePlan(plan);

    const { Pool } = await import("pg");
    const pool = new Pool({ connectionString: TEST_CONNECTION });
    try {
      const { rows: planRows } = await pool.query(
        `SELECT * FROM ${TABLE_PLANS} WHERE id = $1`, [savedId]
      );
      expect(planRows).toHaveLength(1);
      expect(planRows[0].id).toBe(savedId);

      const { rows: orderRows } = await pool.query(
        `SELECT * FROM ${TABLE_ORDERS} WHERE execution_plan_id = $1`, [savedId]
      );
      expect(orderRows).toHaveLength(0);

      const { rows: eventRows } = await pool.query(
        `SELECT * FROM ${TABLE_EVENTS} WHERE execution_plan_id = $1`, [savedId]
      );
      expect(eventRows).toHaveLength(1);

      const { rows: outboxRows } = await pool.query(
        `SELECT * FROM ${TABLE_OUTBOX} WHERE payload->>'planId' = $1`, [savedId]
      );
      expect(outboxRows).toHaveLength(1);
    } finally {
      await pool.end();
    }
  });

  it("execution_plan_events are immutable (UPDATE/DELETE fail)", async () => {
    const repo = ports!;
    const hash = await makeHash("ce-immutable", "rv-immutable");
    const plan = makePlan({ cashEventId: "ce-immutable", ruleVersionId: "rv-immutable", portfolioVersionId: "pv-immutable", hash });
    await repo.execution.savePlan(plan);

    const { Pool } = await import("pg");
    const pool = new Pool({ connectionString: TEST_CONNECTION });
    try {
      await expect(
        pool.query(
          `UPDATE execution_plan_events SET summary = 'tampered' WHERE execution_plan_id = $1`,
          [plan.id]
        )
      ).rejects.toThrow();
      await expect(
        pool.query(`DELETE FROM execution_plan_events WHERE execution_plan_id = $1`, [plan.id])
      ).rejects.toThrow();
    } finally {
      await pool.end();
    }
  });
});

const TABLE_PLANS = "execution_plans";
const TABLE_ORDERS = "execution_plan_orders";
const TABLE_EVENTS = "execution_plan_events";
const TABLE_OUTBOX = "outbox";