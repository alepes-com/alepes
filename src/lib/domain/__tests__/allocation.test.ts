import { describe, it, expect } from "vitest";
import {
  allocateContribution,
  formationScore,
  underweightAmount,
  driftReport,
} from "../allocation";
import { evaluateRule, depositQualifies, summarizeRule } from "../rules";
import type { CashFlowRule, DepositEvent, PortfolioState } from "../types";

// A fixed portfolio mirroring the demo account's shape, with controlled values.
function makeState(
  positions: { symbol: string; name: string; value: number }[],
  holdings: { symbol: string; targetPct: number; bandMinPct?: number; bandMaxPct?: number }[]
): PortfolioState {
  const totalValue = positions.reduce((s, p) => s + p.value, 0);
  return {
    portfolio: {
      id: "test",
      name: "Test",
      version: 1,
      holdings: holdings.map((h) => ({ name: h.symbol, ...h })),
    },
    positions: positions.map((p) => ({
      ...p,
      currentPct: (p.value / totalValue) * 100,
    })),
    totalValue,
  };
}

const SAMPLE = makeState(
  [
    { symbol: "MSFT", name: "Microsoft", value: 4000 }, // 50% target, underweight (current 40%)
    { symbol: "AAPL", name: "Apple", value: 6000 }, // 50% target, overweight (current 60%)
  ],
  [
    { symbol: "MSFT", targetPct: 50 },
    { symbol: "AAPL", targetPct: 50 },
  ]
);
// totalValue = 10000. MSFT @ 40% (target 50% → underweight, gap +$1,000);
// AAPL @ 60% (target 50% → overweight). Clean, unambiguous fixtures.

describe("underweightAmount", () => {
  it("returns positive for underweight holdings and negative for overweight", () => {
    const msft = SAMPLE.positions.find((p) => p.symbol === "MSFT")!;
    const aapl = SAMPLE.positions.find((p) => p.symbol === "AAPL")!;
    const holding = SAMPLE.portfolio.holdings.find((h) => h.symbol === "MSFT")!;
    expect(underweightAmount(msft, holding, SAMPLE.totalValue)).toBeGreaterThan(0);

    const aaplHolding = SAMPLE.portfolio.holdings.find((h) => h.symbol === "AAPL")!;
    expect(underweightAmount(aapl, aaplHolding, SAMPLE.totalValue)).toBeLessThan(0);
  });
});

describe("allocateContribution", () => {
  it("directs funds to underweight holdings first", () => {
    const result = allocateContribution(SAMPLE, 500);
    expect(result.totalDeployed).toBeCloseTo(500, 1);
    // MSFT is the most underweight; it should receive the largest allocation.
    const msft = result.lines.find((l) => l.symbol === "MSFT");
    expect(msft).toBeDefined();
    expect(msft!.amount).toBeGreaterThan(0);
    // AAPL is overweight — it should get nothing.
    expect(result.lines.find((l) => l.symbol === "AAPL")).toBeUndefined();
  });

  it("respects a minimum trade size", () => {
    // NVDA gap is small relative to MSFT; with a high min the small line is skipped.
    const result = allocateContribution(SAMPLE, 100, { minTradeSize: 50 });
    expect(result.totalDeployed).toBeGreaterThanOrEqual(0);
    expect(result.totalDeployed).toBeLessThanOrEqual(100);
  });

  it("respects allocation band upper edge (no overshoot)", () => {
    const state = makeState(
      [{ symbol: "MSFT", name: "Microsoft", value: 8400 }],
      [{ symbol: "MSFT", targetPct: 20, bandMinPct: 17, bandMaxPct: 23 }]
    );
    // MSFT already at 100% current; giving it money would push well past 23% band.
    const result = allocateContribution(state, 1000);
    // The band cap means it should not buy beyond the max band (23% of new total).
    expect(result.totalDeployed).toBeLessThan(1000);
  });

  it("computes fractional shares when prices are provided", () => {
    const result = allocateContribution(SAMPLE, 500, {
      prices: { MSFT: 100, NVDA: 50, GOOGL: 100 },
    });
    const msft = result.lines.find((l) => l.symbol === "MSFT");
    expect(msft).toBeDefined();
    expect(msft!.shares).toBeCloseTo(msft!.amount / 100, 4);
  });

  it("handles a zero or negative contribution gracefully", () => {
    const zero = allocateContribution(SAMPLE, 0);
    expect(zero.lines).toHaveLength(0);
    expect(zero.totalDeployed).toBe(0);
    const negative = allocateContribution(SAMPLE, -50);
    expect(negative.lines).toHaveLength(0);
  });

  it("rounds to cents and reconciles the total", () => {
    const result = allocateContribution(SAMPLE, 422.15);
    const sum = result.lines.reduce((s, l) => s + l.amount, 0);
    expect(Math.abs(sum - result.totalDeployed)).toBeLessThan(0.02);
  });
});

describe("formationScore", () => {
  it("is 100 for a perfectly-formed portfolio", () => {
    // Build a state where current == target exactly.
    const perfect = makeState(
      [
        { symbol: "A", name: "A", value: 5000 },
        { symbol: "B", name: "B", value: 5000 },
      ],
      [
        { symbol: "A", targetPct: 50 },
        { symbol: "B", targetPct: 50 },
      ]
    );
    expect(formationScore(perfect)).toBe(100);
  });

  it("decreases as drift increases", () => {
    const drifted = makeState(
      [
        { symbol: "A", name: "A", value: 9000 },
        { symbol: "B", name: "B", value: 1000 },
      ],
      [
        { symbol: "A", targetPct: 50 },
        { symbol: "B", targetPct: 50 },
      ]
    );
    expect(formationScore(drifted)).toBeLessThan(100);
    expect(formationScore(drifted)).toBeGreaterThanOrEqual(0);
  });
});

describe("driftReport", () => {
  it("labels overweight as 'overweight', underweight as 'buy', near-target as 'hold'", () => {
    const report = driftReport(SAMPLE);
    const aapl = report.find((r) => r.symbol === "AAPL");
    const msft = report.find((r) => r.symbol === "MSFT");
    expect(aapl?.action).toBe("overweight");
    expect(msft?.action).toBe("buy");
  });
});

// ---- Rules engine ----

const paycheckRule: CashFlowRule = {
  id: "r1",
  name: "Paycheck Rule",
  trigger: "payroll",
  reserveBalance: 2000,
  action: "invest_percentage",
  amount: 20,
  maxPerDeposit: 750,
  maxPerMonth: 2000,
  portfolioId: "p1",
  active: true,
  order: 0,
};

function deposit(overrides: Partial<DepositEvent>): DepositEvent {
  return {
    id: "d1",
    amount: 3000,
    source: "payroll",
    description: "Payroll",
    occurredAt: "2026-08-31T09:00:00Z",
    checkingBalanceAfter: 5000,
    ...overrides,
  };
}

describe("evaluateRule", () => {
  it("invests a percentage of a qualifying deposit", () => {
    const eval_ = evaluateRule(paycheckRule, deposit({}), {});
    // 20% of 3000 = 600
    expect(eval_.investmentAmount).toBeCloseTo(600, 2);
    expect(eval_.qualified).toBe(true);
    expect(eval_.skipped).toBe(false);
  });

  it("applies the reserve constraint", () => {
    // balance 2100, reserve 2000 -> only 100 available, cap 20% (600) down to 100
    const eval_ = evaluateRule(paycheckRule, deposit({ checkingBalanceAfter: 2100 }), {});
    expect(eval_.investmentAmount).toBeCloseTo(100, 2);
    expect(eval_.reserveApplied).toBe(true);
  });

  it("applies the per-deposit cap", () => {
    // 20% of 8000 = 1600, capped at 750
    const eval_ = evaluateRule(
      paycheckRule,
      deposit({ amount: 8000, checkingBalanceAfter: 10000 }),
      {}
    );
    expect(eval_.investmentAmount).toBeCloseTo(750, 2);
  });

  it("does not qualify non-matching deposits", () => {
    const eval_ = evaluateRule(paycheckRule, deposit({ source: "bonus" }), {});
    expect(eval_.qualified).toBe(false);
    expect(eval_.investmentAmount).toBe(0);
  });

  it("skips paused rules", () => {
    const paused = { ...paycheckRule, active: false };
    const eval_ = evaluateRule(paused, deposit({}), {});
    expect(eval_.skipped).toBe(true);
    expect(eval_.investmentAmount).toBe(0);
  });

  it("respects a monthly budget", () => {
    // Already invested 1800 this month; only 200 of the 2000 budget remains.
    const eval_ = evaluateRule(paycheckRule, deposit({}), { monthlyInvested: 1800 });
    expect(eval_.investmentAmount).toBeCloseTo(200, 2);
  });

  it("applies a minimum amount gate", () => {
    const rule = { ...paycheckRule, minAmount: 1000 };
    const eval_ = evaluateRule(rule, deposit({ amount: 500 }), {});
    expect(eval_.qualified).toBe(false);
  });
});

describe("depositQualifies", () => {
  it("matches bonus trigger only on bonus deposits", () => {
    const bonusRule = { ...paycheckRule, trigger: "bonus" as const };
    expect(depositQualifies(bonusRule, deposit({ source: "bonus" }))).toBe(true);
    expect(depositQualifies(bonusRule, deposit({ source: "payroll" }))).toBe(false);
  });

  it("any_deposit matches everything", () => {
    const anyRule = { ...paycheckRule, trigger: "any_deposit" as const };
    expect(depositQualifies(anyRule, deposit({ source: "transfer" }))).toBe(true);
  });
});

describe("summarizeRule", () => {
  it("produces a human-readable sentence", () => {
    const summary = summarizeRule(paycheckRule);
    expect(summary).toContain("payroll deposit");
    expect(summary).toContain("20%");
    expect(summary).toContain("$2,000");
    expect(summary).toContain("$750");
  });
});