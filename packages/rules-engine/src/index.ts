// Rules engine: CashEvent → RuleEvaluation → CapitalPlan.
// Pure and deterministic. Integer-cents money throughout.

import type {
  CashEvent,
  CashFlowRule,
  CapitalPlan,
  RuleEvaluation,
  RuleEvaluationResult,
} from "@alepes/domain";
import {
  type Cents,
  type NonNegativeCents,
  ZERO,
  cents,
  nonNegativeCents,
  mulByRatio,
  sub,
  toCurrencyString,
  isNegative,
  isZero,
} from "@alepes/money";

/** Does this cash event match the rule's trigger + minimum-amount gate? */
export function eventQualifies(rule: CashFlowRule, event: CashEvent): boolean {
  switch (rule.trigger) {
    case "payroll":
      if (event.source !== "payroll") return false;
      break;
    case "bonus":
      if (event.source !== "bonus") return false;
      break;
    case "any_deposit":
      break;
  }
  // Only inflows (positive amounts) can trigger investing; outflows never do.
  if (isNegative(event.amount)) return false;
  if (rule.minAmount != null && event.amount < rule.minAmount) return false;
  return true;
}

export interface EvaluateOptions {
  /** Dollars already invested this month across all rules from prior events. */
  monthlyInvested?: NonNegativeCents;
}

/**
 * Evaluate one rule against one event. Records every decision as a string so
 * the resulting plan is auditable. Integer-cents, deterministic.
 */
export function evaluateRule(
  rule: CashFlowRule,
  event: CashEvent,
  opts: EvaluateOptions = {}
): RuleEvaluation {
  const decisions: string[] = [];
  const base: RuleEvaluation = {
    ruleId: rule.id,
    ruleName: rule.name,
    eventId: event.id,
    qualified: false,
    investmentAmount: ZERO,
    decisions,
    reserveApplied: false,
    skipped: !rule.active,
  };

  if (!rule.active) {
    decisions.push("Rule is paused — no action taken.");
    return base;
  }

  if (!eventQualifies(rule, event)) {
    decisions.push(
      `Deposit (source "${event.source}") does not match trigger "${rule.trigger}".`
    );
    base.skipped = true;
    return base;
  }

  base.qualified = true;

  // Gross amount (integer-cents; percentage uses deterministic rounding).
  let gross: Cents;
  if (rule.action === "invest_percentage") {
    const pct = rule.amount as number;
    gross = mulByRatio(event.amount, pct / 100);
    decisions.push(
      `Invest ${pct}% of ${toCurrencyString(event.amount)} → ${toCurrencyString(gross)}.`
    );
  } else {
    gross = cents(rule.amount as number);
    decisions.push(`Invest a fixed ${toCurrencyString(gross)}.`);
  }

  // Reserve constraint: balance after action must stay ≥ reserve.
  const available: Cents = sub(event.checkingBalanceAfter, rule.reserveBalance);
  if (gross > available) {
    const before = gross;
    gross = available > ZERO ? available : ZERO;
    base.reserveApplied = true;
    decisions.push(
      `Reserve applied: keep ${toCurrencyString(rule.reserveBalance)} in checking, so reduced ${toCurrencyString(before)} → ${toCurrencyString(gross)}.`
    );
  } else {
    decisions.push(
      `Reserve check passed: ${toCurrencyString(event.checkingBalanceAfter)} − ${toCurrencyString(rule.reserveBalance)} = ${toCurrencyString(available)} available.`
    );
  }

  // Per-deposit cap.
  if (rule.maxPerDeposit != null && gross > rule.maxPerDeposit) {
    decisions.push(
      `Per-deposit cap ${toCurrencyString(rule.maxPerDeposit)} applied (was ${toCurrencyString(gross)}).`
    );
    gross = rule.maxPerDeposit;
  }

  // Monthly budget.
  if (rule.maxPerMonth != null && opts.monthlyInvested != null) {
    const remainingBudget = max0(sub(rule.maxPerMonth, opts.monthlyInvested));
    if (isZero(remainingBudget)) {
      decisions.push(
        `Monthly cap ${toCurrencyString(rule.maxPerMonth)} already reached — skipped.`
      );
      gross = ZERO;
      base.skipped = true;
    } else if (gross > remainingBudget) {
      decisions.push(
        `Monthly cap leaves ${toCurrencyString(remainingBudget)} this month — reduced from ${toCurrencyString(gross)}.`
      );
      gross = remainingBudget;
    }
  }

  // Clamp to non-negative; anything ≤ 0 is a skip.
  const net: NonNegativeCents =
    gross > ZERO ? nonNegativeCents(gross as number) : ZERO;
  base.investmentAmount = net;
  if (isZero(net)) {
    base.skipped = true;
    decisions.push("Net investment amount is $0 — nothing to deploy.");
  }

  return base;
}

function max0(c: Cents): NonNegativeCents {
  return c > ZERO ? nonNegativeCents(c as number) : ZERO;
}

/**
 * Match an event against an ordered rule set. A deposit may fire AT MOST ONE
 * rule — the first qualifying active rule in priority order wins. This is the
 * "never double-invest" invariant.
 */
export function evaluateRules(
  rules: readonly CashFlowRule[],
  event: CashEvent,
  opts: EvaluateOptions = {}
): RuleEvaluationResult {
  const ordered = [...rules].sort((a, b) => a.order - b.order);

  // Build a trace of every rule whose trigger matches (and paused rules), so
  // the audit explains why exactly one fired.
  const trace: RuleEvaluation[] = [];
  let winner: RuleEvaluation | null = null;

  for (const rule of ordered) {
    const ev = evaluateRule(rule, event, opts);
    trace.push(ev);
    if (winner === null && ev.qualified && !ev.skipped && !isZero(ev.investmentAmount)) {
      winner = ev;
      // Continue tracing (other rules still evaluated for audit) but do NOT
      // let them invest.
    }
  }

  return { evaluation: winner, trace };
}

/** Fold a rule evaluation into a CapitalPlan. */
export function toCapitalPlan(event: CashEvent, result: RuleEvaluationResult): CapitalPlan {
  if (result.evaluation === null) {
    return {
      eventId: event.id,
      deployable: ZERO,
      reserve: event.checkingBalanceAfter,
      evaluation: null,
      isEmpty: true,
    };
  }
  return {
    eventId: event.id,
    deployable: result.evaluation.investmentAmount,
    reserve: event.checkingBalanceAfter,
    evaluation: result.evaluation,
    isEmpty: isZero(result.evaluation.investmentAmount),
  };
}