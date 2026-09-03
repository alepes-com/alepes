// FACADE — delegates all rule evaluation to @alepes/rules-engine.
//
// Public API is unchanged for the React UI (dollar floats in, dollar floats
// out). This module converts dollars → cents, calls the pure integer-cents
// rules engine, and converts back. No financial logic lives here.

import { evaluateRule as evaluateRuleCore, eventQualifies as eventQualifiesCore } from "@alepes/rules-engine";
import { formatCurrency } from "../format";
import type { CashFlowRule, DepositEvent, RuleEvaluation } from "./types";
import { ruleToDomain, depositToDomain, evaluationToUi, toNonNegativeCents } from "./marshal";

/** Does this deposit match the rule's trigger and minimum-amount gate? */
export function depositQualifies(rule: CashFlowRule, deposit: DepositEvent): boolean {
  return eventQualifiesCore(ruleToDomain(rule), depositToDomain(deposit));
}

/**
 * Evaluate a rule against a deposit. Delegates to the core engine; converts
 * money to cents on the way in and back to dollars on the way out.
 */
export function evaluateRule(
  rule: CashFlowRule,
  deposit: DepositEvent,
  opts: { monthlyInvested?: number } = {}
): RuleEvaluation {
  const core = evaluateRuleCore(ruleToDomain(rule), depositToDomain(deposit), {
    monthlyInvested:
      opts.monthlyInvested != null ? toNonNegativeCents(opts.monthlyInvested) : undefined,
  });
  return evaluationToUi(core);
}

/** Human-readable summary of a rule, matching the rule-builder phrasing. */
export function summarizeRule(rule: CashFlowRule): string {
  const triggerPhrase =
  rule.trigger === "payroll"
    ? "a payroll deposit arrives"
    : rule.trigger === "bonus"
      ? "a bonus deposit arrives"
      : "any deposit arrives";

  const actionPhrase =
  rule.action === "invest_percentage"
    ? `invest ${rule.amount}%`
    : `invest ${formatCurrency(rule.amount)}`;

  const parts = [
  `When ${triggerPhrase}`,
  `, ${actionPhrase}`,
  ` as long as checking remains above ${formatCurrency(rule.reserveBalance)}`,
  ];
  if (rule.maxPerDeposit != null) {
  parts.push(`, never more than ${formatCurrency(rule.maxPerDeposit)} from one deposit`);
  }
  if (rule.maxPerMonth != null) {
  parts.push(`, capped at ${formatCurrency(rule.maxPerMonth)} per month`);
  }
  parts.push(".");
  return parts.join("");
  }