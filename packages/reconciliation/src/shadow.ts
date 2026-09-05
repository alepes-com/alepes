// Shadow Mode consumer: the provider-neutral composition that turns reconciled,
// persisted normalized observations into a *shadow* (never-executed) plan.
//
// This is the top of the read-only milestone's downstream flow:
//
//   completed provider sync
//     → reconciled persisted FinancialObservation state (ProviderSyncStore)
//     → deterministic interpretation (interpretObservation)
//     → qualification (qualifyCashEvents → optional CashEvent)
//     → existing financial engines (rules → capital → allocation)
//     → Shadow disposition (execution-policy, shadowMode: true)
//
// No provider observation ever becomes an executable event here, and no money
// movement capability is invoked. External provider references never enter
// financial-policy inputs; they appear only in the provenance/audit trace.

import type {
  AllocationPlan,
  CapitalPlan,
  CashEvent,
  CashFlowRule,
  ExecutionPlan,
  ExecutionDisposition,
  PortfolioState,
} from "@alepes/domain";
import { evaluateRules, toCapitalPlan } from "@alepes/rules-engine";
import { allocate } from "@alepes/allocation-engine";
import { decidePolicy } from "@alepes/execution-policy";
import type {
  AccountBindingId,
  PersistedObservation,
  SyncCycleId,
} from "@alepes/persistence";
import { qualifyCashEvents } from "@alepes/persistence";

//
// ─── Provenance ──────────────────────────────────────────────────────────────
//
// A provider-derived Shadow decision must remain explainable back through:
//   Shadow decision → CashEvent → FinancialObservationId → sync cycle → binding.
// The `CashEvent.id` IS the durable `FinancialObservationId` (minted by the
// persistence layer), and the sync cycle comes from the observation's OWN
// persisted `lastReconciledCycleId` — never a caller-supplied batch cycle.
//

export interface ShadowProvenance {
  /** The CashEvent this decision derives from. Its id is the FinancialObservationId. */
  cashEventId: CashEvent["id"];
  /** The Alepes-owned FinancialObservationId (equal to cashEventId by contract). */
  observationId: CashEvent["id"];
  /** The durable account binding this observation belongs to. */
  accountBindingId: AccountBindingId;
  /** The sync cycle that reconciled this observation into active state. */
  cycleId: SyncCycleId | null;
}

export interface ShadowDecision {
  /** The full plan. Its disposition is ALWAYS shadow. */
  plan: ExecutionPlan;
  /** Disposition — guaranteed shadow (nothing moved). */
  disposition: ExecutionDisposition;
  /** Provenance back to the originating observation + binding + cycle. */
  provenance: ShadowProvenance;
}

export interface ShadowModeInput {
  /** Ordered, active cash-flow rules (the same rule set live mode uses). */
  rules: CashFlowRule[];
  /** Portfolio state to allocate against (immutable at this version). */
  portfolioState: PortfolioState;
}

/** Raised when a qualifying observation's account binding cannot be resolved. */
export class ShadowProvenanceError extends Error {
  constructor(public readonly observationId: CashEvent["id"]) {
    super(
      `Shadow provenance invariant violated: no account binding for observation ${observationId}`
    );
    this.name = "ShadowProvenanceError";
  }
}

/**
 * Deterministic CashEvent identity at the persistence boundary: a stable id
 * from the Alepes-owned observation id. `qualifyCashEvents` (persistence)
 * already emits `CashEvent.id = FinancialObservationId`; this helper documents
 * and enforces that invariant at the composition layer so a repeated
 * interpretation of the same observation can never duplicate a deposit.
 */
export function cashEventIdForObservation(observationId: CashEvent["id"]): CashEvent["id"] {
  return observationId;
}

/**
 * Derive qualifying CashEvents from reconciled persisted observations and run
 * each through the existing Shadow pipeline. Uses the SAME engines live mode
 * uses; only the execution-policy disposition differs (shadow).
 *
 * Deterministic: no time, random, or ordering dependence beyond the (already
 * deterministic) observation ordering. Each decision's provenance comes from the
 * observation's own persisted `lastReconciledCycleId` and account binding.
 */
export function runShadowMode(
  observations: PersistedObservation[],
  input: ShadowModeInput
): ShadowDecision[] {
  const events = qualifyCashEvents(observations);
  const bindingByObservationId = new Map<string, AccountBindingId>(
    observations.map((o) => [o.id, o.accountBindingId])
  );
  const cycleByObservationId = new Map<string, SyncCycleId | null>(
    observations.map((o) => [o.id, o.lastReconciledCycleId])
  );

  const decisions: ShadowDecision[] = [];

  for (const event of events) {
    const ruleResult = evaluateRules(input.rules, event);
    const capitalPlan: CapitalPlan = toCapitalPlan(event, ruleResult);
    const allocationPlan: AllocationPlan = allocate(input.portfolioState, capitalPlan);
    const orders = allocationPlan.lines.map((line, i) => ({
      id: `${event.id}-o${i}`,
      symbol: line.symbol,
      amount: line.amount,
      side: "buy" as const,
      shares: line.shares,
    }));

    const plan: ExecutionPlan = {
      id: event.id,
      cashEvent: event,
      capitalPlan,
      allocationPlan,
      orders,
      proposedDisposition: { kind: "shadow", reason: "unset" },
    };

    // Shadow Mode is the ONLY disposition this read-only milestone produces.
    const outcome = decidePolicy(plan, { shadowMode: true });
    const disposition = outcome.disposition;

    // Provenance must come from persisted state; a missing binding is a data-
    // integrity defect we refuse to paper over.
    const accountBindingId = bindingByObservationId.get(event.id);
    if (!accountBindingId) {
      throw new ShadowProvenanceError(event.id);
    }

    decisions.push({
      plan: { ...plan, proposedDisposition: disposition },
      disposition,
      provenance: {
        cashEventId: cashEventIdForObservation(event.id),
        observationId: event.id,
        accountBindingId,
        cycleId: cycleByObservationId.get(event.id) ?? null,
      },
    });
  }

  return decisions;
}

/** Convenience: total deployable across a set of shadow decisions (for assertions). */
export function totalShadowDeployable(decisions: ShadowDecision[]): number {
  return decisions.reduce((sum, d) => sum + (d.plan.capitalPlan.deployable as number), 0);
}