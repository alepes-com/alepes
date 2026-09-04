import { proxyActivities, sleep } from "@temporalio/workflow";
import type {
  AppendEventInput,
  ExecutionOptions,
  ExecutionResult,
  ExecuteOrdersInput,
  ExecuteOrdersOutput,
  ExpectedProvenance,
  LoadPlanOutput,
  OutboxClaimMsg,
  ReconcileInput,
  ReconcileOutput,
  UpdateDispositionInput,
  VerifyPlanInput,
  VerifyPlanOutput,
} from "./types";

/**
 * Deterministic dynamic ID for an ExecutionPlan workflow.
 */
export function executionWorkflowId(planId: string): string {
  return `execution-plan:${planId}`;
}

// Strongly typed activity stubs. Concrete implementations live in
// `activities.ts` and are provided by the worker process.
const {
  loadPlan,
  verifyPlan,
  appendEvent,
  updateDisposition,
  executeOrders,
  reconcileExecution,
  claimOutbox,
  markOutboxDelivered,
  releaseOutboxClaim,
} = proxyActivities<{
  loadPlan(input: { planId: string }): Promise<LoadPlanOutput>;
  verifyPlan(input: VerifyPlanInput): Promise<VerifyPlanOutput>;
  appendEvent(input: AppendEventInput): Promise<void>;
  updateDisposition(input: UpdateDispositionInput): Promise<void>;
  executeOrders(input: ExecuteOrdersInput): Promise<ExecuteOrdersOutput>;
  reconcileExecution(input: ReconcileInput): Promise<ReconcileOutput>;
  claimOutbox(input: { limit: number; leaseMs: number }): Promise<OutboxClaimMsg[]>;
  markOutboxDelivered(input: { id: string }): Promise<void>;
  releaseOutboxClaim(input: { id: string }): Promise<void>;
}>({
  startToCloseTimeout: "30s",
});

/**
 * ExecutionPlanWorkflow: orchestrates a single persisted ExecutionPlan.
 *
 * Code in here MUST be deterministic:
 *   - no Date.now(), no Math.random(), no I/O. Use workflowInfo() and activities.
 */
export async function executionPlanWorkflow(
  planId: string,
  opts: ExecutionOptions,
  expected?: ExpectedProvenance,
  outboxEventId?: string
): Promise<ExecutionResult> {
  const workflowId = executionWorkflowId(planId);
  const idempotencyKey = `plan:${planId}`;

  // 1) Load plan
  const loaded = await loadPlan({ planId });
  const prov = loaded.provenance;

  if (!prov) {
    return { planId, result: { kind: "not-found" }, filledCents: 0, brokerageCalls: 0, idempotencyKey };
  }

  if (prov.disposition === "executed") {
    return { planId, result: { kind: "skipped-already-executed" }, filledCents: 0, brokerageCalls: 0, idempotencyKey };
  }

  if (prov.disposition === "failed") {
    return { planId, result: { kind: "skipped-already-failed" }, filledCents: 0, brokerageCalls: 0, idempotencyKey };
  }

  // 2) Verify provenance against the *independent* expected identity carried on
  // the outbox event (not against the row we just loaded). If the publisher
  // provided no expected provenance, fall back to the loaded row's own values
  // only to preserve behaviour for direct (non-outbox) invocations.
  const expectedCalc = expected?.calculationVersion ?? prov.calculationVersion;
  const expectedHash = expected?.inputSnapshotHash ?? prov.inputSnapshotHash;
  const verification = await verifyPlan({
    planId,
    expectedCalculationVersion: expectedCalc,
    expectedInputSnapshotHash: expectedHash,
  });

  if (!verification.valid) {
    await updateDisposition({ planId, disposition: "failed" });
    await appendEvent({
      planId,
      eventId: `${workflowId}:verification-failed`,
      stage: "execution.failed",
      summary: `Provenance verification failed: ${verification.mismatch ?? "unknown"}`,
      detail: "The persisted plan's calculation version or snapshot hash did not match the expected values.",
      amountCents: prov.deployableCents,
    });
    return { planId, result: { kind: "failed", reason: verification.mismatch ?? "provenance mismatch" }, filledCents: 0, brokerageCalls: 0, idempotencyKey };
  }

  await appendEvent({
    planId,
    eventId: `${workflowId}:started`,
    stage: "execution.started",
    summary: `Execution plan ${planId} started`,
    detail: `${opts.shadow ? "Shadow Mode:" : ""} Executing ${loaded.orders.length} orders.`,
    amountCents: prov.deployableCents,
  });

  // 3) Execute orders or simulate them
  let brokerageCalls = 0;
  let filledCents = 0;

  if (!opts.shadow) {
    // Shadow mode NEVER enters this branch.
    await updateDisposition({ planId, disposition: "executing" });
    const exec = await executeOrders({
      planId,
      orders: loaded.orders,
    });

    brokerageCalls = exec.brokerageCalls;
    if (!exec.ok) {
      await updateDisposition({ planId, disposition: "failed" });
      await appendEvent({
        planId,
        eventId: `${workflowId}:execution-failed`,
        stage: "execution.failed",
        summary: "Order execution failed",
        detail: exec.error ?? "unknown brokerage error",
        amountCents: prov.deployableCents,
      });
      return { planId, result: { kind: "failed", reason: exec.error ?? "brokerage error" }, filledCents: 0, brokerageCalls, idempotencyKey };
    }

    filledCents = exec.totalFilledCents;

    for (const fill of exec.fills) {
      await appendEvent({
        planId,
        eventId: `${workflowId}:filled:${fill.orderId}`,
        stage: "order.filled",
        summary: `Order ${fill.orderId} filled`,
        detail: `symbol=${fill.symbol} cents=${fill.filledCents}`,
        amountCents: fill.filledCents,
      });
    }

    const rec = await reconcileExecution({
      planId,
      expectedCents: prov.deployableCents,
      fills: exec.fills,
    });

    if (!rec.ok) {
      await updateDisposition({ planId, disposition: "failed" });
      await appendEvent({
        planId,
        eventId: `${workflowId}:reconciliation-failed`,
        stage: "execution.failed",
        summary: "Reconciliation failed after execution",
        detail: `Expected ${prov.deployableCents} cents, actually filled ${rec.actualCents} cents.`,
        amountCents: rec.actualCents,
      });
      return { planId, result: { kind: "failed", reason: "reconciliation mismatch" }, filledCents, brokerageCalls, idempotencyKey };
    }
  } else {
    // Shadow mode: simulate fills deterministically without any brokerage call.
    for (const order of loaded.orders) {
      filledCents += order.amountCents;
      await appendEvent({
        planId,
        eventId: `${workflowId}:shadow-fill:${order.id}`,
        stage: "order.filled",
        summary: `Shadow fill order ${order.id}`,
        detail: `symbol=${order.symbol} cents=${order.amountCents}`,
        amountCents: order.amountCents,
      });
    }
  }

  // 4) Mark executed
  await updateDisposition({ planId, disposition: "executed" });
  await appendEvent({
    planId,
    eventId: `${workflowId}:completed`,
    stage: "execution.completed",
    summary: `Execution ${opts.shadow ? "(shadow)" : ""} completed`,
    detail: `filledCents=${filledCents} workflow=${workflowId}`,
    amountCents: filledCents,
  });

  // 5) Mark outbox event as delivered if one drove this workflow
  if (outboxEventId) {
    await markOutboxDelivered({ id: outboxEventId });
  }

  return {
    planId,
    result: opts.shadow ? { kind: "completed_shadow", simulatedCents: filledCents } : { kind: "completed", filledCents },
    filledCents,
    brokerageCalls,
    idempotencyKey,
  };
}

/**
 * OutboxPublisherWorkflow: claims pending outbox events, starts the correct
 * ExecutionPlanWorkflow for each, then marks them delivered.
 *
 * This workflow is a singleton per publisher identity. It retries automatically
 * during outages. Lease expiry for abandoned claims is enforced by the DB query
 * in `claimPending`.
 */
export async function outboxPublisherWorkflow(
  publisherName: string,
  pollIntervalMs = 5000,
  leaseMs = 30000
): Promise<void> {
  for (;;) {
    // Claim up to 10 pending events under a short lease
    const claims = await claimOutbox({ limit: 10, leaseMs });

    for (const claim of claims) {
      if (claim.type === "ExecutionPlanCreated") {
        const payload = claim.payload as {
          planId?: unknown;
          shadow?: unknown;
          inputSnapshotHash?: unknown;
          calculationVersion?: unknown;
        };
        const planId = String(payload.planId);
        const shadow = Boolean(payload.shadow);
        // Forward independent expected provenance only when both fields are
        // present; otherwise the workflow falls back to self-verification.
        const expected: ExpectedProvenance | undefined =
          typeof payload.inputSnapshotHash === "string" &&
          typeof payload.calculationVersion === "string"
            ? {
                inputSnapshotHash: payload.inputSnapshotHash,
                calculationVersion: payload.calculationVersion,
              }
            : undefined;
        await executionPlanWorkflow(planId, { shadow }, expected, claim.id);
      } else {
        // Unknown event type: release so it doesn't block the queue
        await releaseOutboxClaim({ id: claim.id });
      }
    }

    await sleep(pollIntervalMs);
  }
}
