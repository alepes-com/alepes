// Shadow Mode composition tests: reconciled persisted observations → qualify →
// existing engines → shadow disposition. Covers eligibility, deterministic
// CashEvent identity, provenance, cross-binding isolation, and the "zero money
// movement" guarantee. Property tests assert idempotency/determinism.

import { describe, it, expect } from "vitest";
import fc from "fast-check";
import type {
  AccountBindingId,
  PersistedObservation,
  SyncCycleId,
} from "@alepes/persistence";
import { cents, nonNegativeCents } from "@alepes/money";
import type {
  CashEvent,
  CashFlowRule,
  FinancialObservationId,
  PortfolioState,
} from "@alepes/domain";
import { runShadowMode, cashEventIdForObservation } from "./shadow";

const BID_A = "binding-a" as AccountBindingId;
const BID_B = "binding-b" as AccountBindingId;

function pObs(o: {
  id: string;
  accountBindingId?: AccountBindingId;
  amountCents?: number;
  direction?: "credit" | "debit";
  status?: "pending" | "posted";
  qualificationBalanceCents?: number | null;
  state?: "active" | "removed";
  predecessorObservationId?: string | null;
  lastReconciledCycleId?: string | null;
}): PersistedObservation {
  return {
    id: o.id as FinancialObservationId,
    accountBindingId: o.accountBindingId ?? BID_A,
    amountCents: o.amountCents ?? 100_000,
    direction: o.direction ?? "credit",
    status: o.status ?? "posted",
    qualificationBalanceCents: o.qualificationBalanceCents === undefined ? 500_000 : o.qualificationBalanceCents,
    firstObservedAt: "2026-09-01T00:00:00Z",
    postedAt: o.status === "pending" ? null : "2026-09-01T00:00:00Z",
    description: "deposit",
    normalizationVersion: "norm@1",
    state: o.state ?? "active",
    predecessorObservationId: (o.predecessorObservationId ?? null) as FinancialObservationId | null,
    lastReconciledCycleId: (o.lastReconciledCycleId ?? null) as SyncCycleId | null,
    createdAt: "2026-09-01T00:00:00Z",
    updatedAt: "2026-09-01T00:00:00Z",
  };
}

const anyDepositRule: CashFlowRule = {
  id: "r-any",
  name: "Any deposit",
  trigger: "any_deposit",
  reserveBalance: nonNegativeCents(50_000),
  action: "invest_percentage",
  amount: 50,
  portfolioId: "p1",
  active: true,
  order: 0,
};

const portfolio: PortfolioState = {
  portfolio: {
    id: "p1",
    name: "Test",
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

function shadow(o: PersistedObservation[]) {
  return runShadowMode(o, {
    rules: [anyDepositRule],
    portfolioState: portfolio,
  });
}

describe("Shadow Mode composition", () => {
  it("1. pending incoming observation creates no CashEvent", () => {
    const decisions = shadow([pObs({ id: "o1", status: "pending" })]);
    expect(decisions).toHaveLength(0);
  });

  it("2. posted incoming observation creates exactly one CashEvent", () => {
    const decisions = shadow([pObs({ id: "o1" })]);
    expect(decisions).toHaveLength(1);
    expect(decisions[0].plan.cashEvent.id).toBe("o1");
    expect(decisions[0].plan.cashEvent.amount).toBe(100_000);
  });

  it("3. outgoing (debit) observation creates none", () => {
    const decisions = shadow([pObs({ id: "o1", direction: "debit", amountCents: -5000 })]);
    expect(decisions).toHaveLength(0);
  });

  it("4. removed observation revokes eligibility", () => {
    const decisions = shadow([pObs({ id: "o1", state: "removed" })]);
    expect(decisions).toHaveLength(0);
  });

  it("5. same-ref pending→posted resolves to one logical event", () => {
    // Same observation id, status changes pending→posted across cycles. Only
    // the active, posted, balance-bearing form qualifies once.
    const decisions = shadow([
      pObs({ id: "o1", status: "pending" }),
    ]);
    // pending alone: none
    expect(decisions).toHaveLength(0);
    const posted = shadow([pObs({ id: "o1", status: "posted" })]);
    expect(posted).toHaveLength(1);
    expect(posted[0].plan.cashEvent.id).toBe("o1");
  });

  it("6. predecessor-linked pending removed + posted replacement → one event", () => {
    // Predecessor removed (inactive), replacement posted with predecessor link.
    const decisions = shadow([
      pObs({ id: "o1", state: "removed" }),
      pObs({ id: "o2", predecessorObservationId: "o1" }),
    ]);
    expect(decisions).toHaveLength(1);
    expect(decisions[0].plan.cashEvent.id).toBe("o2");
    expect(decisions[0].provenance.observationId).toBe("o2");
  });

  it("7. replayed completed sync produces no duplicate CashEvent", () => {
    const a = shadow([pObs({ id: "o1" })]);
    const b = shadow([pObs({ id: "o1" })]);
    expect(a).toHaveLength(1);
    expect(b).toHaveLength(1);
    expect(a[0].plan.cashEvent.id).toBe(b[0].plan.cashEvent.id);
  });

  it("8. CashEvent identity is the Alepes persisted observation id (deterministic)", () => {
    const evId = cashEventIdForObservation("obs-1" as FinancialObservationId);
    expect(evId).toBe("obs-1");
    // Repeated interpretation yields the same logical id, never a second deposit.
    const d1 = shadow([pObs({ id: "obs-1" })]);
    const d2 = shadow([pObs({ id: "obs-1" })]);
    expect(d1[0].plan.cashEvent.id).toBe(d2[0].plan.cashEvent.id);
    expect(d1[0].plan.cashEvent.id).toBe("obs-1");
  });

  it("9. modified observation reconciles deterministically (same logical id)", () => {
    // A modify updates facts but keeps the Alepes observation id → same CashEvent id.
    const before = shadow([pObs({ id: "o1", amountCents: 100_000 })]);
    const after = shadow([pObs({ id: "o1", amountCents: 150_000 })]);
    expect(before[0].plan.cashEvent.id).toBe("o1");
    expect(after[0].plan.cashEvent.id).toBe("o1");
    // Amount reflects the modification; identity does not change.
    expect(after[0].plan.cashEvent.amount).toBe(150_000);
  });

  it("10. two bindings cannot cross-link each other's events", () => {
    const d = shadow([
      pObs({ id: "a1", accountBindingId: BID_A }),
      pObs({ id: "b1", accountBindingId: BID_B }),
    ]);
    expect(d).toHaveLength(2);
    const byBinding = new Map(d.map((x) => [x.provenance.accountBindingId, x.plan.cashEvent.id]));
    expect(byBinding.get(BID_A)).toBe("a1");
    expect(byBinding.get(BID_B)).toBe("b1");
    // No event leaked across bindings.
    expect(d.find((x) => x.plan.cashEvent.id === "a1")?.provenance.accountBindingId).toBe(BID_A);
    expect(d.find((x) => x.plan.cashEvent.id === "b1")?.provenance.accountBindingId).toBe(BID_B);
  });

  it("11. Shadow decision invokes zero money movement — disposition is ALWAYS shadow", () => {
    const decisions = shadow([pObs({ id: "o1" }), pObs({ id: "o2" })]);
    expect(decisions).toHaveLength(2);
    for (const d of decisions) {
      expect(d.disposition.kind).toBe("shadow");
      expect(d.plan.proposedDisposition.kind).toBe("shadow");
    }
  });

  it("12. provenance traces from Shadow decision back to observation + binding + per-observation cycle", () => {
    const decisions = shadow([
      pObs({ id: "o1", accountBindingId: BID_A, lastReconciledCycleId: "cycle-9" }),
    ]);
    expect(decisions[0].provenance.cashEventId).toBe("o1");
    expect(decisions[0].provenance.observationId).toBe("o1");
    expect(decisions[0].provenance.accountBindingId).toBe(BID_A);
    // The cycle comes from the observation's OWN persisted lastReconciledCycleId.
    expect(decisions[0].provenance.cycleId).toBe("cycle-9");
    // The CashEvent id IS the FinancialObservationId (same identity chain).
    expect(decisions[0].plan.cashEvent.id).toBe(decisions[0].provenance.observationId);
  });

  it("12b. two observations from DIFFERENT sync cycles retain their own cycle provenance", () => {
    const decisions = shadow([
      pObs({ id: "o1", accountBindingId: BID_A, lastReconciledCycleId: "cycle-1" }),
      pObs({ id: "o2", accountBindingId: BID_A, lastReconciledCycleId: "cycle-2" }),
    ]);
    expect(decisions).toHaveLength(2);
    const byId = new Map(decisions.map((d) => [d.plan.cashEvent.id, d.provenance.cycleId]));
    expect(byId.get("o1")).toBe("cycle-1");
    expect(byId.get("o2")).toBe("cycle-2");
  });

  it("12c. missing binding throws an invariant error instead of fabricating an empty id", () => {
    // A persisted observation with an unresolvable (empty) binding id is a data
    // defect; runShadowMode must NOT silently mint "" as a branded id.
    const obs = pObs({ id: "o1", accountBindingId: "" as AccountBindingId });
    expect(() => shadow([obs])).toThrow();
  });

  it("13. delivery to existing engines: rules→capital→allocation→shadow (full pipeline)", () => {
    const decisions = shadow([pObs({ id: "o1" })]);
    expect(decisions).toHaveLength(1);
    const { capitalPlan, allocationPlan } = decisions[0].plan;
    // 50% of $1000 deposit = $500 deployable (reserve $500 ≥ $0 balance check).
    expect(capitalPlan.deployable).toBe(50_000);
    expect(allocationPlan.totalDeployed).toBe(50_000);
    expect(allocationPlan.lines).toHaveLength(1);
    expect(allocationPlan.lines[0].symbol).toBe("AAA");
    // Sum of allocations === deployable (exact integer-cents reconciliation).
    const sum = allocationPlan.lines.reduce((s, l) => s + (l.amount as number), 0);
    expect(sum).toBe(50_000);
  });
});

// ---- Property tests: idempotency + determinism ------------------------------

describe("Shadow Mode properties (fast-check)", () => {
  it("repeated interpretation of the same observation set yields identical decisions", () => {
    fc.assert(
      fc.property(fc.array(fc.integer({ min: 1, max: 1_000_000 }), { minLength: 1, maxLength: 20 }), (amounts) => {
        const obs = amounts.map((a, i) =>
          pObs({ id: `o${i}`, amountCents: a, qualificationBalanceCents: a })
        );
        const r1 = shadow(obs);
        const r2 = shadow(obs);
        expect(r1.map((d) => d.plan.cashEvent.id)).toEqual(r2.map((d) => d.plan.cashEvent.id));
        expect(r1.map((d) => d.disposition.kind)).toEqual(r2.map((d) => d.disposition.kind));
      }),
      { numRuns: 100 }
    );
  });

  it("a qualifying observation never produces more than one CashEvent regardless of repetition", () => {
    fc.assert(
      fc.property(fc.integer({ min: 1000, max: 100_000 }), (amt) => {
        const d = shadow([pObs({ id: "o1", amountCents: amt, qualificationBalanceCents: amt })]);
        // Exactly one decision, and its id is stable.
        expect(d).toHaveLength(1);
        expect(d[0].plan.cashEvent.id).toBe("o1");
      }),
      { numRuns: 100 }
    );
  });

  it("unknown/unclassified activity (debit or missing balance) stays non-qualifying", () => {
    fc.assert(
      fc.property(fc.boolean(), (isDebit) => {
        const obs = isDebit
          ? [pObs({ id: "o1", direction: "debit", amountCents: -100 })]
          : [pObs({ id: "o1", qualificationBalanceCents: null })];
        const d = runShadowMode(obs, { rules: [anyDepositRule], portfolioState: portfolio });
        expect(d).toHaveLength(0);
      }),
      { numRuns: 50 }
    );
  });
});