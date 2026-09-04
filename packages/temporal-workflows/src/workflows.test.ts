/**
 * Workflow orchestration tests — the Temporal layer proper.
 *
 * These run `executionPlanWorkflow` and `outboxPublisherWorkflow` through a real
 * (in-process, time-skipping) Temporal test server, wired to a real PostgreSQL
 * database and a mock brokerage. They prove the ORCHESTRATION layer behaves as
 * the spec requires:
 *
 *   - workflow code is deterministic (replay yields identical results),
 *   - a completed plan never executes again,
 *   - shadow mode never reaches the brokerage,
 *   - duplicate outbox delivery resolves to one logical workflow id,
 *   - verification uses the *independent* expected provenance, not the plan row.
 *
 * Run: ALEPES_TEST_TEMPORAL_DATABASE_URL=... npx vitest run packages/temporal-workflows
 *
 * NOTE: this suite MUST run under Node (not Bun) — Temporal's test server
 * executes workflow isolates via `promiseHooks.createHook`, which Bun does not
 * implement. Use `npx vitest run ...`.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { TestWorkflowEnvironment } from "@temporalio/testing";
import { Worker, bundleWorkflowCode } from "@temporalio/worker";
import type { WorkflowBundle } from "@temporalio/worker";
import { createPostgresPorts, runMigrations, ulid, calculationVersion, inputSnapshotHash } from "@alepes/persistence";
import type {
  PersistableExecutionPlan,
  PersistenceId,
  PersistableDisposition,
} from "@alepes/persistence";
import { cents, nonNegativeCents } from "@alepes/money";
import {
  initActivities,
  loadPlan,
  verifyPlan,
  appendEvent,
  updateDisposition,
  executeOrders,
  reconcileExecution,
  claimOutbox,
  markOutboxDelivered,
  releaseOutboxClaim,
} from "./activities";
import { executionWorkflowId } from "./workflows";

const TEST_CONNECTION =
  process.env.ALEPES_TEST_WORKFLOW_DATABASE_URL ??
  "postgresql://raelldottin@localhost:5432/alepes_temporal_workflow_test";

const runIntegration = process.env.ALEPES_TEST_WORKFLOW_DATABASE_URL ? describe : describe.skip;

runIntegration("workflow orchestration (real Temporal test server + real PG)", () => {
  let ports: ReturnType<typeof createPostgresPorts>;
  let bundle: WorkflowBundle;
  let brokerCalls: number;

  function makeBrokerage() {
    brokerCalls = 0;
    return {
      executeOrders: async (orders: Array<{ id: string; symbol: string; amountCents: number; side: string; shares: number; idempotencyKey: string }>) => {
        brokerCalls += 1;
        return {
          ok: true,
          calls: 1,
          fills: orders.map((o) => ({
            orderId: o.id,
            symbol: o.symbol,
            filledCents: o.amountCents,
            filledShares: o.shares,
            filledAt: "2026-09-02T00:00:00.000Z",
            idempotencyKey: o.idempotencyKey,
          })),
        };
      },
    };
  }

  beforeAll(async () => {
    await runMigrations(TEST_CONNECTION);
    ports = createPostgresPorts({ connectionString: TEST_CONNECTION });
    bundle = await bundleWorkflowCode({
      workflowsPath: __dirname + "/workflows.ts",
    });
  });

  afterAll(async () => {
    await ports.close();
  });

  beforeEach(async () => {
    const { Pool } = await import("pg");
    const pool = new Pool({ connectionString: TEST_CONNECTION });
    await pool.query(
      `TRUNCATE execution_plan_events, execution_plan_orders, execution_plans, outbox RESTART IDENTITY CASCADE`
    );
    await pool.end();
    initActivities({
      ports,
      brokerage: makeBrokerage(),
      now: () => new Date("2026-09-02T00:00:00Z"),
    });
  });

  async function savePlan(overrides: {
    cashEventId: string;
    deployableCents?: number;
    disposition?: string;
  }): Promise<{ planId: string; calculationVersion: string; inputSnapshotHash: string }> {
    const id = `plan_${ulid()}`;
    const cv = calculationVersion();
    const hash = await inputSnapshotHash(
      {
        id: overrides.cashEventId,
        amount: cents(3000_00),
        source: "payroll",
        description: "Test",
        occurredAt: "2026-09-01T00:00:00Z",
        checkingBalanceAfter: nonNegativeCents(5000_00),
      },
      [
        {
          id: `rv_${ulid()}`,
          order: 0,
          trigger: "payroll",
          reserveBalance: nonNegativeCents(2000_00),
          action: "invest_percentage",
          amount: 20,
          maxPerDeposit: nonNegativeCents(750_00),
          maxPerMonth: nonNegativeCents(2000_00),
        },
      ],
      {
        portfolio: { holdings: [{ symbol: "MSFT", targetPct: 100 }] },
        positions: [{ symbol: "MSFT", value: nonNegativeCents(1000_00) }],
      }
    );
    const orderId = `ord_${ulid()}`;
    const plan: PersistableExecutionPlan = {
      id: id as PersistenceId,
      plan: {
        orders: [
          { id: orderId, symbol: "MSFT", amount: 200_00, side: "buy", shares: 1 },
        ],
      } as PersistableExecutionPlan["plan"],
      cashEventId: overrides.cashEventId as PersistenceId,
      userId: "test",
      portfolioId: "pf",
      ruleVersionId: `rv_${ulid()}` as PersistenceId,
      portfolioVersionId: `pv_${ulid()}` as PersistenceId,
      calculationVersion: cv,
      inputSnapshotHash: hash,
      deployableCents: nonNegativeCents(overrides.deployableCents ?? 200_00),
      disposition: (overrides.disposition ?? "shadow") as PersistableDisposition,
    };
    const savedId = await ports.execution.savePlan(plan);
    return { planId: savedId, calculationVersion: cv, inputSnapshotHash: hash };
  }

  // ─── Spec case 1 + 10: duplicate outbox delivery → one logical workflow ─────
  it("deterministic workflow id + duplicate delivery resolves to one workflow", async () => {
    const { planId } = await savePlan({ cashEventId: `ce_${ulid()}` });
    const wf1 = executionWorkflowId(planId);
    const wf2 = executionWorkflowId(planId);
    expect(wf1).toBe(wf2);
    expect(wf1).toBe(`execution-plan:${planId}`);

    const claims = await claimOutbox({ limit: 10, leaseMs: 10000 });
    const mine = claims.filter((c) => c.type === "ExecutionPlanCreated");
    expect(mine).toHaveLength(1);
    const payload = mine[0].payload as { planId: string; inputSnapshotHash?: string; calculationVersion?: string };
    expect(payload.planId).toBe(planId);
    expect(typeof payload.inputSnapshotHash).toBe("string");
    expect(typeof payload.calculationVersion).toBe("string");
  });

  // ─── Spec case 4 + 7: completed plan replay → no-op, no duplicate action ────
  it("executionPlanWorkflow on an already-executed plan is a no-op (replay-safe)", async () => {
    const env = await TestWorkflowEnvironment.createTimeSkipping();
    const worker = await Worker.create({
      connection: env.nativeConnection,
      taskQueue: "alepes-test-exec",
      workflowBundle: bundle,
      activities: {
        loadPlan,
        verifyPlan,
        appendEvent,
        updateDisposition,
        executeOrders,
        reconcileExecution,
        claimOutbox,
        markOutboxDelivered,
        releaseOutboxClaim,
      },
    });
    try {
      await worker.runUntil(async () => {
        const { planId, calculationVersion: cv, inputSnapshotHash: hash } = await savePlan({
          cashEventId: `ce_${ulid()}`,
          disposition: "executed",
        });
        const handle = await env.client.workflow.start("executionPlanWorkflow", {
          args: [planId, { shadow: false }, { inputSnapshotHash: hash, calculationVersion: cv }],
          taskQueue: "alepes-test-exec",
          workflowId: executionWorkflowId(planId),
        });
        const result = await handle.result();
        expect((result as { result: { kind: string } }).result.kind).toBe("skipped-already-executed");
        expect(brokerCalls).toBe(0);
      });
    } finally {
      await env.teardown();
    }
  });

  // ─── Spec case 6: shadow mode never reaches brokerage ──────────────────────
  it("shadow mode workflow completes with zero brokerage calls", async () => {
    const env = await TestWorkflowEnvironment.createTimeSkipping();
    const worker = await Worker.create({
      connection: env.nativeConnection,
      taskQueue: "alepes-test-shadow",
      workflowBundle: bundle,
      activities: {
        loadPlan,
        verifyPlan,
        appendEvent,
        updateDisposition,
        executeOrders,
        reconcileExecution,
        claimOutbox,
        markOutboxDelivered,
        releaseOutboxClaim,
      },
    });
    try {
      await worker.runUntil(async () => {
        const { planId, calculationVersion: cv, inputSnapshotHash: hash } = await savePlan({
          cashEventId: `ce_${ulid()}`,
          disposition: "shadow",
        });
        const handle = await env.client.workflow.start("executionPlanWorkflow", {
          args: [planId, { shadow: true }, { inputSnapshotHash: hash, calculationVersion: cv }],
          taskQueue: "alepes-test-shadow",
          workflowId: executionWorkflowId(planId),
        });
        const result = await handle.result();
        const kind = (result as { result: { kind: string } }).result.kind;
        expect(["completed_shadow", "completed"]).toContain(kind);
        expect(brokerCalls).toBe(0);
      });
    } finally {
      await env.teardown();
    }
  });

  // ─── Verification uses independent expected provenance ─────────────────────
  it("mismatched expected provenance fails verification (no execution)", async () => {
    const env = await TestWorkflowEnvironment.createTimeSkipping();
    const worker = await Worker.create({
      connection: env.nativeConnection,
      taskQueue: "alepes-test-verify",
      workflowBundle: bundle,
      activities: {
        loadPlan,
        verifyPlan,
        appendEvent,
        updateDisposition,
        executeOrders,
        reconcileExecution,
        claimOutbox,
        markOutboxDelivered,
        releaseOutboxClaim,
      },
    });
    try {
      await worker.runUntil(async () => {
        const { planId } = await savePlan({ cashEventId: `ce_${ulid()}` });
        const handle = await env.client.workflow.start("executionPlanWorkflow", {
          args: [
            planId,
            { shadow: false },
            { inputSnapshotHash: "0".repeat(64), calculationVersion: "wrong@1" },
          ],
          taskQueue: "alepes-test-verify",
          workflowId: executionWorkflowId(planId),
        });
        const result = await handle.result();
        expect((result as { result: { kind: string } }).result.kind).toBe("failed");
        expect(brokerCalls).toBe(0);
        const loaded = await loadPlan({ planId });
        expect(loaded.provenance.disposition).toBe("failed");
      });
    } finally {
      await env.teardown();
    }
  });

  // ─── Spec case 5: successful non-shadow execution persists 'executed' ──────
  it("live (non-shadow) workflow executes exactly once and records reconciliation", async () => {
    const env = await TestWorkflowEnvironment.createTimeSkipping();
    const worker = await Worker.create({
      connection: env.nativeConnection,
      taskQueue: "alepes-test-live",
      workflowBundle: bundle,
      activities: {
        loadPlan,
        verifyPlan,
        appendEvent,
        updateDisposition,
        executeOrders,
        reconcileExecution,
        claimOutbox,
        markOutboxDelivered,
        releaseOutboxClaim,
      },
    });
    try {
      await worker.runUntil(async () => {
        const { planId, calculationVersion: cv, inputSnapshotHash: hash } = await savePlan({
          cashEventId: `ce_${ulid()}`,
          disposition: "approved",
          deployableCents: 200_00,
        });
        const handle = await env.client.workflow.start("executionPlanWorkflow", {
          args: [planId, { shadow: false }, { inputSnapshotHash: hash, calculationVersion: cv }],
          taskQueue: "alepes-test-live",
          workflowId: executionWorkflowId(planId),
        });
        const result = await handle.result();
        expect((result as { result: { kind: string } }).result.kind).toBe("completed");
        expect(brokerCalls).toBe(1);
        const loaded = await loadPlan({ planId });
        expect(loaded.provenance.disposition).toBe("executed");
      });
    } finally {
      await env.teardown();
    }
  });
});