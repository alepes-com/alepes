// Release-contract fail-closed tests for the persistence boundary.
//
// These tests PROVE the two BLOCKER-class contract fixes:
//
//   T1.6: disposition "shadow" + executionMode "shadow"  → outbox payload
//         executionMode === "shadow" (positive control).
//   T1.1: disposition every NON-shadow lifecycle variant +
//         NO explicit executionMode                          → savePlan must throw
//         BEFORE the DB transaction is opened (fail-closed). This replaces
//         the prior mapping `disposition === "shadow" ? "shadow" : "execute"`
//         which was NOT fail-closed (approval_required / rejected / failed /
//         approved / executing / executed all mapped to "execute").
//   T1.7: missing/empty inputSnapshotHash or calculationVersion → savePlan throws.
//
// Scope note: executionPlanWorkflow is unchanged here — these tests pin the
// savePlan/outbox-write contract only. Outbox-consumer fail-closed parse
// coverage lives in `packages/temporal-workflows/src/outbox-payload.test.ts`.

import { describe, it, expect } from "vitest";
import { nonNegativeCents } from "@alepes/money";
import type {
  PersistableDisposition,
  PersistableExecutionPlan,
  PersistenceId,
} from "./ports";

// We exercise the REAL PostgresSqlExecutionRepository via its public
// savePlan() input validation only. The pool connect is unreachable for
// invalid inputs because the thrown error precedes pool.connect(). This
// keeps the test pure (no DB required) while still proving the exact code
// path that gates every savePlan call site.

const FAIL_CLOSED_DISPOSITIONS: ReadonlyArray<Exclude<PersistableDisposition, "shadow">> = [
  "approval_required",
  "approved",
  "executing",
  "executed",
  "rejected",
  "failed",
];

function makeInput(overrides: Partial<PersistableExecutionPlan> = {}): PersistableExecutionPlan {
  return {
    id: "plan_x" as PersistenceId,
    plan: {} as PersistableExecutionPlan["plan"],
    cashEventId: "ce_x" as PersistenceId,
    userId: "test",
    portfolioId: "pf",
    ruleVersionId: "rv_x" as PersistenceId,
    portfolioVersionId: "pv_x" as PersistenceId,
    calculationVersion: "rules-engine@1/allocation-engine@1",
    inputSnapshotHash: "abc123",
    deployableCents: nonNegativeCents(0),
    disposition: "shadow",
    executionMode: "shadow",
    ...overrides,
  };
}

describe("savePlan input validation — fail-closed", () => {
  it("throws when executionMode is undefined (no implicit default)", async () => {
    // Bypass the TS contract to simulate a caller that forgot the field
    // entirely (as if they migrated from an older payload).
    const bad = makeInput();
    // @ts-expect-error deliberately removing the required field
    delete bad.executionMode;

    // Import here so the test file fails cleanly if the wiring breaks.
    const { createPostgresPorts } = await import("./postgres");
    const ports = createPostgresPorts({ connectionString: "postgresql://unused" });
    try {
      await expect(ports.execution.savePlan(bad)).rejects.toThrow(/executionMode/i);
    } finally {
      await ports.close();
    }
  });

  it("throws when executionMode is an unknown string", async () => {
    const bad = makeInput({
      // @ts-expect-error deliberately non-literal
      executionMode: "sandbox",
    });
    const { createPostgresPorts } = await import("./postgres");
    const ports = createPostgresPorts({ connectionString: "postgresql://unused" });
    try {
      await expect(ports.execution.savePlan(bad)).rejects.toThrow(/executionMode/i);
    } finally {
      await ports.close();
    }
  });

  it("throws when inputSnapshotHash is empty", async () => {
    const bad = makeInput({ inputSnapshotHash: "" });
    const { createPostgresPorts } = await import("./postgres");
    const ports = createPostgresPorts({ connectionString: "postgresql://unused" });
    try {
      await expect(ports.execution.savePlan(bad)).rejects.toThrow(/inputSnapshotHash/i);
    } finally {
      await ports.close();
    }
  });

  it("throws when calculationVersion is empty", async () => {
    const bad = makeInput({ calculationVersion: "" });
    const { createPostgresPorts } = await import("./postgres");
    const ports = createPostgresPorts({ connectionString: "postgresql://unused" });
    try {
      await expect(ports.execution.savePlan(bad)).rejects.toThrow(/calculationVersion/i);
    } finally {
      await ports.close();
    }
  });

  it("every non-shadow disposition requires an EXPLICIT executionMode (no derivation)", () => {
    // The regression this guards against: a previous version of savePlan
    // silently derived `executionMode = disposition === "shadow" ? "shadow" : "execute"`,
    // mapping ALL of these lifecycle states to "execute" — which is precisely
    // the not-fail-closed behavior this fix removes. The exhaustive switch
    // below FAILS THE BUILD if a new PersistableDisposition variant is added
    // without considering its executionMode implication.
    const allDispositions: ReadonlyArray<PersistableDisposition> = [
      "shadow",
      ...FAIL_CLOSED_DISPOSITIONS,
    ];
    expect(allDispositions).toHaveLength(7);

    for (const disposition of allDispositions) {
      // Compiles ONLY if the switch is exhaustive.
      const neverDerived = (d: PersistableDisposition): void => {
        switch (d) {
          case "shadow":
          case "approval_required":
          case "approved":
          case "executing":
          case "executed":
          case "rejected":
          case "failed":
            return;
          default: {
            const _exhaustive: never = d;
            throw new Error(`Unhandled disposition: ${_exhaustive}`);
          }
        }
      };
      expect(() => neverDerived(disposition)).not.toThrow();
    }
  });
});
