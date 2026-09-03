// Unit tests for the DuckDB analytics engine.
//
// These run against the REAL @duckdb/node-api native addon under Bun. They are
// the runtime proof that the DuckDBEngine adapter works end-to-end, not just
// the interface shim.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { cents } from "@alepes/money";
import { NullEngine, type ExecutionAnalyticsEngine } from "./engine";
import { DuckDBEngine } from "./duckdb-engine";
import type { AuditRecord } from "@alepes/domain";

const events: AuditRecord[] = [
  { id: "a1", at: "2026-09-03T00:00:00.000Z", eventId: "e1", stage: "cash_event", summary: "payroll", detail: "d", amountCents: cents(420000) },
  { id: "a2", at: "2026-09-03T00:00:01.000Z", eventId: "e1", stage: "allocation_planned", summary: "alloc", detail: "d", amountCents: cents(420000) },
  { id: "a3", at: "2026-09-03T00:00:02.000Z", eventId: "e2", stage: "executed", summary: "exec", detail: "d", amountCents: cents(199999) },
];

describe("analytics adapter (interface)", () => {
  const engine = new NullEngine() satisfies ExecutionAnalyticsEngine;

  it("a null engine is a valid engine", async () => {
    expect(await engine.ingest([])).toBeUndefined();
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

describe("DuckDBEngine (native addon, Bun)", () => {
  let db: DuckDBEngine;

  beforeAll(async () => {
    db = await DuckDBEngine.open();
  });

  afterAll(() => {
    db.close();
  });

  it("opens an in-memory instance", () => {
    expect(db).toBeInstanceOf(DuckDBEngine);
  });

  it("ingests audit records and reports stats", async () => {
    await db.ingest(events);
    const s = await db.stats();
    expect(s.rowsLoaded).toBe(events.length);
    expect(s.rowsDropped).toBe(0);
  });

  it("formationSeries groups by event", async () => {
    const rows = await db.formationSeries(0);
    const byEvent = new Map(rows.map((r) => [r.eventId, r.events]));
    expect(byEvent.get("e1")).toBe(2);
    expect(byEvent.get("e2")).toBe(1);
  });

  it("driftReport sums integer cents exactly", async () => {
    const rows = await db.driftReport(0);
    const executed = rows.find((r) => r.stage === "executed");
    expect(executed).toBeDefined();
    // 199999 cents is far below 2^53, so the sum is exact; string form confirms
    // no float formatting crept in.
    expect(executed!.totalCents).toBe("199999");
  });

  it("drops a duplicate-primary-key event without throwing", async () => {
    // Re-ingesting the same event id violates `id PRIMARY KEY` and must be
    // caught by the engine's per-record guard, not crash the ingest stream.
    const dup = { ...events[0] };
    await db.ingest([dup]);
    expect((await db.stats()).rowsDropped).toBe(1);
  });

  it("closes cleanly", () => {
    expect(() => db.close()).not.toThrow();
  });
});