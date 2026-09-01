"use client";

import { Info, Target } from "lucide-react";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { formatCurrency, formatPercent } from "@/lib/format";
import type { AllocationExplanation } from "@/lib/domain/types";

export function ExplainDrawer({
  open,
  onOpenChange,
  explanation,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  explanation: AllocationExplanation | null;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        {explanation && (
          <>
            <DialogHeader>
              <DialogTitle className="flex items-center gap-2">
                <span className="inline-flex h-8 w-8 items-center justify-center rounded-lg bg-brand/10 text-brand">
                  <Info className="h-4 w-4" />
                </span>
                Why did Alepes buy {explanation.symbol}?
              </DialogTitle>
            </DialogHeader>
            <div className="space-y-4">
              <div className="grid grid-cols-2 gap-3">
                <ExplainCell label="Target allocation" value={formatPercent(explanation.targetPct)} />
                <ExplainCell label="Before contribution" value={formatPercent(explanation.beforePct)} />
                <ExplainCell
                  label="Underweight amount"
                  value={formatCurrency(explanation.underweightAmount)}
                />
                <ExplainCell
                  label="Available contribution"
                  value={formatCurrency(explanation.availableContribution)}
                />
              </div>
              <div className="flex items-start gap-3 rounded-xl bg-secondary/60 p-4">
                <Target className="mt-0.5 h-4 w-4 shrink-0 text-brand" />
                <p className="text-sm leading-relaxed text-muted-foreground">
                  {explanation.reason}
                </p>
              </div>
              <div className="rounded-xl border border-border p-4">
                <p className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
                  Directed this contribution
                </p>
                <p className="mt-1 text-2xl font-semibold tabular text-foreground">
                  {formatCurrency(explanation.amount)}
                </p>
              </div>
            </div>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}

function ExplainCell({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg bg-secondary/50 p-3">
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className="mt-0.5 text-sm font-semibold tabular text-foreground">{value}</p>
    </div>
  );
}