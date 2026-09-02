// Integration test: prove the persistence layer works against a real
// PostgreSQL database.

import { describe, it, expect, beforeAll } from "vitest";
import { createPostgresPorts } from "./postgres";
import type { Ports, PersistableExecutionPlan, PersistenceId } from "./ports";
import { inputSnapshotHash, calculationVersion } from "./identity";
import { cents, nonNegativeCents } from "@alepes/money";

const TEST_CONNECTION =
  process.env.ALEPES_TEST_DATABASE_URL ??
  "postgresql://raelldottin@localhost:5432/alepes_test";

let ports: Ports | undefined;

async function runMigrations() {
  const { Pool } = await import("pg");
  const pool = new Pool({ connectionString: TEST_CONNECTION });
  await pool.query("DROP SCHEMA public CASCADE; CREATE SCHEMA public;");
  const { readFileSync } = await import("fs");
  const { resolve } = await import("path");
  const sql = readFileSync(
    resolve(process.cwd(), "packages/persistence/migrations/0001_init.sql"),
    "utf-8"
  );
  await pool.query(sql);
  await pool.end();
  ports = createPostgresPorts({ connectionString: TEST_CONNECTION });
  return ports;
}

function makePlan(): PersistableExecutionPlan {
  return {
    id: `ps_${Date.now()}_${Math.random().toString(36).slice(2)}` as PersistenceId,
    plan: {} as PersistableExecutionPlan["plan"],
    cashEventId: `ce_${Date.now()}` as PersistenceId,
    userId: "test-user",
    portfolioId: "portfolio-test",
    ruleVersionId: `rv_${Date.now()}` as PersistenceId,
    portfolioVersionId: `pv_${Date.now()}` as PersistenceId,
    calculationVersion: calculationVersion(),
    inputSnapshotHash: inputSnapshotHash(
      {
        id: `ce_x`,
        amount: cents(3000_00),
        source: "payroll",
        description: "Payroll deposit",
        occurredAt: "2026-08-31T09:00:00Z",
        checkingBalanceAfter: nonNegativeCents(5000_00),
      },
      [
        {
          id: `rv_x`,
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
        portfolio: {
          holdings: [
            { symbol: "MSFT", targetPct: 30 },
            { symbol: "AAPL", targetPct: 70 },
          ],
        },
        positions: [{ symbol: "MSFT", value: nonNegativeCents(1000_00) }],
      }
    ),
    deployableCents: nonNegativeCents(600_00),
    disposition: "shadow",
  };
}

const runIntegration = process.env.ALEPES_TEST_DATABASE_URL
  ? describe
  : describe.skip;

runIntegration("persistence integration (real PostgreSQL)", () => {
  beforeAll(async () => {
    await runMigrations();
  });

  it("persists and reloads a plan with full provenance", async () => {
    const repo = ports!;
    const plan = makePlan();
    const savedId = await repo.execution.savePlan(plan);
    expect(savedId).toBe(plan.id);

    const loaded = await repo.execution.loadPlan(plan.id);
    expect(loaded).not.toBeNull();
    expect(loaded!.userId).toBe("test-user");
    expect(loaded!.disposition).toBe("shadow");
    expect(loaded!.calculationVersion).toBe(plan.calculationVersion);
    expect(loaded!.inputSnapshotHash).toBe(plan.inputSnapshotHash);
    expect(loaded!.deployableCents).toBe(plan.deployableCents);
    expect(loaded!.cashEventId).toBe(plan.cashEventId);
  });

  it("is replay-idempotent: a second persist with the same cash+rule does nothing", async () => {
    const repo = ports!;
    const plan = makePlan();
    const first = await repo.execution.savePlan(plan);
    const second = await repo.execution.savePlan(plan);
    expect(second).toBe(first); // same id, no duplicate
    const count = await repo.execution.loadPlan(first);
    expect(count).not.toBeNull();
  });

  it("dedupes even when the new plan has a different id (replay detection by cash+rule)", async () => {
    const repo = ports!;
    const plan = makePlan();
    const firstId = await repo.execution.savePlan(plan);
    expect(firstId).toBe(plan.id);
    const replay: PersistableExecutionPlan = {
      ...plan,
      id: `ps_replay_${Date.now()}` as PersistenceId,
      cashEventId: plan.cashEventId,
      ruleVersionId: plan.ruleVersionId,
    };
    const secondId = await repo.execution.savePlan(replay);
    expect(secondId).toBe(firstId); // dedupes to the original
    const all = await repo.execution.listPlans();
    expect(all.filter((p) => p.cashEventId === plan.cashEventId)).toHaveLength(1);
  });
});