// SECURITY regression tests for the ExecutionPlanCreated outbox payload contract.
//
// These are PURE function tests: no Temporal, no queue, no database, no Plaid,
// no brokerage calls. They pin the fail-closed semantics documented in
// `packages/temporal-workflows/src/types.ts:ExecutionPlanCreatedPayload`.
//
// Background (the v0.5 harness blocker): before the contract below, the outbox
// publisher used `Boolean(payload.shadow)`, so a plan saved WITHOUT an explicit
// mode (missing/shadow=false) defaulted to `shadow=false` and could call
// executeOrders. These tests pin that the path now throws instead.

import { describe, it, expect } from "vitest";
import { parseExecutionPlanCreatedPayload } from "./types";

describe("parseExecutionPlanCreatedPayload — fail-closed contract", () => {
  it("accepts an explicit shadow payload", () => {
    const p = parseExecutionPlanCreatedPayload({
      planId: "plan_01",
      executionMode: "shadow",
      inputSnapshotHash: "hex",
      calculationVersion: "calc@1",
    });
    expect(p.planId).toBe("plan_01");
    expect(p.executionMode).toBe("shadow");
    expect(p.inputSnapshotHash).toBe("hex");
  });

  it("accepts an explicit execute payload", () => {
    const p = parseExecutionPlanCreatedPayload({
      planId: "plan_02",
      executionMode: "execute",
    });
    expect(p.executionMode).toBe("execute");
  });

  it("REJECTS when executionMode is missing (v0.5 hazard: cannot default to shadow=false)", () => {
    expect(() => parseExecutionPlanCreatedPayload({ planId: "plan_x" })).toThrow(/executionMode/);
  });

  it("REJECTS when executionMode is null", () => {
    expect(() => parseExecutionPlanCreatedPayload({ planId: "plan_x", executionMode: null })).toThrow(/executionMode/);
  });

  it("REJECTS when executionMode is boolean true (legacy shape — never implicit)", () => {
    expect(() => parseExecutionPlanCreatedPayload({ planId: "plan_x", executionMode: true })).toThrow(/executionMode/);
  });

  it("REJECTS when executionMode is boolean false", () => {
    expect(() => parseExecutionPlanCreatedPayload({ planId: "plan_x", executionMode: false })).toThrow(/executionMode/);
  });

  it("REJECTS when executionMode is an unknown string", () => {
    expect(() => parseExecutionPlanCreatedPayload({ planId: "plan_x", executionMode: "sandbox" })).toThrow(/executionMode/);
  });

  it("REJECTS when planId is missing", () => {
    expect(() => parseExecutionPlanCreatedPayload({ executionMode: "shadow" })).toThrow(/planId/);
  });

  it("REJECTS when payload is not an object", () => {
    expect(() => parseExecutionPlanCreatedPayload(null)).toThrow();
    expect(() => parseExecutionPlanCreatedPayload(undefined)).toThrow();
    expect(() => parseExecutionPlanCreatedPayload("shadow")).toThrow();
  });

  it("REJECTS when planId is empty", () => {
    expect(() => parseExecutionPlanCreatedPayload({ planId: "", executionMode: "shadow" })).toThrow(/planId/);
  });
});
