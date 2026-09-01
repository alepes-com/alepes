// The Alepes financial domain. Pure types only — no React, no Next.js, no I/O.
// Every value that represents money is integer cents (the `Cents` type from
// @alepes/money). Nothing here may import a provider SDK or the UI.

import type { Cents, NonNegativeCents } from "@alepes/money";

/** A single holding with a target allocation and optional band. */
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