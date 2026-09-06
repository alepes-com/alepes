// Unit + integration tests for the provider-neutral analytics engine and its
// Postgres-backed implementation.
//
// The interface/NullEngine tests run in every CI environment with no external
// dependencies. The PostgresAnalyticsEngine tests follow the `@alepes/persistence`
// convention: they run ONLY when ALEPES_TEST_ANALYTICS_DATABASE_URL is set (or
// fall back to the local default), apply the canonical migrations, and prove the
// queries against REAL PostgreSQL — not an in-memory substitute.
//
// Run explicitly with:
//   ALEPES_TEST_ANALYTICS_DATABASE_URL=postgresql://raelldottin@localhost:5432/alepes_analytics_test \
//   bun run test packages/analytics/src/index.test.ts
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { runMigrations } from "@alepes/persistence";
import { NullEngine, type AnalyticsEngine } from "./engine";
import { PostgresAnalyticsEngine } from "./postgres-engine";

describe("analytics adapter (interface)", () => {
  const engine = new NullEngine() satisfies AnalyticsEngine;

  it("a null engine is a valid read-only engine", async () => {
    expect(await engine.stageSeries(0)).toEqual([]);
    expect(await engine.stageCentsReport(0)).toEqual([]);
    expect(await engine.stats()).toEqual({
      rowsLoaded: 0,
      rowsDropped: 0,
      lastIngestAt: expect.any(String),
    });
  });

  it("stats are deterministic", async () => {
    const s1 = await engine.stats();
    const s2 = await engine.stats();
    expect(s1.rowsLoaded).toBe(0);
    expect(s1.rowsDropped).toBe(0);
    expect(s1.lastIngestAt).toEqual(s2.lastIngestAt);
  });
});

// The Postgres-backed engine reads the canonical append-only audit table written
// by @alepes/persistence. It is read-only and has NO ingest() method — financial
// state is produced by the persistence layer, never by analytics.
const TEST_CONNECTION = process.env.ALEPES_TEST_ANALYTICS_DATABASE_URL
  ?? process.env.ALEPES_TEST_DATABASE_URL
  ?? "postgresql://raelldottin@localhost:5432/alepes_analytics_test";

const runIntegration = (process.env.ALEPES_TEST_ANALYTICS_DATABASE_URL
  || process.env.ALEPES_TEST_DATABASE_URL) ? describe : describe.skip;

runIntegration("PostgresAnalyticsEngine (real PostgreSQL)", () => {
  let db: PostgresAnalyticsEngine;

  async function insertEvent(row: {
    id: string;
    at?: string;
    stage: string;
    amountCents?: number;
  }) {
    const { Pool } = await import("pg");
    const pool = new Pool({ connectionString: TEST_CONNECTION });
    try {
      // A minimal plan row to satisfy the FK; events are the analytics subject.
      await pool.query(
        `INSERT INTO execution_plans
           (id, portfolio_id, cash_event_id, rule_version_id, portfolio_version_id,
            calculation_version, input_snapshot_hash, deployable_cents, disposition)
         VALUES ($1, 'p', $2, 'rv', 'pv', 'calc', 'hash', 0, 'shadow')
         ON CONFLICT (id) DO NOTHING`,
        [row.id, `${row.id}-cash`]
      );
      await pool.query(
        `INSERT INTO execution_plan_events
           (id, execution_plan_id, at, kind, summary, detail, amount_cents)
         VALUES ($1, $2, $3, $4, 's', 'd', $5)`,
        [row.id, row.id, row.at ?? "2026-09-03T00:00:00.000Z", row.stage, row.amountCents ?? 0]
      );
    } finally {
      await pool.end();
    }
  }

  beforeAll(async () => {
    await runMigrations(TEST_CONNECTION);
  });

  afterAll(async () => {
    await db?.close();
  });

  beforeEach(async () => {
    const { Pool } = await import("pg");
    const pool = new Pool({ connectionString: TEST_CONNECTION });
    await pool.query(
      `TRUNCATE execution_plan_events, execution_plan_orders, execution_plans RESTART IDENTITY CASCADE`
    );
    await pool.end();
    db = PostgresAnalyticsEngine.open(TEST_CONNECTION);
  });

  it("opens and closes cleanly over a real connection", async () => {
    expect(db).toBeInstanceOf(PostgresAnalyticsEngine);
    // A second engine over a fresh pool also opens without error.
    const other = PostgresAnalyticsEngine.open(TEST_CONNECTION);
    await other.close();
  });

  it("empty state: both aggregations return [] deterministically", async () => {
    expect(await db.stageSeries(0)).toEqual([]);
    expect(await db.stageCentsReport(0)).toEqual([]);
  });

  it("stageSeries groups events by stage and orders deterministically", async () => {
    await insertEvent({ id: "evt-1", stage: "plan.created", amountCents: 100 });
    await insertEvent({ id: "evt-2", stage: "plan.created", amountCents: 200 });
    await insertEvent({ id: "evt-3", stage: "execution.completed", amountCents: 500 });
    const rows = await db.stageSeries(0);
    expect(rows.map((r) => r.stage)).toEqual(["execution.completed", "plan.created"]);
    const byStage = new Map(rows.map((r) => [r.stage, r.events]));
    expect(byStage.get("plan.created")).toBe(2);
    expect(byStage.get("execution.completed")).toBe(1);
  });

  it("stageCentsReport preserves integer cents exactly (string form)", async () => {
    // 199999 + 1 = 200000; verifying the values come back as decimal strings,
    // never float-formatted scientific notation.
    await insertEvent({ id: "evt-a", stage: "execution.completed", amountCents: 199999 });
    await insertEvent({ id: "evt-b", stage: "execution.completed", amountCents: 1 });
    const rows = await db.stageCentsReport(0);
    const executed = rows.find((r) => r.stage === "execution.completed");
    expect(executed).toBeDefined();
    expect(executed!.count).toBe(2);
    expect(executed!.totalCents).toBe("200000");
  });

  it("zero-amount events sum to \"0\" correctly", async () => {
    await insertEvent({ id: "evt-zero", stage: "policy.evaluated", amountCents: 0 });
    const rows = await db.stageCentsReport(0);
    const held = rows.find((r) => r.stage === "policy.evaluated");
    expect(held!.totalCents).toBe("0");
  });

  it("stats reports a coherent engine state after queries", async () => {
    await insertEvent({ id: "evt-s", stage: "plan.created", amountCents: 1 });
    await db.stageSeries(0);
    const s = await db.stats();
    expect(typeof s.rowsLoaded).toBe("number");
    expect(s.rowsDropped).toBe(0);
  });
});