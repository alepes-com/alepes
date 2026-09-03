// Alepes analytics engine (DuckDB-backed, read-only)
//
// RULES:
// - Postgres is the transactional source of truth; this module only reads.
// - No execution happens here — analytics answer "what happened?" and
//   "what might happen?", never "go do it".
// - The domain never imports DuckDB; only this adapter knows about it.

import type { AuditRecord } from "@alepes/domain";

export type QueryRow = Record<string, unknown>;
export interface ExecutionAnalyticsEngine {
  ingest(events: AuditRecord[]): Promise<void>;
  formationSeries(windowMs: number): Promise<Record<string, unknown>[]>;
  driftReport(windowMs: number): Promise<Record<string, unknown>[]>;
  stats(): Promise<{ rowsLoaded: number; rowsDropped: number; lastIngestAt: string }>;
}

export class NullEngine implements ExecutionAnalyticsEngine {
  async ingest(_: AuditRecord[]): Promise<void> {}
  async formationSeries(_: number): Promise<Record<string, unknown>[]> {
    return [];
  }
  async driftReport(_: number): Promise<Record<string, unknown>[]> {
    return [];
  }
  async stats(): Promise<{ rowsLoaded: number; rowsDropped: number; lastIngestAt: string }> {
    return { rowsLoaded: 0, rowsDropped: 0, lastIngestAt: new Date(0).toISOString() };
  }
}
