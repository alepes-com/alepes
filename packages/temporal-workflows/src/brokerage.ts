import type { FilledOrder, OrderLine } from "./types";

/**
 * Brokerage executor: the port through which the worker invokes the brokerage
 * capability. Implementations MUST be idempotent with respect to
 * `order.idempotencyKey`.
 *
 * This is an infrastructure adapter — it is INVOKED by the Temporal workflow
 * with ExecutionDisposition already applied. See `BrokerageExecutor.executeOrders`
 * where `orders` are the output of the execution policy gate.
 */
export interface BrokerageExecutor {
  executeOrders(orders: OrderLine[]): Promise<BrokerageResult>;
}

export interface BrokerageResult {
  ok: boolean;
  fills: FilledOrder[];
  error?: string;
  /** Number of times the underlying capability was actually invoked. */
  calls: number;
}

/**
 * Mock brokerage executor backed by @alepes/mock-brokerage in-memory plugin.
 * For Temporal tests we usually swap in a spy implementing the same interface.
 * NOTE: this is invoked by the Temporal activity layer with policy-gated orders.
 */
export function createMockBrokerageExecutor(): BrokerageExecutor & { calls: number } {
  let calls = 0;
  return {
    calls,
    async executeOrders(orders) {
      calls += 1;
      const fills: FilledOrder[] = orders.map((o) => ({
        orderId: o.id,
        symbol: o.symbol,
        filledCents: o.amountCents,
        filledShares: o.shares,
        filledAt: new Date(0).toISOString(),
        idempotencyKey: o.idempotencyKey,
      }));
      return { ok: true, fills, calls: 1 };
    },
  };
}
