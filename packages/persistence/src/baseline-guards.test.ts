// Regression guards for the fail-closed sync store construction.
// Baseline-checkpoint manual persistence has been REMOVED — a reconciled
// cursor must be produced by reconcileSyncCycle (which also writes the
// accompanying observation/event rows). No caller should be able to mint a
// "reconciled" checkpoint without a corresponding reconciliation transaction.
// These are UNIT TESTS — no real DB required. They must always run under `bun run test`.

import { describe, it, expect } from "vitest";
import { createSyncPostgresStore, cursorFingerprint } from "./index";

describe("sync store construction + cursor fingerprint — fail-closed guards (unit, no DB)", () => {
  it("createSyncPostgresStore rejects empty connectionString", () => {
    expect(() => createSyncPostgresStore({ connectionString: "" })).toThrow(/non-empty/);
  });

  it("createSyncPostgresStore rejects whitespace-only connectionString", () => {
    expect(() => createSyncPostgresStore({ connectionString: "   " })).toThrow(/non-empty/);
  });

  it("cursorFingerprint is deterministic and length-stable", () => {
    const c = "cursor-12345";
    const fp1 = cursorFingerprint(c);
    const fp2 = cursorFingerprint(c);
    expect(fp1).toBe(fp2);
    // Format: fp-<16 hex chars>-len<length>
    expect(fp1).toMatch(/^fp-[0-9a-f]{16}-len\d+$/);
    const lenMatch = fp1.match(/len(\d+)$/);
    expect(lenMatch).toBeTruthy();
    expect(Number(lenMatch![1])).toBe(c.length);
  });
});
