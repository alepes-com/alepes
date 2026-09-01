// Mock bank plugin: provides checking-balance + deposit-listing capabilities
// with deterministic in-memory data. Implements the capability contracts from
// @alepes/integration-runtime. No real bank, no network.

import type { CashEvent } from "@alepes/domain";
import { nonNegativeCents, cents, type NonNegativeCents } from "@alepes/money";
import {
  CAPABILITIES,
  type Capability,
  type ListDeposits,
  type Plugin,
  type ReadCheckingBalance,
} from "@alepes/integration-runtime";

export interface MockBankState {
  checkingBalance: NonNegativeCents;
  deposits: CashEvent[];
}

/** A mock bank with in-memory, deterministic state + simple mutation hooks. */
export interface MockBank {
  plugin: Plugin;
  setBalance(next: NonNegativeCents): void;
  pushDeposit(event: CashEvent): void;
  getBalance(): NonNegativeCents;
}

export function createMockBank(initial: MockBankState): MockBank {
  const state: MockBankState = {
    checkingBalance: initial.checkingBalance,
    deposits: [...initial.deposits],
  };

  const readCheckingBalance: ReadCheckingBalance = {
    id: CAPABILITIES.readCheckingBalance,
    name: "Read checking balance",
    version: "1.0.0",
    description: "Return the current checking balance.",
    invoke: async () => state.checkingBalance,
  };

  const listDeposits: ListDeposits = {
    id: CAPABILITIES.listDeposits,
    name: "List deposits",
    version: "1.0.0",
    description: "List the most recent deposit events.",
    invoke: async (limit = 20) => state.deposits.slice(0, limit),
  };

  const capabilities = new Map<string, Capability>([
    [CAPABILITIES.readCheckingBalance, readCheckingBalance],
    [CAPABILITIES.listDeposits, listDeposits],
  ]);

  const plugin: Plugin = {
    id: "plugin:mock-bank",
    name: "Mock Bank",
    version: "1.0.0",
    capabilities,
    lifecycle: {
      async connect() {},
      async disconnect() {},
      async health() {
        return null;
      },
    },
  };

  return {
    plugin,
    setBalance(next) {
      state.checkingBalance = next;
    },
    pushDeposit(event) {
      state.deposits = [event, ...state.deposits];
      state.checkingBalance = event.checkingBalanceAfter;
    },
    getBalance() {
      return state.checkingBalance;
    },
  };
}

/** Convenience: a sample paycheck cash event, deterministic aside from the id. */
export function samplePaycheck(overrides: Partial<CashEvent> = {}): CashEvent {
  return {
    id: "paycheck-1",
    amount: cents(2814_32),
    source: "payroll",
    description: "Payroll +$2,814.32 from Acme Payroll",
    occurredAt: "2026-08-31T09:12:45Z",
    checkingBalanceAfter: nonNegativeCents(4812_44),
    ...overrides,
  };
}