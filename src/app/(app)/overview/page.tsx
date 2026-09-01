"use client";

import { useState } from "react";
import Link from "next/link";
import {
  ArrowUpRight,
  Layers,
  Wallet,
  FlaskConical,
  ShieldCheck,
  PauseCircle,
  Info,
  ArrowRight,
  CircleDollarSign,
} from "lucide-react";
import { PageHeader, StatCard } from "@/components/app/primitives";
import { Donut } from "@/components/app/donut";
import { ExplainDrawer } from "@/components/app/explain-drawer";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  mockAccount,
  positions,
  holdings,
  recentAutomation,
  todayChange,
} from "@/lib/data/mock";
import { formationScore, driftReport } from "@/lib/domain/allocation";
import { explainAllocation, runSimulation } from "@/lib/domain/simulation";
import { formatCurrency, formatPercent, greeting } from "@/lib/format";
import type { AllocationExplanation } from "@/lib/domain/types";

export default function OverviewPage() {
  const { portfolioState, checkingBalance, reserveBalance, rules, shadowSummary } =
    mockAccount;
  const score = formationScore(portfolioState);
  const drift = driftReport(portfolioState);

  const [explanation, setExplanation] = useState<AllocationExplanation | null>(
    null
  );

  function explainFirst() {
    // Re-derive the recent automation allocation for the explainability drawer.
    const sim = runSimulation({
      depositAmount: recentAutomation.amount,
      checkingBalanceAfter: checkingBalance,
      source: "payroll",
      rules,
      portfolioState,
    });
    if (sim.allocation && sim.allocation.lines.length) {
      const explained = explainAllocation(
        portfolioState,
        sim.allocation,
        sim.totalWouldInvest
      );
      setExplanation(explained[0]);
    }
  }

  const underweight = drift.filter((d) => d.action === "buy").slice(0, 2);

  return (
    <div>
      <PageHeader
        title={greeting()}
        description="Here's where your money is, and where it's heading."
      />

      {/* Value summary */}
      <div className="mb-6 grid gap-4 sm:grid-cols-3">
        <div className="rounded-2xl border border-border bg-card p-5 sm:col-span-2">
          <div className="flex items-center justify-between">
            <span className="text-sm text-muted-foreground">Portfolio value</span>
            <Badge variant="outline" className="gap-1 text-positive">
              <ArrowUpRight className="h-3 w-3" />
              +{formatPercent(todayChange.pct)}
            </Badge>
          </div>
          <p className="mt-2 text-3xl font-semibold tabular tracking-tight text-foreground">
            {formatCurrency(portfolioState.totalValue)}
          </p>
          <p className="mt-1 text-sm tabular text-positive">
            +{formatCurrency(todayChange.amount)} today
          </p>
        </div>
        <StatCard
          label="Flow this month"
          value={formatCurrency(shadowSummary.wouldHaveInvested)}
          sub={`${shadowSummary.depositsDetected} deposits detected`}
          icon={<CircleDollarSign className="h-4 w-4" />}
          tone="accent"
        />
      </div>

      <div className="grid gap-4 lg:grid-cols-3">
        {/* Your School / formation */}
        <div className="rounded-2xl border border-border bg-card p-5 lg:col-span-2">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <Layers className="h-4 w-4 text-brand" />
              <h2 className="text-sm font-medium text-foreground">Your school</h2>
            </div>
            <Button variant="ghost" size="sm" render={<Link href="/app/portfolio" />}>
              Manage
              <ArrowRight className="h-3.5 w-3.5" />
            </Button>
          </div>

          <div className="mt-5 flex flex-col items-center gap-6 sm:flex-row">
            <Donut
              data={positions.map((p) => ({ label: p.symbol, value: p.value }))}
              size={176}
              thickness={22}
              centerLabel={`${score}%`}
              centerSub="in formation"
            />
            <div className="w-full flex-1 space-y-2.5">
              {positions.map((p) => {
                const holding = holdings.find((h) => h.symbol === p.symbol);
                const target = holding?.targetPct ?? 0;
                return (
                  <div key={p.symbol} className="flex items-center gap-3">
                    <span className="w-14 font-mono text-sm font-medium tabular">
                      {p.symbol}
                    </span>
                    <div className="relative h-1.5 flex-1 rounded-full bg-secondary">
                      <div
                        className="absolute inset-y-0 left-0 rounded-full bg-brand/50"
                        style={{ width: `${p.currentPct}%` }}
                      />
                      <div
                        className="absolute top-1/2 h-3 w-0.5 -translate-y-1/2 rounded-full bg-foreground/70"
                        style={{ left: `${target}%` }}
                        title={`Target ${target}%`}
                      />
                    </div>
                    <span className="w-24 text-right text-xs tabular text-muted-foreground">
                      {p.currentPct.toFixed(1)}% / {target}%
                    </span>
                  </div>
                );
              })}
            </div>
          </div>

          <div className="mt-5 flex flex-wrap items-center gap-2">
            <Badge variant="outline" className="gap-1.5 text-warning">
              <span className="h-1.5 w-1.5 rounded-full bg-warning" />
              Slightly out of formation
            </Badge>
            <span className="text-xs text-muted-foreground">
              {underweight.length > 0 &&
                `${underweight.map((u) => u.symbol).join(" and ")} most underweight`}
            </span>
          </div>
        </div>

        {/* Cash flow */}
        <div className="space-y-4">
          <div className="rounded-2xl border border-border bg-card p-5">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <Wallet className="h-4 w-4 text-brand" />
                <h2 className="text-sm font-medium text-foreground">Cash flow</h2>
              </div>
              <Button variant="ghost" size="sm" render={<Link href="/app/simulate" />}>
                Simulate
              </Button>
            </div>
            <div className="mt-4 space-y-1 text-sm">
              <FlowRow label="Checking balance" value={formatCurrency(checkingBalance)} />
              <FlowRow label="Protected reserve" value={formatCurrency(reserveBalance)} />
              <div className="my-2 border-t border-border/60" />
              <FlowRow
                label="Available cash"
                value={formatCurrency(checkingBalance - reserveBalance)}
                strong
              />
            </div>
            <div className="mt-4 grid grid-cols-2 gap-2 rounded-xl bg-secondary/50 p-3 text-xs">
              <div>
                <p className="text-muted-foreground">Next expected paycheck</p>
                <p className="mt-0.5 font-medium text-foreground">Thursday</p>
              </div>
              <div>
                <p className="text-muted-foreground">Active investment rule</p>
                <p className="mt-0.5 font-medium text-foreground">20%</p>
              </div>
            </div>
          </div>

          {/* Shadow mode status */}
          <div className="rounded-2xl border border-brand/30 bg-brand/[0.04] p-5">
            <div className="flex items-center gap-2">
              <FlaskConical className="h-4 w-4 text-brand" />
              <h2 className="text-sm font-medium text-foreground">Shadow Mode on</h2>
            </div>
            <p className="mt-2 text-xs leading-relaxed text-muted-foreground">
              Alepes is watching and simulating — no real money is moving.
            </p>
            <div className="mt-3 flex items-center gap-3 text-xs">
              <span className="font-medium tabular text-foreground">
                {shadowSummary.depositsDetected} deposits
              </span>
              <span className="text-border">·</span>
              <span className="font-medium tabular text-foreground">
                {formatCurrency(shadowSummary.wouldHaveInvested)} would invest
              </span>
            </div>
          </div>
        </div>
      </div>

      {/* Recent automation */}
      <div className="mt-6 rounded-2xl border border-border bg-card p-5">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Activity pulse />
            <h2 className="text-sm font-medium text-foreground">Recent automation</h2>
          </div>
          <Badge variant="outline" className="gap-1.5 text-positive">
            <span className="h-1.5 w-1.5 rounded-full bg-positive" />
            Paycheck detected
          </Badge>
        </div>

        <div className="mt-4 flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <p className="text-2xl font-semibold tabular text-foreground">
              +{formatCurrency(recentAutomation.amount)}
            </p>
            <p className="mt-1 text-sm text-muted-foreground">
              Alepes allocated{" "}
              <span className="font-medium text-foreground">
                {formatCurrency(recentAutomation.allocatedForInvesting)}
              </span>{" "}
              for investing
            </p>
          </div>
          <Button
            variant="outline"
            size="sm"
            onClick={explainFirst}
            className="gap-1.5"
          >
            <Info className="h-3.5 w-3.5" />
            Why these investments?
          </Button>
        </div>

        <div className="mt-4 grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
          {recentAutomation.purchases.map((p) => (
            <div
              key={p.symbol}
              className="flex items-center justify-between rounded-xl bg-secondary/50 px-4 py-3"
            >
              <div>
                <p className="font-mono text-sm font-medium">{p.symbol}</p>
                <p className="text-xs text-muted-foreground">{p.name}</p>
              </div>
              <span className="font-mono text-sm tabular text-foreground">
                {formatCurrency(p.amount)}
              </span>
            </div>
          ))}
        </div>
      </div>

      {/* Safety strip */}
      <div className="mt-6 flex flex-wrap items-center gap-2 rounded-xl border border-border bg-secondary/30 p-3 text-xs text-muted-foreground">
        <ShieldCheck className="h-4 w-4 text-brand" />
        <span className="font-medium text-foreground">Safeguards</span>
        {[
          `${formatCurrency(reserveBalance)} minimum reserve`,
          "Contribution-only rebalancing",
          "Manual approval above $1,000",
        ].map((s) => (
          <span
            key={s}
            className="inline-flex items-center gap-1.5 rounded-full border border-border bg-card px-2.5 py-1"
          >
            {s}
          </span>
        ))}
        <span className="ml-auto inline-flex items-center gap-1.5 text-positive">
          <PauseCircle className="h-3.5 w-3.5" />
          Pause all
        </span>
      </div>

      <ExplainDrawer
        open={explanation !== null}
        onOpenChange={(v) => !v && setExplanation(null)}
        explanation={explanation}
      />
    </div>
  );
}

function FlowRow({
  label,
  value,
  strong,
}: {
  label: string;
  value: string;
  strong?: boolean;
}) {
  return (
    <div className="flex items-center justify-between">
      <span className="text-muted-foreground">{label}</span>
      <span
        className={
          strong
            ? "font-semibold tabular text-foreground"
            : "tabular text-foreground"
        }
      >
        {value}
      </span>
    </div>
  );
}

function Activity({ pulse }: { pulse?: boolean }) {
  return (
    <span className="relative inline-flex h-4 w-4 items-center justify-center text-brand">
      <span className="absolute h-1.5 w-1.5 rounded-full bg-brand" />
      {pulse && (
        <span className="absolute h-3 w-3 animate-ping rounded-full bg-brand/30" />
      )}
    </span>
  );
}