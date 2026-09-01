import { describe, it, expect } from "vitest";
import { evaluateRule, evaluateRules, toCapitalPlan } from "../src/index";
import type { CashEvent, CashFlowRule } from "@alepes/domain";
import { cents, nonNegativeCents, isZero } from "@alepes/money";

const paycheckRule: CashFlowRule = {
  id: "r-paycheck",
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

const bonusRule: CashFlowRule = {
  id: "r-bonus",
  name: "Bonus Rule",
  trigger: "bonus",
  minAmount: nonNegativeCents(1000_00),
  reserveBalance: nonNegativeCents(500_00),
  action: "invest_percentage",
  amount: 50,
  maxPerDeposit: nonNegativeCents(1000_00),
  portfolioId: "p1",
  active: true,
  order: 1,
};

function event(overrides: Partial<CashEvent> = {}): CashEvent {
  return {
    id: "e1",
    amount: cents(3000_00),
    source: "payroll",
    description: "Payroll",
    occurredAt: "2026-08-31T09:00:00Z",
    checkingBalanceAfter: nonNegativeCents(5000_00),
    ...overrides,
  };
}

describe("evaluateRule — integer-cents exactness", () => {
  it("computes 20% of 300000¢ exactly = 60000¢", () => {
    const r = evaluateRule(paycheckRule, event());
    expect(r.investmentAmount).toBe(60000);
    expect(r.qualified).toBe(true);
    expect(r.skipped).toBe(false);
  });

  it("applies reserve: balance 2100 → only 100 available", () => {
    const r = evaluateRule(
      paycheckRule,
      event({ id: "e2", checkingBalanceAfter: nonNegativeCents(2100_00) })
    );
    expect(r.investmentAmount).toBe(10000);
    expect(r.reserveApplied).toBe(true);
  });

  it("applies per-deposit cap: 20% of 8000 = 1600 → 750", () => {
    const r = evaluateRule(
      paycheckRule,
      event({ id: "e3", amount: cents(8000_00), checkingBalanceAfter: nonNegativeCents(10000_00) })
    );
    expect(r.investmentAmount).toBe(75000);
  });

  it("applies monthly budget", () => {
    const r = evaluateRule(paycheckRule, event(), { monthlyInvested: nonNegativeCents(1800_00) });
    expect(r.investmentAmount).toBe(20000);
  });

  it("skips once monthly cap is exhausted", () => {
    const r = evaluateRule(paycheckRule, event(), { monthlyInvested: nonNegativeCents(2000_00) });
    expect(isZero(r.investmentAmount)).toBe(true);
    expect(r.skipped).toBe(true);
  });

  it("does not qualify a non-matching source", () => {
    const r = evaluateRule(paycheckRule, event({ source: "bonus" }));
    expect(r.qualified).toBe(false);
    expect(isZero(r.investmentAmount)).toBe(true);
  });

  it("ignores outflows (negative cash events)", () => {
    const r = evaluateRule(paycheckRule, event({ amount: cents(-100_00) }));
    expect(r.qualified).toBe(false);
  });

  it("skips paused rules", () => {
    const r = evaluateRule({ ...paycheckRule, active: false }, event());
    expect(r.skipped).toBe(true);
    expect(isZero(r.investmentAmount)).toBe(true);
  });
});

describe("evaluateRules — a deposit fires at most one rule", () => {
  it("wins the first qualifying active rule by priority", () => {
    // Payroll event: only paycheck rule should fire; bonus rule must not.
    const result = evaluateRules([paycheckRule, bonusRule], event());
    expect(result.evaluation?.ruleId).toBe("r-paycheck");
    // Only ONE rule may have a nonzero investment amount.
    const funded = result.trace.filter((t) => !isZero(t.investmentAmount));
    expect(funded).toHaveLength(1);
  });

  it("bonus event routes to the bonus rule, not the paycheck rule", () => {
    const result = evaluateRules(
      [paycheckRule, bonusRule],
      event({ source: "bonus", amount: cents(5000_00) })
    );
    expect(result.evaluation?.ruleId).toBe("r-bonus");
  });

  it("returns null evaluation when nothing qualifies", () => {
    const result = evaluateRules([paycheckRule, bonusRule], event({ source: "transfer" }));
    expect(result.evaluation).toBeNull();
  });
});

describe("toCapitalPlan", () => {
  it("produces an empty plan when nothing qualifies", () => {
    const result = evaluateRules([paycheckRule], event({ source: "transfer" }));
    const plan = toCapitalPlan(event({ source: "transfer" }), result);
    expect(plan.isEmpty).toBe(true);
    expect(isZero(plan.deployable)).toBe(true);
  });

  it("produces a deployable plan from a winning rule", () => {
    const result = evaluateRules([paycheckRule, bonusRule], event());
    const plan = toCapitalPlan(event(), result);
    expect(plan.isEmpty).toBe(false);
    expect(plan.deployable).toBe(60000);
  });
});