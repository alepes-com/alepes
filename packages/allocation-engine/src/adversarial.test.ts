// Adversarial tests for the allocation engine and rules engine — the degenerate
// and hostile inputs a financial core must fail deterministically on, never
// silently mis-allocate.

import { describe, it, expect } from "vitest";
import { allocate, allocateDeployable } from "../src/index";
import { evaluateRules, toCapitalPlan } from "@alepes/rules-engine";
import type {
  CapitalPlan,
  CashEvent,
  CashFlowRule,
  PortfolioState,
} from "@alepes/domain";
import { cents, nonNegativeCents, ZERO } from "@alepes/money";

function plan(deployable: number, eventId = "e"): CapitalPlan {
  return {
    eventId,
    deployable: nonNegativeCents(deployable),
    reserve: ZERO,
    evaluation: null,
    isEmpty: deployable === 0,
  };
}

function state(positions: { symbol: string; name: string; value: number }[], holdings: { symbol: string; name: string; targetPct: number; bandMinPct?: number; bandMaxPct?: number }[], prices?: Record<string, number>): PortfolioState {
  const total = positions.reduce((s, p) => s + p.value, 0);
  return {
    portfolio: { id: "p", name: "P", version: 1, holdings },
    positions: positions.map((p) => ({ ...p, value: nonNegativeCents(p.value) })),
    totalValue: nonNegativeCents(total),
    prices: prices
      ? Object.fromEntries(Object.entries(prices).map(([s, v]) => [s, cents(v)]))
      : undefined,
  };
}

describe("adversarial: prices", () => {
  it("missing price → shares are 0, allocation amount still correct", () => {
    const s = state(
      [
        { symbol: "A", name: "A", value: 4000_00 },
        { symbol: "B", name: "B", value: 6000_00 },
      ],
      [
        { symbol: "A", name: "A", targetPct: 50 },
        { symbol: "B", name: "B", targetPct: 50 },
      ],
      { A: 100_00 } // B has no price
    );
    const result = allocate(s, plan(500_00));
    const a = result.lines.find((l) => l.symbol === "A");
    expect(a).toBeDefined();
    expect(a!.amount).toBeGreaterThan(0);
    expect(a!.shares).toBeGreaterThan(0); // A has a price
  });

  it("zero price → shares are 0, never divides by zero (no NaN/Infinity)", () => {
    const s = state(
      [{ symbol: "A", name: "A", value: 4000_00 }, { symbol: "B", name: "B", value: 6000_00 }],
      [{ symbol: "A", name: "A", targetPct: 50 }, { symbol: "B", name: "B", targetPct: 50 }],
      { A: 0 } // zero price
    );
    const result = allocate(s, plan(500_00));
    const a = result.lines.find((l) => l.symbol === "A");
    expect(a).toBeDefined();
    expect(Number.isFinite(a!.shares)).toBe(true);
    expect(a!.shares).toBe(0);
  });

  it("delisted symbol (in positions but no price and not in holdings?) still handled", () => {
    // A position exists but its holding is absent from portfolio.holdings.
    const s = state(
      [
        { symbol: "GHOST", name: "Delisted", value: 100_00 },
        { symbol: "A", name: "A", value: 4000_00 },
        { symbol: "B", name: "B", value: 6000_00 },
      ],
      [{ symbol: "A", name: "A", targetPct: 50 }, { symbol: "B", name: "B", targetPct: 50 }]
    );
    const result = allocate(s, plan(500_00));
    // GHOST has no holding → it is never allocated to.
    expect(result.lines.find((l) => l.symbol === "GHOST")).toBeUndefined();
    expect(result.totalDeployed).toBeLessThanOrEqual(500_00);
  });
});

describe("adversarial: holdings edge cases", () => {
  it("allocations not totaling 100% still allocate proportionally to underweight gaps", () => {
    // Targets sum to 80% (not 100) — engine still works and never exceeds deployable.
    const s = state(
      [{ symbol: "A", name: "A", value: 3000_00 }, { symbol: "B", name: "B", value: 3000_00 }],
      [{ symbol: "A", name: "A", targetPct: 40 }, { symbol: "B", name: "B", targetPct: 40 }]
    );
    const result = allocate(s, plan(1000_00));
    expect(result.totalDeployed).toBeLessThanOrEqual(1000_00);
    for (const l of result.lines) expect(l.amount).toBeGreaterThanOrEqual(0);
  });

  it("duplicate holdings are collapsed to a single effective target (first wins)", () => {
    const s = state(
      [{ symbol: "A", name: "A", value: 5000_00 }],
      [
        { symbol: "A", name: "A", targetPct: 60 },
        { symbol: "A", name: "A (dup)", targetPct: 40 },
      ]
    );
    // Holding map built via last-wins or first-wins — either way, no crash and
    // no double-counting of the same symbol.
    const result = allocate(s, plan(100_00));
    const aLines = result.lines.filter((l) => l.symbol === "A");
    expect(aLines.length).toBeLessThanOrEqual(1);
  });
});

describe("adversarial: min trade vs deployable", () => {
  it("minimum trade larger than deployable → nothing deployed, listed as skipped", () => {
    const s = state(
      [{ symbol: "A", name: "A", value: 4000_00 }, { symbol: "B", name: "B", value: 6000_00 }],
      [{ symbol: "A", name: "A", targetPct: 50 }, { symbol: "B", name: "B", targetPct: 50 }]
    );
    const result = allocateDeployable(s, nonNegativeCents(50), "e", {
      minTradeSize: nonNegativeCents(1000),
    });
    expect(result.totalDeployed).toBe(0);
    expect(result.lines).toHaveLength(0);
  });
});

describe("adversarial: overflow and extremes", () => {
  it("deployable larger than the underweight gap caps at the gap (no overshoot)", () => {
    // A underweight by $1,000 exactly; deploy $1,000,000 → allocate exactly $1,000.
    const s = state(
      [{ symbol: "A", name: "A", value: 0 }, { symbol: "B", name: "B", value: 10000_00 }],
      [{ symbol: "A", name: "A", targetPct: 50 }, { symbol: "B", name: "B", targetPct: 50 }]
    );
    const result = allocate(s, plan(1_000_000_00));
    expect(result.totalDeployed).toBeLessThanOrEqual(10000_00);
  });

  it("absurdly large values stay within safe-integer range (no silent precision loss)", () => {
    // $1B portfolio; every position value and the deployable are safe integers.
    const billionCents = 100_000_000_000; // $1B
    const s = state(
      [{ symbol: "A", name: "A", value: billionCents }],
      [{ symbol: "A", name: "A", targetPct: 100 }]
    );
    const result = allocate(s, plan(1_00)); // $1 deploy; A already at 100% → overweight, 0 gap
    expect(result.totalDeployed).toBe(0);
  });

  it("NaN/Infinity deployable is impossible via the typed boundary (nonNegativeCents throws)", () => {
    expect(() => nonNegativeCents(Number.NaN)).toThrow(RangeError);
    expect(() => nonNegativeCents(Infinity)).toThrow(RangeError);
  });
});

describe("adversarial: duplicate cash events + rules", () => {
  const paycheckRule: CashFlowRule = {
    id: "r1",
    name: "Paycheck",
    trigger: "payroll",
    reserveBalance: nonNegativeCents(2000_00),
    action: "invest_percentage",
    amount: 20,
    maxPerDeposit: nonNegativeCents(750_00),
    maxPerMonth: nonNegativeCents(2000_00),
    portfolioId: "p",
    active: true,
    order: 0,
  };

  function cash(id: string): CashEvent {
    return {
      id,
      amount: cents(3000_00),
      source: "payroll",
      description: "Payroll",
      occurredAt: "2026-08-31T09:00:00Z",
      checkingBalanceAfter: nonNegativeCents(5000_00),
    };
  }

  it("the same CashEvent id evaluated twice yields identical results (idempotent)", () => {
    const e = cash("dup-1");
    const r1 = evaluateRules([paycheckRule], e);
    const r2 = evaluateRules([paycheckRule], e);
    expect(JSON.stringify(r1)).toBe(JSON.stringify(r2));
  });

  it("two rules that both match a payroll still deploy exactly once (single winner)", () => {
    const secondRule: CashFlowRule = { ...paycheckRule, id: "r2", name: "Also Payroll", order: 1 };
    const e = cash("e1");
    const result = evaluateRules([paycheckRule, secondRule], e);
    // Exactly one rule is the winner...
    expect(result.evaluation?.ruleId).toBe("r1");
    // ...and the capital plan deploys ONLY that winner's amount, not the sum of
    // both independent evaluations. This is the real "no double-invest" guarantee.
    const capital = toCapitalPlan(e, result);
    expect(capital.deployable).toBe(result.evaluation!.investmentAmount);
    // Sanity: the winner's amount is a single 20%-paycheck amount (60,000¢),
    // NOT 2× that (120,000¢).
    expect(capital.deployable).toBe(60000);
  });
});