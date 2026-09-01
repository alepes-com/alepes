// FACADE — delegates all allocation math to @alepes/allocation-engine.
//
// Public API is unchanged for the React UI (dollar floats in, dollar floats
// out). This module converts dollars → cents, calls the pure integer-cents
// allocation engine, and converts back. No financial logic lives here.

import {
  allocateDeployable as allocateDeployableCore,
  formationScore as formationScoreCore,
  driftReport as driftReportCore,
  underweightAmount as underweightAmountCore,
  actionableGap as actionableGapCore,
  type AllocationOptions as DomainAllocationOptions,
} from "@alepes/allocation-engine";
import type {
  AllocationLine,
  AllocationResult,
  PortfolioState,
} from "./types";
import {
  portfolioStateToDomain,
  toCents,
  toNonNegativeCents,
  toDollars,
} from "./marshal";

export interface AllocationOptions {
  minTradeSize?: number;
  prices?: Record<string, number>;
  maxPerHolding?: number;
}

/**
 * Compute the dollar gap between current allocation and target for a holding.
 * Positive => underweight; negative => overweight. (Delegates to core.)
 */
export function underweightAmount(
  position: { value: number },
  holding: { targetPct: number },
  totalValue: number
): number {
  return toDollars(
    underweightAmountCore(
      { symbol: "", name: "", value: toNonNegativeCents(position.value) },
      { symbol: "", name: "", targetPct: holding.targetPct },
      toNonNegativeCents(totalValue)
    )
  );
}

/** Actionable (non-negative) gap. (Delegates to core.) */
export function effectiveGap(
  position: { value: number },
  holding: { targetPct: number },
  totalValue: number
): number {
  return toDollars(
    actionableGapCore(
      { symbol: "", name: "", value: toNonNegativeCents(position.value) },
      { symbol: "", name: "", targetPct: holding.targetPct },
      toNonNegativeCents(totalValue)
    )
  );
}

/** Alias kept for the legacy exports — same as effectiveGap. */
export const actionableGap = effectiveGap;

/**
 * Allocate `contribution` dollars across the portfolio. Delegates to the core
 * engine; converts dollars → cents in and cents → dollars out.
 */
export function allocateContribution(
  state: PortfolioState,
  contribution: number,
  options: AllocationOptions = {}
): AllocationResult {
  const domainState = portfolioStateToDomain(state);
  // Inject prices (dollars/share → cents/share) so the core computes shares.
  if (options.prices) {
    domainState.prices = Object.fromEntries(
      Object.entries(options.prices).map(([sym, price]) => [sym, toCents(price)])
    );
  }
  const opts: DomainAllocationOptions = {
    minTradeSize:
      options.minTradeSize != null ? toNonNegativeCents(options.minTradeSize) : undefined,
    maxPerHolding:
      options.maxPerHolding != null ? toNonNegativeCents(options.maxPerHolding) : undefined,
  };
  const plan = allocateDeployableCore(
    domainState,
    toNonNegativeCents(Math.max(0, contribution)),
    "facade",
    opts
  );

  const lines: AllocationLine[] = plan.lines.map((line) => {
    const pos = state.positions.find((p) => p.symbol === line.symbol);
    const beforePct = pos?.currentPct ?? 0;
    const afterValue = toDollars(line.amount) + (pos?.value ?? 0);
    const newTotal = state.totalValue + toDollars(plan.totalDeployed);
    const afterPct = newTotal > 0 ? (afterValue / newTotal) * 100 : 0;
    const explanation = plan.explanations.find((e) => e.symbol === line.symbol);
    return {
      symbol: line.symbol,
      name: line.name,
      amount: toDollars(line.amount),
      shares: line.shares,
      beforePct,
      afterPct,
      underweightAmount:
        explanation != null ? toDollars(explanation.underweightAmount) : 0,
    };
  });

  return {
    totalDeployed: toDollars(plan.totalDeployed),
    lines,
    skipped: plan.skipped,
  };
}

/**
 * Formation score (0–100) — delegates to the core engine, which computes it
 * from integer-cents state.
 */
export function formationScore(state: PortfolioState): number {
  return formationScoreCore(portfolioStateToDomain(state));
}

/** Current-vs-target drift, sorted by magnitude. (Delegates to core.) */
export function driftReport(state: PortfolioState): Array<{
  symbol: string;
  name: string;
  targetPct: number;
  currentPct: number;
  delta: number;
  action: "overweight" | "buy" | "hold";
}> {
  return driftReportCore(portfolioStateToDomain(state)).map((d) => ({
    symbol: d.symbol,
    name: d.name,
    targetPct: d.targetPct,
    currentPct: d.currentPct,
    delta: d.deltaPct,
    action: d.action,
  }));
}

/** Deterministic cent rounding (retained for the legacy public API surface). */
export function round2(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}