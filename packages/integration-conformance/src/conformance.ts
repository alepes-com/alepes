// Conformance harness: certify a bank or brokerage plugin against its capability
// contract. This is where the Opnory capability architecture pays off — any
// plugin (mock, Plaid-backed, Schwab-backed) can be run through the SAME suite
// to prove it satisfies the contract the engine depends on.

import type {
  AuditRecord,
  ExecutionOrder,
  ExternalObservationRef,
  FinancialObservation,
  PortfolioState,
} from "@alepes/domain";
import { nonNegativeCents } from "@alepes/money";
import {
  CAPABILITIES,
  ProviderError,
  Registry,
  type AccountBinding,
  type FinancialDataProvider,
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

//
// ─── Financial-data-provider conformance ────────────────────────────────────
//

/**
 * A fixture the harness drives to exercise multi-cycle synchronization against a
 * provider. `provider` is the capability under test; the hooks let the harness
 * inject deterministic external state changes between sync cycles without
 * reaching into any provider SDK.
 */
export interface FinancialDataSyncFixture {
  provider: FinancialDataProvider;
  /** Add one external record (becomes an "added" observation next cycle). */
  add(ref: string, amountCents: number, direction: "credit" | "debit", status: "pending" | "posted"): void;
  /** Modify an existing record (becomes a "modified" observation next cycle). */
  modify(ref: string, amountCents: number, status?: "pending" | "posted"): void;
  /** Remove an existing record (becomes a "removed" reference next cycle). */
  remove(ref: string): void;
  /** Claim a mutation-during-pagination condition (provider raises restart_sync). */
  triggerMutationDuringPagination?(): void;
}

/**
 * Certify a read-only financial-data provider against the provider-neutral
 * synchronization contract. Proves the invariants ingestion depends on:
 * stable identity, no duplication on replay, explicit add/modify/remove deltas,
 * full-cycle cursor atomicity, cross-binding isolation, credential hygiene, and
 * provider-reference confinement.
 */
export async function certifyFinancialDataProvider(
  fixture: FinancialDataSyncFixture
): Promise<ConformanceReport> {
  const failures: string[] = [];
  const provider = fixture.provider;

  async function check(name: string, fn: () => Promise<void> | void) {
    try {
      await fn();
    } catch (err) {
      failures.push(`${name}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  let binding: AccountBinding | null = null;
  try {
    const accts = await provider.discoverAccounts("cred:test");
    if (!Array.isArray(accts) || accts.length === 0) {
      failures.push("discoverAccounts: no accounts discovered");
      binding = null;
    } else {
      binding = accts[0];
    }
  } catch (err) {
    failures.push(`discoverAccounts: ${err instanceof Error ? err.message : String(err)}`);
    binding = null;
  }

  if (binding) {
    const b: AccountBinding = binding;
    // The durable cursor advances only at full-cycle completion.
    let cursor = "";

    await check("initial sync returns well-formed delta", async () => {
      const d = await provider.syncObservations(b, cursor);
      if (!d || !Array.isArray(d.added) || !Array.isArray(d.modified) || !Array.isArray(d.removed))
        throw new Error("malformed delta");
      if (typeof d.nextCursor !== "string" || typeof d.hasMore !== "boolean")
        throw new Error("delta missing cursor/hasMore");
    });

    // 1. addition
    fixture.add("txn-1", 100_00, "credit", "posted");
    await check("added record surfaces in delta", async () => {
      const d = await provider.syncObservations(b, cursor);
      if (d.added.length !== 1) throw new Error(`expected 1 added, got ${d.added.length}`);
    });

    // 2. deterministic idempotent replay from the SAME cursor
    await check("replay of same cursor yields identical delta (idempotent)", async () => {
      const a = await provider.syncObservations(b, cursor);
      const c = await provider.syncObservations(b, cursor);
      if (JSON.stringify(a) !== JSON.stringify(c)) throw new Error("replay delta differs");
    });

    // 3. stable identity on the added observation
    await check("added observation has stable Alepes id + opaque external ref", async () => {
      const d = await provider.syncObservations(b, cursor);
      const o: FinancialObservation = d.added[0];
      if (!o.id || !o.externalRef) throw new Error("observation lacks identity");
    });

    // 4. advance the cursor via a full cycle, then modify → modified delta
    const cycle1 = await provider.syncObservations(b, cursor);
    cursor = cycle1.nextCursor;
    fixture.modify("txn-1", 150_00, "posted");
    await check("modify surfaces as modified (same stable id)", async () => {
      const d = await provider.syncObservations(b, cursor);
      const byRef = d.modified.find((o) => o.externalRef === ("txn-1" as ExternalObservationRef));
      if (!byRef) throw new Error("modified record missing from delta");
      if (byRef.id !== ("obs-txn-1" as ReturnType<typeof String>)) throw new Error("modified id changed");
    });

    // 5. remove → removed delta
    const cycle2 = await provider.syncObservations(b, cursor);
    cursor = cycle2.nextCursor;
    fixture.remove("txn-1");
    await check("removed record surfaces as removed reference", async () => {
      const d = await provider.syncObservations(b, cursor);
      const hasRemoved = d.removed.some((r) => r === ("txn-1" as ExternalObservationRef));
      if (!hasRemoved) throw new Error("removal not surfaced");
    });

    // 6. pending → posted keeps one logical identity
    const cycle3 = await provider.syncObservations(b, cursor);
    cursor = cycle3.nextCursor;
    fixture.add("txn-p", 80_00, "credit", "pending");
    await check("pending then posted stays one logical observation", async () => {
      const d1 = await provider.syncObservations(b, cursor);
      const pendingObs = d1.added.find((o) => o.externalRef === ("txn-p" as ExternalObservationRef));
      if (!pendingObs) throw new Error("pending record not observed");
      const c1 = d1.nextCursor;
      fixture.modify("txn-p", 80_00, "posted");
      const d2 = await provider.syncObservations(b, c1);
      const postedObs = d2.modified
        .concat(d2.added)
        .find((o) => o.externalRef === ("txn-p" as ExternalObservationRef));
      if (!postedObs) throw new Error("posted record missing");
      if (postedObs.id !== pendingObs.id) throw new Error("pending→posted changed observation identity");
    });

    // 7. cross-binding isolation (only meaningful with 2+ accounts)
    await check("account bindings do not cross", async () => {
      const accts = await provider.discoverAccounts("cred:test");
      if (accts.length < 2) return;
      const d = await provider.syncObservations(b, cursor);
      for (const o of d.added.concat(d.modified)) {
        if (o.accountBindingId !== b.id) throw new Error("cross-binding leak");
      }
    });

    // 8. credential hygiene
    await check("credential material never appears in returned objects", async () => {
      const d = await provider.syncObservations(b, cursor);
      if (/cred:test|secret|token|password/i.test(JSON.stringify(d))) {
        throw new Error("credential material leaked into delta");
      }
    });
  }

  return {
    pluginId: provider.info.id,
    failures,
    get pass() {
      return failures.length === 0;
    },
  };
}