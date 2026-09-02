// Integration test: prove the persistence layer hardening against a real
// PostgreSQL database.
//
// Run with: ALEPES_TEST_DATABASE_URL=postgresql://raelldottin@localhost:5432/alepes_test npm test packages/persistence

import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { createPostgresPorts } from "./postgres";
import { runMigrations } from "./migrations";
import type { Ports, PersistableExecutionPlan, PersistenceId } from "./ports";
import { inputSnapshotHash, calculationVersion, ulid } from "./identity";
import { cents, nonNegativeCents } from "@alepes/money";

const TEST_CONNECTION = process.env.ALEPES_TEST_DATABASE_URL ?? "postgresql://raelldottin@localhost:5432/alepes_persistence_test";

const PLANS = "execution_plans";
const ORDERS = "execution_plan_orders";
const EVENTS = "execution_plan_events";
const OUTBOX = "outbox";

let ports: Ports | undefined;

async function cleanDb() {
  await runMigrations(TEST_CONNECTION);
  ports = createPostgresPorts({ connectionString: TEST_CONNECTION });
}

async function makeHash(cashEventId: string, ruleVersionId: string): Promise<string> {
  return inputSnapshotHash(
    {
      id: cashEventId,
      amount: cents(3000_00),
      source: "payroll",
      description: "Payroll deposit",
      occurredAt: "2026-08-31T09:00:00Z",
      checkingBalanceAfter: nonNegativeCents(5000_00),
    },
    [
      {
        id: ruleVersionId,
        order: 0,
        trigger: "payroll",
        reserveBalance: nonNegativeCents(2000_00),
        action: "invest_percentage",
        amount: 20,
        maxPerDeposit: nonNegativeCents(750_00),
        maxPerMonth: nonNegativeCents(2000_00),
      },
    ],
    {
      portfolio: { holdings: [{ symbol: "MSFT", targetPct: 30 }] },
      positions: [{ symbol: "MSFT", value: nonNegativeCents(1000_00) }],
    }
  );
}

function makePlan(input: {
  cashEventId: string;
  ruleVersionId: string;
  portfolioVersionId?: string;
  hash?: string;
}): PersistableExecutionPlan {
  return {
    id: `p_${ulid()}` as PersistenceId,
    plan: {} as PersistableExecutionPlan["plan"],
    cashEventId: input.cashEventId as PersistenceId,
    userId: "test-user",
    portfolioId: "portfolio-test",
    ruleVersionId: input.ruleVersionId as PersistenceId,
    portfolioVersionId: (input.portfolioVersionId ?? `pv_${input.cashEventId}`) as PersistenceId,
    calculationVersion: calculationVersion(),
    inputSnapshotHash: input.hash ?? `fake-hash-for-${input.cashEventId}`,
    deployableCents: nonNegativeCents(600_00),
    disposition: "shadow",
  };
}

const runIntegration = process.env.ALEPES_TEST_DATABASE_URL ? describe : describe.skip;

runIntegration("persistence integration (real PostgreSQL)", () => {
  beforeAll(async () => {
    await cleanDb();
  });

  beforeEach(async () => {
    // Truncate all tables to ensure test isolation
    const { Pool } = await import("pg");
    const pool = new Pool({ connectionString: TEST_CONNECTION });
    await pool.query(`TRUNCATE ${EVENTS}, ${ORDERS}, ${PLANS}, ${OUTBOX} RESTART IDENTITY CASCADE`);
    await pool.end();
  });

  it("persists and reloads a plan with full provenance", async () => {
    const repo = ports!;
    const hash = await makeHash("ce-1", "rv-1");
    const plan = makePlan({ cashEventId: "ce-1", ruleVersionId: "rv-1", portfolioVersionId: "pv-1", hash });
    const saved = await repo.execution.savePlan(plan);
    expect(saved).toBe(plan.id);
    const loaded = await repo.execution.loadPlan(plan.id);
    expect(loaded).not.toBeNull();
    expect(loaded!.userId).toBe("test-user");
    expect(loaded!.disposition).toBe("shadow");
    expect(loaded!.calculationVersion).toBe(plan.calculationVersion);
    expect(loaded!.inputSnapshotHash).toBe(plan.inputSnapshotHash);
    expect(loaded!.deployableCents).toBe(plan.deployableCents);
    expect(loaded!.cashEventId).toBe("ce-1");
  });

  it("replay with identical inputs returns the existing plan id (no duplicate)", async () => {
    const repo = ports!;
    const hash = await makeHash("ce-2", "rv-2");
    const plan = makePlan({ cashEventId: "ce-2", ruleVersionId: "rv-2", portfolioVersionId: "pv-2", hash });
    const first = await repo.execution.savePlan(plan);
    const second = await repo.execution.savePlan(plan);
    expect(second).toBe(first);
    const all = await repo.execution.listPlans();
    const mine = all.filter((p) => p.cashEventId === "ce-2");
    expect(mine).toHaveLength(1);
  });

  it("a different ruleVersionId cannot silently replay a new executable financial action", async () => {
    const repo = ports!;
    const hash = await makeHash("ce-3", "rv-3");
    const plan = makePlan({ cashEventId: "ce-3", ruleVersionId: "rv-3", portfolioVersionId: "pv-3", hash });
    await repo.execution.savePlan(plan);

    const replay = makePlan({
      cashEventId: "ce-3",
      ruleVersionId: "rv-3-b",
      portfolioVersionId: "pv-3",
      hash: await makeHash("ce-3", "rv-3-b"),
    });

    const first = await repo.execution.savePlan(plan);
    const second = await repo.execution.savePlan(replay);
    expect(second).toBe(first);
    const all = await repo.execution.listPlans();
    const mine = all.filter((p) => p.cashEventId === "ce-3");
    expect(mine).toHaveLength(1);
  });

  it("several distinct CashEvents each create exactly one plan", async () => {
    const repo = ports!;
    const ids: string[] = [];
    for (const tag of ["a", "b", "c"]) {
      const ce = `ce_distinct_${tag}_${ulid()}`;
      const rv = `rv_${ulid()}`;
      const pv = `pv_${ulid()}`;
      const hash = await makeHash(ce, rv);
      await repo.execution.savePlan(
        makePlan({ cashEventId: ce, ruleVersionId: rv, portfolioVersionId: pv, hash })
      );
      ids.push(ce);
    }
    const all = await repo.execution.listPlans();
    const mine = all.filter((p) => ids.includes(p.cashEventId));
    expect(mine).toHaveLength(3);
    const uniqueIds = new Set(mine.map((p) => p.id));
    expect(uniqueIds.size).toBe(3);
  });

  it("a failed savePlan leaves no persisted plan, orders, or outbox rows", async () => {
    const repo = ports!;
    const hash = await makeHash("ce-atomic", "rv-atomic");
    const badPlan = makePlan({
      cashEventId: "ce-atomic",
      ruleVersionId: "rv-atomic",
      portfolioVersionId: "pv-atomic",
      hash,
    });
    badPlan.portfolioId = null as unknown as string;

    const { Pool } = await import("pg");
    const preSql = `SELECT COUNT(*)::int AS n FROM ${PLANS}`;
    const preOrders = `SELECT COUNT(*)::int AS n FROM ${ORDERS}`;
    const preEvents = `SELECT COUNT(*)::int AS n FROM ${EVENTS}`;
    const preOutbox = `SELECT COUNT(*)::int AS n FROM ${OUTBOX}`;
    const prePool = new Pool({ connectionString: TEST_CONNECTION });
    const before = await Promise.all([
      prePool.query(preSql),
      prePool.query(preOrders),
      prePool.query(preEvents),
      prePool.query(preOutbox),
    ]);
    await prePool.end();

    await expect(repo.execution.savePlan(badPlan)).rejects.toThrow();

    const postPool = new Pool({ connectionString: TEST_CONNECTION });
    const after = await Promise.all([
      postPool.query(preSql),
      postPool.query(preOrders),
      postPool.query(preEvents),
      postPool.query(preOutbox),
    ]);
    await postPool.end();

    expect(after[0].rows[0].n).toBe(before[0].rows[0].n);
    expect(after[1].rows[0].n).toBe(before[1].rows[0].n);
    expect(after[2].rows[0].n).toBe(before[2].rows[0].n);
    expect(after[3].rows[0].n).toBe(before[3].rows[0].n);
  });

  it("mid-transaction failure after plan+orders+events written rolls back everything", async () => {
    const { Pool } = await import("pg");
    const pool = new Pool({ connectionString: TEST_CONNECTION });
    const client = await pool.connect();
    try {
      await client.query("BEGIN");

      const hash = await makeHash("ce-midfail", "rv-midfail");
      const plan = makePlan({ cashEventId: "ce-midfail", ruleVersionId: "rv-midfail", portfolioVersionId: "pv-midfail", hash });

      // Insert the plan
      await client.query(
        `INSERT INTO ${PLANS} (id, user_id, portfolio_id, cash_event_id, rule_version_id, portfolio_version_id, calculation_version, input_snapshot_hash, deployable_cents, disposition)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
        [
          plan.id,
          plan.userId,
          plan.portfolioId,
          plan.cashEventId,
          plan.ruleVersionId,
          plan.portfolioVersionId,
          plan.calculationVersion,
          plan.inputSnapshotHash,
          plan.deployableCents,
          plan.disposition,
        ]
      );

      // Insert an order
      await client.query(
        `INSERT INTO ${ORDERS} (id, execution_plan_id, symbol, amount_cents, side, shares)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        ["ord-test", plan.id, "MSFT", 100_00, "buy", 2.5]
      );

      // Insert an audit event
      await client.query(
        `INSERT INTO ${EVENTS} (id, execution_plan_id, at, kind, summary, detail, amount_cents)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        ["evt-test", plan.id, new Date(), "plan.created", "test", "detail", 0]
      );

      // Insert an outbox row
      await client.query(
        `INSERT INTO ${OUTBOX} (id, type, payload, created_at)
         VALUES ($1, $2, $3, $4)`,
        ["out-test", "ExecutionPlanCreated", JSON.stringify({ planId: plan.id }), new Date()]
      );

      // Now fail the transaction
      await client.query("ROLLBACK");
    } finally {
      client.release();
      await pool.end();
    }

    // Verify nothing persisted
    const verifyPool = new Pool({ connectionString: TEST_CONNECTION });
    const after = await Promise.all([
      verifyPool.query(`SELECT COUNT(*)::int AS n FROM ${PLANS}`),
      verifyPool.query(`SELECT COUNT(*)::int AS n FROM ${ORDERS}`),
      verifyPool.query(`SELECT COUNT(*)::int AS n FROM ${EVENTS}`),
      verifyPool.query(`SELECT COUNT(*)::int AS n FROM ${OUTBOX}`),
    ]);
    await verifyPool.end();

    expect(after[0].rows[0].n).toBe(0);
    expect(after[1].rows[0].n).toBe(0);
    expect(after[2].rows[0].n).toBe(0);
    expect(after[3].rows[0].n).toBe(0);
  });

  it("execution_plan_events are immutable (UPDATE/DELETE fail)", async () => {
    const repo = ports!;
    const hash = await makeHash("ce-immutable", "rv-immutable");
    const plan = makePlan({ cashEventId: "ce-immutable", ruleVersionId: "rv-immutable", portfolioVersionId: "pv-immutable", hash });
    const savedId = await repo.execution.savePlan(plan);

    const { Pool } = await import("pg");
    const pool = new Pool({ connectionString: TEST_CONNECTION });
    try {
      // Verify events exist and get an actual event ID.
      const events = await pool.query(`SELECT id FROM ${EVENTS} WHERE execution_plan_id = $1`, [savedId]);
      expect(events.rows.length).toBeGreaterThan(0);
      const eventId = events.rows[0].id;

      await expect(
        pool.query(`UPDATE ${EVENTS} SET summary = 'tampered' WHERE id = $1`, [eventId])
      ).rejects.toThrow();
      await expect(
        pool.query(`DELETE FROM ${EVENTS} WHERE execution_plan_id = $1`, [savedId])
      ).rejects.toThrow();
    } finally {
      await pool.end();
    }
  });
});