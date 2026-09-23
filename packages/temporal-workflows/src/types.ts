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
  /**
   * The execution mode declared when the plan row was persisted. The
   * workflow cross-checks this against `opts.shadow` and throws on any
   * mismatch, so a direct caller (`{shadow:false}`) can NEVER silently turn
   * a plan persisted as `execution_mode = 'shadow'` into a real-money run.
   */
  executionMode: "shadow" | "execute";
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
    | "shadow.order.filled"
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

/**
 * Independent expected provenance carried on the outbox event. The publisher
 * forwards it into the workflow so verification compares against a canonical
 * identity source, not against the plan row loaded moments earlier.
 */
export interface ExpectedProvenance {
  inputSnapshotHash: string;
  calculationVersion: string;
}

export interface ExecutionOptions {
  shadow: boolean;
}

/**
 * Outbox ExecutionPlanCreated payload contract.
 *
 * ═══ SECURITY-CRITICAL ═══
 * `executionMode` MUST be explicit `"shadow" | "execute"`. Consumers MUST fail
 * closed (throw / refuse) if the mode is missing, not a string, or not one of
 * the two named values. NEVER default a missing mode to "execute".
 * Currently, every Alepes v0.5 plan is created with `executionMode: "shadow"`.
 */
export type ExecutionPlanOutboxMode = "shadow" | "execute";

export interface ExecutionPlanCreatedPayload {
  planId: string;
  /** REQUIRED. "shadow" = simulate only; "execute" = actually submit orders. */
  executionMode: ExecutionPlanOutboxMode;
  /**
   * REQUIRED. Independent provenance for outbox-driven consumers. Must be a
   * non-empty string. The publisher forwards these to the workflow as the
   * independent `ExpectedProvenance`; the workflow refuses to verify against
   * the freshly-loaded row's own values. Direct (non-outbox) workflow
   * invocation may pass `expected` explicitly; it may not omit it.
   */
  inputSnapshotHash: string;
  calculationVersion: string;
}

/** Parse an unknown outbox payload into a typed ExecutionPlanCreatedPayload — fail-closed on any defect. */
export function parseExecutionPlanCreatedPayload(payload: unknown): ExecutionPlanCreatedPayload {
  const p = payload as Record<string, unknown> | null | undefined;
  if (!p || typeof p !== "object") {
    throw new Error("ExecutionPlanCreated payload must be an object");
  }
  const planId = p.planId;
  if (typeof planId !== "string" || planId.length === 0) {
    throw new Error("ExecutionPlanCreated.planId must be a non-empty string");
  }
  const mode = p.executionMode;
  if (mode !== "shadow" && mode !== "execute") {
    throw new Error(
      `ExecutionPlanCreated.executionMode must be "shadow" or "execute" (got: ${typeof mode === "string" ? JSON.stringify(mode) : typeof mode})`
    );
  }
  // Outbox-driven provenance is NON-NEGOTIABLE. Allowing it to be omitted
  // and "falling back" to the freshly-loaded row's own values would let the
  // event self-verify — which is precisely the laundering the outbox
  // contract exists to prevent.
  const inputSnapshotHash = p.inputSnapshotHash;
  if (typeof inputSnapshotHash !== "string" || inputSnapshotHash.length === 0) {
    throw new Error(
      "ExecutionPlanCreated.inputSnapshotHash is required (non-empty string) for outbox-driven execution"
    );
  }
  const calculationVersion = p.calculationVersion;
  if (typeof calculationVersion !== "string" || calculationVersion.length === 0) {
    throw new Error(
      "ExecutionPlanCreated.calculationVersion is required (non-empty string) for outbox-driven execution"
    );
  }
  return { planId, executionMode: mode, inputSnapshotHash, calculationVersion };
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