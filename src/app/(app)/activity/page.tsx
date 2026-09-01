"use client";

import { useMemo, useState } from "react";
import { Activity as ActivityIcon, Search } from "lucide-react";
import { PageHeader } from "@/components/app/primitives";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { activities } from "@/lib/data/mock";
import { formatRelativeTime, formatCurrency } from "@/lib/format";
import { cn } from "@/lib/utils";

const KIND_COLOR: Record<string, string> = {
  deposit: "bg-positive/15 text-positive",
  rule_evaluated: "bg-brand/15 text-brand",
  reserve_applied: "bg-warning/15 text-warning",
  allocation_generated: "bg-brand/15 text-brand",
  order_simulated: "bg-flow/15 text-flow",
  order_executed: "bg-positive/15 text-positive",
  hold: "bg-muted text-muted-foreground",
  version_change: "bg-secondary text-foreground",
  connection: "bg-secondary text-foreground",
  safety: "bg-warning/15 text-warning",
};

export default function ActivityPage() {
  const [filter, setFilter] = useState("all");
  const [query, setQuery] = useState("");

  const filtered = useMemo(() => {
    return activities.filter((a) => {
      if (filter !== "all" && a.kind !== filter) return false;
      if (query && !`${a.title} ${a.detail}`.toLowerCase().includes(query.toLowerCase()))
        return false;
      return true;
    });
  }, [filter, query]);

  return (
    <div>
      <PageHeader
        title="Activity"
        description="An immutable log of every decision Alepes made."
      />

      <div className="mb-5 flex flex-col gap-3 sm:flex-row sm:items-center">
        <div className="relative flex-1">
          <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search activity…"
            className="pl-9"
          />
        </div>
        <Select value={filter} onValueChange={(v) => setFilter(v ?? "all")}>
          <SelectTrigger className="w-full sm:w-48">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All events</SelectItem>
            <SelectItem value="deposit">Deposits</SelectItem>
            <SelectItem value="rule_evaluated">Rule evaluations</SelectItem>
            <SelectItem value="reserve_applied">Reserves</SelectItem>
            <SelectItem value="allocation_generated">Allocations</SelectItem>
            <SelectItem value="order_simulated">Simulated orders</SelectItem>
          </SelectContent>
        </Select>
      </div>

      {filtered.length === 0 ? (
        <div className="flex flex-col items-center justify-center rounded-2xl border border-dashed border-border p-16 text-center">
          <ActivityIcon className="h-8 w-8 text-muted-foreground/40" />
          <p className="mt-3 text-sm text-muted-foreground">No matching activity.</p>
        </div>
      ) : (
        <div className="overflow-hidden rounded-2xl border border-border">
          <ul className="divide-y divide-border/60">
            {filtered.map((a) => (
              <li
                key={a.id}
                className="flex items-start gap-4 bg-card px-5 py-4 transition-colors hover:bg-secondary/30"
              >
                <span
                  className={cn(
                    "mt-0.5 inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-lg",
                    KIND_COLOR[a.kind]
                  )}
                >
                  <Dot kind={a.kind} />
                </span>
                <div className="min-w-0 flex-1">
                  <div className="flex items-center justify-between gap-3">
                    <p className="text-sm font-medium text-foreground">{a.title}</p>
                    <span className="shrink-0 text-xs tabular text-muted-foreground">
                      {formatRelativeTime(a.at)}
                    </span>
                  </div>
                  <p className="mt-0.5 text-xs leading-relaxed text-muted-foreground">
                    {a.detail}
                  </p>
                </div>
                {a.amount != null && (
                  <span
                    className={cn(
                      "shrink-0 font-mono text-sm tabular",
                      a.tone === "positive"
                        ? "text-positive"
                        : a.tone === "negative"
                          ? "text-negative"
                          : "text-foreground"
                    )}
                  >
                    {a.tone === "positive" ? "+" : ""}
                    {formatCurrency(a.amount)}
                  </span>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

function Dot({ kind }: { kind: string }) {
  // A small glyph per event kind.
  switch (kind) {
    case "deposit":
      return <span className="h-1.5 w-1.5 rounded-full bg-current" />;
    case "rule_evaluated":
      return <span className="text-xs font-bold">R</span>;
    case "reserve_applied":
      return <span className="text-xs font-bold">$</span>;
    case "allocation_generated":
      return <span className="text-xs font-bold">%</span>;
    case "order_simulated":
      return <span className="text-xs font-bold">#</span>;
    default:
      return <span className="h-1.5 w-1.5 rounded-full bg-current" />;
  }
}