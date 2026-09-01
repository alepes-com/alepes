import { describe, it, expect } from "vitest";
import {
  allocate,
  underweightAmount,
  actionableGap,
  formationScore,
  driftReport,
} from "../src/index";
import type {
  CapitalPlan,
  PortfolioState,
  Holding,
} from "@alepes/domain";
import { nonNegativeCents, isZero } from "@alepes/money";

function makeState(
  positions: { symbol: string; name: string; value: number }[],
  holdings: (Holding & { symbol: string })[]
): PortfolioState {
  const totalValue = positions.reduce((s, p) => s + p.value, 0);
  return {
    portfolio: { id: "p1", name: "Primary", version: 1, holdings },
    positions: positions.map((p) => ({ ...p, value: nonNegativeCents(p.value) })),
    totalValue: nonNegativeCents(totalValue),
  };
}

// 50/50 two-holding fixture: MSFT underweight (40% vs 50%), AAPL overweight (60% vs 50%).
const TWO_ASSET = makeState(
  [
    { symbol: "MSFT", name: "Microsoft", value: 4000_00 },
    { symbol: "AAPL", name: "Apple", value: 6000_00 },
  ],
  [
    { symbol: "MSFT", name: "Microsoft", targetPct: 50 },
    { symbol: "AAPL", name: "Apple", targetPct: 50 },
  ]
);

function plan(deployable: number, eventId = "e1"): CapitalPlan {
  return {
    eventId,
    deployable: nonNegativeCents(deployable),
    reserve: nonNegativeCents(0),
    evaluation: null,
    isEmpty: deployable === 0,
  };
}

describe("underweightAmount / actionableGap", () => {
  it("returns positive for underweight, negative for overweight", () => {
    const msft = TWO_ASSET.positions.find((p) => p.symbol === "MSFT")!;
    const aapl = TWO_ASSET.positions.find((p) => p.symbol === "AAPL")!;
    const msftH = TWO_ASSET.portfolio.holdings.find((h) => h.symbol === "MSFT")!;
    const aaplH = TWO_ASSET.portfolio.holdings.find((h) => h.symbol === "AAPL")!;
    expect(underweightAmount(msft, msftH, TWO_ASSET.totalValue)).toBeGreaterThan(0);
    expect(underweightAmount(aapl, aaplH, TWO_ASSET.totalValue)).toBeLessThan(0);
    expect(actionableGap(aapl, aaplH, TWO_ASSET.totalValue)).toBe(0);
  });
});

describe("allocation invariants", () => {
  it("routes all deployable capital to the only underweight holding", () => {
    const result = allocate(TWO_ASSET, plan(500_00)); // deploy $500
    expect(result.lines).toHaveLength(1);
    expect(result.lines[0].symbol).toBe("MSFT");
    expect(result.lines[0].amount).toBe(500_00);
  });

  it("never exceeds deployable (sum of lines ≤ deployable)", () => {
    const result = allocate(TWO_ASSET, plan(500_00));
    const sum = result.lines.reduce((s, l) => s + l.amount, 0);
    expect(sum).toBeLessThanOrEqual(500_00);
    expect(result.totalDeployed).toBe(500_00);
  });

  it("reconciles exactly to totalDeployed (integer cents)", () => {
    // 422.15 → 42215¢, split across underweight holdings deterministically.
    const STATE = makeState(
      [
        { symbol: "A", name: "A", value: 3000_00 },
        { symbol: "B", name: "B", value: 3000_00 },
        { symbol: "C", name: "C", value: 4000_00 },
      ],
      [
        { symbol: "A", name: "A", targetPct: 40 },
        { symbol: "B", name: "B", targetPct: 30 },
        { symbol: "C", name: "C", targetPct: 30 },
      ]
    );
    const result = allocate(STATE, plan(422_15));
    const sum = result.lines.reduce((s, l) => s + l.amount, 0);
    expect(sum).toBe(result.totalDeployed);
    expect(result.totalDeployed).toBe(422_15);
  });

  it("never produces a negative allocation", () => {
    const result = allocate(TWO_ASSET, plan(100_00));
    for (const line of result.lines) expect(line.amount).toBeGreaterThanOrEqual(0);
  });

  it("gives an overweight asset nothing while an underweight exists", () => {
    const result = allocate(TWO_ASSET, plan(100_00));
    expect(result.lines.find((l) => l.symbol === "AAPL")).toBeUndefined();
  });

  it("respects the band upper edge boundary (never overshoots bandMax)", () => {
    // Single holding at 100% current, bandMax 23% (Degenerate-ish): can't buy
    // past 23% of the *new* total, so the band cap must throttle to 0.
    const STATE = makeState(
      [{ symbol: "X", name: "X", value: 10000_00 }],
      [{ symbol: "X", name: "X", targetPct: 100, bandMinPct: 0, bandMaxPct: 23 }]
    );
    const result = allocate(STATE, plan(1000_00));
    // Already at 100% > 23% bandMax → no room to add.
    expect(result.totalDeployed).toBe(0);
  });

  it("band boundary is INCLUSIVE: funding up to exactly bandMax is allowed", () => {
    // Holding underweight (0% current, target 50%), bandMax 50%.
    const STATE = makeState(
      [
        { symbol: "A", name: "A", value: 0 },
        { symbol: "B", name: "B", value: 10000_00 },
      ],
      [
        { symbol: "A", name: "A", targetPct: 50, bandMinPct: 0, bandMaxPct: 50 },
        { symbol: "B", name: "B", targetPct: 50 },
      ]
    );
    const result = allocate(STATE, plan(10000_00)); // bring A from 0 to 50%
    // A should receive up to its bandMax of 50% of the final total.
    const aLine = result.lines.find((l) => l.symbol === "A");
    expect(aLine).toBeDefined();
    expect(aLine!.amount).toBeGreaterThan(0);
  });

  it("$0 deployable produces an empty plan deterministically", () => {
    const result = allocate(TWO_ASSET, plan(0));
    expect(result.lines).toHaveLength(0);
    expect(isZero(result.totalDeployed)).toBe(true);
  });

  it("zero-value portfolio produces no lines and no crash", () => {
    const empty = makeState([], []);
    const result = allocate(empty, plan(100_00));
    expect(result.lines).toHaveLength(0);
  });

  it("is deterministic: same inputs → byte-identical output", () => {
    const a = JSON.stringify(allocate(TWO_ASSET, plan(333_33)));
    const b = JSON.stringify(allocate(TWO_ASSET, plan(333_33)));
    expect(a).toBe(b);
  });
});

describe("formationScore + driftReport", () => {
  it("scores perfect formation 100, drifted lower", () => {
    const perfect = makeState(
      [
        { symbol: "A", name: "A", value: 5000_00 },
        { symbol: "B", name: "B", value: 5000_00 },
      ],
      [
        { symbol: "A", name: "A", targetPct: 50 },
        { symbol: "B", name: "B", targetPct: 50 },
      ]
    );
    expect(formationScore(perfect)).toBe(100);
    expect(formationScore(TWO_ASSET)).toBeLessThan(100);
  });

  it("scores an empty portfolio 0 (not NaN)", () => {
    expect(formationScore(makeState([], []))).toBe(0);
  });

  it("driftReport labels overweight vs buy", () => {
    const report = driftReport(TWO_ASSET);
    expect(report.find((r) => r.symbol === "AAPL")?.action).toBe("overweight");
    expect(report.find((r) => r.symbol === "MSFT")?.action).toBe("buy");
  });
});