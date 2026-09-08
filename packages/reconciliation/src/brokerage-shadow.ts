// Bridge: observed brokerage facts → the PortfolioState Shadow Mode consumes.
//
// v0.4.0 (Alpaca live read-only) proves that REAL observed account data flows
// through the complete Observe → Decide → Validate → Shadow pipeline. That
// pipeline's allocation stage (`allocate`) consumes a `PortfolioState`; the
// read-only brokerage adapter produces `BrokerageAccountState` +
// `BrokeragePosition[]`. This module is the ONE place those two shapes meet.
//
// It is a PURE mapping — no SQL, no provider SDK, no I/O, no policy. It turns
// reported positions into position snapshots and derives the portfolio those
// positions sit in, using integer cents throughout (never float money).
//
// NO order/transfer/mutation is expressed or reachable anywhere here.

import type {
  BrokeragePosition,
  Portfolio,
  PortfolioState,
  PositionSnapshot,
} from "@alepes/domain";
import { nonNegativeCents, sum, toNumber } from "@alepes/money";

/**
 * Build the minimal `Portfolio` an observed brokerage account maps into. Alepes
 * does not import external portfolio definitions, so the observed account is
 * represented as a single synthetic portfolio whose holdings mirror the observed
 * symbols. `targetPct` is 0 (targets are a user decision, never inferred from
 * observation); name/version are deterministic from the binding label.
 */
export function brokeragePortfolio(accountLabel: string, positions: BrokeragePosition[]): Portfolio {
  const seen = new Set<string>();
  const holdings = positions
    .map((p) => p.symbol)
    .filter((s) => {
      if (seen.has(s)) return false;
      seen.add(s);
      return true;
    })
    .map((symbol) => ({ symbol, name: symbol, targetPct: 0 }));
  return {
    id: `observed:${accountLabel}`,
    name: accountLabel,
    version: 1,
    holdings,
  };
}

/**
 * Convert observed broker positions into provider-neutral position snapshots.
 * Each snapshot carries the symbol + market value in integer cents. The
 * (display-only) name is the symbol; Alepes does not import provider security
 * names from the trading API.
 */
export function toPositionSnapshots(positions: BrokeragePosition[]): PositionSnapshot[] {
  return positions.map((p) => ({
    symbol: p.symbol,
    name: p.symbol,
    value: p.marketValueCents,
  }));
}

/**
 * Build a `PortfolioState` from observed brokerage facts. `totalValue` is the
 * exact integer-cent sum of position market values (NOT the broker's reported
 * portfolio_value, which also counts cash — the allocation stage needs equity
 * held, so we derive it from positions to avoid double-counting cash).
 */
export function brokerageToPortfolioState(
  accountLabel: string,
  positions: BrokeragePosition[]
): PortfolioState {
  const snapshots = toPositionSnapshots(positions);
  const total = sum(positions.map((p) => p.marketValueCents));
  return {
    portfolio: brokeragePortfolio(accountLabel, positions),
    positions: snapshots,
    totalValue: nonNegativeCents(toNumber(total)),
  };
}