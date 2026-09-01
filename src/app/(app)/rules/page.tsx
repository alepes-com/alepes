"use client";

import { useMemo, useState } from "react";
import {
  Plus,
  Check,
  SlidersHorizontal,
  ArrowRight,
  Zap,
  CircleDollarSign,
} from "lucide-react";
import { PageHeader } from "@/components/app/primitives";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import { rules as initialRules } from "@/lib/data/mock";
import { summarizeRule } from "@/lib/domain/rules";
import type { CashFlowRule } from "@/lib/domain/types";

export default function RulesPage() {
  const [rules, setRules] = useState<CashFlowRule[]>(initialRules);
  const [open, setOpen] = useState(false);

  function toggle(id: string) {
    setRules((prev) =>
      prev.map((r) => (r.id === id ? { ...r, active: !r.active } : r))
    );
  }

  function addRule(rule: CashFlowRule) {
    setRules((prev) => [...prev, rule]);
  }

  return (
    <div>
      <PageHeader
        title="Rules"
        description="Automation is defined by rules you control."
        actions={
          <Button size="sm" onClick={() => setOpen(true)}>
            <Plus className="h-4 w-4" />
            New rule
          </Button>
        }
      />

      {rules.length === 0 ? (
        <div className="flex flex-col items-center justify-center rounded-2xl border border-dashed border-border p-16 text-center">
          <SlidersHorizontal className="h-8 w-8 text-muted-foreground/50" />
          <h3 className="mt-3 text-sm font-medium text-foreground">No rules yet</h3>
          <p className="mt-1 max-w-xs text-sm text-muted-foreground">
            Create your first rule to tell Alepes how new cash should flow.
          </p>
          <Button size="sm" className="mt-4" onClick={() => setOpen(true)}>
            <Plus className="h-4 w-4" />
            Create a rule
          </Button>
        </div>
      ) : (
        <div className="space-y-4">
          {rules.map((rule) => (
            <div
              key={rule.id}
              className="rounded-2xl border border-border bg-card transition-colors hover:border-brand/30"
            >
              <div className="flex items-center justify-between border-b border-border/60 px-5 py-4">
                <div className="flex items-center gap-3">
                  <span className="inline-flex h-9 w-9 items-center justify-center rounded-xl bg-brand/10 text-brand">
                    {rule.trigger === "payroll" ? (
                      <CircleDollarSign className="h-[18px] w-[18px]" />
                    ) : rule.trigger === "bonus" ? (
                      <Zap className="h-[18px] w-[18px]" />
                    ) : (
                      <SlidersHorizontal className="h-[18px] w-[18px]" />
                    )}
                  </span>
                  <div>
                    <h3 className="text-sm font-semibold text-foreground">
                      {rule.name}
                    </h3>
                    <p className="text-xs text-muted-foreground">
                      {summarizeRule(rule)}
                    </p>
                  </div>
                </div>
                <div className="flex items-center gap-3">
                  <Badge
                    variant="outline"
                    className={rule.active ? "text-positive" : "text-muted-foreground"}
                  >
                    {rule.active ? "Active" : "Paused"}
                  </Badge>
                  <Switch
                    checked={rule.active}
                    onCheckedChange={() => toggle(rule.id)}
                    aria-label={`Toggle ${rule.name}`}
                  />
                </div>
              </div>

              <dl className="grid gap-x-6 gap-y-1 px-5 py-4 text-sm sm:grid-cols-2 lg:grid-cols-3">
                <RuleField label="Trigger" value={triggerLabel(rule)} />
                <RuleField
                  label="Investment rate"
                  value={
                    rule.action === "invest_percentage"
                      ? `${rule.amount}%`
                      : `$${rule.amount}`
                  }
                />
                <RuleField
                  label="Minimum checking balance"
                  value={`$${rule.reserveBalance.toLocaleString()}`}
                />
                {rule.maxPerDeposit != null && (
                  <RuleField
                    label="Maximum per deposit"
                    value={`$${rule.maxPerDeposit.toLocaleString()}`}
                  />
                )}
                {rule.maxPerMonth != null && (
                  <RuleField
                    label="Monthly maximum"
                    value={`$${rule.maxPerMonth.toLocaleString()}`}
                  />
                )}
                <RuleField label="Destination" value="Primary School" />
              </dl>
            </div>
          ))}
        </div>
      )}

      <RuleBuilderDialog
        open={open}
        onOpenChange={setOpen}
        onSave={(rule) => {
          addRule(rule);
          setOpen(false);
        }}
      />
    </div>
  );
}

function triggerLabel(rule: CashFlowRule): string {
  const min = rule.minAmount != null ? ` > $${rule.minAmount.toLocaleString()}` : "";
  switch (rule.trigger) {
    case "payroll":
      return "Payroll deposit detected";
    case "bonus":
      return `Bonus deposit${min}`;
    default:
      return min ? `Deposit${min}` : "Any deposit";
  }
}

function RuleField({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex flex-col py-2">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="mt-0.5 font-medium tabular text-foreground">{value}</dd>
    </div>
  );
}

function RuleBuilderDialog({
  open,
  onOpenChange,
  onSave,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  onSave: (rule: CashFlowRule) => void;
}) {
  const [trigger, setTrigger] = useState<CashFlowRule["trigger"]>("payroll");
  const [minAmount, setMinAmount] = useState("");
  const [reserve, setReserve] = useState("2000");
  const [action, setAction] = useState<CashFlowRule["action"]>("invest_percentage");
  const [amount, setAmount] = useState("20");
  const [maxPerDeposit, setMaxPerDeposit] = useState("750");
  const [maxPerMonth, setMaxPerMonth] = useState("");
  const [name, setName] = useState("New Rule");

  const summary = useMemo(() => {
    const draft: CashFlowRule = {
      id: "draft",
      name,
      trigger,
      minAmount: minAmount ? parseFloat(minAmount) : undefined,
      reserveBalance: parseFloat(reserve) || 0,
      action,
      amount: parseFloat(amount) || 0,
      maxPerDeposit: maxPerDeposit ? parseFloat(maxPerDeposit) : undefined,
      maxPerMonth: maxPerMonth ? parseFloat(maxPerMonth) : undefined,
      portfolioId: "school-primary",
      active: true,
      order: 0,
    };
    return summarizeRule(draft);
  }, [trigger, minAmount, reserve, action, amount, maxPerDeposit, maxPerMonth, name]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Build a rule</DialogTitle>
        </DialogHeader>

        <div className="space-y-5">
          <Field label="Name">
            <Input value={name} onChange={(e) => setName(e.target.value)} />
          </Field>

          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="WHEN">
              <Select value={trigger} onValueChange={(v) => setTrigger(v as CashFlowRule["trigger"])}>
                <SelectTrigger className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="payroll">Payroll deposit</SelectItem>
                  <SelectItem value="any_deposit">Any deposit</SelectItem>
                  <SelectItem value="bonus">Bonus deposit</SelectItem>
                </SelectContent>
              </Select>
            </Field>
            <Field label="FROM">
              <Select defaultValue="payroll">
                <SelectTrigger className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="payroll">Payroll</SelectItem>
                  <SelectItem value="any">Any source</SelectItem>
                  <SelectItem value="specific">Specific source</SelectItem>
                </SelectContent>
              </Select>
            </Field>
          </div>

          <Field label="AMOUNT — greater than (optional)">
            <Input
              type="number"
              placeholder="e.g. 1000"
              value={minAmount}
              onChange={(e) => setMinAmount(e.target.value)}
              className="font-mono tabular"
            />
          </Field>

          <Field label="IF — checking balance stays above">
            <div className="relative">
              <span className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground">
                $
              </span>
              <Input
                type="number"
                value={reserve}
                onChange={(e) => setReserve(e.target.value)}
                className="pl-7 font-mono tabular"
              />
            </div>
          </Field>

          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="THEN">
              <Select value={action} onValueChange={(v) => setAction(v as CashFlowRule["action"])}>
                <SelectTrigger className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="invest_percentage">Invest percentage</SelectItem>
                  <SelectItem value="invest_fixed">Invest fixed amount</SelectItem>
                </SelectContent>
              </Select>
            </Field>
            <Field label={action === "invest_percentage" ? "Percentage %" : "Fixed $"}>
              <Input
                type="number"
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
                className="font-mono tabular"
              />
            </Field>
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="MAXIMUM — per deposit">
              <div className="relative">
                <span className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground">
                  $
                </span>
                <Input
                  type="number"
                  value={maxPerDeposit}
                  onChange={(e) => setMaxPerDeposit(e.target.value)}
                  className="pl-7 font-mono tabular"
                />
              </div>
            </Field>
            <Field label="MONTHLY LIMIT — optional">
              <div className="relative">
                <span className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground">
                  $
                </span>
                <Input
                  type="number"
                  value={maxPerMonth}
                  onChange={(e) => setMaxPerMonth(e.target.value)}
                  className="pl-7 font-mono tabular"
                />
              </div>
            </Field>
          </div>

          <Field label="DESTINATION">
            <Select defaultValue="school-primary">
              <SelectTrigger className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="school-primary">Primary Portfolio</SelectItem>
                <SelectItem value="school-taxable">Taxable Brokerage</SelectItem>
              </SelectContent>
            </Select>
          </Field>

          <div className="flex items-start gap-3 rounded-xl bg-brand/[0.06] p-4">
            <span className="mt-0.5 inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-brand/10 text-brand">
              <Check className="h-3.5 w-3.5" />
            </span>
            <p className="text-sm leading-relaxed text-muted-foreground">
              <span className="font-medium text-foreground">Summary: </span>
              {summary}
            </p>
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            onClick={() =>
              onSave({
                id: `rule-${Date.now()}`,
                name: name || "New Rule",
                trigger,
                minAmount: minAmount ? parseFloat(minAmount) : undefined,
                reserveBalance: parseFloat(reserve) || 0,
                action,
                amount: parseFloat(amount) || 0,
                maxPerDeposit: maxPerDeposit ? parseFloat(maxPerDeposit) : undefined,
                maxPerMonth: maxPerMonth ? parseFloat(maxPerMonth) : undefined,
                portfolioId: "school-primary",
                active: true,
                order: 0,
              })
            }
          >
            Create rule
            <ArrowRight className="h-4 w-4" />
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
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