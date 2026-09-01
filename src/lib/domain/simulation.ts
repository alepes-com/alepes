// FACADE — delegates simulation + explanation to the @alepes/* core pipeline.
//
// The React UI calls runSimulation/explainAllocation with dollar floats; this
// module converts to integer cents, runs the SAME pipeline the real system uses
// (rules-engine → allocation-engine → execution-policy), and converts the result
// back to dollar DTOs. No financial logic lives here.

import { evaluateRules as evaluateRulesCore, toCapitalPlan } from "@alepes/rules-engine";
import {
  type AllocationExplanation,
  type AllocationResult,
  type CashFlowRule,
  type DepositEvent,
  type PortfolioState,
  type SimulationResult,
  type SimulationSummary,
} from "./types";
import {
  ruleToDomain,
  toCents,
  toNonNegativeCents,
  toDollars,
} from "./marshal";
import { allocateContribution } from "./allocation";
import type { CashEvent } from "@alepes/domain";

export interface SimulationInput {
  depositAmount: number;
  checkingBalanceAfter: number;
  source: DepositEvent["source"];
  rules: CashFlowRule[];
  portfolioState: PortfolioState;
  monthlyInvested?: number;
  prices?: Record<string, number>;
  ruleId?: string;
}

/** Run the full "what if" through the same core pipeline the real system uses. */
export function runSimulation(input: SimulationInput): SimulationResult {
  const cashEvent: CashEvent = {
    id: `dep-${Date.now().toString(36)}`,
    amount: toCents(input.depositAmount),
    source: input.source,
    description: simulateDescription(input.source, input.depositAmount),
    occurredAt: new Date().toISOString(),
    checkingBalanceAfter: toNonNegativeCents(input.checkingBalanceAfter),
  };

  const domainRules = input.rules.map(ruleToDomain);
  const ordered = input.ruleId
    ? domainRules.filter((r) => r.id === input.ruleId)
    : [...domainRules].sort((a, b) => a.order - b.order);

  // Evaluate rules through the core engine (single decision source).
  const ruleResult = evaluateRulesCore(ordered, cashEvent);
  const capitalPlan = toCapitalPlan(cashEvent, ruleResult);

  // Map core evaluations back to the legacy UI shape.
  const evaluations = ruleResult.trace.map((e) => ({
    ruleId: e.ruleId,
    ruleName: e.ruleName,
    depositId: e.eventId,
    investmentAmount: toDollars(e.investmentAmount),
    qualified: e.qualified,
    decisions: e.decisions,
    reserveApplied: e.reserveApplied,
    skipped: e.skipped,
  }));

  const totalWouldInvest = toDollars(capitalPlan.deployable);

  let allocation: AllocationResult | null = null;
  if (!capitalPlan.isEmpty) {
    allocation = allocateContribution(
      input.portfolioState,
      totalWouldInvest,
      { prices: input.prices }
    );
  }

  return {
    deposit: {
      id: cashEvent.id,
      amount: toDollars(cashEvent.amount),
      source: cashEvent.source,
      description: cashEvent.description,
      occurredAt: cashEvent.occurredAt,
      checkingBalanceAfter: toDollars(cashEvent.checkingBalanceAfter),
    },
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

/**
 * Build a human-readable explanation for why a holding received funds.
 * Delegates to the core allocation engine's explanation records.
 */
export function explainAllocation(
  portfolioState: PortfolioState,
  allocation: AllocationResult,
  contribution: number
): AllocationExplanation[] {
  const holdingBySymbol = new Map(
    portfolioState.portfolio.holdings.map((h) => [h.symbol, h])
  );

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

// Re-export the pieces the UI/tests may still reach through this module.
export { allocateContribution };