// Regression guards for the fail-closed baseline checkpoint path.
// These are UNIT TESTS — no real DB required. They must always run under `bun run test`.

import { describe, it, expect } from "vitest";
import { createSyncPostgresStore, persistBaselineCheckpoint, cursorFingerprint } from "./index";

describe("baseline guards — fail-closed persistence (unit, no DB)", () => {
  it("createSyncPostgresStore rejects empty connectionString", () => {
    expect(() => createSyncPostgresStore({ connectionString: "" })).toThrow(/non-empty/);
  });

  it("createSyncPostgresStore rejects whitespace-only connectionString", () => {
    expect(() => createSyncPostgresStore({ connectionString: "   " })).toThrow(/non-empty/);
  });

  it("persistBaselineCheckpoint rejects empty connectionString before any DB contact", async () => {
    await expect(
      persistBaselineCheckpoint("", {
        accountBindingId: "b1" as any,
        cursor: "test-cursor",
        status: "reconciled",
      })
    ).rejects.toThrow(/non-empty/);
  });

  it("persistBaselineCheckpoint rejects whitespace-only connectionString", async () => {
    await expect(
      persistBaselineCheckpoint("   ", {
        accountBindingId: "b1" as any,
        cursor: "test-cursor",
        status: "reconciled",
      })
    ).rejects.toThrow(/non-empty/);
  });

  it("persistBaselineCheckpoint rejects on write failure (nonexistent DB) and never returns persisted:true", async () => {
    // Use a connection string that will fail to connect / write
    await expect(
      persistBaselineCheckpoint("postgresql://user@localhost:1/nonexistent", {
        accountBindingId: "b1" as any,
        cursor: "test-cursor",
        status: "reconciled",
      })
    ).rejects.toThrow(); // rejects, does not resolve with { persisted: true }
  });

  it("cursorFingerprint is deterministic and length-stable", () => {
    const c = "cursor-12345";
    const fp1 = cursorFingerprint(c);
    const fp2 = cursorFingerprint(c);
    expect(fp1).toBe(fp2);
    // Format: fp-<16 hex chars>-len<length>
    expect(fp1).toMatch(/^fp-[0-9a-f]{16}-len\d+$/);
    // Length encoded matches actual cursor length
    const lenMatch = fp1.match(/len(\d+)$/);
    expect(lenMatch).toBeTruthy();
    expect(Number(lenMatch![1])).toBe(c.length);
  });
});