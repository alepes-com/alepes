import { describe, it, expect } from "vitest";
import {
  interpretObservation,
  qualifyCashEvent,
  type FinancialObservation,
  type FinancialObservationId,
  type ExternalObservationRef,
} from "./index";
import { cents, nonNegativeCents, type NonNegativeCents } from "@alepes/money";

const OID = "obs" as FinancialObservationId;
const EREF = "ext" as ExternalObservationRef;
const BAL = nonNegativeCents(5000_00);

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
    ...overrides,
  };
}

describe("observation interpretation (pure)", () => {
  it("posted incoming cash may qualify (given an account balance)", () => {
    const interp = interpretObservation(obs({ direction: "credit", status: "posted" }));
    expect(interp.kind).toBe("incoming_cash");
    expect(qualifyCashEvent(obs({ direction: "credit", status: "posted" }), interp, BAL)).not.toBeNull();
  });

  it("pending incoming cash cannot become executable cash", () => {
    const interp = interpretObservation(obs({ direction: "credit", status: "pending" }));
    expect(interp.kind).toBe("unknown");
    expect(qualifyCashEvent(obs({ direction: "credit", status: "pending" }), interp, BAL)).toBeNull();
  });

  it("outgoing transactions do not qualify", () => {
    const interp = interpretObservation(obs({ direction: "debit", status: "posted", amountCents: cents(-50_00) }));
    expect(interp.kind).toBe("outgoing_cash");
    expect(qualifyCashEvent(obs({ direction: "debit", status: "posted" }), interp, BAL)).toBeNull();
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
    expect(qualifyCashEvent(pending, interpretObservation(pending), BAL)).toBeNull();
    expect(qualifyCashEvent(posted, interpretObservation(posted), BAL)).not.toBeNull();
  });

  it("qualification defers when no account balance snapshot is available", () => {
    const interp = interpretObservation(obs({ direction: "credit", status: "posted" }));
    expect(interp.kind).toBe("incoming_cash");
    // But without an account balance it is not yet executable cash.
    expect(qualifyCashEvent(obs({ direction: "credit", status: "posted" }), interp, undefined)).toBeNull();
  });

  it("the account balance used is the snapshot's selected balance, not a transaction fact", () => {
    const interp = interpretObservation(obs({ direction: "credit", status: "posted" }));
    const ev = qualifyCashEvent(obs({ direction: "credit", status: "posted" }), interp, BAL);
    expect(ev?.checkingBalanceAfter).toBe(BAL);
  });
});