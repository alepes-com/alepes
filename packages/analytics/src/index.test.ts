// Unit tests for the DuckDB analytics adapter interface.
import { describe, it, expect } from "vitest";
import { NullEngine, type ExecutionAnalyticsEngine } from "./engine";
import type { AuditRecord } from "@alepes/domain";

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
    expect(s1.lastIngestAt).toEqual(s2.lastIngestAt); // Immutability guarantee
  });
});
