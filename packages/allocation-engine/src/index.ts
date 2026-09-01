// Allocation engine: CapitalPlan → AllocationPlan.
//
// Contribution-based drift correction: route deployable capital toward the most
// underweight holdings so the portfolio returns to formation without selling.
//
// Invariants (enforced by construction, verified by tests):
//  - Sum of lines NEVER exceeds deployable capital.
//  - Sum of lines reconciles EXACTLY to totalDeployed (integer cents, no float).
//  - No line is ever negative.
//  - Overweight holdings receive nothing unless every permissible underweight
//    alternative is exhausted (and bands still permit it).
//  - Allocation bands behave correctly ON their boundaries (inclusive lower
//    edge; never overshoot past the upper edge).
//  - Determinism: identical inputs → byte-identical output.

import type {
  AllocationExplanation,
  AllocationLine,
  AllocationPlan,
  CapitalPlan,
  Holding,
  PositionSnapshot,
  PortfolioState,
} from "@alepes/domain";
import {
  type Cents,
  type NonNegativeCents,
  ZERO,
  cents,
  nonNegativeCents,
  asCents,
  sub,
  isZero,
  isNegative,
} from "@alepes/money";

export interface AllocationOptions {
  /** Minimum dollar size (cents) for any one funded line. */
  minTradeSize?: NonNegativeCents;
  /** Optional per-holding cap, cents. */
  maxPerHolding?: NonNegativeCents;
}

const DEFAULT_MIN_TRADE = nonNegativeCents(1_00); // $1.00

/** Current allocation of a position as a percentage (0–100). */
function positionPct(pos: PositionSnapshot, totalValue: NonNegativeCents): number {
  if (isZero(totalValue)) return 0;
  return ((pos.value as number) / (totalValue as number)) * 100;
}

function mulRatio(value: NonNegativeCents, ratio: number): Cents {
  return cents(Math.round((value as number) * ratio));
}

/** Dollar gap between current value and target value. + = underweight. */
export function underweightAmount(
  pos: PositionSnapshot,
  holding: Holding,
  totalValue: NonNegativeCents
): Cents {
  const targetValue = mulRatio(totalValue, holding.targetPct / 100);
  return sub(targetValue, pos.value);
}

/**
 * Actionable gap — the underweight amount, floored at zero. Overweight holdings
 * yield 0 and are therefore never candidates.
 */
export function actionableGap(
  pos: PositionSnapshot,
  holding: Holding,
  totalValue: NonNegativeCents
): NonNegativeCents {
  const gap = underweightAmount(pos, holding, totalValue);
  if (isNegative(gap)) return ZERO;
  return nonNegativeCents(gap as number);
}

function max0(c: Cents): NonNegativeCents {
  return c > ZERO ? nonNegativeCents(c as number) : ZERO;
}

/** Estimated fractional shares (informational only, not a monetary value). */
function shareEstimate(
  amountCents: NonNegativeCents,
  prices: Record<string, Cents> | undefined,
  symbol: string
): number {
  const price = prices?.[symbol];
  if (!price || isZero(price)) return 0;
  return (amountCents as number) / (price as number);
}

function formatCents(c: NonNegativeCents): string {
  const abs = c as number;
  const whole = Math.floor(abs / 100);
  const frac = (abs % 100).toString().padStart(2, "0");
  return `$${whole.toLocaleString("en-US")}.${frac}`;
}

/**
 * Allocate a CapitalPlan's deployable amount across underweight holdings.
 * The resulting plan's eventId mirrors the CapitalPlan's eventId.
 */
export function allocate(
  state: PortfolioState,
  plan: CapitalPlan,
  options: AllocationOptions = {}
): AllocationPlan {
  return allocateDeployable(state, plan.deployable, plan.eventId, options);
}

export function allocateDeployable(
  state: PortfolioState,
  deployable: NonNegativeCents,
  eventId: string,
  options: AllocationOptions = {}
): AllocationPlan {
  const base: AllocationPlan = {
    eventId,
    totalDeployed: ZERO,
    lines: [],
    skipped: [],
    explanations: [],
  };

  if (isZero(deployable) || state.positions.length === 0) return base;

  const { minTradeSize = DEFAULT_MIN_TRADE, maxPerHolding } = options;
  const { totalValue, positions, prices } = state;
  const holdings = state.portfolio.holdings;
  const holdingBySymbol = new Map(holdings.map((h) => [h.symbol, h]));

  // Candidates: underweight holdings with a positive actionable gap.
  const candidates = positions
    .flatMap((pos) => {
      const holding = holdingBySymbol.get(pos.symbol);
      if (!holding) return [];
      const gap = actionableGap(pos, holding, totalValue);
      if (isZero(gap)) return [];
      return [{ pos, holding, gap }];
    })
    .sort((a, b) => (b.gap as number) - (a.gap as number));

  const lines: AllocationLine[] = [];
  const skipped: AllocationPlan["skipped"] = [];
  const explanations: AllocationExplanation[] = [];
  let remaining: Cents = asCents(deployable);

  for (const { pos, holding, gap } of candidates) {
    if (isZero(remaining)) break;

    let allocateAmount: Cents = remaining < gap ? remaining : gap;
    if (maxPerHolding != null && allocateAmount > maxPerHolding) {
      allocateAmount = maxPerHolding;
    }

    // Hard stop at the band's upper edge — never overshoot past bandMax.
    if (holding.bandMaxPct != null) {
      const bandMaxValue = mulRatio(totalValue, holding.bandMaxPct / 100);
      const projected = (pos.value as number) + (allocateAmount as number);
      if (projected > (bandMaxValue as number)) {
        const headroom = max0(sub(bandMaxValue, pos.value));
        if (allocateAmount > headroom) allocateAmount = headroom;
      }
    }

    if (allocateAmount < minTradeSize) {
      if (!isZero(allocateAmount)) {
        skipped.push({
          symbol: pos.symbol,
          reason: `Below minimum trade size of ${formatCents(minTradeSize)}`,
        });
      }
      continue;
    }

    const amount = nonNegativeCents(allocateAmount as number);
    lines.push({
      symbol: pos.symbol,
      name: pos.name,
      amount,
      shares: shareEstimate(amount, prices, pos.symbol),
    });
    explanations.push({
      symbol: pos.symbol,
      name: pos.name,
      targetPct: holding.targetPct,
      beforePct: positionPct(pos, totalValue),
      underweightAmount: gap,
      amount,
      reason: `${pos.symbol} was underweight relative to its ${holding.targetPct}% target, so new money was directed there before selling other holdings.`,
    });

    remaining = sub(remaining, amount);
  }

  const totalDeployed = sub(deployable, remaining);

  return {
    eventId,
    totalDeployed: nonNegativeCents(totalDeployed as number),
    lines,
    skipped,
    explanations,
  };
}

/** Formation score: 0–100, decreasing with weighted absolute drift. */
export function formationScore(state: PortfolioState): number {
  const { totalValue, positions } = state;
  if (isZero(totalValue)) return 0;
  const holdings = state.portfolio.holdings;
  const holdingBySymbol = new Map(holdings.map((h) => [h.symbol, h]));

  let weightedDeviation = 0;
  for (const pos of positions) {
    const holding = holdingBySymbol.get(pos.symbol);
    if (!holding) continue;
    const weight = (pos.value as number) / (totalValue as number);
    weightedDeviation += Math.abs(positionPct(pos, totalValue) - holding.targetPct) * weight;
  }

  return Math.max(0, Math.round(100 - weightedDeviation * 3));
}

/** Current-vs-target drift report, largest |delta| first. */
export function driftReport(state: PortfolioState): Array<{
  symbol: string;
  name: string;
  targetPct: number;
  currentPct: number;
  deltaPct: number;
  action: "overweight" | "buy" | "hold";
}> {
  const { totalValue, positions } = state;
  const holdings = state.portfolio.holdings;
  const holdingBySymbol = new Map(holdings.map((h) => [h.symbol, h]));

  return positions
    .map((pos) => {
      const holding = holdingBySymbol.get(pos.symbol);
      const targetPct = holding?.targetPct ?? 0;
      const currentPct = positionPct(pos, totalValue);
      const deltaPct = currentPct - targetPct;
      return {
        symbol: pos.symbol,
        name: pos.name,
        targetPct,
        currentPct,
        deltaPct,
        action:
          deltaPct > 0.5
            ? ("overweight" as const)
            : deltaPct < -0.5
              ? ("buy" as const)
              : ("hold" as const),
      };
    })
    .sort((a, b) => Math.abs(b.deltaPct) - Math.abs(a.deltaPct));
}