// PostgreSQL implementation of the persistence ports. This is the ONLY module
// that knows about `pg` or SQL. Everything else in the repo targets the pure
// interfaces in `./ports.ts`.

import { Pool } from "pg";
import {
  Ports,
  PersistableExecutionPlan,
  PersistenceId,
  PersistableDisposition,
  OutboxClaim,
} from "./ports";
import { nonNegativeCents } from "@alepes/money";

const TABLE_PLANS = "execution_plans";
const TABLE_ORDERS = "execution_plan_orders";
const TABLE_EVENTS = "execution_plan_events";
const TABLE_OUTBOX = "outbox";

function mapAuditStageToKind(stage: string): string {
  switch (stage) {
    case "plan_created": case "created": return "plan.created";
    case "policy_evaluated": return "policy.evaluated";
    case "approval_requested": return "approval.requested";
    case "approval_granted": return "approval.granted";
    case "execution_started": return "execution.started";
    case "order_submitted": return "order.submitted";
    case "order_filled": return "order.filled";
    case "execution_completed": return "execution.completed";
    case "execution_failed": return "execution.failed";
    default: return stage;
  }
}

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

      const insert = await client.query<{ id: string }>(
        `INSERT INTO ${TABLE_PLANS} (id, user_id, portfolio_id, cash_event_id, rule_version_id, portfolio_version_id, calculation_version, input_snapshot_hash, deployable_cents, disposition, plan_data)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
         ON CONFLICT (cash_event_id) DO NOTHING
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
          JSON.stringify(input.plan ?? null),
        ]
      );

      const replayed = insert.rowCount === 0;

      if (replayed) {
        const existing = await client.query<{ id: string }>(
          `SELECT id FROM ${TABLE_PLANS} WHERE cash_event_id = $1`,
          [input.cashEventId]
        );
        const existingId = existing.rows[0]?.id;
        if (!existingId) {
          throw new Error("replay: plan not found after dedup conflict");
        }
        await client.query("COMMIT");
        return existingId as PersistenceId;
      }

      const persistedPlanId = insert.rows[0].id as PersistenceId;

      for (const order of input.plan.orders ?? []) {
        await client.query(
          `INSERT INTO ${TABLE_ORDERS} (id, execution_plan_id, symbol, amount_cents, side, shares, idempotency_key)
           VALUES ($1, $2, $3, $4, $5, $6, $7)
           ON CONFLICT (idempotency_key) DO NOTHING`,
          [
            order.id,
            persistedPlanId,
            order.symbol,
            order.amount as number,
            order.side,
            order.shares,
            `${persistedPlanId}::${order.id}`,
          ]
        );
      }

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

      await client.query(
        `INSERT INTO ${TABLE_OUTBOX} (id, type, payload) VALUES ($1, $2, $3)`,
        [ulidOf(), "ExecutionPlanCreated", JSON.stringify({ planId: persistedPlanId })]
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
      `SELECT id, user_id, portfolio_id, cash_event_id, rule_version_id, portfolio_version_id, calculation_version, input_snapshot_hash, deployable_cents, disposition, plan_data
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
      deployableCents: nonNegativeCents(
        typeof row.deployable_cents === "string"
          ? parseInt(row.deployable_cents, 10)
          : row.deployable_cents
      ),
      disposition: row.disposition as PersistableDisposition,
      plan: (row.plan_data ?? undefined) as PersistableExecutionPlan["plan"],
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
    const kind = mapAuditStageToKind(record.stage);
    await this.pool.query(
      `INSERT INTO ${TABLE_EVENTS} (id, execution_plan_id, at, kind, summary, detail, amount_cents)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [
        record.id,
        planId,
        record.at,
        kind,
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

  async loadOrders(planId: PersistenceId): Promise<Array<{ id: string; symbol: string; amountCents: number; side: string; shares: number; idempotencyKey: string }>> {
    const res = await this.pool.query(
      `SELECT id, symbol, amount_cents, side, shares, idempotency_key FROM ${TABLE_ORDERS} WHERE execution_plan_id = $1 ORDER BY created_at`,
      [planId]
    );
    return res.rows.map((r) => ({
      id: r.id,
      symbol: r.symbol,
      amountCents: typeof r.amount_cents === "string" ? parseInt(r.amount_cents, 10) : r.amount_cents,
      side: r.side,
      shares: r.shares,
      idempotencyKey: r.idempotency_key,
    }));
  }
}

class PostgresOutboxRepository {
  constructor(private pool: Pool) {}

  async append(payload: { type: string; payload: Record<string, unknown> }): Promise<void> {
    await this.pool.query(
      `INSERT INTO ${TABLE_OUTBOX} (id, type, payload) VALUES ($1, $2, $3)`,
      [ulidOf(), payload.type, payload.payload]
    );
  }

  async claimPending(limit: number, leaseMs: number): Promise<OutboxClaim[]> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const res = await client.query(
        `SELECT id, type, payload
           FROM ${TABLE_OUTBOX}
          WHERE delivered_at IS NULL
            AND (claimed_at IS NULL OR claim_expires_at < now())
          ORDER BY created_at ASC
          FOR UPDATE SKIP LOCKED
          LIMIT $1`,
        [limit]
      );
      const ids = res.rows.map((r) => r.id);
      if (ids.length === 0) {
        await client.query("COMMIT");
        return [];
      }
      const upd = await client.query(
        `UPDATE ${TABLE_OUTBOX}
            SET claimed_at = now(),
                claim_expires_at = now() + ($1 || ' milliseconds')::interval,
                attempts = attempts + 1
          WHERE id = ANY($2)
          RETURNING id, type, payload, claim_expires_at, attempts`,
        [String(leaseMs), ids]
      );
      await client.query("COMMIT");
      return upd.rows.map((r) => ({
        id: r.id as PersistenceId,
        type: r.type,
        payload: r.payload,
        claimExpiresAt: r.claim_expires_at,
        attempts: r.attempts,
      }));
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }
  }

  async markPublished(id: PersistenceId): Promise<void> {
    await this.pool.query(
      `UPDATE ${TABLE_OUTBOX} SET delivered_at = now() WHERE id = $1`,
      [id]
    );
  }

  async releaseClaim(id: PersistenceId): Promise<void> {
    await this.pool.query(
      `UPDATE ${TABLE_OUTBOX}
          SET claimed_at = NULL, claim_expires_at = NULL
        WHERE id = $1 AND delivered_at IS NULL`,
      [id]
    );
  }
}

function ulidOf(): string {
  return `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 12)}`;
}