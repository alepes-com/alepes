import { describe, it, expect } from "vitest";
import {
  interpretObservation,
  qualifyCashEvent,
  type FinancialObservation,
  type FinancialObservationId,
  type ExternalObservationRef,
} from "./index";
import { cents, nonNegativeCents } from "@alepes/money";

const OID = "obs" as FinancialObservationId;
const EREF = "ext" as ExternalObservationRef;

function obs(overrides: Partial<FinancialObservation>): FinancialObservation {
  return {
    id: OID,
    externalRef: EREF,
    accountBindingId: "binding-1",
    amountCents: cents(100_00),
    direction: "credit",
    status: "posted",
    firstObservedAt: "2026-09-01T00:00:00Z",
    postedAt: "2026-09-01T00:00:00Z",
    description: "paycheck",
    normalizationVersion: "norm@1",
    balanceAfterCents: nonNegativeCents(5000_00),
    ...overrides,
  };
}

describe("observation interpretation (pure)", () => {
  it("posted incoming cash may qualify", () => {
    const interp = interpretObservation(obs({ direction: "credit", status: "posted" }));
    expect(interp.kind).toBe("incoming_cash");
    expect(qualifyCashEvent(obs({ direction: "credit", status: "posted" }), interp)).not.toBeNull();
  });

  it("pending incoming cash cannot become executable cash", () => {
    const interp = interpretObservation(obs({ direction: "credit", status: "pending" }));
    expect(interp.kind).toBe("unknown");
    expect(qualifyCashEvent(obs({ direction: "credit", status: "pending" }), interp)).toBeNull();
  });

  it("outgoing transactions do not qualify", () => {
    const interp = interpretObservation(obs({ direction: "debit", status: "posted", amountCents: cents(-50_00) }));
    expect(interp.kind).toBe("outgoing_cash");
    expect(qualifyCashEvent(obs({ direction: "debit", status: "posted" }), interp)).toBeNull();
  });

  it("unknown activity stays unknown rather than being guessed into income", () => {
    // A credit with non-positive amount is an inconsistency, not income.
    const interp = interpretObservation(obs({ direction: "credit", amountCents: cents(0) }));
    expect(interp.kind).toBe("unknown");
  });

  it("interpretation is deterministic", () => {
    const a = interpretObservation(obs({ direction: "credit", status: "posted" }));
    const b = interpretObservation(obs({ direction: "credit", status: "posted" }));
    expect(a).toEqual(b);
  });

  it("pending→posted replacement yields at most one active CashEvent", () => {
    // The pending observation never qualifies; only the posted one does.
    const pending = obs({ direction: "credit", status: "pending" });
    const posted = obs({ direction: "credit", status: "posted" });
    expect(qualifyCashEvent(pending, interpretObservation(pending))).toBeNull();
    expect(qualifyCashEvent(posted, interpretObservation(posted))).not.toBeNull();
  });

  it("qualification defers when no balance-after is reported", () => {
    const interp = interpretObservation(obs({ direction: "credit", status: "posted", balanceAfterCents: undefined }));
    expect(interp.kind).toBe("incoming_cash");
    // But without a checking balance it is not yet executable cash.
    expect(qualifyCashEvent(obs({ direction: "credit", status: "posted", balanceAfterCents: undefined }), interp)).toBeNull();
  });
});