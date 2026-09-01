// Rules engine: evaluate a cash-flow rule against a detected deposit.
// Pure and deterministic — produces a RuleEvaluation with full decision traces.

import type { CashFlowRule, DepositEvent, RuleEvaluation } from "./types";
import { round2 } from "./allocation";

/** Does this deposit match the rule's trigger and minimum-amount gate? */
export function depositQualifies(
  rule: CashFlowRule,
  deposit: DepositEvent
): boolean {
  switch (rule.trigger) {
    case "payroll":
      if (deposit.source !== "payroll") return false;
      break;
    case "bonus":
      if (deposit.source !== "bonus") return false;
      break;
    case "any_deposit":
      // anything passes
      break;
  }
  if (rule.minAmount != null && deposit.amount < rule.minAmount) {
    return false;
  }
  return true;
}

/**
 * Evaluate a rule against a deposit.
 *
 * Order of operations (each is a recorded decision):
 *  1. Qualify on trigger + minimum amount.
 *  2. Compute the gross amount (percentage or fixed).
 *  3. Apply the reserve constraint (balance must stay >= reserve).
 *  4. Apply per-deposit cap.
 *  5. Apply remaining monthly budget (if a monthly-tracked amount is provided).
 */
export function evaluateRule(
  rule: CashFlowRule,
  deposit: DepositEvent,
  opts: { monthlyInvested?: number } = {}
): RuleEvaluation {
  const decisions: string[] = [];
  const base: RuleEvaluation = {
    ruleId: rule.id,
    ruleName: rule.name,
    depositId: deposit.id,
    investmentAmount: 0,
    qualified: false,
    decisions,
    reserveApplied: false,
    skipped: rule.active ? false : true,
  };

  if (!rule.active) {
    decisions.push("Rule is paused — no action taken.");
    return base;
  }

  if (!depositQualifies(rule, deposit)) {
    decisions.push(
      `Deposit (source “${deposit.source}”) does not match trigger “${rule.trigger}”.`
    );
    base.skipped = true;
    return base;
  }

  base.qualified = true;

  // Gross amount
  let gross: number;
  if (rule.action === "invest_percentage") {
    gross = (rule.amount / 100) * deposit.amount;
    decisions.push(
      `Invest ${rule.amount}% of $${deposit.amount.toFixed(2)} → $${gross.toFixed(2)}.`
    );
  } else {
    gross = rule.amount;
    decisions.push(`Invest a fixed $${rule.amount.toFixed(2)}.`);
  }

  // Reserve constraint
  const availableFromBalance = deposit.checkingBalanceAfter - rule.reserveBalance;
  if (gross > availableFromBalance) {
    const before = gross;
    gross = Math.max(0, availableFromBalance);
    base.reserveApplied = true;
    decisions.push(
      `Reserve applied: keep $${rule.reserveBalance.toFixed(2)} in checking, so reduced $${before.toFixed(2)} → $${gross.toFixed(2)}.`
    );
  } else {
    decisions.push(
      `Reserve check passed: $${deposit.checkingBalanceAfter.toFixed(2)} − $${rule.reserveBalance.toFixed(2)} = $${availableFromBalance.toFixed(2)} available.`
    );
  }

  // Per-deposit cap
  if (rule.maxPerDeposit != null && gross > rule.maxPerDeposit) {
    decisions.push(
      `Per-deposit cap $${rule.maxPerDeposit.toFixed(2)} applied (was $${gross.toFixed(2)}).`
    );
    gross = rule.maxPerDeposit;
  }

  // Monthly budget
  if (rule.maxPerMonth != null && opts.monthlyInvested != null) {
    const remainingBudget = rule.maxPerMonth - opts.monthlyInvested;
    if (remainingBudget <= 0) {
      decisions.push(
        `Monthly cap $${rule.maxPerMonth.toFixed(2)} already reached — skipped.`
      );
      gross = 0;
      base.skipped = true;
    } else if (gross > remainingBudget) {
      decisions.push(
        `Monthly cap leaves $${remainingBudget.toFixed(2)} this month — reduced from $${gross.toFixed(2)}.`
      );
      gross = remainingBudget;
    }
  }

  base.investmentAmount = round2(gross);
  if (base.investmentAmount <= 0) {
    base.skipped = true;
    decisions.push("Net investment amount is $0 — nothing to deploy.");
  }

  return base;
}

/** Human-readable summary of a rule, matching the rule-builder phrasing. */
export function summarizeRule(rule: CashFlowRule): string {
  const usd = (n: number) => `$${n.toLocaleString("en-US")}`;
  const triggerPhrase =
    rule.trigger === "payroll"
      ? "a payroll deposit arrives"
      : rule.trigger === "bonus"
        ? "a bonus deposit arrives"
        : "any deposit arrives";

  const actionPhrase =
    rule.action === "invest_percentage"
      ? `invest ${rule.amount}%`
      : `invest ${usd(rule.amount)}`;

  const parts = [
    `When ${triggerPhrase}`,
    `, ${actionPhrase}`,
    ` as long as checking remains above ${usd(rule.reserveBalance)}`,
  ];
  if (rule.maxPerDeposit != null) {
    parts.push(`, never more than ${usd(rule.maxPerDeposit)} from one deposit`);
  }
  if (rule.maxPerMonth != null) {
    parts.push(`, capped at ${usd(rule.maxPerMonth)} per month`);
  }
  parts.push(".");
  return parts.join("");
}