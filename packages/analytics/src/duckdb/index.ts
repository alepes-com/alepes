// DuckDB-backed analytics store for Alepes.
// Read-only analytical side: this module NEVER initiates financial actions.
// It consumes exported Parquet data from Postgres and answers drift/simulation
// questions for Shadow Mode + reporting.

import type { AuditRecord } from "@alepes/domain";

/**
 * DuckDB handles the Promise/await layer for the analytics engine.
 * We lazy-load the module so tests that don't need DuckDB can skip it.
 */
type DuckDBConnectionLike = {
  run(sql: string, params?: unknown): Promise<unknown>;
  close(): Promise<void>;
};

let dbInstance: DuckDBConnectionLike | null = null;

/** Initialize DuckDB with an in-memory database (or file path for persistent volumes). */
export async function initDuckDB(path = ":memory:"): Promise<DuckDBConnectionLike> {
  if (dbInstance) return dbInstance;
  const mod = await import("@duckdb/node-api");
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const DuckDBConnection: any = mod.DuckDBConnection;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const conn: any = new DuckDBConnection(path);
  dbInstance = conn as DuckDBConnectionLike;
  return conn;
}

export async function closeDuckDB(): Promise<void> {
  if (dbInstance) await dbInstance.close();
  dbInstance = null;
}

/** A query result row from the analytical engine. */
export interface QueryRow {
  [key: string]: unknown;
}

/** Run a read-only analytics query. */
export async function query(sql: string, params: unknown[] = []): Promise<QueryRow[]> {
  const db = await initDuckDB();
  // DuckDB Neo API: run(sql, params?) returns a result set
  const result = await db.run(sql, params.length ? params : undefined);
  return result as QueryRow[];
}

/** Load a flat list of records into a named DuckDB table for analysis. */
export async function loadAuditRecords(records: AuditRecord[]): Promise<void> {
  await initDuckDB();
  await query(`
    CREATE OR REPLACE TABLE audit_events (
      id TEXT,
      plan_id TEXT,
      event_id TEXT,
      amount_cents BIGINT,
      symbol TEXT,
      timestamp TIMESTAMP,
      kind TEXT,
      detail TEXT
    );
  `);
  if (records.length > 0) {
    // We use an aggregate insert for speed and safety.
    // Production: replace this with a Parquet export pipeline.
    const values = records.map(
      (r) =>
        `VALUES (${JSON.stringify(r.id)}, ${JSON.stringify(r.eventId)}, ${r.amountCents ?? 0}, ${JSON.stringify(r.summary)}, ${JSON.stringify(r.detail)}, ${JSON.stringify(r.at)})`
    ).join(",\n");
    await query(`INSERT INTO audit_events ${values}`);
  }
}

/** Typical analytical query: drift over time. */
export async function formationHistory(): Promise<QueryRow[]> {
  return query(`
    SELECT
      timestamp::date AS day,
      SUM(amount_cents) AS total_cents,
      COUNT(DISTINCT symbol) AS symbols_deployed
    FROM audit_events
    WHERE kind = 'order.filled'
    GROUP BY 1
    ORDER BY 1
  `);
}

/** Aggregate totals for a single execution plan. */
export async function planSummary(planId: string): Promise<QueryRow[]> {
  return query(
    `SELECT symbol, amount_cents, COUNT(*) FROM audit_events WHERE plan_id = ? GROUP BY 1, 2 ORDER BY 1;`,
    [planId]
  );
}
