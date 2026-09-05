// End-to-end (fixture-backed): a Plaid-shaped incoming transaction flows the
// FULL read-only path into Shadow Mode without ever invoking money movement.
//
//   Plaid fixture (transactions + account balances)
//     → adapter.syncObservations (sign flip + account-balance snapshot at the boundary)
//     → normalized FinancialObservation + AccountBalanceSnapshot
//     → persisted observation + qualification balance (reconciled)
//     → qualifyCashEvents → runShadowMode (shadow disposition only)
//
// The balance comes from the Plaid fixture/account-data boundary — it is NOT
// hand-injected after normalization. No live Plaid SDK call, no credentials.

import { describe, it, expect } from "vitest";
import {
  createPlaidFinancialDataProvider,
  incomingPlaidTransaction,
  plaidAccountWithBalances,
  syncResponse,
  type PlaidTransactionsSyncClient,
} from "@alepes/plaid-financial-data";
import { runShadowMode } from "@alepes/reconciliation";
import { selectAccountBalance } from "@alepes/domain";
import type { AccountBinding } from "@alepes/integration-runtime";
import type { ExternalObservationRef, FinancialObservationId } from "@alepes/domain";
import type { AccountBindingId, PersistedObservation, SyncCycleId } from "@alepes/persistence";
import type { PortfolioState, CashFlowRule } from "@alepes/domain";
import { nonNegativeCents } from "@alepes/money";

const rule: CashFlowRule = {
  id: "r-any",
  name: "Any deposit",
  trigger: "any_deposit",
  reserveBalance: nonNegativeCents(0),
  action: "invest_percentage",
  amount: 50,
  portfolioId: "p1",
  active: true,
  order: 0,
};

const portfolio: PortfolioState = {
  portfolio: {
    id: "p1",
    name: "Primary",
    version: 1,
    holdings: [
      { symbol: "AAA", name: "AAA", targetPct: 50 },
      { symbol: "BBB", name: "BBB", targetPct: 50 },
    ],
  },
  positions: [
    { symbol: "AAA", name: "AAA", value: nonNegativeCents(0) },
    { symbol: "BBB", name: "BBB", value: nonNegativeCents(100_000) },
  ],
  totalValue: nonNegativeCents(100_000),
};

function makeProvider(transactionsSync: PlaidTransactionsSyncClient["transactionsSync"]) {
  return createPlaidFinancialDataProvider({
    client: { transactionsSync },
    resolveAccessToken: async (ref) => (ref === "cred:a" ? "tok-a" : "tok-b"),
    discover: async () => [
      { accountId: "acct-1", name: "Checking" },
      { accountId: "acct-2", name: "Savings" },
    ],
  });
}

describe("fixture-backed Plaid → Shadow Mode (read-only)", () => {
  it("an incoming Plaid transaction qualifies via the adapter's account-balance snapshot (no synthetic balance)", async () => {
    const provider = makeProvider(async () => ({
      data: syncResponse({
        added: [incomingPlaidTransaction("txn-in", -800.0)], // -$800 Plaid = +$800 Alepes (money IN)
        accounts: [plaidAccountWithBalances({ available: 5000, current: 4900 }) as never],
        next_cursor: "c1",
        has_more: false,
      }),
    }));
    const binding: AccountBinding = (await provider.discoverAccounts("cred:a"))[0];

    // The adapter produces BOTH the transaction delta AND an account balance
    // snapshot — the balance is not injected by the test.
    const delta = await provider.syncObservations(binding, "");
    expect(delta.added).toHaveLength(1);
    expect(delta.added[0].direction).toBe("credit");
    expect(delta.added[0].amountCents).toBe(80_000);
    expect(delta.accountBalance).toBeDefined();
    expect(delta.accountBalance!.accountBindingId).toBe(binding.id);

    // The selected balance (available ?? current) is what qualification uses.
    const selected = selectAccountBalance(delta.accountBalance!);
    expect(selected).toBe(500_000); // available $5000.00

    // Build the persisted observation shape the SAME way reconcileSyncCycle does:
    // the durable id is minted by persistence, and the qualification balance is
    // the SELECTED account balance carried on the sync cycle (not per-transaction).
    const persisted: PersistedObservation = {
      id: "obs_01ARZ3NDEKTSV4RRFFQ69G5FAV" as FinancialObservationId,
      accountBindingId: "binding-acct-1" as AccountBindingId,
      amountCents: delta.added[0].amountCents,
      direction: delta.added[0].direction,
      status: delta.added[0].status,
      qualificationBalanceCents: selected,
      firstObservedAt: delta.added[0].firstObservedAt,
      postedAt: delta.added[0].postedAt ?? null,
      description: delta.added[0].description,
      normalizationVersion: delta.added[0].normalizationVersion,
      state: "active",
      predecessorObservationId: null,
      lastReconciledCycleId: "cycle-1" as SyncCycleId,
      createdAt: delta.added[0].firstObservedAt,
      updatedAt: delta.added[0].firstObservedAt,
    };

    const decisions = runShadowMode([persisted], { rules: [rule], portfolioState: portfolio });

    expect(decisions).toHaveLength(1);
    const d = decisions[0];

    // Shadow disposition only — no execution.
    expect(d.disposition.kind).toBe("shadow");
    expect(d.plan.proposedDisposition.kind).toBe("shadow");

    // It planned a deployment (50% of $800 = $400 toward the underweight holding).
    expect(d.plan.capitalPlan.deployable).toBe(40_000);
    expect(d.plan.allocationPlan.totalDeployed).toBe(40_000);

    // The CashEvent's balance is the ACCOUNT snapshot, not a fabricated
    // per-transaction "balance after".
    expect(d.plan.cashEvent.checkingBalanceAfter).toBe(500_000);

    // Provenance is intact: decision → CashEvent → FinancialObservationId → binding.
    expect(d.provenance.cashEventId).toBe("obs_01ARZ3NDEKTSV4RRFFQ69G5FAV");
    expect(d.provenance.observationId).toBe("obs_01ARZ3NDEKTSV4RRFFQ69G5FAV");
    expect(d.provenance.accountBindingId).toBe("binding-acct-1");
    expect(d.provenance.cycleId).toBe("cycle-1");

    // No order reaches any brokerage/transfer capability (shadow-only).
    expect(d.plan.orders.length).toBeGreaterThan(0);
    expect(d.disposition.kind).not.toBe("execute");
  });

  it("does not leak the provider external reference into financial-policy inputs", async () => {
    const provider = makeProvider(async () => ({
      data: syncResponse({
        added: [incomingPlaidTransaction("plaid-secret-tx-id", -100.0)],
        accounts: [plaidAccountWithBalances({ current: 500 }) as never],
        next_cursor: "c1",
        has_more: false,
      }),
    }));
    const binding: AccountBinding = (await provider.discoverAccounts("cred:a"))[0];
    const delta = await provider.syncObservations(binding, "");
    const obs = delta.added[0];
    expect(obs.externalRef).toBe("plaid-secret-tx-id" as ExternalObservationRef);
    const selected = selectAccountBalance(delta.accountBalance!);

    const durableId = "obs_01ARZ3NDEKTSV4RRFFQ69G5FAV" as FinancialObservationId;
    const persisted: PersistedObservation = {
      id: durableId,
      accountBindingId: "b" as AccountBindingId,
      amountCents: obs.amountCents,
      direction: obs.direction,
      status: obs.status,
      qualificationBalanceCents: selected,
      firstObservedAt: obs.firstObservedAt,
      postedAt: obs.postedAt ?? null,
      description: obs.description,
      normalizationVersion: obs.normalizationVersion,
      state: "active",
      predecessorObservationId: null,
      lastReconciledCycleId: null,
      createdAt: obs.firstObservedAt,
      updatedAt: obs.firstObservedAt,
    };

    const decisions = runShadowMode([persisted], { rules: [rule], portfolioState: portfolio });
    expect(decisions).toHaveLength(1);
    expect(decisions[0].plan.cashEvent.id).toBe(durableId);
    // The raw Plaid id never appears anywhere in the plan.
    const serialized = JSON.stringify(decisions.map((d) => d.plan));
    expect(serialized).not.toContain("plaid-secret-tx-id");
  });

  it("cached balances qualify for Shadow, and the snapshot is marked cached", async () => {
    const provider = makeProvider(async () => ({
      data: syncResponse({
        added: [incomingPlaidTransaction("txn-cached", -50.0)],
        accounts: [plaidAccountWithBalances({ available: null, current: 1234.56 }) as never],
        next_cursor: "c1",
        has_more: false,
      }),
    }));
    const binding: AccountBinding = (await provider.discoverAccounts("cred:a"))[0];
    const delta = await provider.syncObservations(binding, "");
    // available is null → falls back to current ($1234.56 → 123456 cents).
    const selected = selectAccountBalance(delta.accountBalance!);
    expect(selected).toBe(123_456);
    // The snapshot is explicitly flagged as provider-cached (Shadow-appropriate).
    expect(delta.accountBalance!.isCachedByProvider).toBe(true);
  });
});