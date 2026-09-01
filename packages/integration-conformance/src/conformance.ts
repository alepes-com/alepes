// Conformance harness: certify a bank or brokerage plugin against its capability
// contract. This is where the Opnory capability architecture pays off — any
// plugin (mock, Plaid-backed, Schwab-backed) can be run through the SAME suite
// to prove it satisfies the contract the engine depends on.

import type { AuditRecord, ExecutionOrder, PortfolioState } from "@alepes/domain";
import { nonNegativeCents } from "@alepes/money";
import {
  CAPABILITIES,
  Registry,
  type ListDeposits,
  type Plugin,
  type ReadCheckingBalance,
  type ReadPortfolio,
  type ReadPrices,
  type SubmitOrders,
} from "@alepes/integration-runtime";

export interface ConformanceReport {
  pluginId: string;
  failures: string[];
  get pass(): boolean;
}

async function check(name: string, failures: string[], fn: () => Promise<void> | void) {
  try {
    await fn();
  } catch (err) {
    failures.push(`${name}: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/** Certify a bank plugin provides read-checking-balance + list-deposits correctly. */
export async function certifyBank(plugin: Plugin): Promise<ConformanceReport> {
  const failures: string[] = [];
  const registry = new Registry();
  registry.install(plugin);

  const readBalance = registry.get<ReadCheckingBalance>(CAPABILITIES.readCheckingBalance);

  await check("bank exposes read-checking-balance capability", failures, () => {
    if (!readBalance) throw new Error("missing read-checking-balance capability");
  });

  if (readBalance) {
    await check("read-checking-balance returns a non-negative integer", failures, async () => {
      const bal = await readBalance.invoke();
      if (typeof bal !== "number" || !Number.isSafeInteger(bal) || bal < 0) {
        throw new Error(`non-negative integer expected, got ${bal}`);
      }
    });
  }

  const listDeposits = registry.get<ListDeposits>(CAPABILITIES.listDeposits);
  await check("bank exposes list-deposits capability", failures, () => {
    if (!listDeposits) throw new Error("missing list-deposits capability");
  });

  if (listDeposits) {
    await check("list-deposits returns an array of well-formed cash events", failures, async () => {
      const events = await listDeposits.invoke(5);
      if (!Array.isArray(events)) throw new Error("expected an array");
      for (const e of events) {
        if (!e.id || typeof e.amount !== "number" || !Number.isSafeInteger(e.amount)) {
          throw new Error(`malformed event: ${JSON.stringify(e)}`);
        }
      }
    });
  }

  return {
    pluginId: plugin.id,
    failures,
    get pass() {
      return failures.length === 0;
    },
  };
}

/** Certify a brokerage plugin provides portfolio/prices/submit capabilities. */
export async function certifyBrokerage(plugin: Plugin): Promise<ConformanceReport> {
  const failures: string[] = [];
  const registry = new Registry();
  registry.install(plugin);

  const readPortfolio = registry.get<ReadPortfolio>(CAPABILITIES.readPortfolio);
  await check("brokerage exposes read-portfolio", failures, () => {
    if (!readPortfolio) throw new Error("missing read-portfolio capability");
  });
  if (readPortfolio) {
    await check("read-portfolio returns a well-formed portfolio state", failures, async () => {
      const state: PortfolioState = await readPortfolio.invoke();
      if (!state.positions || !Array.isArray(state.positions)) throw new Error("missing positions");
      if (!state.portfolio?.holdings) throw new Error("missing holdings");
      const total = state.positions.reduce((s, p) => s + (p.value as number), 0);
      if (total !== (state.totalValue as number)) {
        throw new Error("positions do not sum to totalValue");
      }
    });
  }

  const readPrices = registry.get<ReadPrices>(CAPABILITIES.readPrices);
  await check("brokerage exposes read-prices", failures, () => {
    if (!readPrices) throw new Error("missing read-prices capability");
  });
  if (readPrices) {
    await check("read-prices returns cents per symbol for every requested symbol", failures, async () => {
      const prices = await readPrices.invoke(["AAPL", "MSFT"]);
      if (typeof prices !== "object" || prices === null) throw new Error("expected a map");
      for (const sym of ["AAPL", "MSFT"]) {
        if (typeof prices[sym] !== "number" || !Number.isSafeInteger(prices[sym])) {
          throw new Error(`missing/invalid price for ${sym}`);
        }
      }
    });
  }

  const submit = registry.get<SubmitOrders>(CAPABILITIES.submitOrders);
  await check("brokerage exposes submit-orders", failures, () => {
    if (!submit) throw new Error("missing submit-orders capability");
  });
  if (submit) {
    await check("submit-orders returns an audit record per order", failures, async () => {
      const orders: ExecutionOrder[] = [
        { id: "o1", symbol: "AAPL", amount: nonNegativeCents(100_00), side: "buy", shares: 1 },
      ];
      const records: AuditRecord[] = await submit.invoke(orders);
      if (!Array.isArray(records) || records.length !== orders.length) {
        throw new Error("expected one audit record per order");
      }
      for (const r of records) {
        if (!r.id || !r.at || !r.stage) throw new Error(`malformed audit record: ${JSON.stringify(r)}`);
      }
    });
  }

  return {
    pluginId: plugin.id,
    failures,
    get pass() {
      return failures.length === 0;
    },
  };
}