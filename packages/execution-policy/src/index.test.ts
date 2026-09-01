import { describe, it, expect } from "vitest";
import { decidePolicy, toOrders } from "../src/index";
import type { ExecutionPlan } from "@alepes/domain";
import { nonNegativeCents, ZERO } from "@alepes/money";

function makePlan(props: Partial<ExecutionPlan> = {}): ExecutionPlan {
  return {
    id: "plan-1",
    cashEvent: {
      id: "e1",
      amount: nonNegativeCents(3000_00),
      source: "payroll",
      description: "Payroll",
      occurredAt: "2026-08-31T09:00:00Z",
      checkingBalanceAfter: nonNegativeCents(5000_00),
    },
    capitalPlan: {
      eventId: "e1",
      deployable: nonNegativeCents(600_00),
      reserve: nonNegativeCents(2000_00),
      evaluation: null,
      isEmpty: false,
    },
    allocationPlan: {
      eventId: "e1",
      totalDeployed: nonNegativeCents(600_00),
      lines: [
        { symbol: "MSFT", name: "Microsoft", amount: nonNegativeCents(400_00), shares: 0.5 },
        { symbol: "NVDA", name: "NVIDIA", amount: nonNegativeCents(200_00), shares: 0.2 },
      ],
      skipped: [],
      explanations: [],
    },
    orders: [],
    proposedDisposition: { kind: "shadow", reason: "unset" },
    ...props,
  };
}

describe("toOrders", () => {
  it("produces buy-only orders (contribution-only, never sell)", () => {
    const plan = makePlan();
    plan.orders = toOrders(plan);
    expect(plan.orders).toHaveLength(2);
    for (const o of plan.orders) expect(o.side).toBe("buy");
  });
});

describe("decidePolicy — shadow vs live share the plan; only disposition differs", () => {
  it("shadow mode always resolves to shadow (no execution)", () => {
    const plan = makePlan();
    plan.orders = toOrders(plan);
    const outcome = decidePolicy(plan, { shadowMode: true });
    expect(outcome.disposition.kind).toBe("shadow");
    expect(outcome.ordersToExecute).toHaveLength(0);
    // Orders are still proposed — they exist, they just don't execute.
    expect(outcome.ordersHeld).toHaveLength(2);
  });

  it("live mode without threshold executes", () => {
    const plan = makePlan();
    plan.orders = toOrders(plan);
    const outcome = decidePolicy(plan, { shadowMode: false });
    expect(outcome.disposition.kind).toBe("execute");
    expect(outcome.ordersToExecute).toHaveLength(2);
  });

  it("live mode above threshold requires approval", () => {
    const plan = makePlan();
    plan.orders = toOrders(plan);
    const outcome = decidePolicy(plan, {
      shadowMode: false,
      approvalThresholdCents: nonNegativeCents(500_00), // 600 > 500
    });
    expect(outcome.disposition.kind).toBe("approval");
    expect(outcome.ordersToExecute).toHaveLength(0);
    expect(outcome.ordersHeld).toHaveLength(2);
  });

  it("pre-approval releases a threshold-exceeding plan", () => {
    const plan = makePlan();
    plan.orders = toOrders(plan);
    const outcome = decidePolicy(plan, {
      shadowMode: false,
      approvalThresholdCents: nonNegativeCents(500_00),
      approvals: new Set(["plan-1"]),
    });
    expect(outcome.disposition.kind).toBe("execute");
  });

  it("empty plan is inert in both modes", () => {
    const plan = makePlan({
      allocationPlan: {
        eventId: "e1",
        totalDeployed: ZERO,
        lines: [],
        skipped: [],
        explanations: [],
      },
      orders: [],
    });
    const shadow = decidePolicy(plan, { shadowMode: true });
    const live = decidePolicy(plan, { shadowMode: false });
    expect(shadow.ordersToExecute).toHaveLength(0);
    expect(live.ordersToExecute).toHaveLength(0);
  });
});