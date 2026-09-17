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
      inputSnapshotHash: "deadbeef",
      calculationVersion: "calc@1",
    });
    expect(p.executionMode).toBe("execute");
    expect(p.inputSnapshotHash).toBe("deadbeef");
    expect(p.calculationVersion).toBe("calc@1");
  });

  // REQUIRED provenance: outbox-driven execution MUST carry independent
  // planId + executionMode + inputSnapshotHash + calculationVersion. There is
  // no publisher-side fallback to self-verification.
  it("REJECTS a shadow payload missing inputSnapshotHash", () => {
    expect(() =>
      parseExecutionPlanCreatedPayload({
        planId: "plan_p1",
        executionMode: "shadow",
        calculationVersion: "calc@1",
      } as unknown as Record<string, unknown>)
    ).toThrow(/inputSnapshotHash/i);
  });

  it("REJECTS a shadow payload missing calculationVersion", () => {
    expect(() =>
      parseExecutionPlanCreatedPayload({
        planId: "plan_p2",
        executionMode: "shadow",
        inputSnapshotHash: "abc",
      } as unknown as Record<string, unknown>)
    ).toThrow(/calculationVersion/i);
  });

  it("REJECTS an execute payload missing provenance (fail-closed, never self-verify)", () => {
    expect(() =>
      parseExecutionPlanCreatedPayload({
        planId: "plan_p3",
        executionMode: "execute",
      } as unknown as Record<string, unknown>)
    ).toThrow(/inputSnapshotHash|calculationVersion/i);
  });

  it("REJECTS when inputSnapshotHash is an empty string", () => {
    expect(() =>
      parseExecutionPlanCreatedPayload({
        planId: "plan_p4",
        executionMode: "shadow",
        inputSnapshotHash: "",
        calculationVersion: "calc@1",
      })
    ).toThrow(/inputSnapshotHash/i);
  });

  it("REJECTS when calculationVersion is an empty string", () => {
    expect(() =>
      parseExecutionPlanCreatedPayload({
        planId: "plan_p5",
        executionMode: "shadow",
        inputSnapshotHash: "abc",
        calculationVersion: "",
      })
    ).toThrow(/calculationVersion/i);
  });

  it("REJECTS when provenance is non-string (number/null/object/coerced-to-undefined laundering)", () => {
    for (const v of [null, 0, 42, {}, [], false]) {
      expect(() =>
        parseExecutionPlanCreatedPayload({
          planId: "plan_p6",
          executionMode: "shadow",
          inputSnapshotHash: v as unknown as string,
          calculationVersion: "calc@1",
        })
      ).toThrow(/inputSnapshotHash/i);
      expect(() =>
        parseExecutionPlanCreatedPayload({
          planId: "plan_p6",
          executionMode: "shadow",
          inputSnapshotHash: "abc",
          calculationVersion: v as unknown as string,
        })
      ).toThrow(/calculationVersion/i);
    }
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
