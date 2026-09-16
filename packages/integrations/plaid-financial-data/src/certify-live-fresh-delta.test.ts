// Regression test for PR-head harness defect: certify-live.ts used to pass a
// lossy reporting projection (missing `state`, `accountBindingId`, etc.) into
// `qualifyCashEvents` and `runShadowMode`. Since qualifyCashEvents filters
// strictly on `o.state === \"active\"`, every observation was discarded and the
// harness emitted sync.no_qualifying_event despite a perfectly persisted credit.
//
// This test pins the real invariant: an authoritative PersistedObservation
// (exactly as listActiveObservations returns) must reach qualification/Shadow.

import { describe, it, expect } from "vitest";
import { qualifyCashEvents } from "@alepes/persistence";
import { runShadowMode } from "@alepes/reconciliation";
import type { PersistedObservation, AccountBindingId } from "@alepes/persistence";
import type { FinancialObservationId } from "@alepes/domain";
import { cents, nonNegativeCents } from "@alepes/money";
import { ulid } from "@alepes/persistence";

function persistedObservation(overrides: Partial<PersistedObservation> = {}): PersistedObservation {
  return {
    id: `obs-${ulid()}` as FinancialObservationId,
    accountBindingId: "binding-live" as AccountBindingId,
    amountCents: cents(1000), // +1000 cents = +$10.00 credit
    direction: "credit",
    status: "posted",
    qualificationBalanceCents: 30319,
    firstObservedAt: "2026-09-16T08:15:15.410Z",
    postedAt: "2026-09-16T08:15:15.410Z",
    description: "Deposit from 360 Performance Savings ***********",
    normalizationVersion: "plaid-sign-convention@1",
    state: "active",
    predecessorObservationId: null,
    lastReconciledCycleId: "sync_cycle-1" as never,
    createdAt: "2026-09-16T08:15:15.410Z",
    updatedAt: "2026-09-16T08:15:15.410Z",
    ...overrides,
  };
}

function certRule() {
  return {
    id: "r-live-cert",
    name: "Live certification rule",
    trigger: "any_deposit" as const,
    reserveBalance: nonNegativeCents(0),
    action: "invest_percentage" as const,
    amount: 50,
    portfolioId: "p1",
    active: true,
    order: 0,
  };
}

function certPortfolioState() {
  return {
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
}

describe("certify-live fresh-delta boundary (regression: PersistedObservation must reach qualification)", () => {
  it("qualification: one active posted +1000¢ credit with balance qualifies into exactly one CashEvent", () => {
    const obs = persistedObservation();
    // This is the direct call the harness makes. If the harness passed a lossy
    // projection missing `state`, this returns []; with the true
    // PersistedObservation it must return exactly one CashEvent.
    const events = qualifyCashEvents([obs]);
    expect(events).toHaveLength(1);
    expect(events[0].amount).toBe(1000);
    expect(events[0].checkingBalanceAfter).toBe(30319);
  });

  it("qualification: mixed delta of debit + pending + one posted credit qualifies only the credit", () => {
    const credit = persistedObservation();
    const postedDebit = persistedObservation({
      direction: "debit",
      amountCents: cents(-500),
      status: "posted",
      description: "CVS",
    });
    const pendingCredit = persistedObservation({
      status: "pending",
      postedAt: undefined,
      description: "Pending deposit",
    });
    const events = qualifyCashEvents([postedDebit, pendingCredit, credit]);
    expect(events).toHaveLength(1);
    expect(events[0].id).toBe(credit.id);
  });

  it("shadow: runShadowMode consumes the same PersistedObservation and yields one shadow decision with provenance", () => {
    const obs = persistedObservation();
    const decisions = runShadowMode([obs], {
      rules: [certRule()],
      portfolioState: certPortfolioState(),
    });
    expect(decisions).toHaveLength(1);
    const d = decisions[0];
    expect(d.disposition.kind).toBe("shadow");
    // 50% of $10 deployable = $5 = 500 cents
    expect(d.plan.capitalPlan.deployable).toBe(500);
    expect(d.plan.orders.length).toBeGreaterThanOrEqual(1);
    expect(d.plan.orders.every((o) => o.side === "buy")).toBe(true);
    // Provenance must flow through the persisted identity
    expect(d.provenance.observationId).toBe(obs.id);
  });
});
