// Allocation engine: contribution-based drift correction.
//
// Given a portfolio state and an incoming dollar amount, decide which holdings
// should receive the new money. The guiding principle: new contributions flow
// toward UNDERWEIGHT holdings so the portfolio returns to formation without
// selling anything. This is pure and deterministic — no network, no randomness.

import type {
  AllocationLine,
  AllocationResult,
  Holding,
  PositionSnapshot,
  PortfolioState,
} from "./types";

export interface AllocationOptions {
  /** Minimum dollar size for any one purchase line. */
  minTradeSize?: number;
  /** Current price per share, keyed by symbol. Enables fractional-share math. */
  prices?: Record<string, number>;
  /** If set, cap any single line to this many dollars. */
  maxPerHolding?: number;
}

const DEFAULT_MIN_TRADE = 1;

/**
 * Compute the dollar gap between current allocation and target for a holding.
 * Positive => underweight (needs money). Negative => overweight.
 */
export function underweightAmount(
  position: PositionSnapshot,
  holding: Holding,
  totalValue: number
): number {
  const targetValue = (holding.targetPct / 100) * totalValue;
  return targetValue - position.value;
}

/**
 * If a band is defined, only the portion of underweight that sits *inside* the
 * band's lower edge is actionable — but we still let money flow toward target.
 * For simplicity we treat the underweight gap as the distance back to target.
 */
export function effectiveGap(
  position: PositionSnapshot,
  holding: Holding,
  totalValue: number
): number {
  return Math.max(0, underweightAmount(position, holding, totalValue));
}

/**
 * Allocate `contribution` dollars across the portfolio, prioritizing the most
 * underweight holdings. Respects allocation bands, minimum trade size, and an
 * optional per-holding cap.
 *
 * Returns dollar amounts (not rounded to whole shares by default) and computes
 * estimated shares when prices are supplied.
 */
export function allocateContribution(
  state: PortfolioState,
  contribution: number,
  options: AllocationOptions = {}
): AllocationResult {
  const { minTradeSize = DEFAULT_MIN_TRADE, prices, maxPerHolding } = options;
  const { totalValue, positions } = state;
  const holdings = state.portfolio.holdings;

  if (contribution <= 0) {
    return { totalDeployed: 0, lines: [], skipped: [] };
  }

  const holdingBySymbol = new Map(holdings.map((h) => [h.symbol, h]));

  // Build candidates: every holding with a positive (underweight) gap.
  const candidates = positions
    .flatMap((pos) => {
      const holding = holdingBySymbol.get(pos.symbol);
      if (!holding) return [];
      const gap = effectiveGap(pos, holding, totalValue);
      if (gap <= 0) return [];
      return [{ pos, holding, gap }];
    })
    .sort((a, b) => b.gap - a.gap);

  const lines: AllocationLine[] = [];
  const skipped: AllocationResult["skipped"] = [];
  let remaining = contribution;

  for (const { pos, holding, gap } of candidates) {
    if (remaining <= 0) break;

    let allocate = Math.min(remaining, gap);
    if (maxPerHolding != null) allocate = Math.min(allocate, maxPerHolding);

    // Respect allocation band upper edge — don't overshoot past bandMax.
    if (holding.bandMaxPct != null) {
      const bandMaxValue = (holding.bandMaxPct / 100) * totalValue;
      const headroom = Math.max(0, bandMaxValue - (pos.value + allocate));
      allocate -= Math.max(0, allocate - headroom);
    }

    if (allocate < minTradeSize) {
      if (allocate > 0) {
        skipped.push({
          symbol: pos.symbol,
          reason: `Below minimum trade size (${minTradeSize})`,
        });
      }
      continue;
    }

    const shares =
      prices && prices[pos.symbol] ? allocate / prices[pos.symbol] : 0;
    const beforePct = pos.currentPct;
    const afterValue = pos.value + allocate;
    const afterTotal = totalValue + lines.reduce((s, l) => s + l.amount, 0) + allocate;
    const afterPct = (afterValue / afterTotal) * 100;

    lines.push({
      symbol: pos.symbol,
      name: pos.name,
      amount: round2(allocate),
      shares: Number(shares.toFixed(6)),
      beforePct: round2(beforePct),
      afterPct: round2(afterPct),
      underweightAmount: round2(gap),
    });

    remaining -= allocate;
  }

  // Round each line to cents and reconcile the remainder to the largest line.
  const roundedLines = lines.map((l) => ({ ...l, amount: round2(l.amount) }));
  const totalRounded = round2(
    roundedLines.reduce((s, l) => s + l.amount, 0)
  );
  const deployed = round2(contribution - remaining);
  const diff = round2(deployed - totalRounded);
  if (diff !== 0 && roundedLines.length > 0) {
    // Adjust the largest line to absorb the rounding remainder.
    roundedLines.sort((a, b) => b.amount - a.amount);
    roundedLines[0].amount = round2(roundedLines[0].amount + diff);
    roundedLines.sort((a, b) => b.amount - a.amount);
  }

  return {
    totalDeployed: round2(deployed),
    lines: roundedLines,
    skipped,
  };
}

/**
 * Compute how "in formation" a portfolio is: 100 = perfectly on target,
 * decreasing as holdings drift. Uses weighted absolute deviation.
 */
export function formationScore(state: PortfolioState): number {
  const { totalValue, positions } = state;
  const holdings = state.portfolio.holdings;
  const holdingBySymbol = new Map(holdings.map((h) => [h.symbol, h]));

  let weightedDeviation = 0;
  for (const pos of positions) {
    const holding = holdingBySymbol.get(pos.symbol);
    if (!holding) continue;
    const weight = pos.value / totalValue;
    weightedDeviation += Math.abs(pos.currentPct - holding.targetPct) * weight;
  }

  // Scale: 100 with zero deviation, floor toward 0 as deviation grows.
  const score = Math.max(0, 100 - weightedDeviation * 3);
  return Math.round(score);
}

export function round2(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

/** For each holding, current-vs-target drift, sorted by magnitude desc. */
export function driftReport(state: PortfolioState) {
  const holdings = state.portfolio.holdings;
  const holdingBySymbol = new Map(holdings.map((h) => [h.symbol, h]));
  return state.positions
    .map((pos) => {
      const holding = holdingBySymbol.get(pos.symbol);
      const targetPct = holding?.targetPct ?? 0;
      const delta = pos.currentPct - targetPct;
      return {
        symbol: pos.symbol,
        name: pos.name,
        targetPct,
        currentPct: pos.currentPct,
        delta: round2(delta),
        action:
          delta > 0.5
            ? ("overweight" as const)
            : delta < -0.5
              ? ("buy" as const)
              : ("hold" as const),
      };
    })
    .sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta));
}