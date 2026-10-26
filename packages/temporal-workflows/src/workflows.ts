import { proxyActivities, sleep, ApplicationFailure } from "@temporalio/workflow";
import { parseExecutionPlanCreatedPayload } from "./types";
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

/**
 * Deterministic id for the bounded single-event publisher workflow. The
 * publisher is keyed by the outbox event id so a certification harness can
 * drive EXACTLY one row through the outbox -> workflow -> delivered path
 * without ever claiming (or even observing) unrelated pending rows.
 */
export function publishOutboxEventWorkflowId(outboxEventId: string): string {
  return `outbox-publish-once:${outboxEventId}`;
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
  claimOutboxById,
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
  claimOutboxById(input: { id: string; leaseMs: number }): Promise<OutboxClaimMsg>;
  markOutboxDelivered(input: { id: string }): Promise<void>;
  releaseOutboxClaim(input: { id: string }): Promise<void>;
}>({
  startToCloseTimeout: "30s",
});

/**
 * Refusal policy for the bounded certification publisher. The only failures
 * from claimOutboxById are CONTRACT failures: row missing, already delivered,
 * held by a healthy lease, or type mismatch. None are retryable — retrying
 * the SAME invalid invocation will never succeed and only produces a noisy,
 * multi-attempt Temporal history. This is also how we distinguish a benign
 * "already delivered" claim (the test replays the bounded publisher) from a
 * real, recoverable transient.
 */
const claimOutboxByIdNonRetryable = proxyActivities<{
  claimOutboxById(input: { id: string; leaseMs: number }): Promise<OutboxClaimMsg>;
}>({
  startToCloseTimeout: "30s",
  retry: { maximumAttempts: 1 },
}).claimOutboxById;

/**
 * ExecutionPlanWorkflow: orchestrates a single persisted ExecutionPlan.
 *
 * Code in here MUST be deterministic:
 *   - no Date.now(), no Math.random(), no I/O. Use workflowInfo() and activities.
 */
export async function executionPlanWorkflow(
  planId: string,
  opts: ExecutionOptions,
  expected: ExpectedProvenance,
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

  // 1b) Cross-check the caller's execution intent against the persisted,
  // authoritative execution_mode on the plan row. A direct invocation
  // (`opts.shadow = false` against a `shadow`-persisted plan) would otherwise
  // let an out-of-band caller escalate a simulation-only plan into a real
  // provider call. This is fail-closed: any mismatch throws BEFORE any
  // provider mutation, marking nothing and refusing to start.
  const requestedMode: "shadow" | "execute" = opts.shadow ? "shadow" : "execute";
  if (loaded.executionMode !== requestedMode) {
    await appendEvent({
      planId,
      eventId: `${workflowId}:mode-mismatch`,
      stage: "execution.failed",
      summary: `Refusing to run: caller requested ${requestedMode} but plan was persisted as execution_mode=${loaded.executionMode}`,
      detail: "executionPlanWorkflow refuses to continue when caller intent does not match the persisted execution_mode. Direct invocation can never override the persisted contract.",
      amountCents: prov.deployableCents,
    });
    await updateDisposition({ planId, disposition: "failed" });
    return {
      planId,
      result: { kind: "failed", reason: `execution mode mismatch: caller=${requestedMode} persisted=${loaded.executionMode}` },
      filledCents: 0,
      brokerageCalls: 0,
      idempotencyKey,
    };
  }

  // 2) Verify provenance against the INDEPENDENT expected identity carried by
  // the caller (outbox publisher or direct workflow invocation, both of which
  // are REQUIRED to pass it). No fallback to the freshly-loaded row's own
  // values: that would be self-verification and is precisely what the
  // provenance contract exists to prevent. The `expected` parameter is a
  // REQUIRED argument — TypeScript enforces this at the call site.
  const verification = await verifyPlan({
    planId,
    expectedCalculationVersion: expected.calculationVersion,
    expectedInputSnapshotHash: expected.inputSnapshotHash,
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
    // Durable audit MUST be unambiguous: simulation fills are persisted as
    // `shadow.order.filled`, NEVER `order.filled` (which is reserved for real
    // provider fills on the non-shadow branch above).
    for (const order of loaded.orders) {
      filledCents += order.amountCents;
      await appendEvent({
        planId,
        eventId: `${workflowId}:shadow-fill:${order.id}`,
        stage: "shadow.order.filled",
        summary: `Shadow fill order ${order.id}`,
        detail: `simulated; symbol=${order.symbol} cents=${order.amountCents}`,
        amountCents: order.amountCents,
      });
    }
  }

  // 4) Mark terminal disposition correctly for the mode.
  // Shadow: plan is completed simulatively — disposition stays "shadow" forever;
  //    "executed" is reserved for plans that actually submitted orders to a
  //    provider. Elsewhere, "executed" means real execution.
  // Real: executed (orders were submitted and reconciled).
  const finalDisposition = opts.shadow ? ("shadow" as const) : ("executed" as const);
  await updateDisposition({ planId, disposition: finalDisposition });
  await appendEvent({
    planId,
    eventId: `${workflowId}:completed`,
    stage: "execution.completed",
    summary: opts.shadow ? `Shadow run completed` : `Execution completed`,
    detail: opts.shadow
      ? `Shadow fills simulated. filledCents=${filledCents} workflow=${workflowId}`
      : `filledCents=${filledCents} workflow=${workflowId}`,
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
        // SECURITY: never default missing/unknown mode to execute. Parse throw
        // is fail-closed — Temporal retries the workflow and marks the run
        // failed rather than executing money on the basis of a missing flag.
        // Provenance (planId, inputSnapshotHash, calculationVersion) is
        // enforced REQUIRED by the parser; a payload that omits it is rejected
        // here, never silently self-verified downstream.
        const parsed = parseExecutionPlanCreatedPayload(claim.payload);
        if (parsed.executionMode !== "shadow" && parsed.executionMode !== "execute") {
          // parse already enforces this; unreachable defensive check for defense in depth
          throw new Error(`unreachable: invalid executionMode`);
        }
        const shadow = parsed.executionMode === "shadow";
        const expected: ExpectedProvenance = {
          inputSnapshotHash: parsed.inputSnapshotHash,
          calculationVersion: parsed.calculationVersion,
        };
        await executionPlanWorkflow(parsed.planId, { shadow }, expected, claim.id);
      } else {
        // Unknown event type: release so it doesn't block the queue
        await releaseOutboxClaim({ id: claim.id });
      }
    }

    await sleep(pollIntervalMs);
  }
}

/**
 * Bounded single-event publisher workflow.
 *
 * Certification-scoped: drives EXACTLY ONE outbox row (by id) through the
 * real outbox -> ExecutionPlanWorkflow -> delivered path. Never iterates,
 * never claims any other pending row, never calls markPublished directly
 * outside the workflow boundary.
 *
 * Failure semantics (fail-closed):
 *   - row not found / already delivered / claimed by another lease ->
 *     claimOutboxById throws BEFORE this workflow does anything else.
 *   - payload fails parseExecutionPlanCreatedPayload -> throw. The outbox row
 *     is left claimed-but-undelivered; the lease expires, the row returns to
 *     pending, and the certification harness reads delivered_at IS NULL and
 *     correctly does NOT count the run as published.
 *   - executionPlanWorkflow result kind "failed" -> throw (so Temporal marks
 *     this run failed and the row is NOT marked delivered).
 *
 * Idempotency: a re-run against an already-delivered row throws on claim
 * (claimPendingById refuses redelivery), so the certification harness sees
 * the NOT-claimed state and counts the FIRST successful run only.
 */
export async function publishOutboxEventWorkflow(
  outboxEventId: string,
  leaseMs = 30000
): Promise<{ planId: string; published: true }> {
  // 1) Claim ONLY this row. Throws on missing/delivered/held rows.
  //    Uses the non-retryable proxy: a refusal to claim is a terminal
  //    contract violation, not a transient error.
  const claim = await claimOutboxByIdNonRetryable({ id: outboxEventId, leaseMs });

  // 2) Refuse anything that is not an ExecutionPlanCreated event. Releasing
  // would let the certification claim another row later; we want a failed
  // claim to be loud, so we release the claim first (lease cleanup) and then
  // fail the workflow run with a NON-RETRYABLE ApplicationFailure. (Without
  // nonRetryable, Temporal would re-drive this workflow forever against the
  // exact same tampered-outbox state.)
  if (claim.type !== "ExecutionPlanCreated") {
    await releaseOutboxClaim({ id: claim.id });
    throw ApplicationFailure.create({
      message: `publishOutboxEventWorkflow: refusing to publish type=${claim.type} (id=${claim.id})`,
      nonRetryable: true,
    });
  }

  // 3) Strict parse: REQUIRED planId, REQUIRED explicit executionMode,
  // REQUIRED non-empty provenance. A malformed payload leaves the event
  // claimed-but-undelivered so the certification harness never observes
  // delivered_at on a tampered row. Wrap in a try/catch so the parse error
  // becomes a non-retryable ApplicationFailure — Temporal would otherwise
  // keep retrying this workflow against the same tampered row until lease
  // expiry, which produces noisy history and never converges faster.
  let parsed: ReturnType<typeof parseExecutionPlanCreatedPayload>;
  try {
    parsed = parseExecutionPlanCreatedPayload(claim.payload);
  } catch (err) {
    throw ApplicationFailure.create({
      message: err instanceof Error ? err.message : String(err),
      nonRetryable: true,
    });
  }
  if (parsed.executionMode !== "shadow" && parsed.executionMode !== "execute") {
    throw new Error(`unreachable: invalid executionMode after parse`);
  }
  const shadow = parsed.executionMode === "shadow";

  // 4) Run the execution workflow as a child, forwarding independent provenance.
  const result = await executionPlanWorkflow(
    parsed.planId,
    { shadow },
    { inputSnapshotHash: parsed.inputSnapshotHash, calculationVersion: parsed.calculationVersion },
    claim.id
  );

  // 5) Fail-closed: a workflow result that did not complete (failed,
  // skipped-already-executed, skipped-already-failed, not-found) must NOT be
  // counted as published. Note that executionPlanWorkflow marks delivered_at
  // itself on its code path BEFORE returning; that mark only happens on the
  // completion path — but if the workflow returns a non-completion result,
  // delivered_at was never set, so the throw below keeps the row pending. We
  // still release the claim so a later, valid retried run can re-claim the
  // row after investigation.
  const kind = result.result.kind;
  if (kind !== "completed" && kind !== "completed_shadow") {
    await releaseOutboxClaim({ id: claim.id });
    throw ApplicationFailure.create({
      message: `publishOutboxEventWorkflow: refusing to count as published; executionPlanWorkflow returned kind=${kind} (planId=${parsed.planId})`,
      nonRetryable: true,
    });
  }

  return { planId: parsed.planId, published: true };
}
