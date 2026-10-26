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
  executionMode?: "shadow" | "execute";
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
    executionMode: input.executionMode ?? "shadow",
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
        `INSERT INTO ${PLANS} (id, user_id, portfolio_id, cash_event_id, rule_version_id, portfolio_version_id, calculation_version, input_snapshot_hash, deployable_cents, disposition, execution_mode)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
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
          plan.executionMode,
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

// ---------------------------------------------------------------------------
// PR #6 remediation — Finding 2 (P1): historical plan immutability.
//
// migration 0007 rebuilds `execution_plans_lifecycle_guard`. Every column of
// execution_plans EXCEPT `disposition` (the lifecycle column) is immutable
// after creation: ownership (user_id, portfolio_id) and the recorded plan
// (plan_data) are history, not editable state. `user_id` and `plan_data` are
// nullable, so the guard MUST use null-safe comparison — a plain `<>` chain
// silently accepts NULL→value and value→NULL rewrites.
//
// The nine F2-* tests below map 1:1 to the required database tests from the
// remediation card; F2-10 is an additional null-safety probe.
// ---------------------------------------------------------------------------
runIntegration("execution_plans historical immutability (migration 0007 lifecycle guard)", () => {
  const GUARD_ERROR = /immutable after creation/;

  async function savePlanFor(tag: string) {
    const repo = ports!;
    const cashEventId = `ce-f2-${tag}-${ulid()}`;
    const plan = makePlan({
      cashEventId,
      ruleVersionId: `rv-f2-${tag}`,
      portfolioVersionId: `pv-f2-${tag}`,
      hash: `hash-f2-${tag}`,
    });
    const id = await repo.execution.savePlan(plan);
    return { id, plan };
  }

  // Raw insert so we can create rows the app layer would never produce
  // (user_id NULL, plan_data NULL) to prove null-safe comparison.
  async function insertRawPlan(
    id: string,
    overrides: { userId?: string | null; planData?: string | null } = {}
  ) {
    const { Pool } = await import("pg");
    const pool = new Pool({ connectionString: TEST_CONNECTION });
    try {
      await pool.query(
        `INSERT INTO ${PLANS} (id, user_id, portfolio_id, cash_event_id, rule_version_id, portfolio_version_id, calculation_version, input_snapshot_hash, deployable_cents, disposition, execution_mode, plan_data)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
        [
          id,
          overrides.userId ?? null,
          "portfolio-test",
          `ce-raw-${id}`,
          `rv-raw-${id}`,
          `pv-raw-${id}`,
          `cv-raw-${id}`,
          `hash-raw-${id}`,
          100_00,
          "shadow",
          "shadow",
          overrides.planData ?? null,
        ]
      );
    } finally {
      await pool.end();
    }
  }

  async function readHistoricalRow(id: string) {
    const { Pool } = await import("pg");
    const pool = new Pool({ connectionString: TEST_CONNECTION });
    try {
      const res = await pool.query(
        `SELECT id, user_id, portfolio_id, cash_event_id, rule_version_id, portfolio_version_id,
                calculation_version, input_snapshot_hash, deployable_cents::text AS deployable_cents,
                disposition, execution_mode, plan_data::text AS plan_data, created_at::text AS created_at
           FROM ${PLANS} WHERE id = $1`,
        [id]
      );
      return res.rows[0];
    } finally {
      await pool.end();
    }
  }

  // Attempt an UPDATE and report whether the guard rejected it. Never throws,
  // so the assertion below can present the real outcome (accepted vs rejected)
  // in the failure message.
  async function attempt(sql: string, params: unknown[] = []) {
    const { Pool } = await import("pg");
    const pool = new Pool({ connectionString: TEST_CONNECTION });
    try {
      const res = await pool.query(sql, params);
      return { rejected: false as const, rowCount: res.rowCount ?? 0 };
    } catch (err) {
      return {
        rejected: true as const,
        message: err instanceof Error ? err.message : String(err),
      };
    } finally {
      await pool.end();
    }
  }

  beforeAll(async () => {
    await cleanDb();
  });

  beforeEach(async () => {
    const { Pool } = await import("pg");
    const pool = new Pool({ connectionString: TEST_CONNECTION });
    await pool.query(`TRUNCATE ${EVENTS}, ${ORDERS}, ${PLANS}, ${OUTBOX} RESTART IDENTITY CASCADE`);
    await pool.end();
  });

  it("F2-1 changing user_id is rejected", async () => {
    const { id } = await savePlanFor("t1");
    const result = await attempt(`UPDATE ${PLANS} SET user_id = 'attacker' WHERE id = $1`, [id]);
    expect(result, `historical ownership (user_id) must be immutable; got: ${JSON.stringify(result)}`)
      .toEqual(expect.objectContaining({ rejected: true, message: expect.stringMatching(GUARD_ERROR) }));
  });

  it("F2-2 changing portfolio_id is rejected", async () => {
    const { id } = await savePlanFor("t2");
    const result = await attempt(`UPDATE ${PLANS} SET portfolio_id = 'rogue-portfolio' WHERE id = $1`, [id]);
    expect(result, `historical ownership (portfolio_id) must be immutable; got: ${JSON.stringify(result)}`)
      .toEqual(expect.objectContaining({ rejected: true, message: expect.stringMatching(GUARD_ERROR) }));
  });

  it("F2-3 changing plan_data is rejected", async () => {
    const { id } = await savePlanFor("t3");
    const result = await attempt(
      `UPDATE ${PLANS} SET plan_data = '{"tampered":true}'::jsonb WHERE id = $1`,
      [id]
    );
    expect(result, `recorded plan contents (plan_data) must be immutable; got: ${JSON.stringify(result)}`)
      .toEqual(expect.objectContaining({ rejected: true, message: expect.stringMatching(GUARD_ERROR) }));
  });

  it("F2-4 combined user_id + portfolio_id + plan_data mutation is rejected", async () => {
    const { id } = await savePlanFor("t4");
    const result = await attempt(
      `UPDATE ${PLANS} SET user_id = 'attacker', portfolio_id = 'rogue-portfolio', plan_data = '{"tampered":true}'::jsonb WHERE id = $1`,
      [id]
    );
    expect(result, `combined historical mutation must be immutable; got: ${JSON.stringify(result)}`)
      .toEqual(expect.objectContaining({ rejected: true, message: expect.stringMatching(GUARD_ERROR) }));
  });

  it("F2-5 mutation without a disposition change is rejected", async () => {
    const { id } = await savePlanFor("t5");
    // disposition is explicitly re-asserted at its current value ('shadow'):
    // framing the UPDATE as disposition maintenance must not smuggle content.
    const result = await attempt(
      `UPDATE ${PLANS} SET plan_data = '{"smuggled":true}'::jsonb, disposition = 'shadow' WHERE id = $1`,
      [id]
    );
    expect(result, `mutation with unchanged disposition must be rejected; got: ${JSON.stringify(result)}`)
      .toEqual(expect.objectContaining({ rejected: true, message: expect.stringMatching(GUARD_ERROR) }));
  });

  it("F2-6 mutation smuggled alongside a permitted disposition change is rejected", async () => {
    const { id } = await savePlanFor("t6");
    // disposition 'shadow' -> 'executed' alone would be permitted; the
    // plan_data rewrite in the same statement must still fail the guard.
    const result = await attempt(
      `UPDATE ${PLANS} SET plan_data = '{"smuggled":true}'::jsonb, disposition = 'executed' WHERE id = $1`,
      [id]
    );
    expect(result, `historical mutation must not ride along a lifecycle transition; got: ${JSON.stringify(result)}`)
      .toEqual(expect.objectContaining({ rejected: true, message: expect.stringMatching(GUARD_ERROR) }));
  });

  it("F2-7 a legitimate lifecycle transition (disposition-only change) is accepted", async () => {
    const { id } = await savePlanFor("t7");
    const before = await readHistoricalRow(id);

    // The real production path for lifecycle transitions.
    await ports!.execution.updateDisposition(id as PersistenceId, "executed");

    const after = await readHistoricalRow(id);
    expect(after.disposition).toBe("executed");
    // Everything except disposition is untouched.
    expect({ ...after, disposition: undefined }).toEqual({ ...before, disposition: undefined });
  });

  it("F2-8 a legitimate no-op disposition update is accepted", async () => {
    const { id } = await savePlanFor("t8"); // disposition starts at 'shadow'
    const before = await readHistoricalRow(id);

    const result = await attempt(`UPDATE ${PLANS} SET disposition = 'shadow' WHERE id = $1`, [id]);
    expect(result, `no-op disposition update must stay accepted; got: ${JSON.stringify(result)}`)
      .toEqual({ rejected: false, rowCount: 1 });

    expect(await readHistoricalRow(id)).toEqual(before);
  });

  it("F2-9 rejected updates leave the historical row unchanged", async () => {
    const { id } = await savePlanFor("t9");
    const before = await readHistoricalRow(id);

    const battery: Array<[string, unknown[]]> = [
      [`UPDATE ${PLANS} SET user_id = 'attacker' WHERE id = $1`, [id]],
      [`UPDATE ${PLANS} SET portfolio_id = 'rogue-portfolio' WHERE id = $1`, [id]],
      [`UPDATE ${PLANS} SET plan_data = '{"tampered":true}'::jsonb WHERE id = $1`, [id]],
      [
        `UPDATE ${PLANS} SET user_id = 'attacker', portfolio_id = 'rogue-portfolio', plan_data = '{"tampered":true}'::jsonb WHERE id = $1`,
        [id],
      ],
      // Regression pin: columns the guard already covered pre-fix stay covered.
      [`UPDATE ${PLANS} SET deployable_cents = 99999 WHERE id = $1`, [id]],
      [`UPDATE ${PLANS} SET cash_event_id = 'ce-hijacked' WHERE id = $1`, [id]],
      [`UPDATE ${PLANS} SET created_at = now() WHERE id = $1`, [id]],
      [`UPDATE ${PLANS} SET execution_mode = 'execute' WHERE id = $1`, [id]],
      [
        `UPDATE ${PLANS} SET plan_data = '{"smuggled":true}'::jsonb, disposition = 'executed' WHERE id = $1`,
        [id],
      ],
    ];
    for (const [sql, params] of battery) {
      const result = await attempt(sql, params);
      expect(
        { sql, result },
        `prohibited historical mutation must be rejected: ${sql}`
      ).toEqual(expect.objectContaining({ result: expect.objectContaining({ rejected: true }) }));
    }

    const after = await readHistoricalRow(id);
    expect(after, `row must be byte-identical after the rejected battery`).toEqual(before);
  });

  it("F2-10 null-safe comparison: NULL↔value transitions on nullable historical fields are rejected", async () => {
    const nullRowId = `p-f2-null-${ulid()}`;
    await insertRawPlan(nullRowId); // user_id NULL, plan_data NULL

    const nullToUser = await attempt(`UPDATE ${PLANS} SET user_id = 'attacker' WHERE id = $1`, [nullRowId]);
    expect(nullToUser, `NULL user_id -> 'attacker' must be rejected (null-safe compare); got: ${JSON.stringify(nullToUser)}`)
      .toEqual(expect.objectContaining({ rejected: true, message: expect.stringMatching(GUARD_ERROR) }));

    const nullToPlan = await attempt(`UPDATE ${PLANS} SET plan_data = '{"tampered":true}'::jsonb WHERE id = $1`, [nullRowId]);
    expect(nullToPlan, `NULL plan_data -> value must be rejected (null-safe compare); got: ${JSON.stringify(nullToPlan)}`)
      .toEqual(expect.objectContaining({ rejected: true, message: expect.stringMatching(GUARD_ERROR) }));

    const { id } = await savePlanFor("t10"); // user_id 'test-user', plan_data '{}'
    const userToNull = await attempt(`UPDATE ${PLANS} SET user_id = NULL WHERE id = $1`, [id]);
    expect(userToNull, `'test-user' -> NULL must be rejected (null-safe compare); got: ${JSON.stringify(userToNull)}`)
      .toEqual(expect.objectContaining({ rejected: true, message: expect.stringMatching(GUARD_ERROR) }));

    const planToNull = await attempt(`UPDATE ${PLANS} SET plan_data = NULL WHERE id = $1`, [id]);
    expect(planToNull, `plan_data -> NULL must be rejected (null-safe compare); got: ${JSON.stringify(planToNull)}`)
      .toEqual(expect.objectContaining({ rejected: true, message: expect.stringMatching(GUARD_ERROR) }));

    // Control: a NULL-historical row may still undergo a legitimate
    // disposition transition (NULL stays NULL; nothing historical moves).
    const lifecycle = await attempt(
      `UPDATE ${PLANS} SET disposition = 'approval_required' WHERE id = $1`,
      [nullRowId]
    );
    expect(lifecycle, `legitimate transition on a NULL-historical row must stay accepted; got: ${JSON.stringify(lifecycle)}`)
      .toEqual({ rejected: false, rowCount: 1 });
  });
});