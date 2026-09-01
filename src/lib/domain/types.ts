// Core domain types for the Alepes cash-flow-to-investment engine.
// These are pure, provider-agnostic types — financial integrations stay
// behind the provider interfaces in `providers/`, never coupled here.

/** A single holding in a portfolio, with target and current allocation. */
export interface Holding {
  /** Ticker symbol, e.g. "AAPL" or "BRK.B". */
  symbol: string;
  /** Company / fund name. */
  name: string;
  /** Target allocation as a percentage (20 = 20%). */
  targetPct: number;
  /** Allowed band around target, as a percentage (17 = 17%). */
  bandMinPct?: number;
  /** Allowed band around target, as a percentage (23 = 23%). */
  bandMaxPct?: number;
}

/** The live snapshot of a holding's market value + allocation. */
export interface PositionSnapshot {
  symbol: string;
  name: string;
  /** Current market value in dollars. */
  value: number;
  /** Current allocation as a percentage of the portfolio. */
  currentPct: number;
}

/** A single target portfolio — an Alepes "school". */
export interface Portfolio {
  id: string;
  name: string;
  version: number;
  holdings: Holding[];
}

/** The state of a portfolio at a point in time. */
export interface PortfolioState {
  portfolio: Portfolio;
  positions: PositionSnapshot[];
  /** Total portfolio market value, dollars. */
  totalValue: number;
}

/** A node in a cash-flow automation rule. */
export type RuleTrigger = "payroll" | "any_deposit" | "bonus";
export type RuleAction = "invest_percentage" | "invest_fixed";

export interface CashFlowRule {
  id: string;
  name: string;
  trigger: RuleTrigger;
  /** Optional: minimum deposit size to qualify, dollars. */
  minAmount?: number;
  /** Minimum checking balance to maintain after the action, dollars. */
  reserveBalance: number;
  action: RuleAction;
  /** For invest_percentage: percent of qualifying deposit (0-100). For invest_fixed: dollars. */
  amount: number;
  /** Maximum dollars invested from a single deposit. */
  maxPerDeposit?: number;
  /** Maximum dollars invested in a rolling month. */
  maxPerMonth?: number;
  /** Destination portfolio id. */
  portfolioId: string;
  /** Whether the rule is currently actively evaluated. */
  active: boolean;
  /** Sort/display order hint. */
  order?: number;
}

/** A detected deposit event from the bank provider. */
export interface DepositEvent {
  id: string;
  /** Dollar amount of the deposit. */
  amount: number;
  /** Payroll / bonus / transfer / other. */
  source: "payroll" | "bonus" | "transfer" | "other";
  /** Description from the bank feed. */
  description: string;
  /** ISO timestamp. */
  occurredAt: string;
  /** Checking balance at the moment of detection (after deposit posted). */
  checkingBalanceAfter: number;
}

/** Result of evaluating a single rule against a deposit. */
export interface RuleEvaluation {
  ruleId: string;
  ruleName: string;
  depositId: string;
  /** Chosen investment dollar amount after all caps and reserves. */
  investmentAmount: number;
  /** Whether the deposit qualified at all. */
  qualified: boolean;
  /** Human list of the decisions made and why. */
  decisions: string[];
  /** Whether the reserve constraint kicked in and reduced the amount. */
  reserveApplied: boolean;
  /** Whether this deposit was skipped entirely. */
  skipped: boolean;
}

/** A single proposed purchase produced by the allocation engine. */
export interface AllocationLine {
  symbol: string;
  name: string;
  /** Dollars allocated to this holding. */
  amount: number;
  /** Estimated fractional shares acquired. */
  shares: number;
  /** Current allocation before contribution. */
  beforePct: number;
  /** Estimated allocation after contribution. */
  afterPct: number;
  /** Underweight amount (positive = underweight, needs funds). */
  underweightAmount: number;
}

/** The aggregate result of allocating a contribution. */
export interface AllocationResult {
  /** Total dollars deployed. */
  totalDeployed: number;
  /** The individual purchase lines, largest first. */
  lines: AllocationLine[];
  /** Holdings that received nothing and why. */
  skipped: { symbol: string; reason: string }[];
}

/** A proposed-but-not-executed simulation result (Shadow Mode). */
export interface SimulationResult {
  deposit: DepositEvent;
  evaluations: RuleEvaluation[];
  /** Allocation result if any money would have been invested. */
  allocation: AllocationResult | null;
  /** Summary metrics for a window of simulation. */
  summary?: SimulationSummary;
  /** Whether any money would have moved. */
  moneyWouldMove: boolean;
  /** Total would-be invested across all rules. */
  totalWouldInvest: number;
}

export interface SimulationSummary {
  depositsDetected: number;
  wouldHaveInvested: number;
  transfersSkipped: number;
  driftReducedPct: number;
}

/** Human-readable explanation for one allocation line. */
export interface AllocationExplanation {
  symbol: string;
  name: string;
  targetPct: number;
  beforePct: number;
  underweightAmount: number;
  availableContribution: number;
  amount: number;
  reason: string;
}

/** A single immutable activity/audit entry. */
export interface ActivityEvent {
  id: string;
  /** ISO timestamp. */
  at: string;
  kind:
    | "deposit"
    | "rule_evaluated"
    | "reserve_applied"
    | "allocation_generated"
    | "order_simulated"
    | "order_executed"
    | "hold"
    | "version_change"
    | "connection"
    | "safety";
  title: string;
  detail: string;
  amount?: number;
  tone?: "positive" | "negative" | "neutral" | "accent";
}

/** A saved historical snapshot of a portfolio's target allocation. */
export interface PortfolioVersion {
  version: number;
  label: string;
  date: string;
  holdings: Holding[];
}

/** Formation (allocation-health) summary metrics. */
export interface FormationStats {
  /** 0-100 score of how closely current matches target. */
  score: number;
  status: "in_formation" | "slight_drift" | "drifted";
  statusLabel: string;
  /** Total absolute drift in percentage points, weighted by value. */
  driftPct: number;
  biggestUnderweight: string | null;
  biggestOverweight: string | null;
}

/** The fictional connected-account state for one demo user. */
export interface AccountState {
  checkingBalance: number;
  reserveBalance: number;
  portfolioState: PortfolioState;
  rules: CashFlowRule[];
  activities: ActivityEvent[];
  versions: PortfolioVersion[];
  shadowSummary: SimulationSummary;
}