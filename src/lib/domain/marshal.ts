// Marshalling layer: the ONLY place that converts between UI dollar DTOs
// (float) and the integer-cents domain in @alepes/*. Every financial decision is
// delegated to the packages; this file is pure data conversion, no financial
// logic of its own.
//
//   UI dollars (float)  ←→  integer cents (@alepes/money Cents)
//   UI DTOs (types.ts)  ←→  domain models (@alepes/domain)

import {
  centsFromDollarsFloat,
  type Cents,
  type NonNegativeCents,
  nonNegativeCents,
} from "@alepes/money";
import type {
  CashEvent as DomainCashEvent,
  Holding as DomainHolding,
  PositionSnapshot as DomainPosition,
  Portfolio as DomainPortfolio,
  PortfolioState as DomainPortfolioState,
  CashFlowRule as DomainRule,
  RuleEvaluation as DomainRuleEvaluation,
} from "@alepes/domain";
import type {
  DepositEvent,
  Holding,
  Portfolio,
  PortfolioState,
  CashFlowRule,
  RuleEvaluation,
} from "./types";

// ---- dollars → cents ----

export function toCents(dollars: number): Cents {
  return centsFromDollarsFloat(dollars);
}
export function toNonNegativeCents(dollars: number): NonNegativeCents {
  return nonNegativeCents(centsFromDollarsFloat(Math.max(0, dollars)) as number);
}
export function toDollars(c: Cents): number {
  return (c as number) / 100;
}

// ---- Holdings / Portfolio ----

export function holdingToDomain(h: Holding): DomainHolding {
  return { ...h };
}
export function holdingFromDomain(h: DomainHolding): Holding {
  return { ...h };
}

export function portfolioToDomain(p: Portfolio): DomainPortfolio {
  return { ...p, holdings: p.holdings.map(holdingToDomain) };
}

export function portfolioStateToDomain(s: PortfolioState): DomainPortfolioState {
  const positions: DomainPosition[] = s.positions.map((pos) => ({
    symbol: pos.symbol,
    name: pos.name,
    value: toNonNegativeCents(pos.value),
  }));
  const total = positions.reduce((sum, p) => sum + (p.value as number), 0);
  return {
    portfolio: portfolioToDomain(s.portfolio),
    positions,
    totalValue: nonNegativeCents(total),
  };
}

export function portfolioStateFromDomain(s: DomainPortfolioState): PortfolioState {
  return {
    portfolio: {
      id: s.portfolio.id,
      name: s.portfolio.name,
      version: s.portfolio.version,
      holdings: s.portfolio.holdings.map(holdingFromDomain),
    },
    positions: s.positions.map((pos) => ({
      symbol: pos.symbol,
      name: pos.name,
      value: toDollars(pos.value),
      currentPct: ((pos.value as number) / (s.totalValue as number)) * 100,
    })),
    totalValue: toDollars(s.totalValue),
  };
}

// ---- Deposit / CashEvent ----

export function depositToDomain(d: DepositEvent): DomainCashEvent {
  return {
    id: d.id,
    amount: toCents(d.amount),
    source: d.source,
    description: d.description,
    occurredAt: d.occurredAt,
    checkingBalanceAfter: toNonNegativeCents(d.checkingBalanceAfter),
  };
}
export function depositFromDomain(d: DomainCashEvent): DepositEvent {
  return {
    id: d.id,
    amount: toDollars(d.amount),
    source: d.source,
    description: d.description,
    occurredAt: d.occurredAt,
    checkingBalanceAfter: toDollars(d.checkingBalanceAfter),
  };
}

// ---- Rules ----

export function ruleToDomain(r: CashFlowRule): DomainRule {
  return {
    id: r.id,
    name: r.name,
    trigger: r.trigger,
    minAmount: r.minAmount != null ? toNonNegativeCents(r.minAmount) : undefined,
    reserveBalance: toNonNegativeCents(r.reserveBalance),
    action: r.action,
    amount:
      r.action === "invest_percentage"
        ? (r.amount as number)
        : (toNonNegativeCents(r.amount) as number),
    maxPerDeposit:
      r.maxPerDeposit != null ? toNonNegativeCents(r.maxPerDeposit) : undefined,
    maxPerMonth:
      r.maxPerMonth != null ? toNonNegativeCents(r.maxPerMonth) : undefined,
    portfolioId: r.portfolioId,
    active: r.active,
    order: r.order ?? 0,
  };
}

export function ruleFromDomain(r: DomainRule): CashFlowRule {
  return {
    id: r.id,
    name: r.name,
    trigger: r.trigger,
    minAmount: r.minAmount != null ? toDollars(r.minAmount) : undefined,
    reserveBalance: toDollars(r.reserveBalance),
    action: r.action,
    amount:
      r.action === "invest_percentage" ? (r.amount as number) : toDollars(r.amount as Cents),
    maxPerDeposit:
      r.maxPerDeposit != null ? toDollars(r.maxPerDeposit) : undefined,
    maxPerMonth: r.maxPerMonth != null ? toDollars(r.maxPerMonth) : undefined,
    portfolioId: r.portfolioId,
    active: r.active,
    order: r.order,
  };
}

// ---- RuleEvaluation → UI shape ----

export function evaluationToUi(e: DomainRuleEvaluation): RuleEvaluation {
  return {
    ruleId: e.ruleId,
    ruleName: e.ruleName,
    depositId: e.eventId,
    investmentAmount: toDollars(e.investmentAmount),
    qualified: e.qualified,
    decisions: e.decisions,
    reserveApplied: e.reserveApplied,
    skipped: e.skipped,
  };
}