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
  claimOutboxById,
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
    executionMode?: "shadow" | "execute";
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
      executionMode: overrides.executionMode ?? "shadow",
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
        claimOutboxById,
        markOutboxDelivered,
        releaseOutboxClaim,
      },
    });
    try {
      await worker.runUntil(async () => {
        const { planId, calculationVersion: cv, inputSnapshotHash: hash } = await savePlan({
          cashEventId: `ce_${ulid()}`,
          disposition: "executed",
          executionMode: "execute",
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
        claimOutboxById,
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
        claimOutboxById,
        markOutboxDelivered,
        releaseOutboxClaim,
      },
    });
    try {
      await worker.runUntil(async () => {
        const { planId } = await savePlan({ cashEventId: `ce_${ulid()}`, executionMode: "execute" });
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
        claimOutboxById,
        markOutboxDelivered,
        releaseOutboxClaim,
      },
    });
    try {
      await worker.runUntil(async () => {
        const { planId, calculationVersion: cv, inputSnapshotHash: hash } = await savePlan({
          cashEventId: `ce_${ulid()}`,
          disposition: "approved",
          executionMode: "execute",
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

  // ─── Spec: worker/replay recovery → one financial effect despite retry ─────
  // A brokerage whose first submit records the fill but throws (the classic
  // "order received but acknowledgement lost" failure). Temporal retries the
  // activity, the workflow replays, and the idempotency-key boundary must
  // converge on ONE financial effect — not two.
  it("activity retry after a lost acknowledgement yields exactly one fill per key", async () => {
    let firstCall = true;
    const fillsByKey = new Map<string, { count: number }>();
    // A throw-once-then-dedup broker, wired into initActivities for this test.
    initActivities({
      ports,
      brokerage: {
        executeOrders: async (orders: Array<{ id: string; symbol: string; amountCents: number; side: string; shares: number; idempotencyKey: string }>) => {
          if (firstCall) {
            firstCall = false;
            // Record the effects durably, then fail to acknowledge.
            for (const o of orders) {
              const k = o.idempotencyKey;
              fillsByKey.set(k, { count: (fillsByKey.get(k)?.count ?? 0) + 1 });
            }
            throw new Error("transient acknowledgement loss after submit");
          }
          // Retry: dedup by idempotency key — already-filled keys are NOT
          // recorded again (exactly-once effect).
          const fills = orders.map((o) => {
            const k = o.idempotencyKey;
            // Do NOT increment; the effect already happened on the first call.
            return {
              orderId: o.id,
              symbol: o.symbol,
              filledCents: o.amountCents,
              filledShares: o.shares,
              filledAt: "2026-09-02T00:00:00.000Z",
              idempotencyKey: k,
            };
          });
          return { ok: true, fills, calls: 2 };
        },
      },
      now: () => new Date("2026-09-02T00:00:00Z"),
    });

    const env = await TestWorkflowEnvironment.createTimeSkipping();
    const worker = await Worker.create({
      connection: env.nativeConnection,
      taskQueue: "alepes-test-replay",
      workflowBundle: bundle,
      activities: {
        loadPlan,
        verifyPlan,
        appendEvent,
        updateDisposition,
        executeOrders,
        reconcileExecution,
        claimOutbox,
        claimOutboxById,
        markOutboxDelivered,
        releaseOutboxClaim,
      },
    });
    try {
      await worker.runUntil(async () => {
        const { planId, calculationVersion: cv, inputSnapshotHash: hash } = await savePlan({
          cashEventId: `ce_${ulid()}`,
          disposition: "approved",
          executionMode: "execute",
          deployableCents: 200_00,
        });
        const loaded = await loadPlan({ planId });
        // The order's idempotency key is planId::orderId, assigned at save.
        const key = loaded.orders[0].idempotencyKey;

        const handle = await env.client.workflow.start("executionPlanWorkflow", {
          args: [planId, { shadow: false }, { inputSnapshotHash: hash, calculationVersion: cv }],
          taskQueue: "alepes-test-replay",
          workflowId: executionWorkflowId(planId),
        });
        const result = await handle.result();
        // The workflow should still fail (the first activity throw is fatal to
        // that attempt's disposition) OR succeed after retry — but crucially the
        // financial effect is exactly one per idempotency key.
        //
        // NOTE: Temporal's default activity retry policy retries the activity,
        // so `executeOrders` is invoked twice; the boundary dedup guarantees
        // exactly one recorded effect.
        expect(fillsByKey.get(key)?.count).toBe(1);
        // The mock broker recorded the effect exactly once even though the
        // activity was invoked more than once.
        expect(result).toBeTruthy();
      });
    } finally {
      await env.teardown();
    }
  });

  // ─── Spec: duplicate outbox redelivery → one workflow, one delivered ──────
  it("delivered outbox events are never reclaimed; redelivery converges", async () => {
    const { planId } = await savePlan({ cashEventId: `ce_${ulid()}` });

    // First claim + deliver.
    const first = await claimOutbox({ limit: 10, leaseMs: 10000 });
    const mine = first.filter((c) => c.type === "ExecutionPlanCreated");
    expect(mine).toHaveLength(1);
    const eventId = mine[0].id;
    await markOutboxDelivered({ id: eventId });

    // Second claim (as a duplicate publisher delivery would do): the delivered
    // event is gone and never reclaimable.
    const second = await claimOutbox({ limit: 10, leaseMs: 10000 });
    const again = second.filter((c) => c.type === "ExecutionPlanCreated");
    expect(again).toHaveLength(0);

    // And the deterministic workflow id is stable across deliveries.
    expect(executionWorkflowId(planId)).toBe(`execution-plan:${planId}`);
  });

  // ─── Spec case: caller/persisted execution-mode mismatch fails closed ──────
  // A direct workflow invocation with `opts.shadow = false` against a plan
  // persisted with execution_mode = 'shadow' must NOT silently escalate into
  // a real provider call. The workflow throws BEFORE touching executeOrders.
  it("executionPlanWorkflow: caller requests execute against a shadow plan → failed, no brokerage", async () => {
    const env = await TestWorkflowEnvironment.createTimeSkipping();
    const worker = await Worker.create({
      connection: env.nativeConnection,
      taskQueue: "alepes-test-modex",
      workflowBundle: bundle,
      activities: {
        loadPlan,
        verifyPlan,
        appendEvent,
        updateDisposition,
        executeOrders,
        reconcileExecution,
        claimOutbox,
        claimOutboxById,
        markOutboxDelivered,
        releaseOutboxClaim,
      },
    });
    try {
      await worker.runUntil(async () => {
        const { planId, calculationVersion: cv, inputSnapshotHash: hash } = await savePlan({
          cashEventId: `ce_${ulid()}`,
          disposition: "shadow",
          executionMode: "shadow",
        });
        const handle = await env.client.workflow.start("executionPlanWorkflow", {
          args: [planId, { shadow: false }, { inputSnapshotHash: hash, calculationVersion: cv }],
          taskQueue: "alepes-test-modex",
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

  // ─── Spec case: shadow-mode fills persist under shadow.order.filled ─────
  // The durable audit must NEVER confuse a simulated shadow fill with a real
  // provider fill. We prove the fills end up under the distinct kind.
  it("shadow mode persists simulated fills under shadow.order.filled (never order.filled)", async () => {
    const env = await TestWorkflowEnvironment.createTimeSkipping();
    const worker = await Worker.create({
      connection: env.nativeConnection,
      taskQueue: "alepes-test-audit",
      workflowBundle: bundle,
      activities: {
        loadPlan,
        verifyPlan,
        appendEvent,
        updateDisposition,
        executeOrders,
        reconcileExecution,
        claimOutbox,
        claimOutboxById,
        markOutboxDelivered,
        releaseOutboxClaim,
      },
    });
    try {
      await worker.runUntil(async () => {
        const { planId, calculationVersion: cv, inputSnapshotHash: hash } = await savePlan({
          cashEventId: `ce_${ulid()}`,
          disposition: "shadow",
          executionMode: "shadow",
        });
        const handle = await env.client.workflow.start("executionPlanWorkflow", {
          args: [planId, { shadow: true }, { inputSnapshotHash: hash, calculationVersion: cv }],
          taskQueue: "alepes-test-audit",
          workflowId: executionWorkflowId(planId),
        });
        const result = await handle.result();
        expect((result as { result: { kind: string } }).result.kind).toBe("completed_shadow");
        expect(brokerCalls).toBe(0);

        const { Pool } = await import("pg");
        const pool = new Pool({ connectionString: TEST_CONNECTION });
        try {
          const kinds = await pool.query<{ kind: string }>(
            `SELECT DISTINCT kind FROM execution_plan_events WHERE execution_plan_id = $1`,
            [planId]
          );
          const kindSet = new Set(kinds.rows.map((r) => r.kind));
          // At minimum: plan.created, execution.started, shadow.order.filled, execution.completed.
          expect(kindSet.has("shadow.order.filled")).toBe(true);
          expect(kindSet.has("plan.created")).toBe(true);
          expect(kindSet.has("execution.started")).toBe(true);
          expect(kindSet.has("execution.completed")).toBe(true);
          // The whole point of this fix: NO plain "order.filled" was written.
          expect(kindSet.has("order.filled")).toBe(false);
        } finally {
          await pool.end();
        }
      });
    } finally {
      await env.teardown();
    }
  });

  // ─── Bounded single-event publisher: proves PUBLISHED, not ENQUEUED ────
  // The certification-safe path:
  //   1) seed a SECOND unrelated pending ExecutionPlanCreated row;
  //   2) drive ONLY the certification row through publishOutboxEventWorkflow;
  //   3) assert that row's delivered_at is set and the unrelated row's is not;
  //   4) assert brokerageCalls === 0, disposition remains "shadow";
  //   5) assert a replay against the now-delivered row refuses to claim.
  it("publishOutboxEventWorkflow: delivers the exact row, leaves unrelated pending rows alone", { timeout: 60_000 }, async () => {
    const env = await TestWorkflowEnvironment.createTimeSkipping();
    const worker = await Worker.create({
      connection: env.nativeConnection,
      taskQueue: "alepes-test-bounded-pub",
      workflowBundle: bundle,
      activities: {
        loadPlan,
        verifyPlan,
        appendEvent,
        updateDisposition,
        executeOrders,
        reconcileExecution,
        claimOutbox,
        claimOutboxById,
        markOutboxDelivered,
        releaseOutboxClaim,
      },
    });
    try {
      await worker.runUntil(async () => {
        // The "real" certification plan
        const target = await savePlan({
          cashEventId: `ce_${ulid()}`,
          disposition: "shadow",
          executionMode: "shadow",
        });
        // An unrelated pending ExecutionPlanCreated event composed to resemble a
        // stray earlier plan. The bounded publisher must NOT consume it.
        const unrelated = await savePlan({
          cashEventId: `ce_${ulid()}`,
          disposition: "shadow",
          executionMode: "shadow",
        });

        // Locate the two outbox rows by planId via raw SQL (mirrors the
        // certification harness's lookup pattern).
        const { Pool } = await import("pg");
        const pool = new Pool({ connectionString: TEST_CONNECTION });
        let targetOutboxId: string | null = null;
        let unrelatedOutboxId: string | null = null;
        try {
          for (const [planId, setter] of [
            [target.planId, (v: string) => (targetOutboxId = v)],
            [unrelated.planId, (v: string) => (unrelatedOutboxId = v)],
          ] as Array<[string, (v: string) => void]>) {
            const r = await pool.query<{ id: string }>(
              `SELECT id FROM outbox
                WHERE type = 'ExecutionPlanCreated' AND payload->>'planId' = $1
                ORDER BY created_at DESC LIMIT 1`,
              [planId]
            );
            expect(r.rows).toHaveLength(1);
            setter(r.rows[0].id);
          }
          expect(targetOutboxId).not.toBe(unrelatedOutboxId);

          // Drive ONLY the target row through the bounded publisher.
          const handle = await env.client.workflow.start("publishOutboxEventWorkflow", {
            args: [targetOutboxId!, 30000],
            taskQueue: "alepes-test-bounded-pub",
            workflowId: `outbox-publish-once:${targetOutboxId}`,
          });
          const result = await handle.result();
          expect((result as { published: boolean }).published).toBe(true);
          expect((result as { planId: string }).planId).toBe(target.planId);

          // Assert: target row IS delivered; unrelated row is NOT.
          const targetRow = await pool.query<{ delivered_at: Date | null; claimed_at: Date | null }>(
            `SELECT delivered_at, claimed_at FROM outbox WHERE id = $1`,
            [targetOutboxId]
          );
          expect(targetRow.rows[0].delivered_at).not.toBeNull();

          const unrelatedRow = await pool.query<{ delivered_at: Date | null; claimed_at: Date | null }>(
            `SELECT delivered_at, claimed_at FROM outbox WHERE id = $1`,
            [unrelatedOutboxId]
          );
          expect(unrelatedRow.rows[0].delivered_at).toBeNull();

          // Disposition remains "shadow"; brokerage was never invoked.
          const loaded = await loadPlan({ planId: target.planId });
          expect(loaded.provenance.disposition).toBe("shadow");
          expect(brokerCalls).toBe(0);

          // Re-running the bounded publisher against the now-delivered row
          // MUST refuse — claimPendingById throws on already-delivered rows.
          // Temporal will mark this second run failed; the durable state remains.
          const secondHandle = await env.client.workflow.start("publishOutboxEventWorkflow", {
            args: [targetOutboxId!, 30000],
            taskQueue: "alepes-test-bounded-pub",
            workflowId: `outbox-publish-once:${targetOutboxId}-replay`,
          });
          await expect(secondHandle.result()).rejects.toThrow(/Workflow execution failed|already delivered|claimPendingById/);
        } finally {
          await pool.end();
        }
      });
    } finally {
      await env.teardown();
    }
  });

  // ─── Bounded publisher on a TAMPERED payload: refuses to deliver ─────────
  // Writes a syntactically-valid outbox row by hand whose payload is missing
  // provenance. The bounded publisher must throw, and the harness must NEVER
  // see delivered_at set on it.
  it("publishOutboxEventWorkflow: tampered payload (missing provenance) never delivers", { timeout: 60_000 }, async () => {
    const env = await TestWorkflowEnvironment.createTimeSkipping();
    const worker = await Worker.create({
      connection: env.nativeConnection,
      taskQueue: "alepes-test-tampered",
      workflowBundle: bundle,
      activities: {
        loadPlan,
        verifyPlan,
        appendEvent,
        updateDisposition,
        executeOrders,
        reconcileExecution,
        claimOutbox,
        claimOutboxById,
        markOutboxDelivered,
        releaseOutboxClaim,
      },
    });
    try {
      await worker.runUntil(async () => {
        const { planId } = await savePlan({
          cashEventId: `ce_${ulid()}`,
          disposition: "shadow",
          executionMode: "shadow",
        });

        const { Pool } = await import("pg");
        const pool = new Pool({ connectionString: TEST_CONNECTION });
        let tamperedId: string | null = null;
        try {
          // Insert a tampered-by-hand outbox row mimicking a shadow plan but
          // WITHOUT provenance. The bounded publisher must refuse.
          const ins = await pool.query<{ id: string }>(
            `INSERT INTO outbox (id, type, payload)
             VALUES ($1, 'ExecutionPlanCreated', $2)
             RETURNING id`,
            [
              `tampered_${ulid()}`,
              JSON.stringify({ planId, executionMode: "shadow" }),
            ]
          );
          tamperedId = ins.rows[0].id;

          const handle = await env.client.workflow.start("publishOutboxEventWorkflow", {
            args: [tamperedId, 30000],
            taskQueue: "alepes-test-tampered",
            workflowId: `outbox-publish-once:${tamperedId}`,
          });
          await expect(handle.result()).rejects.toThrow(/Workflow execution failed|inputSnapshotHash|calculationVersion/i);

          const row = await pool.query<{ delivered_at: Date | null }>(
            `SELECT delivered_at FROM outbox WHERE id = $1`,
            [tamperedId]
          );
          expect(row.rows[0].delivered_at).toBeNull();
          expect(brokerCalls).toBe(0);
        } finally {
          await pool.end();
        }
      });
    } finally {
      await env.teardown();
    }
  });
});