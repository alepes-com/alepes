"use client";

import { useState } from "react";
import {
  FlaskConical,
  Play,
  ArrowDown,
  Info,
  CircleDollarSign,
  ShieldCheck,
} from "lucide-react";
import { PageHeader } from "@/components/app/primitives";
import { ExplainDrawer } from "@/components/app/explain-drawer";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { mockAccount } from "@/lib/data/mock";
import { runSimulation, explainAllocation } from "@/lib/domain/simulation";
import type { AllocationExplanation, SimulationResult } from "@/lib/domain/types";
import { formatCurrency } from "@/lib/format";

export default function SimulatePage() {
  const { rules, portfolioState, reserveBalance } = mockAccount;

  const [deposit, setDeposit] = useState("3000");
  const [balance, setBalance] = useState("4500");
  const [ruleId, setRuleId] = useState(rules[0]?.id ?? "");
  const [result, setResult] = useState<SimulationResult | null>(null);
  const [explanation, setExplanation] = useState<AllocationExplanation | null>(
    null
  );

  function run() {
    const input = {
      depositAmount: parseFloat(deposit) || 0,
      checkingBalanceAfter: (parseFloat(balance) || 0) + (parseFloat(deposit) || 0),
      source: "payroll" as const,
      rules,
      portfolioState,
      ruleId: ruleId || undefined,
    };
    const sim = runSimulation(input);
    setResult(sim);
  }

  const explain = (symbol: string) => {
    if (!result?.allocation) return;
    const explained = explainAllocation(
      portfolioState,
      result.allocation,
      result.totalWouldInvest
    );
    setExplanation(explained.find((e) => e.symbol === symbol) ?? null);
  };

  const checkingBefore = parseFloat(balance) || 0;
  const depositAmt = parseFloat(deposit) || 0;
  const ruleInvest = result?.totalWouldInvest ?? 0;
  const checkingAfter = checkingBefore + depositAmt - (result?.moneyWouldMove ? ruleInvest : 0);

  const rows = result
    ? [
        { label: "Checking before", value: formatCurrency(checkingBefore) },
        { label: "Deposit", value: `+${formatCurrency(depositAmt)}`, tone: "positive" },
        { label: "Protected reserve", value: formatCurrency(reserveBalance) },
        {
          label: "Rule investment",
          value: `-${formatCurrency(ruleInvest)}`,
          tone: ruleInvest > 0 ? "negative" : "neutral",
        },
        { label: "Checking after", value: formatCurrency(checkingAfter), strong: true },
      ]
    : [];

  return (
    <div>
      <PageHeader
        title="What if?"
        description="Test a deposit against your rules before it happens."
      />

      <div className="grid gap-6 lg:grid-cols-[360px_1fr]">
        {/* Inputs */}
        <div className="space-y-6">
          <div className="rounded-2xl border border-border bg-card p-5">
            <h3 className="flex items-center gap-2 text-sm font-medium text-foreground">
              <FlaskConical className="h-4 w-4 text-brand" />
              Simulate a deposit
            </h3>
            <div className="mt-5 space-y-4">
              <Field label="Deposit amount">
                <div className="relative">
                  <span className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground">
                    $
                  </span>
                  <Input
                    type="number"
                    value={deposit}
                    onChange={(e) => setDeposit(e.target.value)}
                    className="pl-7 font-mono tabular"
                  />
                </div>
              </Field>
              <Field label="Current checking balance">
                <div className="relative">
                  <span className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground">
                    $
                  </span>
                  <Input
                    type="number"
                    value={balance}
                    onChange={(e) => setBalance(e.target.value)}
                    className="pl-7 font-mono tabular"
                  />
                </div>
              </Field>
              <Field label="Rule">
                <Select value={ruleId} onValueChange={(v) => setRuleId(v ?? "")}>
                  <SelectTrigger className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {rules.map((r) => (
                      <SelectItem key={r.id} value={r.id}>
                        {r.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </Field>

              <Button size="lg" className="w-full" onClick={run}>
                <Play className="h-4 w-4" />
                Simulate
              </Button>
            </div>
          </div>

          <div className="rounded-2xl border border-border bg-secondary/30 p-4 text-xs leading-relaxed text-muted-foreground">
            <ShieldCheck className="mb-1 h-4 w-4 text-brand" />
            Simulations are read-only. No money moves, and nothing is recorded on
            your accounts.
          </div>
        </div>

        {/* Output */}
        <div className="space-y-4">
          {!result ? (
            <div className="flex h-full min-h-[320px] flex-col items-center justify-center rounded-2xl border border-dashed border-border p-12 text-center">
              <CircleDollarSign className="h-8 w-8 text-muted-foreground/40" />
              <h3 className="mt-3 text-sm font-medium text-foreground">
                No simulation yet
              </h3>
              <p className="mt-1 max-w-sm text-sm text-muted-foreground">
                Enter a deposit amount and rule, then run the simulation to see
                how Alepes would allocate it.
              </p>
            </div>
          ) : (
            <>
              <div className="rounded-2xl border border-border bg-card p-5">
                <h3 className="text-sm font-medium text-foreground">
                  Cash flow result
                </h3>
                <div className="mt-4 space-y-2">
                  {rows.map((r) => (
                    <div
                      key={r.label}
                      className="flex items-center justify-between py-1.5 text-sm"
                    >
                      <span className="text-muted-foreground">{r.label}</span>
                      <span
                        className={
                          r.strong
                            ? "font-semibold tabular text-foreground"
                            : r.tone === "positive"
                              ? "tabular text-positive"
                              : r.tone === "negative"
                                ? "tabular text-negative"
                                : "tabular text-foreground"
                        }
                      >
                        {r.value}
                      </span>
                    </div>
                  ))}
                </div>
              </div>

              {result.moneyWouldMove && result.allocation ? (
                <div className="rounded-2xl border border-border bg-card p-5">
                  <h3 className="text-sm font-medium text-foreground">
                    Proposed allocation — toward underweight holdings
                  </h3>
                  <div className="mt-4 space-y-2">
                    {result.allocation.lines.map((line) => (
                      <div
                        key={line.symbol}
                        className="flex items-center justify-between rounded-xl bg-secondary/50 px-4 py-3"
                      >
                        <div className="flex items-center gap-3">
                          <span className="font-mono text-sm font-medium">
                            {line.symbol}
                          </span>
                          <span className="text-xs text-muted-foreground">
                            {line.afterPct.toFixed(1)}% after
                          </span>
                        </div>
                        <div className="flex items-center gap-3">
                          <span className="font-mono text-sm tabular text-foreground">
                            {formatCurrency(line.amount)}
                          </span>
                          <button
                            onClick={() => explain(line.symbol)}
                            className="rounded-lg p-1 text-muted-foreground transition-colors hover:bg-secondary hover:text-brand"
                            aria-label={`Why ${line.symbol}`}
                          >
                            <Info className="h-4 w-4" />
                          </button>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              ) : (
                <div className="rounded-2xl border border-border bg-card p-5 text-sm text-muted-foreground">
                  This deposit would not trigger an investment under the selected
                  rule.{" "}
                  {result.evaluations[0]?.decisions[0]}
                </div>
              )}

              {/* Decision trace */}
              {result.evaluations[0]?.decisions.length > 0 && (
                <div className="rounded-2xl border border-border bg-card p-5">
                  <h3 className="text-sm font-medium text-foreground">
                    How Alepes decided
                  </h3>
                  <ul className="mt-3 space-y-2">
                    {result.evaluations[0].decisions.map((d, i) => (
                      <li
                        key={i}
                        className="flex items-start gap-2 text-sm text-muted-foreground"
                      >
                        <ArrowDown className="mt-0.5 h-3.5 w-3.5 shrink-0 text-brand" />
                        {d}
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </>
          )}
        </div>
      </div>

      <ExplainDrawer
        open={explanation !== null}
        onOpenChange={(v) => !v && setExplanation(null)}
        explanation={explanation}
      />
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="space-y-1.5">
      <label className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
        {label}
      </label>
      {children}
    </div>
  );
}