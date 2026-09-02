// PostgreSQL implementation of the persistence ports. This is the ONLY module
// that knows about `pg` or SQL. Everything else in the repo targets the pure
// interfaces in `./ports.ts`.

import { Pool } from "pg";
import {
  Ports,
  PersistableExecutionPlan,
  PersistenceId,
  PersistableDisposition,
} from "./ports";
import { nonNegativeCents } from "@alepes/money";

const TABLE_PLANS = "execution_plans";
const TABLE_ORDERS = "execution_plan_orders";
const TABLE_EVENTS = "execution_plan_events";
const TABLE_OUTBOX = "outbox";

export interface PostgresConfig {
  connectionString: string;
}

export function createPostgresPorts(cfg: PostgresConfig): Ports {
  const pool = new Pool({ connectionString: cfg.connectionString });
  return {
    execution: new PostgresExecutionRepository(pool),
    outbox: new PostgresOutboxRepository(pool),
    close: async () => {
      await pool.end();
    },
  };
}

class PostgresExecutionRepository {
  constructor(private pool: Pool) {}

  async savePlan(input: PersistableExecutionPlan): Promise<PersistenceId> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");

      // Idempotent insert: replaying the same (cash_event_id, rule_version_id)
      // returns the existing row instead of creating a duplicate.
      const insert = await client.query<{ id: string }>(
        `INSERT INTO ${TABLE_PLANS} (id, user_id, portfolio_id, cash_event_id, rule_version_id, portfolio_version_id, calculation_version, input_snapshot_hash, deployable_cents, disposition)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
         ON CONFLICT (cash_event_id, rule_version_id) DO NOTHING
         RETURNING id`,
        [
          input.id,
          input.userId ?? null,
          input.portfolioId,
          input.cashEventId,
          input.ruleVersionId,
          input.portfolioVersionId,
          input.calculationVersion,
          input.inputSnapshotHash,
          input.deployableCents as number,
          input.disposition,
        ]
      );

      const replayed = insert.rowCount === 0;

      if (replayed) {
        // Replay: look up the pre-existing plan id so callers get the original.
        const existing = await client.query<{ id: string }>(
          `SELECT id FROM ${TABLE_PLANS} WHERE cash_event_id = $1 AND rule_version_id = $2`,
          [input.cashEventId, input.ruleVersionId]
        );
        const existingId = existing.rows[0]?.id;
        if (!existingId) {
          throw new Error("replay: plan not found after dedup conflict");
        }
        await client.query("COMMIT");
        return existingId as PersistenceId;
      }

      const persistedPlanId = insert.rows[0].id as PersistenceId;

      // Orders
      for (const order of input.plan.orders ?? []) {
        await client.query(
          `INSERT INTO ${TABLE_ORDERS} (id, execution_plan_id, symbol, amount_cents, side, shares)
           VALUES ($1, $2, $3, $4, $5, $6)`,
          [
            order.id,
            persistedPlanId,
            order.symbol,
            order.amount as number,
            order.side,
            order.shares,
          ]
        );
      }

      // Initial audit event
      await client.query(
        `INSERT INTO ${TABLE_EVENTS} (id, execution_plan_id, at, kind, summary, detail, amount_cents)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [
          `plan.created-${persistedPlanId}`,
          persistedPlanId,
          new Date().toISOString(),
          "plan.created",
          "Plan created",
          `Persisted ${persistedPlanId} (calc ${input.calculationVersion}, hash ${input.inputSnapshotHash}).`,
          input.deployableCents as number,
        ]
      );

      // Outbox event (same transaction)
      await client.query(
        `INSERT INTO ${TABLE_OUTBOX} (id, type, payload) VALUES ($1, $2, $3)`,
        [ulid(), "ExecutionPlanCreated", JSON.stringify({ planId: persistedPlanId })]
      );

      await client.query("COMMIT");
      return persistedPlanId;
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }
  }

  async loadPlan(id: PersistenceId): Promise<PersistableExecutionPlan | null> {
    const res = await this.pool.query(
      `SELECT id, user_id, portfolio_id, cash_event_id, rule_version_id, portfolio_version_id, calculation_version, input_snapshot_hash, deployable_cents, disposition
       FROM ${TABLE_PLANS} WHERE id = $1`,
      [id]
    );
    if (res.rows.length === 0) return null;
    const row = res.rows[0];
    return {
      id: row.id as PersistenceId,
      userId: row.user_id ?? undefined,
      portfolioId: row.portfolio_id,
      cashEventId: row.cash_event_id,
      ruleVersionId: row.rule_version_id,
      portfolioVersionId: row.portfolio_version_id,
      calculationVersion: row.calculation_version,
      inputSnapshotHash: row.input_snapshot_hash,
      deployableCents: nonNegativeCents(typeof row.deployable_cents === "string" ? parseInt(row.deployable_cents, 10) : row.deployable_cents),
      disposition: row.disposition as PersistableDisposition,
      plan: undefined as unknown as PersistableExecutionPlan["plan"],
    };
  }

  async listPlans(): Promise<PersistableExecutionPlan[]> {
    const res = await this.pool.query(
      `SELECT id FROM ${TABLE_PLANS} ORDER BY created_at ASC`
    );
    const out: PersistableExecutionPlan[] = [];
    for (const row of res.rows) {
      const p = await this.loadPlan(row.id);
      if (p) out.push(p);
    }
    return out;
  }

  async appendEvent(
    planId: PersistenceId,
    record: import("@alepes/domain").AuditRecord
  ): Promise<void> {
    await this.pool.query(
      `INSERT INTO ${TABLE_EVENTS} (id, execution_plan_id, at, kind, summary, detail, amount_cents)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [
        record.id,
        planId,
        record.at,
        record.stage,
        record.summary,
        record.detail,
        record.amountCents ?? 0,
      ]
    );
  }

  async updateDisposition(planId: PersistenceId, disposition: PersistableDisposition): Promise<void> {
    await this.pool.query(
      `UPDATE ${TABLE_PLANS} SET disposition = $1 WHERE id = $2`,
      [disposition, planId]
    );
  }
}

class PostgresOutboxRepository {
  constructor(private pool: Pool) {}

  async append(payload: { type: string; payload: Record<string, unknown> }): Promise<void> {
    await this.pool.query(
      `INSERT INTO ${TABLE_OUTBOX} (id, type, payload) VALUES ($1, $2, $3)`,
      [ulid(), payload.type, payload.payload]
    );
  }

  async claimPending(limit: number): Promise<Array<{ id: PersistenceId; type: string; payload: Record<string, unknown> }>> {
    const res = await this.pool.query(
      `SELECT id, type, payload FROM ${TABLE_OUTBOX} WHERE claimed_at IS NULL ORDER BY created_at ASC LIMIT $1`,
      [limit]
    );
    return res.rows.map((r) => ({
      id: r.id as PersistenceId,
      type: r.type,
      payload: r.payload,
    }));
  }
}

function ulid(): string {
  return `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 12)}`;
}