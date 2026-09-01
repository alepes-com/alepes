// Simulation engine: run a full "what if" over a deposit, rules, and allocation.
// Used by both Shadow Mode and the interactive Simulation page.

import type {
  AllocationExplanation,
  AllocationResult,
  CashFlowRule,
  DepositEvent,
  PortfolioState,
  SimulationResult,
  SimulationSummary,
} from "./types";
import { allocateContribution } from "./allocation";
import { evaluateRule } from "./rules";

export interface SimulationInput {
  depositAmount: number;
  checkingBalanceAfter: number;
  source: DepositEvent["source"];
  rules: CashFlowRule[];
  portfolioState: PortfolioState;
  monthlyInvested?: number;
  prices?: Record<string, number>;
  /** Which rule to evaluate (default: all active rules, first match wins priority). */
  ruleId?: string;
}

let idCounter = 0;
function genId(prefix: string): string {
  idCounter += 1;
  return `${prefix}-${Date.now().toString(36)}-${idCounter}`;
}

/**
 * Run a simulation. Evaluates the selected rule (or the first qualifying active
 * rule), then allocates the resulting contribution to the most underweight holdings.
 */
export function runSimulation(input: SimulationInput): SimulationResult {
  const deposit: DepositEvent = {
    id: genId("dep"),
    amount: input.depositAmount,
    source: input.source,
    description: simulateDescription(input.source, input.depositAmount),
    occurredAt: new Date().toISOString(),
    checkingBalanceAfter: input.checkingBalanceAfter,
  };

  const rulesToTry = input.ruleId
    ? input.rules.filter((r) => r.id === input.ruleId)
    : [...input.rules].sort((a, b) => (a.order ?? 0) - (b.order ?? 0));

  const evaluations = rulesToTry.map((rule) =>
    evaluateRule(rule, deposit, { monthlyInvested: input.monthlyInvested })
  );

  const totalWouldInvest = evaluations.reduce(
    (sum, e) => sum + e.investmentAmount,
    0
  );

  let allocation: AllocationResult | null = null;
  if (totalWouldInvest > 0) {
    allocation = allocateContribution(input.portfolioState, totalWouldInvest, {
      prices: input.prices,
    });
  }

  return {
    deposit,
    evaluations,
    allocation,
    moneyWouldMove: totalWouldInvest > 0,
    totalWouldInvest,
  };
}

function simulateDescription(source: DepositEvent["source"], amount: number): string {
  switch (source) {
    case "payroll":
      return `Payroll deposit +$${amount.toFixed(2)}`;
    case "bonus":
      return `Bonus deposit +$${amount.toFixed(2)}`;
    case "transfer":
      return `Transfer +$${amount.toFixed(2)}`;
    default:
      return `Deposit +$${amount.toFixed(2)}`;
  }
}

/** Build a human-readable explanation for why a holding received funds. */
export function explainAllocation(
  portfolioState: PortfolioState,
  allocation: AllocationResult,
  contribution: number
): AllocationExplanation[] {
  const holdings = portfolioState.portfolio.holdings;
  const holdingBySymbol = new Map(holdings.map((h) => [h.symbol, h]));

  return allocation.lines.map((line) => {
    const holding = holdingBySymbol.get(line.symbol);
    const targetPct = holding?.targetPct ?? 0;
    const reason =
      line.underweightAmount >= contribution * 0.9
        ? `${line.symbol} was the most underweight holding in your portfolio, so it received the largest share of this contribution.`
        : `${line.symbol} was underweight relative to its ${targetPct.toFixed(1)}% target, so new money was directed there instead of selling other holdings.`;

    return {
      symbol: line.symbol,
      name: line.name,
      targetPct,
      beforePct: line.beforePct,
      underweightAmount: line.underweightAmount,
      availableContribution: contribution,
      amount: line.amount,
      reason,
    };
  });
}

export const emptySummary = (): SimulationSummary => ({
  depositsDetected: 0,
  wouldHaveInvested: 0,
  transfersSkipped: 0,
  driftReducedPct: 0,
});