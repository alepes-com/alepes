// Provider abstraction layer. Real bank/brokerage integrations plug in here
// later — the MVP ships a MockBankProvider and MockBrokerageProvider. The rest
// of the app only ever imports these interfaces (and the provider registry),
// never a concrete third-party SDK.

import type { DepositEvent, PortfolioState } from "../domain/types";

/** Read-side: observe checking balances and deposit events. */
export interface BankProvider {
  readonly id: string;
  readonly name: string;
  getCheckingBalance(): Promise<number>;
  listRecentDeposits(limit?: number): Promise<DepositEvent[]>;
  /** Subscribe to deposit callbacks (depositDetector uses this). */
  onDeposit(cb: (e: DepositEvent) => void): () => void;
}

/** Read-side: observe portfolio positions and prices. */
export interface BrokerageProvider {
  readonly id: string;
  readonly name: string;
  getPortfolioState(): Promise<PortfolioState>;
  getPrices(symbols: string[]): Promise<Record<string, number>>;
}

/** Detects deposits by polling/streaming a BankProvider. */
export interface DepositDetector {
  start(): void;
  stop(): void;
  readonly active: boolean;
}

/** A single place to look up providers so views stay decoupled from mocks. */
export interface ProviderRegistry {
  bank: BankProvider;
  brokerage: BrokerageProvider;
  detectors: DepositDetector[];
}