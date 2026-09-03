// DuckDB engine for Alepes analytics — the ONLY module in the repo allowed to
// import @duckdb/node-api (enforced by oxlint `alepes/no-duckdb-outside-analytics`).
//
// Certified stable under Bun 1.4 on macOS arm64 (see test/certify-duckdb-bun.ts
// for the full 12-point matrix). Read-only: it answers "what happened?" and
// "what might happen?" — it never initiates a transfer, order, or trade, and it
// never receives write-path access to Postgres.
//
// Boundary: PostgreSQL (source of truth) → analytical export → AnalyticsEngine
//           → DuckDB → reporting / Shadow Mode / simulations / strategy analytics.

import type { AuditRecord } from "@alepes/domain";
import { NullEngine, type ExecutionAnalyticsEngine } from "./engine";

// Lazy, single-flight loader so the native addon is only pulled in when a
// DuckDB-backed engine is actually constructed (keeps NullEngine / interface
// consumers dependency-free and testable).
let duckdbMod: Promise<any> | null = null;
function loadDuckDB(): Promise<any> {
  if (!duckdbMod) {
    duckdbMod = import("@duckdb/node-api");
  }
  return duckdbMod;
}

/** DuckDB-backed implementation of the provider-neutral analytics engine. */
export class DuckDBEngine
  extends NullEngine
  implements ExecutionAnalyticsEngine
{
  private instance: any;
  private conn: any;
  private loadedEvents = 0;
  private droppedEvents = 0;
  private lastIngestAtIso = new Date(0).toISOString();

  private constructor(instance: any, conn: any) {
    super();
    this.instance = instance;
    this.conn = conn;
  }

  /** Open an in-memory (default) or file-backed DuckDB instance. */
  static async open(path?: string): Promise<DuckDBEngine> {
    const mod = await loadDuckDB();
    const instance = await mod.DuckDBInstance.create(path ?? ":memory:");
    const conn = await instance.connect();
    const engine = new DuckDBEngine(instance, conn);
    await engine.initSchema();
    return engine;
  }

  private async initSchema(): Promise<void> {
    await this.conn.run(`
      CREATE TABLE IF NOT EXISTS audit (
        id        VARCHAR PRIMARY KEY,
        "at"      VARCHAR,
        event_id  VARCHAR,
        stage     VARCHAR,
        summary   VARCHAR,
        detail    VARCHAR,
        amount    BIGINT
      );
    `);
  }

  async ingest(events: AuditRecord[]): Promise<void> {
    for (const e of events) {
      try {
        // amountCents is integer cents; stored as BIGINT so no float loss.
        const amount = e.amountCents != null ? BigInt(e.amountCents) : null;
        await this.conn.run(
          `INSERT INTO audit (id, "at", event_id, stage, summary, detail, amount)
           VALUES (?, ?, ?, ?, ?, ?, ?);`,
          [e.id, e.at, e.eventId, e.stage, e.summary, e.detail, amount],
        );
        this.loadedEvents += 1;
      } catch {
        // Non-fatal: a malformed/duplicate record is dropped and counted, so a
        // single bad event never breaks the ingest stream.
        this.droppedEvents += 1;
      }
    }
    this.lastIngestAtIso = new Date().toISOString();
  }

  async formationSeries(_windowMs: number): Promise<Record<string, unknown>[]> {
    const rows = await this.conn.runAndReadAll(
      `SELECT event_id, COUNT(*) AS events
       FROM audit
       GROUP BY event_id
       ORDER BY event_id;`,
    );
    const out = await rows.getRows();
    return out.map((r: unknown[]) => ({ eventId: r[0], events: Number(r[1]) }));
  }

  async driftReport(_windowMs: number): Promise<Record<string, unknown>[]> {
    const rows = await this.conn.runAndReadAll(
      `SELECT stage, COUNT(*) AS n, SUM(amount) AS total_cents
       FROM audit
       WHERE amount IS NOT NULL
       GROUP BY stage
       ORDER BY stage;`,
    );
    const out = await rows.getRows();
    return out.map((r: unknown[]) => ({
      stage: r[0],
      count: Number(r[1]),
      totalCents: r[2] != null ? String(r[2]) : null,
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

  /** Release the native connection and instance. */
  close(): void {
    try {
      this.conn?.closeSync();
    } catch {
      /* already closed */
    }
    try {
      this.instance?.closeSync();
    } catch {
      /* already closed */
    }
  }
}