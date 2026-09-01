// Execution policy: consumes a fully-planned ExecutionPlan and produces a single
// disposition. This is the ONE place where Shadow vs live mode diverge — and
// they diverge ONLY here. The plan produced upstream is byte-identical whether
// the account is in Shadow Mode or live. Execution is a pure function of
// (plan, policy), never of the mode of the surrounding system.

import type {
  ExecutionDisposition,
  ExecutionOrder,
  ExecutionPlan,
} from "@alepes/domain";
import { isZero } from "@alepes/money";

export interface ExecutionPolicyConfig {
  /** When true, every plan resolves to a Shadow disposition (no money moves). */
  shadowMode: boolean;
  /** If set, orders whose total exceeds this cents amount require approval. */
  approvalThresholdCents?: number;
  /** Manual approval currently pending/granted for a plan id. */
  approvals?: Set<string>;
}

export type PolicyOutcome = {
  disposition: ExecutionDisposition;
  /** Orders released for execution (empty for shadow and approval). */
  ordersToExecute: ExecutionOrder[];
  /** Orders held back pending approval. */
  ordersHeld: ExecutionOrder[];
};

/**
 * Decide what to do with a plan. Shadow Mode short-circuits to `shadow`; a live
 * plan with a total above the approval threshold resolves to `approval` unless
 * pre-approved; otherwise `execute`.
 */
export function decidePolicy(
  plan: ExecutionPlan,
  config: ExecutionPolicyConfig
): PolicyOutcome {
  const total = plan.allocationPlan.totalDeployed;

  // Nothing to do.
  if (isZero(total) || plan.orders.length === 0) {
    return {
      disposition: { kind: "shadow", reason: "Empty plan — nothing to execute." },
      ordersToExecute: [],
      ordersHeld: [],
    };
  }

  // Shadow Mode: the plan is real, the execution is not.
  if (config.shadowMode) {
    return {
      disposition: {
        kind: "shadow",
        reason: "Shadow Mode is on — no money moved.",
      },
      ordersToExecute: [],
      ordersHeld: plan.orders,
    };
  }

  // Approval gate.
  const aboveThreshold =
    config.approvalThresholdCents != null && total > config.approvalThresholdCents;
  const preApproved = config.approvals?.has(plan.id) ?? false;

  if (aboveThreshold && !preApproved) {
    return {
      disposition: {
        kind: "approval",
        reason: `Total ${total}¢ exceeds the ${config.approvalThresholdCents}¢ approval threshold.`,
      },
      ordersToExecute: [],
      ordersHeld: plan.orders,
    };
  }

  return {
    disposition: {
      kind: "execute",
      reason: "Plan approved for execution.",
    },
    ordersToExecute: plan.orders,
    ordersHeld: [],
  };
}

/**
 * Build the ordered execution instructions from an allocation plan.
 * Contribution-only by construction: every order is a buy (positive amount),
 * never a sell.
 */
export function toOrders(plan: ExecutionPlan): ExecutionOrder[] {
  return plan.allocationPlan.lines.map((line, i) => ({
    id: `${plan.id}-o${i}`,
    symbol: line.symbol,
    amount: line.amount,
    side: "buy" as const,
    shares: line.shares,
  }));
}