"use client";

import { useMemo, useState } from "react";
import {
  Search,
  Plus,
  Trash2,
  Check,
  AlertTriangle,
  GripVertical,
  ArrowLeft,
  GitBranch,
} from "lucide-react";
import { PageHeader } from "@/components/app/primitives";
import { Donut } from "@/components/app/donut";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { holdings, versions } from "@/lib/data/mock";
import type { Holding } from "@/lib/domain/types";
import { cn } from "@/lib/utils";

// A small searchable universe of symbols for the demo.
const UNIVERSE = [
  { symbol: "AAPL", name: "Apple Inc." },
  { symbol: "MSFT", name: "Microsoft Corp." },
  { symbol: "GOOGL", name: "Alphabet Inc." },
  { symbol: "AMZN", name: "Amazon.com, Inc." },
  { symbol: "NVDA", name: "NVIDIA Corp." },
  { symbol: "BRK.B", name: "Berkshire Hathaway" },
  { symbol: "V", name: "Visa Inc." },
  { symbol: "META", name: "Meta Platforms" },
  { symbol: "TSLA", name: "Tesla, Inc." },
  { symbol: "JPM", name: "JPMorgan Chase" },
  { symbol: "COST", name: "Costco Wholesale" },
  { symbol: "VTI", name: "Vanguard Total Market ETF" },
  { symbol: "VOO", name: "Vanguard S&P 500 ETF" },
  { symbol: "QQQ", name: "Invesco QQQ Trust" },
];

export default function PortfolioPage() {
  const [items, setItems] = useState<Holding[]>(holdings);
  const [query, setQuery] = useState("");
  const [showSearch, setShowSearch] = useState(false);
  const [dragging, setDragging] = useState<number | null>(null);

  const total = useMemo(
    () => items.reduce((s, h) => s + h.targetPct, 0),
    [items]
  );
  const inBalance = Math.abs(total - 100) < 0.01;

  const results = UNIVERSE.filter(
    (u) =>
      !items.some((h) => h.symbol === u.symbol) &&
      (query === "" ||
        u.symbol.toLowerCase().includes(query.toLowerCase()) ||
        u.name.toLowerCase().includes(query.toLowerCase()))
  ).slice(0, 5);

  function addHolding(symbol: string, name: string) {
    setItems((prev) => [...prev, { symbol, name, targetPct: 0 }]);
    setQuery("");
    setShowSearch(false);
  }

  function removeHolding(symbol: string) {
    setItems((prev) => prev.filter((h) => h.symbol !== symbol));
  }

  function setTarget(symbol: string, value: number) {
    setItems((prev) =>
      prev.map((h) =>
        h.symbol === symbol ? { ...h, targetPct: Math.max(0, value) } : h
      )
    );
  }

  function setBand(symbol: string, key: "bandMinPct" | "bandMaxPct", value: number) {
    setItems((prev) =>
      prev.map((h) => (h.symbol === symbol ? { ...h, [key]: value } : h))
    );
  }

  function reorder(from: number, to: number) {
    setItems((prev) => {
      const next = [...prev];
      const [moved] = next.splice(from, 1);
      next.splice(to, 0, moved);
      return next;
    });
  }

  return (
    <div>
      <PageHeader
        title="Build your school"
        description="Choose your holdings and set target allocations."
        actions={
          <Button
            variant="outline"
            size="sm"
            onClick={() => setShowSearch((v) => !v)}
          >
            {showSearch ? <ArrowLeft className="h-4 w-4" /> : <Plus className="h-4 w-4" />}
            {showSearch ? "Close" : "Add holding"}
          </Button>
        }
      />

      <Tabs defaultValue="builder">
        <TabsList>
          <TabsTrigger value="builder">Allocations</TabsTrigger>
          <TabsTrigger value="versions" className="gap-1.5">
            <GitBranch className="h-3.5 w-3.5" />
            Versions
          </TabsTrigger>
        </TabsList>

        <TabsContent value="builder" className="mt-6">
          <div className="grid gap-6 lg:grid-cols-[1fr_320px]">
            {/* Holdings editor */}
            <div className="space-y-4">
              {showSearch && (
                <div className="rounded-2xl border border-border bg-card p-4">
                  <div className="relative">
                    <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                    <Input
                      value={query}
                      onChange={(e) => setQuery(e.target.value)}
                      placeholder="Search stocks and ETFs…"
                      className="pl-9"
                      autoFocus
                    />
                  </div>
                  {query && results.length > 0 && (
                    <div className="mt-2 divide-y divide-border/60">
                      {results.map((r) => (
                        <button
                          key={r.symbol}
                          onClick={() => addHolding(r.symbol, r.name)}
                          className="flex w-full items-center justify-between py-2.5 text-left hover:bg-secondary/50"
                        >
                          <div className="flex items-center gap-3">
                            <span className="font-mono text-sm font-medium">
                              {r.symbol}
                            </span>
                            <span className="text-sm text-muted-foreground">
                              {r.name}
                            </span>
                          </div>
                          <Plus className="h-4 w-4 text-muted-foreground" />
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              )}

              {items.length === 0 && (
                <div className="flex flex-col items-center justify-center rounded-2xl border border-dashed border-border p-12 text-center">
                  <LayersIcon />
                  <h3 className="mt-3 text-sm font-medium text-foreground">
                    Your school is empty
                  </h3>
                  <p className="mt-1 text-sm text-muted-foreground">
                    Add a holding to start building your formation.
                  </p>
                  <Button
                    size="sm"
                    className="mt-4"
                    onClick={() => setShowSearch(true)}
                  >
                    <Plus className="h-4 w-4" />
                    Add holding
                  </Button>
                </div>
              )}

              {items.map((h, i) => (
                <div
                  key={h.symbol}
                  draggable
                  onDragStart={() => setDragging(i)}
                  onDragOver={(e) => e.preventDefault()}
                  onDrop={() => {
                    if (dragging !== null && dragging !== i) reorder(dragging, i);
                    setDragging(null);
                  }}
                  className={cn(
                    "group rounded-2xl border border-border bg-card p-4 transition-colors",
                    dragging === i && "opacity-50"
                  )}
                >
                  <div className="flex items-start gap-3">
                    <GripVertical className="mt-3 h-4 w-4 cursor-grab text-muted-foreground/40" />
                    <div className="flex-1 space-y-4">
                      <div className="flex items-center justify-between">
                        <div className="flex items-center gap-3">
                          <span className="font-mono text-base font-semibold">
                            {h.symbol}
                          </span>
                          <span className="text-sm text-muted-foreground">
                            {h.name}
                          </span>
                        </div>
                        <button
                          onClick={() => removeHolding(h.symbol)}
                          className="rounded-lg p-1.5 text-muted-foreground transition-colors hover:bg-destructive/10 hover:text-destructive"
                          aria-label={`Remove ${h.symbol}`}
                        >
                          <Trash2 className="h-4 w-4" />
                        </button>
                      </div>

                      <div className="grid gap-4 sm:grid-cols-3">
                        <div>
                          <label className="text-xs text-muted-foreground">
                            Target %
                          </label>
                          <div className="relative mt-1">
                            <Input
                              type="number"
                              min={0}
                              step={0.5}
                              value={h.targetPct}
                              onChange={(e) =>
                                setTarget(h.symbol, parseFloat(e.target.value) || 0)
                              }
                              className="pr-7 font-mono tabular"
                            />
                            <span className="absolute right-3 top-1/2 -translate-y-1/2 text-sm text-muted-foreground">
                              %
                            </span>
                          </div>
                        </div>
                        <div>
                          <label className="text-xs text-muted-foreground">
                            Allowed range
                          </label>
                          <div className="mt-1 flex items-center gap-1.5">
                            <Input
                              type="number"
                              value={h.bandMinPct ?? ""}
                              placeholder="17"
                              onChange={(e) =>
                                setBand(
                                  h.symbol,
                                  "bandMinPct",
                                  parseFloat(e.target.value) || 0
                                )
                              }
                              className="font-mono tabular"
                            />
                            <span className="text-muted-foreground">–</span>
                            <Input
                              type="number"
                              value={h.bandMaxPct ?? ""}
                              placeholder="23"
                              onChange={(e) =>
                                setBand(
                                  h.symbol,
                                  "bandMaxPct",
                                  parseFloat(e.target.value) || 0
                                )
                              }
                              className="font-mono tabular"
                            />
                            <span className="text-sm text-muted-foreground">%</span>
                          </div>
                        </div>
                        <div className="flex items-end">
                          <Badge
                            variant="outline"
                            className="gap-1.5 font-mono text-xs"
                          >
                            <GitBranch className="h-3 w-3" />
                            v{3}
                          </Badge>
                        </div>
                      </div>
                    </div>
                  </div>
                </div>
              ))}
            </div>

            {/* Summary / donut */}
            <div className="lg:sticky lg:top-6 lg:self-start">
              <div className="rounded-2xl border border-border bg-card p-5">
                <h3 className="text-sm font-medium text-foreground">
                  Total allocation
                </h3>
                <div className="mt-4 flex justify-center">
                  <Donut
                    data={items.map((h) => ({ label: h.symbol, value: h.targetPct }))}
                    size={180}
                    thickness={20}
                    centerLabel={`${total.toFixed(1)}%`}
                    centerSub={inBalance ? "on target" : "of 100%"}
                  />
                </div>

                <div
                  className={cn(
                    "mt-4 flex items-center gap-2 rounded-lg p-3 text-sm",
                    inBalance
                      ? "bg-positive/10 text-positive"
                      : "bg-warning/10 text-warning"
                  )}
                >
                  {inBalance ? (
                    <Check className="h-4 w-4" />
                  ) : (
                    <AlertTriangle className="h-4 w-4" />
                  )}
                  {inBalance
                    ? "Allocations total 100% — your school is balanced."
                    : `Allocations total ${total.toFixed(1)}% — ${
                        total < 100
                          ? `add ${(100 - total).toFixed(1)}%`
                          : `remove ${(total - 100).toFixed(1)}%`
                      } to reach 100%.`}
                </div>

                <div className="mt-4 space-y-1.5">
                  {items.map((h, i) => (
                    <div key={h.symbol} className="flex items-center gap-2 text-xs">
                      <span
                        className="h-2 w-2 rounded-full"
                        style={{
                          background: `var(--chart-${(i % 5) + 1})`,
                        }}
                      />
                      <span className="font-mono">{h.symbol}</span>
                      <span className="ml-auto tabular text-muted-foreground">
                        {h.targetPct}%
                      </span>
                    </div>
                  ))}
                </div>

                <Button className="mt-5 w-full" size="lg" disabled={!inBalance}>
                  {inBalance ? "Save formation" : "Balance to save"}
                </Button>
              </div>
            </div>
          </div>
        </TabsContent>

        <TabsContent value="versions" className="mt-6">
          <div className="space-y-3">
            {versions.map((v) => (
              <div
                key={v.version}
                className="flex items-center justify-between rounded-2xl border border-border bg-card p-5"
              >
                <div className="flex items-center gap-4">
                  <span className="inline-flex h-9 w-9 items-center justify-center rounded-xl bg-secondary font-mono text-sm font-medium text-brand">
                    v{v.version}
                  </span>
                  <div>
                    <p className="text-sm font-medium text-foreground">
                      Portfolio v{v.version}
                      {v.version === 3 && (
                        <Badge className="ml-2">Current</Badge>
                      )}
                    </p>
                    <p className="text-xs text-muted-foreground">{v.date}</p>
                  </div>
                </div>
                <p className="hidden items-center gap-1 text-xs text-muted-foreground sm:flex">
                  {v.holdings
                    .slice(0, 3)
                    .map((h) => `${h.symbol} ${h.targetPct}%`)
                    .join(" · ")}
                  {v.holdings.length > 3 && " …"}
                </p>
              </div>
            ))}
          </div>
        </TabsContent>
      </Tabs>
    </div>
  );
}

function LayersIcon() {
  return (
    <span className="inline-flex h-10 w-10 items-center justify-center rounded-xl bg-secondary text-muted-foreground">
      <Search className="h-5 w-5" />
    </span>
  );
}