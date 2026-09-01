// Mock data for the fictional demo account. Every screen pulls from here.
// Realistic, internally consistent numbers matching the product spec.

import type {
  AccountState,
  ActivityEvent,
  CashFlowRule,
  Holding,
  Portfolio,
  PortfolioVersion,
  PositionSnapshot,
  SimulationSummary,
} from "../domain/types";

const portfolioId = "school-primary";

export const holdings: Holding[] = [
  { symbol: "AAPL", name: "Apple Inc.", targetPct: 20, bandMinPct: 17, bandMaxPct: 23 },
  { symbol: "MSFT", name: "Microsoft Corp.", targetPct: 20, bandMinPct: 17, bandMaxPct: 23 },
  { symbol: "GOOGL", name: "Alphabet Inc.", targetPct: 15, bandMinPct: 12.5, bandMaxPct: 17.5 },
  { symbol: "AMZN", name: "Amazon.com, Inc.", targetPct: 15, bandMinPct: 12.5, bandMaxPct: 17.5 },
  { symbol: "NVDA", name: "NVIDIA Corp.", targetPct: 10, bandMinPct: 7, bandMaxPct: 13 },
  { symbol: "BRK.B", name: "Berkshire Hathaway", targetPct: 10, bandMinPct: 7, bandMaxPct: 13 },
  { symbol: "V", name: "Visa Inc.", targetPct: 10, bandMinPct: 7, bandMaxPct: 13 },
];

// Current allocation percentages (sum to ~100) for $24,812.16 portfolio.
const pct = {
  AAPL: 21.3,
  MSFT: 16.8,
  GOOGL: 15.2,
  AMZN: 16.1,
  NVDA: 8.1,
  "BRK.B": 12.9,
  V: 9.6,
};

export const totalValue = 24812.16;

export const positions: PositionSnapshot[] = holdings.map((h) => {
  const currentPct = pct[h.symbol as keyof typeof pct];
  return {
    symbol: h.symbol,
    name: h.name,
    value: Number(((currentPct / 100) * totalValue).toFixed(2)),
    currentPct,
  };
});

export const portfolio: Portfolio = {
  id: portfolioId,
  name: "Primary School",
  version: 3,
  holdings,
};

export const prices: Record<string, number> = {
  AAPL: 232.4,
  MSFT: 421.7,
  GOOGL: 178.3,
  AMZN: 194.2,
  NVDA: 131.8,
  "BRK.B": 449.1,
  V: 278.6,
};

export const rules: CashFlowRule[] = [
  {
    id: "rule-paycheck",
    name: "Paycheck Rule",
    trigger: "payroll",
    reserveBalance: 2000,
    action: "invest_percentage",
    amount: 20,
    maxPerDeposit: 750,
    maxPerMonth: 2000,
    portfolioId,
    active: true,
    order: 0,
  },
  {
    id: "rule-bonus",
    name: "Bonus Rule",
    trigger: "bonus",
    minAmount: 1000,
    reserveBalance: 2000,
    action: "invest_percentage",
    amount: 50,
    maxPerDeposit: 1000,
    maxPerMonth: 3500,
    portfolioId,
    active: true,
    order: 1,
  },
  {
    id: "rule-transfer",
    name: "Windfall Rule",
    trigger: "any_deposit",
    minAmount: 5000,
    reserveBalance: 2000,
    action: "invest_fixed",
    amount: 600,
    maxPerDeposit: 600,
    maxPerMonth: 1200,
    portfolioId,
    active: false,
    order: 2,
  },
];

export const versions: PortfolioVersion[] = [
  {
    version: 3,
    label: "Current",
    date: "August 2",
    holdings: holdings.map((h, i) => ({ ...h, targetPct: [20, 20, 15, 15, 10, 10, 10][i] })),
  },
  {
    version: 2,
    label: "March 12",
    date: "March 12",
    holdings: holdings.map((h, i) => ({ ...h, targetPct: [25, 20, 15, 15, 8, 8, 9][i] })),
  },
  {
    version: 1,
    label: "January 4",
    date: "January 4",
    holdings: holdings.map((h, i) => ({ ...h, targetPct: [30, 20, 15, 15, 5, 5, 10][i] })),
  },
];

export const activities: ActivityEvent[] = [
  { id: "a1", at: "2026-08-31T09:14:03Z", kind: "order_simulated", title: "Shadow order simulated", detail: "No money moved. 4 fractional shares staged.", tone: "accent" },
  { id: "a2", at: "2026-08-31T09:14:01Z", kind: "allocation_generated", title: "Allocation generated", detail: "$422.15 routed toward underweight holdings.", tone: "accent" },
  { id: "a3", at: "2026-08-31T09:13:58Z", kind: "reserve_applied", title: "Cash reserve applied", detail: "Maximum allowed = $422.15 after $2,000 protected reserve.", amount: 422.15 },
  { id: "a4", at: "2026-08-31T09:13:56Z", kind: "rule_evaluated", title: "Investment rule evaluated", detail: "20% = $562.86 → capped by reserve to $422.15.", amount: 562.86 },
  { id: "a5", at: "2026-08-31T09:12:45Z", kind: "deposit", title: "Paycheck detected", detail: "Payroll +$2,814.32 from Acme Payroll.", amount: 2814.32, tone: "positive" },
  { id: "a6", at: "2026-08-28T12:40:11Z", kind: "hold", title: "Bonus deposit held", detail: "$1,200 bonus did not meet the $1,000 minimum for the Bonus Rule? Held for review.", tone: "neutral" },
  { id: "a7", at: "2026-08-28T12:39:50Z", kind: "deposit", title: "Deposit detected", detail: "General deposit +$1,200.00.", amount: 1200, tone: "neutral" },
  { id: "a8", at: "2026-08-24T09:18:22Z", kind: "order_simulated", title: "Shadow order simulated", detail: "$386.10 would have been invested (Shadow Mode).", tone: "accent" },
  { id: "a9", at: "2026-08-24T09:18:19Z", kind: "deposit", title: "Paycheck detected", detail: "Payroll +$2,814.32 from Acme Payroll.", amount: 2814.32, tone: "positive" },
  { id: "a10", at: "2026-08-17T09:15:02Z", kind: "rule_evaluated", title: "Investment rule evaluated", detail: "20% = $562.86 evaluated successfully.", amount: 562.86 },
  { id: "a11", at: "2026-08-17T09:14:58Z", kind: "deposit", title: "Paycheck detected", detail: "Payroll +$2,814.32 from Acme Payroll.", amount: 2814.32, tone: "positive" },
  { id: "a12", at: "2026-08-10T09:13:41Z", kind: "reserve_applied", title: "Cash reserve applied", detail: "Held to maintain $2,000 protected reserve.", tone: "neutral" },
  { id: "a13", at: "2026-08-10T09:13:40Z", kind: "deposit", title: "Paycheck detected", detail: "Payroll +$2,814.32 from Acme Payroll.", amount: 2814.32, tone: "positive" },
  { id: "a14", at: "2026-08-02T10:02:18Z", kind: "version_change", title: "Portfolio advanced to v3", detail: "Target allocations updated — NVDA raised to 10%.", tone: "neutral" },
  { id: "a15", at: "2026-07-28T10:02:18Z", kind: "connection", title: "Checking account connected", detail: "Linked via trusted financial-data provider (sandbox).", tone: "positive" },
];

export const shadowSummary: SimulationSummary = {
  depositsDetected: 4,
  wouldHaveInvested: 1740,
  transfersSkipped: 1,
  driftReducedPct: 38,
};

export const mockAccount: AccountState = {
  checkingBalance: 4812.44,
  reserveBalance: 2000,
  portfolioState: {
    portfolio,
    positions,
    totalValue,
  },
  rules,
  activities,
  versions,
  shadowSummary,
};

export const recentAutomation = {
  depositLabel: "Paycheck detected",
  amount: 2814.32,
  allocatedForInvesting: 422.15,
  purchases: [
    { symbol: "MSFT", name: "Microsoft Corp.", amount: 148.22 },
    { symbol: "NVDA", name: "NVIDIA Corp.", amount: 112.3 },
    { symbol: "V", name: "Visa Inc.", amount: 91.14 },
    { symbol: "GOOGL", name: "Alphabet Inc.", amount: 70.49 },
  ] as { symbol: string; name: string; amount: number }[],
};

// A helper for the fluctuation of "today's change".
export const todayChange = { amount: 183.42, pct: 0.74 };