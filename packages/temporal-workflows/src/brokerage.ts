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
 * A mock brokerage executor that models the exactly-once contract a real
 * brokerage provides through `idempotencyKey`.
 *
 * - The first `executeOrders` for a given key records one fill for that key.
 * - A later `executeOrders` that repeats an already-filled key returns the
 *   SAME fill without double-counting (this is what makes a Temporal replay /
 *   activity-retry safe: the boundary, not the workflow, dedups).
 *
 * `calls` counts *invocations* (how many times `executeOrders` ran), while
 * `fillCountByKey` counts *financial effects* (how many fills were actually
 * recorded per key). The "effectively-once" invariant is
 * `fillCountByKey(k) === 1` even when `calls > 1`.
 */
export function createMockBrokerageExecutor(): BrokerageExecutor & {
  /** Invocation count (may exceed the number of financial effects). */
  calls: number;
  /** Fills actually recorded, keyed by idempotency key. */
  fillsByKey: Map<string, FilledOrder>;
} {
  let calls = 0;
  const fillsByKey = new Map<string, FilledOrder>();

  return {
    get calls() {
      return calls;
    },
    fillsByKey,
    async executeOrders(orders) {
      calls += 1;
      const fills: FilledOrder[] = orders.map((o) => {
        const key = o.idempotencyKey;
        const prior = fillsByKey.get(key);
        if (prior) {
          // Already filled once — replay/retry returns the existing effect.
          return prior;
        }
        const fill: FilledOrder = {
          orderId: o.id,
          symbol: o.symbol,
          filledCents: o.amountCents,
          filledShares: o.shares,
          filledAt: new Date(0).toISOString(),
          idempotencyKey: key,
        };
        fillsByKey.set(key, fill);
        return fill;
      });
      return { ok: true, fills, calls };
    },
  };
}