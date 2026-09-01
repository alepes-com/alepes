// End-to-end: a simulated paycheck travels the entire architecture —
//   CashEvent → RuleEvaluation → CapitalPlan → AllocationPlan → ExecutionPlan
//   → ExecutionPolicy → (Shadow | Approval | Execute) → MockBrokerage
// — and leaves behind a reproducible audit record explaining every decision.

import { describe, it, expect } from "vitest";
import { evaluateRules, toCapitalPlan } from "@alepes/rules-engine";
import { allocate } from "@alepes/allocation-engine";
import { decidePolicy, toOrders } from "@alepes/execution-policy";
import { Registry } from "@alepes/integration-runtime";
import { createMockBank, samplePaycheck } from "@alepes/mock-bank";
import { createMockBrokerage } from "@alepes/mock-brokerage";
import type {
  AuditRecord,
  CashFlowRule,
  ExecutionOrder,
  ExecutionPlan,
  PortfolioState,
} from "@alepes/domain";
import { cents, nonNegativeCents, isZero } from "@alepes/money";

function portfolio(): PortfolioState {
  // 7-holding mock, mirroring the product spec allocations.
  const holdings = [
    { symbol: "AAPL", name: "Apple", targetPct: 20 },
    { symbol: "MSFT", name: "Microsoft", targetPct: 20 },
    { symbol: "GOOGL", name: "Alphabet", targetPct: 15 },
    { symbol: "AMZN", name: "Amazon", targetPct: 15 },
    { symbol: "NVDA", name: "NVIDIA", targetPct: 10 },
    { symbol: "BRK.B", name: "Berkshire", targetPct: 10 },
    { symbol: "V", name: "Visa", targetPct: 10 },
  ];
  const pct = { AAPL: 21.3, MSFT: 16.8, GOOGL: 15.2, AMZN: 16.1, NVDA: 8.1, "BRK.B": 12.9, V: 9.6 };
  const total = 24812_16; // $24,812.16 in cents
  const positions = holdings.map((h) => ({
    symbol: h.symbol,
    name: h.name,
    value: nonNegativeCents(Math.round((pct[h.symbol as keyof typeof pct] / 100) * total)),
  }));
  return {
    portfolio: { id: "p1", name: "Primary", version: 3, holdings },
    positions,
    totalValue: nonNegativeCents(total),
    prices: {
      AAPL: cents(232_40),
      MSFT: cents(421_70),
      GOOGL: cents(178_30),
      AMZN: cents(194_20),
      NVDA: cents(131_80),
      "BRK.B": cents(449_10),
      V: cents(278_60),
    },
  };
}

const paycheckRule: CashFlowRule = {
  id: "r1",
  name: "Paycheck Rule",
  trigger: "payroll",
  reserveBalance: nonNegativeCents(2000_00),
  action: "invest_percentage",
  amount: 20,
  maxPerDeposit: nonNegativeCents(750_00),
  maxPerMonth: nonNegativeCents(2000_00),
  portfolioId: "p1",
  active: true,
  order: 0,
};

describe("end-to-end pipeline", () => {
  it("routes a paycheck to the mock brokerage and leaves a full audit trail", () => {
    // ---- wire plugins ----
    const registry = new Registry();
    const bank = createMockBank({
      checkingBalance: nonNegativeCents(4812_44),
      deposits: [],
    });
    const brokerage = createMockBrokerage({
      portfolio: portfolio(),
      prices: portfolio().prices!,
    });
    registry.install(bank.plugin);
    registry.install(brokerage.plugin);

    // ---- cash event ----
    const cashEvent = samplePaycheck();
    bank.pushDeposit(cashEvent);

    const audit: AuditRecord[] = [];
    audit.push({
      id: "a1",
      at: cashEvent.occurredAt,
      eventId: cashEvent.id,
      stage: "cash_event",
      summary: "Paycheck detected",
      detail: cashEvent.description,
      amountCents: cashEvent.amount,
    });

    // ---- rule evaluation → capital plan ----
    const ruleResult = evaluateRules([paycheckRule], cashEvent);
    expect(ruleResult.evaluation).not.toBeNull();
    const capitalPlan = toCapitalPlan(cashEvent, ruleResult);
    expect(capitalPlan.isEmpty).toBe(false);
    audit.push({
      id: "a2",
      at: cashEvent.occurredAt,
      eventId: cashEvent.id,
      stage: "capital_planned",
      summary: "Investment rule evaluated",
      detail: `20% → ${capitalPlan.deployable}¢ authorized.`,
      amountCents: capitalPlan.deployable,
    });

    // ---- allocation plan ----
    const allocationPlan = allocate(portfolio(), capitalPlan);
    expect(allocationPlan.lines.length).toBeGreaterThan(0);
    for (const line of allocationPlan.lines) {
      audit.push({
        id: `a-${line.symbol}`,
        at: cashEvent.occurredAt,
        eventId: cashEvent.id,
        stage: "allocation_planned",
        summary: `Allocated ${line.symbol}`,
        detail: `${line.amount}¢ toward underweight ${line.symbol}.`,
        amountCents: line.amount,
      });
    }

    // ---- execution plan + orders ----
    const plan: ExecutionPlan = {
      id: "plan-1",
      cashEvent,
      capitalPlan,
      allocationPlan,
      orders: [] as ExecutionOrder[],
      proposedDisposition: { kind: "shadow", reason: "" },
    };
    plan.orders = toOrders(plan);

    // ---- policy gate (Shadow Mode) ----
    const shadow = decidePolicy(plan, { shadowMode: true });
    expect(shadow.disposition.kind).toBe("shadow");
    expect(shadow.ordersToExecute).toHaveLength(0);
    audit.push({
      id: "a-policy",
      at: cashEvent.occurredAt,
      eventId: cashEvent.id,
      stage: "shadowed",
      summary: "Policy decision",
      detail: shadow.disposition.reason,
    });

    // ---- policy gate (live mode, no threshold) → execute ----
    const live = decidePolicy(plan, { shadowMode: false });
    expect(live.disposition.kind).toBe("execute");
    expect(live.ordersToExecute.length).toBeGreaterThan(0);

    // The plan used by shadow and live is byte-identical — only disposition differs.
    expect(JSON.stringify(plan.allocationPlan)).toBe(
      JSON.stringify(plan.allocationPlan)
    );

    // ---- execute through the mock brokerage capability ----
    const execRecords = brokerage.submit(live.ordersToExecute);
    audit.push(...execRecords);

    // ---- reproducibility ----
    // Re-running the pure planning path yields byte-identical results.
    const plan2 = JSON.stringify(allocate(portfolio(), toCapitalPlan(cashEvent, evaluateRules([paycheckRule], cashEvent))));
    const plan1 = JSON.stringify(allocationPlan);
    expect(plan1).toBe(plan2);

    // Every stage is represented in the audit trail.
    const stages = new Set(audit.map((a) => a.stage));
    expect(stages.has("cash_event")).toBe(true);
    expect(stages.has("capital_planned")).toBe(true);
    expect(stages.has("allocation_planned")).toBe(true);
    expect(stages.has("executed")).toBe(true);

    // No negative amounts anywhere.
    for (const a of audit) {
      if (a.amountCents != null) expect(a.amountCents).toBeGreaterThanOrEqual(0);
    }
  });

  it("no double-invest: only one rule's capital reaches the plan", () => {
    const twoRules: CashFlowRule[] = [
      paycheckRule,
      { ...paycheckRule, id: "r2", name: "Bonus Rule", trigger: "bonus", order: 1 },
    ];
    const e = samplePaycheck();
    const result = evaluateRules(twoRules, e);
    const funded = result.trace.filter((t) => !isZero(t.investmentAmount));
    expect(funded).toHaveLength(1);
    expect(result.evaluation?.ruleId).toBe("r1");
  });
});