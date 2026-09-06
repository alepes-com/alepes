// Alepes analytics engine — provider-neutral, read-only.
//
// RULES:
// - Postgres is the transactional source of truth; analytics ANSWER questions
//   ("what happened?", "what might happen?") and never write back to it.
// - No execution happens here. Analytics never initiates a transfer, order, or
//   trade, and never receives the write path to Postgres.
// - The domain never imports a concrete database or SQL engine. Consumers
//   depend on this provider-neutral `AnalyticsEngine` interface only.
//
// The first implementation is `PostgresAnalyticsEngine` (see `postgres-engine.ts`),
// which reads the canonical append-only audit table (`execution_plan_events`)
// written by `@alepes/persistence`. A `DuckDBAnalyticsEngine` may be added later
// behind this same interface if analytical scale ever warrants a separate engine.

/** A generic analytical row (column name → scalar). */
export type QueryRow = Record<string, unknown>;

/**
 * Provider-neutral analytics capability over the persisted audit trail.
 *
 * IMPORTANT — scope honesty: this engine only answers questions the canonical
 * schema can answer. Portfolio "formation" and "drift" are NOT analytics-table
 * concepts; they are pure in-memory domain functions over `PortfolioState`
 * (`@alepes/allocation-engine`), which is not persisted in the audit table.
 * This engine therefore exposes the audit-trail aggregations the schema does
 * support, and does NOT invent portfolio-formation meaning the data cannot back.
 */
export interface AnalyticsEngine {
  /** Group the append-only audit trail by stage, ordered deterministically. */
  stageSeries(windowMs: number): Promise<QueryRow[]>;
  /** Sum integer cents by stage (amounts preserved as strings — no float loss). */
  stageCentsReport(windowMs: number): Promise<QueryRow[]>;
  /** Internal stats about the engine's own load state. */
  stats(): Promise<{ rowsLoaded: number; rowsDropped: number; lastIngestAt: string }>;
}

/**
 * Dependency-free no-op engine used where analytics is unavailable (no live
 * database), or in tests that must not touch a real connection.
 */
export class NullEngine implements AnalyticsEngine {
  async stageSeries(_windowMs: number): Promise<QueryRow[]> {
    return [];
  }
  async stageCentsReport(_windowMs: number): Promise<QueryRow[]> {
    return [];
  }
  async stats(): Promise<{ rowsLoaded: number; rowsDropped: number; lastIngestAt: string }> {
    return { rowsLoaded: 0, rowsDropped: 0, lastIngestAt: new Date(0).toISOString() };
  }
}