import { describe, it, expect } from "vitest";
import { qualifyCashEvents } from "./reconcile";
import type { PersistedObservation } from "./sync-ports";
import type { AccountBindingId, SyncCycleId } from "./sync-ports";
import type { FinancialObservationId } from "@alepes/domain";

const BID = "b1" as AccountBindingId;

function pObs(o: Omit<Partial<PersistedObservation>, "id" | "qualificationBalanceCents"> & { id: string; qualificationBalanceCents?: number | null }): PersistedObservation {
  return {
    id: o.id as FinancialObservationId,
    accountBindingId: o.accountBindingId ?? BID,
    amountCents: o.amountCents ?? 100000,
    direction: o.direction ?? "credit",
    status: o.status ?? "posted",
    qualificationBalanceCents: o.qualificationBalanceCents === undefined ? 500000 : o.qualificationBalanceCents,
    firstObservedAt: o.firstObservedAt ?? "2026-09-01T00:00:00Z",
    postedAt: o.postedAt ?? "2026-09-01T00:00:00Z",
    description: "record",
    normalizationVersion: "norm@1",
    state: o.state ?? "active",
    predecessorObservationId: (o.predecessorObservationId ?? null) as FinancialObservationId | null,
    lastReconciledCycleId: (o.lastReconciledCycleId ?? null) as SyncCycleId | null,
    createdAt: "2026-09-01T00:00:00Z",
    updatedAt: "2026-09-01T00:00:00Z",
  };
}

describe("qualifyCashEvents (pure downstream reconciliation)", () => {
  it("qualifies a posted incoming-cash observation with a balance", () => {
    const events = qualifyCashEvents([pObs({ id: "o1" })]);
    expect(events).toHaveLength(1);
    expect(events[0].amount).toBe(100000);
  });

  it("a pending observation never qualifies", () => {
    const events = qualifyCashEvents([pObs({ id: "o1", status: "pending", postedAt: null })]);
    expect(events).toHaveLength(0);
  });

  it("a posted observation without a balance does not qualify", () => {
    const events = qualifyCashEvents([pObs({ id: "o1", qualificationBalanceCents: null })]);
    expect(events).toHaveLength(0);
  });

  it("outgoing (debit) never qualifies as cash", () => {
    const events = qualifyCashEvents([pObs({ id: "o1", direction: "debit", amountCents: -5000 })]);
    expect(events).toHaveLength(0);
  });

  it("a removed observation never qualifies", () => {
    const events = qualifyCashEvents([pObs({ id: "o1", state: "removed" })]);
    expect(events).toHaveLength(0);
  });

  it("pending → posted via predecessor yields exactly one event", () => {
    // predecessor is removed (absent from active list); replacement is posted.
    const posted = pObs({ id: "o2", predecessorObservationId: "o1" as FinancialObservationId });
    const events = qualifyCashEvents([posted]);
    expect(events).toHaveLength(1);
  });

  it("is deterministic (same input → same output)", () => {
    const a = qualifyCashEvents([pObs({ id: "o1" }), pObs({ id: "o2", direction: "debit", amountCents: -5 })]);
    const b = qualifyCashEvents([pObs({ id: "o1" }), pObs({ id: "o2", direction: "debit", amountCents: -5 })]);
    expect(a.map((e) => e.id)).toEqual(b.map((e) => e.id));
  });
});