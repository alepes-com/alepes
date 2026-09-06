// PostgreSQL analytics engine for Alepes — the ONLY concrete implementation of
// the provider-neutral `AnalyticsEngine` in the runtime today.
//
// Read-only: it answers "what happened?" by querying the canonical append-only
// audit table (`execution_plan_events`) written by `@alepes/persistence`. It
// never initiates a transfer, order, or trade, and it never receives write-path
// access to Postgres.
//
// Postgres is both the system of record and the initial analytical query engine
// (views / materialized views / plain SQL). DuckDB is deferred: it may be
// introduced later AS A SEPARATE analytical workload behind this same
// `AnalyticsEngine` interface (e.g. `DuckDBAnalyticsEngine`) if/when analytical
// scale — large historical simulations, long time-series scans, backtests,
// Parquet analysis — warrants the extra runtime boundary. Until then, no Node
// sidecar or CLI subprocess is introduced solely to run DuckDB under Bun 1.4.
//
// Scope honesty (see engine.ts): the canonical audit table exposes `kind`
// (the lifecycle stage) and `amount_cents` (integer cents) per event, plus a
// timestamped, append-only, DB-enforced-immutable trail. The queries below
// aggregate exactly that — they do NOT fabricate portfolio "formation"/"drift",
// which are in-memory domain concepts over `PortfolioState`
// (`@alepes/allocation-engine`), not rows in this table.

import { Pool } from "pg";
import { NullEngine, type AnalyticsEngine, type QueryRow } from "./engine";

/** PostgreSQL connection options consumed by the analytics engine. */
export interface PostgresAnalyticsConfig {
  connectionString: string;
  /** Optional existing pool; when omitted the engine owns (and closes) its own. */
  pool?: Pool;
}

/**
 * Postgres-backed implementation of the read-only analytics engine. It maps the
 * persisted audit-event schema to analytics queries, preserving integer cents as
 * strings so no floating-point formatting ever touches amounts.
 */
export class PostgresAnalyticsEngine extends NullEngine implements AnalyticsEngine {
  private readonly pool: Pool;
  private readonly ownsPool: boolean;
  private loadedEvents = 0;
  private droppedEvents = 0;
  private lastIngestAtIso = new Date(0).toISOString();

  constructor(cfg: PostgresAnalyticsConfig) {
    super();
    if (cfg.pool) {
      this.pool = cfg.pool;
      this.ownsPool = false;
    } else {
      this.pool = new Pool({ connectionString: cfg.connectionString });
      this.ownsPool = true;
    }
  }

  /** Convenience factory for a self-owned engine (single-line construction). */
  static open(connectionString: string): PostgresAnalyticsEngine {
    return new PostgresAnalyticsEngine({ connectionString });
  }

  async stageSeries(_windowMs: number): Promise<QueryRow[]> {
    const res = await this.pool.query<{ kind: string; events: string }>(
      `SELECT kind, COUNT(*) AS events
         FROM execution_plan_events
        GROUP BY kind
        ORDER BY kind`
    );
    this.loadedEvents = res.rowCount ?? 0;
    return res.rows.map((r) => ({ stage: r.kind, events: Number(r.events) }));
  }

  async stageCentsReport(_windowMs: number): Promise<QueryRow[]> {
    const res = await this.pool.query<{
      kind: string;
      count: string;
      total_cents: string | null;
    }>(
      `SELECT kind, COUNT(*) AS count, SUM(amount_cents) AS total_cents
         FROM execution_plan_events
        GROUP BY kind
        ORDER BY kind`
    );
    return res.rows.map((r) => ({
      stage: r.kind,
      count: Number(r.count),
      totalCents: r.total_cents != null ? String(r.total_cents) : null,
    }));
  }

  override async stats(): Promise<{
    rowsLoaded: number;
    rowsDropped: number;
    lastIngestAt: string;
  }> {
    return {
      rowsLoaded: this.loadedEvents,
      rowsDropped: this.droppedEvents,
      lastIngestAt: this.lastIngestAtIso,
    };
  }

  /** Release the pool only if this engine created it. */
  async close(): Promise<void> {
    if (this.ownsPool) {
      await this.pool.end();
    }
  }
}