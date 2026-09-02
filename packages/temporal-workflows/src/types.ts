/**
 * Shared types for the Alepes Temporal workflow layer.
 * Plain JSON-safe types only. No runtime imports of domain or persistence.
 */

export type Disposition =
  | "shadow"
  | "approval_required"
  | "approved"
  | "executing"
  | "executed"
  | "rejected"
  | "failed";

export interface PersistedProvenance {
  /** Durable plan id. */
  id: string;
  cashEventId: string;
  ruleVersionId: string;
  portfolioVersionId: string;
  calculationVersion: string;
  inputSnapshotHash: string;
  deployableCents: number;
  disposition: Disposition;
}

export interface OrderLine {
  id: string;
  symbol: string;
  amountCents: number;
  side: "buy" | "sell";
  shares: number;
  idempotencyKey: string;
}

export interface LoadPlanOutput {
  provenance: PersistedProvenance;
  orders: OrderLine[];
}

export interface VerifyPlanInput {
  planId: string;
  expectedCalculationVersion: string;
  expectedInputSnapshotHash: string;
}

export interface VerifyPlanOutput {
  valid: boolean;
  mismatch?: string;
}

export interface AppendEventInput {
  planId: string;
  /** Lowercase dotted string mapped to DB enum. */
  stage:
    | "plan.created"
    | "policy.evaluated"
    | "approval.requested"
    | "approval.granted"
    | "execution.started"
    | "order.submitted"
    | "order.filled"
    | "execution.completed"
    | "execution.failed";
  summary: string;
  detail: string;
  amountCents?: number;
  /** Deterministic event identity for idempotent retries. */
  eventId: string;
}

export interface UpdateDispositionInput {
  planId: string;
  disposition: Disposition;
}

export interface ExecuteOrdersInput {
  planId: string;
  orders: OrderLine[];
}

export interface FilledOrder {
  orderId: string;
  symbol: string;
  filledCents: number;
  filledShares: number;
  filledAt: string;
  idempotencyKey: string;
}

export interface ExecuteOrdersOutput {
  ok: boolean;
  fills: FilledOrder[];
  totalFilledCents: number;
  error?: string;
  /** How many times the brokerage adapter was actually invoked. */
  brokerageCalls: number;
}

export interface ReconcileInput {
  planId: string;
  expectedCents: number;
  fills: FilledOrder[];
}

export interface ReconcileOutput {
  ok: boolean;
  actualCents: number;
}

export interface OutboxClaimMsg {
  id: string;
  type: string;
  payload: Record<string, unknown>;
}

export interface ExecutionOptions {
  shadow: boolean;
}

export type WorkflowResult =
  | { kind: "completed"; filledCents: number }
  | { kind: "completed_shadow"; simulatedCents: number }
  | { kind: "skipped-already-executed" }
  | { kind: "skipped-already-failed" }
  | { kind: "failed"; reason: string }
  | { kind: "not-found" };

export interface ExecutionResult {
  planId: string;
  result: WorkflowResult;
  filledCents: number;
  /** Number of times the brokerage capability was invoked. */
  brokerageCalls: number;
  /** Idempotency key used for order calls. */
  idempotencyKey: string;
}