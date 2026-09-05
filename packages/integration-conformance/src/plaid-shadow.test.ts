// End-to-end (fixture-backed): a Plaid-shaped incoming transaction flows the
// FULL read-only path into Shadow Mode without ever invoking money movement.
//
//   Plaid fixture → adapter.syncObservations (sign flip at boundary)
//     → normalized FinancialObservation → persisted observation shape
//     → qualifyCashEvents → runShadowMode (shadow disposition only)
//
// No live Plaid SDK call, no credentials, no brokerage/transfer capability.

import { describe, it, expect } from "vitest";
import { createPlaidFinancialDataProvider, type PlaidTransactionsSyncClient } from "@alepes/plaid-financial-data";
import { incomingPlaidTransaction, syncResponse } from "@alepes/plaid-financial-data";
import { runShadowMode } from "@alepes/reconciliation";
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

describe("fixture-backed Plaid → Shadow Mode (read-only)", () => {
  it("a qualified incoming Plaid transaction reaches Shadow Mode with no money movement", async () => {
    // 1. Adapter, driven by a deterministic Plaid-shaped fixture (no SDK call).
    const client: PlaidTransactionsSyncClient = {
      transactionsSync: async () => ({
        data: syncResponse({
          added: [incomingPlaidTransaction("txn-in", -800.0)], // -$800 Plaid = +$800 Alepes (money IN)
          next_cursor: "c1",
          has_more: false,
        }),
      }),
    };
    const provider = createPlaidFinancialDataProvider({
      client,
      resolveAccessToken: async () => "unused",
      discover: async () => [{ accountId: "acct-1", name: "Checking" }],
    });
    const accts = await provider.discoverAccounts("cred:x");
    const binding: AccountBinding = accts[0];

    // 2. Normalize via the adapter (the sign flip happens here).
    const delta = await provider.syncObservations(binding, "");
    expect(delta.added).toHaveLength(1);
    const obs = delta.added[0];
    expect(obs.direction).toBe("credit");
    expect(obs.amountCents).toBe(80_000); // +$800.00 in Alepes credits

    // 3. Persisted-observation shape (what reconcileSyncCycle stored).
    const persisted: PersistedObservation = {
      id: obs.id,
      accountBindingId: "binding-acct-1" as AccountBindingId,
      amountCents: obs.amountCents,
      direction: obs.direction,
      status: obs.status,
      balanceAfterCents: 5_000_00,
      firstObservedAt: obs.firstObservedAt,
      postedAt: obs.postedAt ?? null,
      description: obs.description,
      normalizationVersion: obs.normalizationVersion,
      state: "active",
      predecessorObservationId: null,
      createdAt: obs.firstObservedAt,
      updatedAt: obs.firstObservedAt,
    };

    // 4. Run Shadow Mode.
    const cycleId = "cycle-1" as SyncCycleId;
    const decisions = runShadowMode([persisted], { rules: [rule], portfolioState: portfolio, cycleId });

    expect(decisions).toHaveLength(1);
    const d = decisions[0];

    // Shadow disposition only — no execution.
    expect(d.disposition.kind).toBe("shadow");
    expect(d.plan.proposedDisposition.kind).toBe("shadow");

    // It DID plan a deployment (50% of $800 = $400 toward the underweight holding).
    expect(d.plan.capitalPlan.deployable).toBe(40_000);
    expect(d.plan.allocationPlan.totalDeployed).toBe(40_000);

    // Provenance is intact: decision → CashEvent → FinancialObservationId → binding.
    expect(d.provenance.cashEventId).toBe(obs.id);
    expect(d.provenance.observationId).toBe(obs.id);
    expect(d.provenance.accountBindingId).toBe("binding-acct-1");
    expect(d.provenance.cycleId).toBe(cycleId);

    // The CashEvent id is the Alepes observation id, NOT the Plaid transaction id.
    expect(d.plan.cashEvent.id).toBe(obs.id);
    expect(d.plan.cashEvent.id).not.toBe("txn-in");

    // No order was handed to any brokerage/transfer capability (orders are only
    // INSIDE the plan; the shadow disposition releases zero orders).
    expect(d.plan.orders.length).toBeGreaterThan(0);
    expect(d.disposition.kind).not.toBe("execute");
  });

  it("does not leak the provider external reference into financial-policy inputs", async () => {
    // The external Plaid id must appear only in provenance (via observation id
    // mapping), never inside the CashEvent or plans themselves. In the real
    // pipeline the persistence layer mints a ULID id and drops the adapter's
    // provisional `obs-${ref}` id, so the durable identity never encodes the ref.
    const client: PlaidTransactionsSyncClient = {
      transactionsSync: async () => ({
        data: syncResponse({
          added: [incomingPlaidTransaction("plaid-secret-tx-id", -100.0)],
          next_cursor: "c1",
          has_more: false,
        }),
      }),
    };
    const provider = createPlaidFinancialDataProvider({
      client,
      resolveAccessToken: async () => "x",
      discover: async () => [{ accountId: "acct-1", name: "Checking" }],
    });
    const binding: AccountBinding = (await provider.discoverAccounts("cred:x"))[0];
    const delta = await provider.syncObservations(binding, "");
    const obs = delta.added[0];
    expect(obs.externalRef).toBe("plaid-secret-tx-id" as ExternalObservationRef);

    // The durable, Alepes-minted id (what reconcileSyncCycle persists) is a ULID,
    // NOT the adapter's provisional `obs-plaid-secret-tx-id`.
    const durableId = "obs_01ARZ3NDEKTSV4RRFFQ69G5FAV" as FinancialObservationId;

    const persisted: PersistedObservation = {
      id: durableId,
      accountBindingId: "b" as AccountBindingId,
      amountCents: obs.amountCents,
      direction: obs.direction,
      status: obs.status,
      balanceAfterCents: 200_00,
      firstObservedAt: obs.firstObservedAt,
      postedAt: obs.postedAt ?? null,
      description: obs.description,
      normalizationVersion: obs.normalizationVersion,
      state: "active",
      predecessorObservationId: null,
      createdAt: obs.firstObservedAt,
      updatedAt: obs.firstObservedAt,
    };

    const decisions = runShadowMode([persisted], { rules: [rule], portfolioState: portfolio });
    expect(decisions).toHaveLength(1);
    // The CashEvent id is the durable Alepes id, not the provider ref, not the
    // adapter's provisional id.
    expect(decisions[0].plan.cashEvent.id).toBe(durableId);
    // The raw Plaid id never appears anywhere in the plan.
    const serialized = JSON.stringify(decisions.map((d) => d.plan));
    expect(serialized).not.toContain("plaid-secret-tx-id");
  });
});