// Mock providers. These satisfy the provider interfaces with in-memory data
// and a simulated latency, so the app behaves like it's talking to a real
// integration. Swap the registry for real providers later without touching views.

import type { DepositEvent, PortfolioState } from "../domain/types";
import type {
  BankProvider,
  BrokerageProvider,
  DepositDetector,
  ProviderRegistry,
} from "./types";
import {
  activities,
  positions,
  portfolio,
  totalValue,
  prices,
} from "../data/mock";

const LATENCY_MS = 180;

function delay<T>(value: T): Promise<T> {
  return new Promise((res) => setTimeout(() => res(value), LATENCY_MS));
}

const checkingBalance = 4812.44;

const deposits: DepositEvent[] = activities
  .filter((a) => a.kind === "deposit")
  .map((a, i) => ({
    id: a.id,
    amount: a.amount ?? 0,
    source: (a.title.toLowerCase().includes("paycheck")
      ? "payroll"
      : a.title.toLowerCase().includes("bonus") || a.detail.toLowerCase().includes("bonus")
        ? "bonus"
        : a.detail.toLowerCase().includes("transfer")
          ? "transfer"
          : "other") as DepositEvent["source"],
    description: a.detail,
    occurredAt: a.at,
    checkingBalanceAfter: checkingBalance - i * 50,
  }));

export class MockBankProvider implements BankProvider {
  readonly id = "mock-checking";
  readonly name = "First Coast Bank ··4821";
  private listeners = new Set<(e: DepositEvent) => void>();

  async getCheckingBalance() {
    return delay(checkingBalance);
  }
  async listRecentDeposits(limit = 20) {
    return delay(deposits.slice(0, limit));
  }
  onDeposit(cb: (e: DepositEvent) => void) {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }
  emitDeposit(deposit: DepositEvent) {
    this.listeners.forEach((cb) => cb(deposit));
  }
}

export class MockBrokerageProvider implements BrokerageProvider {
  readonly id = "mock-brokerage";
  readonly name = "Apex Clearing ··8440";
  async getPortfolioState(): Promise<PortfolioState> {
    return delay({ portfolio, positions, totalValue });
  }
  async getPrices(symbols: string[]) {
    return delay(
      Object.fromEntries(symbols.map((s) => [s, prices[s] ?? 0]))
    );
  }
}

export class PollingDepositDetector implements DepositDetector {
  active = false;
  private timer: ReturnType<typeof setInterval> | null = null;
  constructor(private _bank: BankProvider, private intervalMs = 15000) {}
  start() {
    if (this.active) return;
    this.active = true;
    // In the MVP this is a heartbeat; real deposit detection is wired to the
    // bank provider's onDeposit stream via a future integration.
    this.timer = setInterval(() => {
      void this._bank.listRecentDeposits(1);
    }, this.intervalMs);
  }
  stop() {
    this.active = false;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}

const mockBank = new MockBankProvider();
const mockBrokerage = new MockBrokerageProvider();
const depositDetector = new PollingDepositDetector(mockBank);

export const mockRegistry: ProviderRegistry = {
  bank: mockBank,
  brokerage: mockBrokerage,
  detectors: [depositDetector],
};