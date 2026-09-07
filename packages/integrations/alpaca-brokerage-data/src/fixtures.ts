// Deterministic Alpaca fixtures. These are Alpaca-TYPED internally (matching the
// real API's decimal-string money / positions / quotes shapes) but are exported
// only for building injectable clients in conformance and unit tests. The public
// adapter surface never exposes Alpaca values.

import type { AlpacaAccount, AlpacaPosition, AlpacaQuote } from "./index";

export function alpacaAccount(overrides: Partial<AlpacaAccount> = {}): AlpacaAccount {
  return {
    id: "paper-acct-123",
    account_number: "PA1234567890",
    status: "ACTIVE",
    currency: "USD",
    cash: "24812.16",
    buying_power: "49624.32",
    portfolio_value: "100000.00",
    equity: "100000.00",
    ...overrides,
  };
}

export function alpacaPosition(overrides: Partial<AlpacaPosition> = {}): AlpacaPosition {
  return {
    asset_id: "asset-aapl",
    symbol: "AAPL",
    qty: "10.500000",
    market_value: "1892.10",
    avg_entry_price: "175.23",
    currency: "USD",
    ...overrides,
  };
}

export function alpacaQuote(overrides: Partial<AlpacaQuote> = {}): AlpacaQuote {
  return { ap: 180.25, bp: 180.10, ...overrides };
}

export interface StaticAlpacaClientSpec {
  account?: AlpacaAccount;
  positions?: AlpacaPosition[];
  quotes?: Record<string, AlpacaQuote>;
}

export interface StaticAlpacaClient {
  getAccount(): Promise<{ status: number; data: AlpacaAccount }>;
  getPositions(): Promise<{ status: number; data: AlpacaPosition[] }>;
  getQuote(symbol: string): Promise<{ status: number; data: AlpacaQuote }>;
}

/** Build a deterministic in-memory Alpaca client for tests/conformance. */
export function makeStaticAlpacaClient(spec: StaticAlpacaClientSpec = {}): StaticAlpacaClient {
  const account = spec.account ?? alpacaAccount();
  const positions = spec.positions ?? [alpacaPosition()];
  const quotes = spec.quotes ?? { AAPL: alpacaQuote() };
  return {
    getAccount: async () => ({ status: 200, data: account }),
    getPositions: async () => ({ status: 200, data: positions }),
    getQuote: async (symbol: string) => ({
      status: 200,
      data: quotes[symbol] ?? alpacaQuote(),
    }),
  };
}