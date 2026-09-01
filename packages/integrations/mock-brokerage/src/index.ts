// Mock brokerage plugin: provides portfolio-read, price-read, and order-submit
// capabilities. Submission is recorded into an in-memory ledger and returns
// audit records — it never talks to a real brokerage.

import type {
  AuditRecord,
  ExecutionOrder,
  PortfolioState,
} from "@alepes/domain";
import { cents, type Cents } from "@alepes/money";
import {
  CAPABILITIES,
  type Capability,
  type Plugin,
  type ReadPortfolio,
  type ReadPrices,
  type SubmitOrders,
} from "@alepes/integration-runtime";

export interface MockBrokerageState {
  portfolio: PortfolioState;
  prices: Record<string, Cents>;
}

export interface MockBrokerage {
  plugin: Plugin;
  /** Audit records produced by executed orders, in order. */
  executed: AuditRecord[];
  /** Execute orders directly (bypassing the capability) for convenience. */
  submit(orders: ExecutionOrder[]): AuditRecord[];
}

export function createMockBrokerage(initial: MockBrokerageState): MockBrokerage {
  const portfolio = initial.portfolio;
  const prices = { ...initial.prices };
  const executed: AuditRecord[] = [];

  const readPortfolio: ReadPortfolio = {
    id: CAPABILITIES.readPortfolio,
    name: "Read portfolio",
    version: "1.0.0",
    description: "Return the current portfolio state.",
    invoke: async () => portfolio,
  };

  const readPrices: ReadPrices = {
    id: CAPABILITIES.readPrices,
    name: "Read prices",
    version: "1.0.0",
    description: "Return current price per share (cents) for symbols.",
    invoke: async (symbols: string[]) =>
      Object.fromEntries(symbols.map((s) => [s, prices[s] ?? cents(0)])),
  };

  function submitOrdersFn(orders: ExecutionOrder[]): AuditRecord[] {
    const records: AuditRecord[] = [];
    for (const o of orders) {
      const at = new Date().toISOString();
      records.push({
        id: `${o.id}-exec`,
        at,
        eventId: o.id,
        stage: "executed",
        summary: `Executed ${o.side} ${o.symbol}`,
        detail: `${o.side.toUpperCase()} ${o.symbol} for ${o.shares.toFixed(6)} shares (${o.amount}¢).`,
        amountCents: o.amount,
      });
    }
    return records;
  }

  const submitOrders: SubmitOrders = {
    id: CAPABILITIES.submitOrders,
    name: "Submit orders",
    version: "1.0.0",
    description: "Submit a batch of orders and return audit records.",
    invoke: async (orders: ExecutionOrder[]) => {
      const records = submitOrdersFn(orders);
      executed.push(...records);
      return records;
    },
  };

  const capabilities = new Map<string, Capability>([
    [CAPABILITIES.readPortfolio, readPortfolio],
    [CAPABILITIES.readPrices, readPrices],
    [CAPABILITIES.submitOrders, submitOrders],
  ]);

  const plugin: Plugin = {
    id: "plugin:mock-brokerage",
    name: "Mock Brokerage",
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

  return { plugin, executed, submit: submitOrdersFn };
}