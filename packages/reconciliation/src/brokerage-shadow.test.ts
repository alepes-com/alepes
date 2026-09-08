import { describe, expect, it } from "vitest";
import type { BrokeragePosition } from "@alepes/domain";
import { nonNegativeCents, toNumber } from "@alepes/money";
import {
  brokeragePortfolio,
  brokerageToPortfolioState,
  toPositionSnapshots,
} from "./brokerage-shadow";

function pos(
  symbol: string,
  qty: string,
  marketValueCents: number,
  avgEntryCents = 0
): BrokeragePosition {
  return {
    symbol,
    quantity: qty,
    marketValueCents: nonNegativeCents(marketValueCents),
    averageEntryPriceCents: nonNegativeCents(avgEntryCents),
    currency: "USD",
  };
}

describe("brokerage-shadow bridge (observed facts → PortfolioState)", () => {
  it("maps positions to snapshots with integer-cent values", () => {
    const positions = [pos("AAPL", "10.500000", 189210, 17523), pos("MSFT", "5", 200000, 40000)];
    const snapshots = toPositionSnapshots(positions);
    expect(snapshots).toEqual([
      { symbol: "AAPL", name: "AAPL", value: 189210 },
      { symbol: "MSFT", name: "MSFT", value: 200000 },
    ]);
  });

  it("derives totalValue as the exact sum of position market values", () => {
    const positions = [pos("AAPL", "10.5", 189210), pos("MSFT", "5", 200000)];
    const state = brokerageToPortfolioState("Live Acct", positions);
    expect(toNumber(state.totalValue)).toBe(389210);
  });

  it("builds a synthetic portfolio whose holdings mirror observed symbols (targetPct 0)", () => {
    const positions = [pos("AAPL", "1", 100), pos("AAPL", "2", 200), pos("MSFT", "1", 50)];
    const state = brokerageToPortfolioState("Live Acct", positions);
    // AAPL appears twice but must dedupe to one holding.
    expect(state.portfolio.holdings.map((h) => h.symbol).sort()).toEqual(["AAPL", "MSFT"]);
    expect(state.portfolio.holdings.every((h) => h.targetPct === 0)).toBe(true);
    expect(state.portfolio.id).toBe("observed:Live Acct");
  });

  it("empty positions yield an empty portfolio with zero total", () => {
    const state = brokerageToPortfolioState("Live Acct", []);
    expect(state.positions).toEqual([]);
    expect(toNumber(state.totalValue)).toBe(0);
    expect(brokeragePortfolio("Live Acct", []).holdings).toEqual([]);
  });

  it("never references order/transfer/mutation surfaces", () => {
    const state = brokerageToPortfolioState("Live Acct", [pos("AAPL", "1", 100)]);
    expect(JSON.stringify(state)).not.toMatch(/order|submit|transfer|execute|place/i);
  });
});