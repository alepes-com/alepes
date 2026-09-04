// The Alepes financial domain. Pure types only — no React, no Next.js, no I/O.
// Every value that represents money is integer cents (the `Cents` type from
// @alepes/money). Nothing here may import a provider SDK or the UI.

import type { Cents, NonNegativeCents } from "@alepes/money";

//
// ─── Provider-normalized financial observations ─────────────────────────────
//
// Alepes owns these types. A financial-data provider (Plaid, a mock, …) exposes
// *observations* of external activity; Alepes interprets them and, only when an
// observation qualifies as incoming cash, derives a `CashEvent`.
//
// The stages are kept explicit and distinct:
//   1. provider delta            (add / modify / remove — see ObservationSyncDelta)
//   2. normalized observation    (provider facts only; sign convention resolved)
//   3. financial interpretation  (Alepes classifies into incoming/outgoing/…)
//   4. CashEvent qualification   (a qualifying incoming-cash observation only)
//
// `CashEvent` is deliberately NOT the ingestion primitive: it sits downstream of
// the normalized observation + reconciliation layer so that pending→posted
// transitions, corrections, and removals never cause a double financial effect.
//

/**
 * An opaque, provider-issued reference to one external record (e.g. a Plaid
 * transaction_id). It is confined to the integration adapter, account-binding
 * persistence, and the reconciliation layer. It MUST NOT leak into rules,
 * allocation, execution policy, `CashEvent`, or capital/execution plans.
 */
export type ExternalObservationRef = string & { readonly __externalRef: unique symbol };

/**
 * A durable, Alepes-minted identity for a normalized observation. Distinct from
 * the provider's external reference: this is what Alepes persists and keys its
 * own history on, while `externalRef` holds the provider-side link.
 */
export type FinancialObservationId = string & { readonly __observationId: unique symbol };

/**
 * The provider-normalized direction of a record, already resolved into Alepes's
 * sign convention. The adapter is responsible for converting any provider's own
 * convention (e.g. Plaid's inverted sign) into this at the boundary — the domain
 * never sees the provider's raw sign semantics.
 */
export type ObservationDirection = "credit" | "debit";

/** The posting status of an observation, mirroring provider-timing semantics. */
export type ObservationStatus = "pending" | "posted";

/**
 * A provider-neutral, normalized observation of one external financial record.
 * This carries facts only — amount/direction/status/timing — and deliberately
 * does NOT classify the record's financial meaning. Classification is a separate
 * Alepes-owned interpretation step.
 */
export interface FinancialObservation {
  /** Durable Alepes-owned identity (minted at normalization/persistence). */
  id: FinancialObservationId;
  /** Opaque provider reference; integration/reconciliation layer only. */
  externalRef: ExternalObservationRef;
  /** The Alepes account binding this observation belongs to. */
  accountBindingId: string;
  /**
   * Signed amount in integer cents in ALEPES convention: credit (money in) is
   * positive, debit (money out) is negative. The adapter has already resolved
   * the provider's own sign convention into this.
   */
  amountCents: Cents;
  direction: ObservationDirection;
  status: ObservationStatus;
  /** Optional provider-reported balance/amount AFTER this record (integer cents). */
  balanceAfterCents?: NonNegativeCents;
  /** ISO-8601 timestamp the provider first reported this record. */
  firstObservedAt: string;
  /** ISO-8601 timestamp the record became authoritative/posted (if posted). */
  postedAt?: string;
  /** Human-readable description rooted in provider data (display only). */
  description: string;
  /**
   * Opaque provider-issued predecessor/supersession reference, when the provider
   * links this record to a prior one (e.g. pending → posted). Only the
   * reconciliation layer interprets it; it is never an Alepes identity.
   */
  predecessorRef?: ExternalObservationRef;
  /** The normalization version that produced this observation. */
  normalizationVersion: string;
}

/**
 * A provider-neutral synchronization delta. Rather than a flat list that
 * downstream code must diff against a previous snapshot, the provider explicitly
 * partitions one sync cycle's changes into added / modified / removed. This is
 * the lossless form the reconciliation layer consumes; the provider adapter
 * guarantees each external change appears in exactly one bucket.
 */
export interface ObservationSyncDelta {
  added: FinancialObservation[];
  modified: FinancialObservation[];
  /** Provider references of records that no longer exist (explicit removals). */
  removed: ExternalObservationRef[];
  /** Opaque cursor/checkpoint to resume from on the NEXT cycle. */
  nextCursor: string;
  /** True when the provider reports further changes after this cycle. */
  hasMore: boolean;
}

//
// ─── Financial interpretation and CashEvent qualification ───────────────────
//
// The adapter normalizes provider FACTS. Alepes INTERPRETS them. These pure,
// deterministic functions are that interpretation boundary: they classify a
// normalized observation and, only when it qualifies as posted incoming cash,
// derive a `CashEvent`. No provider-specific source logic (e.g. "this category
// string means payroll") lives here yet — that is a later, explicitly-scoped
// concern.
//

/** The Alepes financial meaning of a normalized observation. */
export type ObservationInterpretation =
  | { kind: "incoming_cash" }
  | { kind: "outgoing_cash" }
  | { kind: "transfer" }
  | { kind: "reversal" }
  | { kind: "unknown" };

/**
 * Deterministically interpret a normalized observation's financial meaning from
 * its facts (direction + status + amount sign). Pure: same input → same output.
 */
export function interpretObservation(obs: FinancialObservation): ObservationInterpretation {
  if (obs.status === "pending") {
    // Pending records are NOT yet authoritatively classified as cash — they may
    // still be corrected before posting. They stay unknown to the engine.
    return { kind: "unknown" };
  }
  if (obs.direction === "credit") {
    return obs.amountCents > 0 ? { kind: "incoming_cash" } : { kind: "unknown" };
  }
  if (obs.direction === "debit") {
    return { kind: "outgoing_cash" };
  }
  return { kind: "unknown" };
}

/**
 * Qualify an interpreted observation into a `CashEvent`, or return null.
 *
 * Only a POSTED incoming-cash interpretation qualifies. Pending records never
 * become executable cash, so a pending→posted replacement yields at most one
 * active CashEvent (the pending one never qualified in the first place).
 *
 * `source` is a coarse, deterministic categorization and does NOT auto-select a
 * specific financial rule; downstream rule evaluation keeps that decision.
 */
export function qualifyCashEvent(
  obs: FinancialObservation,
  interp: ObservationInterpretation
): CashEvent | null {
  if (interp.kind !== "incoming_cash" || obs.status !== "posted") {
    return null;
  }
  // A well-formed CashEvent requires a checking balance after the event. If the
  // provider did not report one, qualification is deferred rather than fabricating
  // a balance — the observation stays normalized but is not yet executable cash.
  if (obs.balanceAfterCents === undefined) {
    return null;
  }
  return {
    id: obs.id,
    amount: obs.amountCents,
    source: "transfer",
    description: obs.description,
    occurredAt: obs.postedAt ?? obs.firstObservedAt,
    checkingBalanceAfter: obs.balanceAfterCents,
  };
}

/**
 * A single holding with a target allocation and optional band.
 */
export interface Holding {
  symbol: string;
  name: string;
  /** Target as a percentage 0–100 (e.g. 20 = 20%). Display only — see drift. */
  targetPct: number;
  /** Optional allocation band, in percent. */
  bandMinPct?: number;
  bandMaxPct?: number;
}

/** A live snapshot of one position's market value. */
export interface PositionSnapshot {
  symbol: string;
  name: string;
  /** Market value in integer cents. */
  value: NonNegativeCents;
}

/** A portfolio (an Alepes "school"), immutable at a given version. */
export interface Portfolio {
  id: string;
  name: string;
  version: number;
  holdings: Holding[];
}

/** Portfolio + live positions at a point in time. */
export interface PortfolioState {
  portfolio: Portfolio;
  positions: PositionSnapshot[];
  /** Sum of position values, integer cents. */
  totalValue: NonNegativeCents;
  /** Optional current share prices in cents-per-share × 10^6 to keep fractional precision. */
  prices?: Record<string, Cents>;
}

/** A raw cash movement observed by a bank integration. */
export interface CashEvent {
  id: string;
  /** Positive signed amount in cents (negative = outflow/withdrawal). */
  amount: Cents;
  source: "payroll" | "bonus" | "transfer" | "other";
  description: string;
  occurredAt: string;
  /** Checking balance after the event posted, in cents. */
  checkingBalanceAfter: NonNegativeCents;
}

// ---- Rules ----

export type RuleTrigger = "payroll" | "any_deposit" | "bonus";
export type RuleAction = "invest_percentage" | "invest_fixed";

export interface CashFlowRule {
  id: string;
  name: string;
  trigger: RuleTrigger;
  /** Minimum qualifying deposit, cents (optional). */
  minAmount?: NonNegativeCents;
  /** Checking balance to preserve, cents. */
  reserveBalance: NonNegativeCents;
  action: RuleAction;
  /** invest_percentage: percent 0–100. invest_fixed: cents. */
  amount: number | Cents;
  /** Maximum invested from a single deposit, cents (optional). */
  maxPerDeposit?: NonNegativeCents;
  /** Maximum invested in a rolling month, cents (optional). */
  maxPerMonth?: NonNegativeCents;
  /** Destination portfolio id. */
  portfolioId: string;
  active: boolean;
  /** Priority: lower runs first; a deposit matches at most one rule. */
  order: number;
}

/** The decision trace of evaluating a rule against a cash event. */
export interface RuleEvaluation {
  ruleId: string;
  ruleName: string;
  eventId: string;
  qualified: boolean;
  /** Gross amount after caps/reserves, cents. */
  investmentAmount: NonNegativeCents;
  decisions: string[];
  reserveApplied: boolean;
  skipped: boolean;
}

/** Result of matching a cash event across the ordered rule set. */
export interface RuleEvaluationResult {
  /** The winning evaluation (first qualifying active rule), or null. */
  evaluation: RuleEvaluation | null;
  /** Every rule that was checked and why, in priority order (for audit). */
  trace: RuleEvaluation[];
}

/**
 * How much capital to deploy, derived from rules. This is intentionally a
 * distinct stage from allocation: rules decide *how much*, allocation decides
 * *where*.
 */
export interface CapitalPlan {
  eventId: string;
  /** Total dollars (cents) authorized to invest across the qualifying rule. */
  deployable: NonNegativeCents;
  reserve: NonNegativeCents;
  /** The rule evaluation that produced this plan (if any). */
  evaluation: RuleEvaluation | null;
  /** Nothing to deploy — plan is empty and safe to no-op. */
  isEmpty: boolean;
}

// ---- Allocation ----

export interface AllocationLine {
  symbol: string;
  name: string;
  /** Dollars (cents) allocated to this holding. Always ≥ 0. */
  amount: NonNegativeCents;
  /** Estimated fractional shares (informational, not a monetary value). */
  shares: number;
}

export interface AllocationPlan {
  eventId: string;
  /** Total deployed, cents. Never exceeds deployable. */
  totalDeployed: NonNegativeCents;
  lines: AllocationLine[];
  /** Holdings considered but not funded, with the reason. */
  skipped: { symbol: string; reason: string }[];
  /** Explanation records — one per funded line, describing why. */
  explanations: AllocationExplanation[];
}

export interface AllocationExplanation {
  symbol: string;
  name: string;
  targetPct: number;
  beforePct: number;
  underweightAmount: Cents;
  amount: NonNegativeCents;
  reason: string;
}

// ---- Execution ----

/** One concrete instruction to a brokerage. */
export interface ExecutionOrder {
  id: string;
  symbol: string;
  /** Dollar amount in cents (or negative for a sell). */
  amount: Cents;
  side: "buy" | "sell";
  /** Estimated fractional shares. */
  shares: number;
}

/**
 * The full, immutable plan produced by the domain pipeline. An ExecutionPlan is
 * what the ExecutionPolicy gate consumes — Shadow and live mode produce the
 * IDENTICAL plan; only the disposition differs.
 */
export interface ExecutionPlan {
  id: string;
  cashEvent: CashEvent;
  capitalPlan: CapitalPlan;
  allocationPlan: AllocationPlan;
  orders: ExecutionOrder[];
  /** Proposed dispositions in a strict order: shadow < approval < execute. */
  proposedDisposition: ExecutionDisposition;
}

/** What the policy gate decided to do with the plan. */
export type ExecutionDisposition =
  | { kind: "shadow"; reason: string }
  | { kind: "approval"; reason: string }
  | { kind: "execute"; reason: string };

/** A single immutable audit record explaining one decision. */
export interface AuditRecord {
  id: string;
  at: string;
  eventId: string;
  stage:
    | "cash_event"
    | "rule_evaluated"
    | "capital_planned"
    | "allocation_planned"
    | "policy_decided"
    | "executed"
    | "shadowed"
    | "held";
  summary: string;
  detail: string;
  amountCents?: Cents;
}

/** The complete, reproducible result of routing one cash event through the pipeline. */
export interface LedgerEntry {
  plan: ExecutionPlan;
  disposition: ExecutionDisposition;
  /** Ordered audit trail explaining every decision. */
  audit: AuditRecord[];
}