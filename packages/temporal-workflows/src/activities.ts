/**
 * Temporal activities — the ONLY place this package touches PostgreSQL or the
 * brokerage. Workflows import them via proxyActivities.
 *
 * Side-effecting resources are injected via `initActivities` so tests can
 * supply spies (for the same-instance Temporal TestWorkflowEnvironment) and
 * production workers can wire real ports.
 */

import type { Ports, PersistenceId, PersistableDisposition } from "@alepes/persistence";
import type { BrokerageExecutor, BrokerageResult } from "./brokerage";
import type {
  AppendEventInput,
  ExecuteOrdersInput,
  ExecuteOrdersOutput,
  LoadPlanOutput,
  OrderLine,
  OutboxClaimMsg,
  ReconcileInput,
  ReconcileOutput,
  UpdateDispositionInput,
  VerifyPlanInput,
  VerifyPlanOutput,
} from "./types";

export interface ActivitiesDeps {
  ports: Ports;
  brokerage: BrokerageExecutor;
  /** Deterministic-at-test-time clock; defaults to wall clock. */
  now?: () => Date;
}

let deps: ActivitiesDeps | null = null;

export function initActivities(d: ActivitiesDeps): void {
  deps = d;
}

function ctx(): ActivitiesDeps {
  if (!deps) throw new Error("initActivities must be called before activity execution");
  return deps;
}

const EVENT_KIND_MAP: Record<string, string> = {
  "plan.created": "plan.created",
  "policy.evaluated": "policy.evaluated",
  "approval.requested": "approval.requested",
  "approval.granted": "approval.granted",
  "execution.started": "execution.started",
  "order.submitted": "order.submitted",
  "order.filled": "order.filled",
  "execution.completed": "execution.completed",
  "execution.failed": "execution.failed",
};

export async function loadPlan(input: { planId: string }): Promise<LoadPlanOutput> {
  const { ports } = ctx();
  const plan = await ports.execution.loadPlan(input.planId as PersistenceId);
  if (!plan) throw new Error(`Plan not found: ${input.planId}`);
  const orders = await ports.execution.loadOrders(input.planId as PersistenceId);
  return {
    provenance: {
      id: plan.id,
      cashEventId: plan.cashEventId,
      ruleVersionId: plan.ruleVersionId,
      portfolioVersionId: plan.portfolioVersionId,
      calculationVersion: plan.calculationVersion,
      inputSnapshotHash: plan.inputSnapshotHash,
      deployableCents: plan.deployableCents as number,
      disposition: plan.disposition,
    },
    orders: orders.map((o) => ({
      id: o.id,
      symbol: o.symbol,
      amountCents: o.amountCents,
      side: o.side as "buy" | "sell",
      shares: o.shares,
      idempotencyKey: o.idempotencyKey,
    })),
  };
}

export async function verifyPlan(input: VerifyPlanInput): Promise<VerifyPlanOutput> {
  const { ports } = ctx();
  const plan = await ports.execution.loadPlan(input.planId as PersistenceId);
  if (!plan) return { valid: false, mismatch: `plan ${input.planId} not found` };
  if (plan.calculationVersion !== input.expectedCalculationVersion) {
    return {
      valid: false,
      mismatch: `calculationVersion mismatch: stored=${plan.calculationVersion} expected=${input.expectedCalculationVersion}`,
    };
  }
  if (plan.inputSnapshotHash !== input.expectedInputSnapshotHash) {
    return {
      valid: false,
      mismatch: `inputSnapshotHash mismatch: stored=${plan.inputSnapshotHash} expected=${input.expectedInputSnapshotHash}`,
    };
  }
  return { valid: true };
}

export async function appendEvent(input: AppendEventInput): Promise<void> {
  const { ports, now } = ctx();
  const at = (now?.() ?? new Date()).toISOString();
  const kind = EVENT_KIND_MAP[input.stage];
  if (!kind) throw new Error(`unknown audit stage: ${input.stage}`);
  await ports.execution.appendEvent(input.planId as PersistenceId, {
    id: input.eventId,
    at,
    eventId: input.planId,
    stage: mapStageToDomain(input.stage),
    summary: input.summary,
    detail: input.detail,
    amountCents: input.amountCents ?? 0,
  } as unknown as Parameters<typeof ports.execution.appendEvent>[1]);
}

function mapStageToDomain(s: string): "plan_created" | "policy_evaluated" | "approval_requested" | "approval_granted" | "execution_started" | "order_submitted" | "order_filled" | "execution_completed" | "execution_failed" {
  switch (s) {
    case "plan.created": return "plan_created";
    case "policy.evaluated": return "policy_evaluated";
    case "approval.requested": return "approval_requested";
    case "approval.granted": return "approval_granted";
    case "execution.started": return "execution_started";
    case "order.submitted": return "order_submitted";
    case "order.filled": return "order_filled";
    case "execution.completed": return "execution_completed";
    case "execution.failed": return "execution_failed";
    default: throw new Error(`unknown audit stage: ${s}`);
  }
}

export async function updateDisposition(input: UpdateDispositionInput): Promise<void> {
  const { ports } = ctx();
  await ports.execution.updateDisposition(
    input.planId as PersistenceId,
    input.disposition as PersistableDisposition
  );
}

export async function executeOrders(input: ExecuteOrdersInput): Promise<ExecuteOrdersOutput> {
  const { brokerage } = ctx();
  const result = await brokerage.executeOrders(input.orders);
  return {
    ok: result.ok,
    fills: result.fills,
    totalFilledCents: result.fills.reduce((s, f) => s + f.filledCents, 0),
    error: result.error,
    brokerageCalls: result.calls,
  };
}

export async function reconcileExecution(input: ReconcileInput): Promise<ReconcileOutput> {
  const actual = input.fills.reduce((s, f) => s + f.filledCents, 0);
  if (actual !== input.expectedCents) {
    return { ok: false, actualCents: actual };
  }
  return { ok: true, actualCents: actual };
}

export async function claimOutbox(input: { limit: number; leaseMs: number }): Promise<OutboxClaimMsg[]> {
  const { ports } = ctx();
  const claims = await ports.outbox.claimPending(input.limit, input.leaseMs);
  return claims.map((c) => ({ id: c.id, type: c.type, payload: c.payload }));
}

export async function markOutboxDelivered(input: { id: string }): Promise<void> {
  const { ports } = ctx();
  await ports.outbox.markPublished(input.id as PersistenceId);
}

export async function releaseOutboxClaim(input: { id: string }): Promise<void> {
  const { ports } = ctx();
  await ports.outbox.releaseClaim(input.id as PersistenceId);
}
