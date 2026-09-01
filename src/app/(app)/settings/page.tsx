"use client";

import { useState } from "react";
import {
  ShieldCheck,
  Banknote,
  PauseCircle,
  FlaskConical,
  Landmark,
  Building2,
  ChevronRight,
  GitBranch,
  Moon,
  Sun,
  LogOut,
} from "lucide-react";
import Link from "next/link";
import { PageHeader } from "@/components/app/primitives";
import { Switch } from "@/components/ui/switch";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { mockRegistry } from "@/lib/providers/mock";
import { versions } from "@/lib/data/mock";
import { useTheme } from "next-themes";
import { formatCurrency } from "@/lib/format";

export default function SettingsPage() {
  const { resolvedTheme, setTheme } = useTheme();
  const [shadowMode, setShadowMode] = useState(true);
  const [paused, setPaused] = useState(false);
  const [approvalThreshold, setApprovalThreshold] = useState("1000");

  return (
    <div>
      <PageHeader title="Settings" description="Control your safeguards and connections." />

      <div className="space-y-6">
        {/* Safety controls */}
        <section className="rounded-2xl border border-border bg-card p-5">
          <h2 className="flex items-center gap-2 text-sm font-medium text-foreground">
            <ShieldCheck className="h-4 w-4 text-brand" />
            Safety controls
          </h2>
          <p className="mt-1 text-xs text-muted-foreground">
            These safeguards can never be bypassed by automation.
          </p>

          <div className="mt-5 divide-y divide-border/60">
            <ToggleRow
              title="Shadow Mode"
              desc="Watch and simulate without moving money."
              icon={<FlaskConical className="h-4 w-4" />}
              checked={shadowMode}
              onChange={setShadowMode}
            />
            <ToggleRow
              title="Pause all automation"
              desc="Global kill-switch. Stops every active rule."
              icon={<PauseCircle className="h-4 w-4" />}
              checked={paused}
              onChange={setPaused}
              danger
            />
            <ToggleRow
              title="Contribution-only rebalancing"
              desc="Rebalance with new money only — never sell to rebalance."
              icon={<Banknote className="h-4 w-4" />}
              checked
              onChange={() => {}}
              locked
            />

            <div className="flex flex-col gap-3 py-4 sm:flex-row sm:items-center sm:justify-between">
              <div className="flex items-center gap-3">
                <span className="inline-flex h-9 w-9 items-center justify-center rounded-lg bg-secondary text-muted-foreground">
                  <Banknote className="h-4 w-4" />
                </span>
                <div>
                  <p className="text-sm font-medium text-foreground">
                    Require manual approval above
                  </p>
                  <p className="text-xs text-muted-foreground">
                    Larger transfers wait for your sign-off.
                  </p>
                </div>
              </div>
              <div className="relative w-40">
                <span className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground">
                  $
                </span>
                <Input
                  type="number"
                  value={approvalThreshold}
                  onChange={(e) => setApprovalThreshold(e.target.value)}
                  className="pl-7 font-mono tabular"
                />
              </div>
            </div>

            <div className="flex flex-col gap-3 py-4 sm:flex-row sm:items-center sm:justify-between">
              <div className="flex items-center gap-3">
                <span className="inline-flex h-9 w-9 items-center justify-center rounded-lg bg-secondary text-muted-foreground">
                  <Banknote className="h-4 w-4" />
                </span>
                <div>
                  <p className="text-sm font-medium text-foreground">
                    Minimum cash reserve
                  </p>
                  <p className="text-xs text-muted-foreground">
                    Always keep this much in checking.
                  </p>
                </div>
              </div>
              <Badge variant="outline" className="font-mono tabular">
                {formatCurrency(2000)}
              </Badge>
            </div>

            <div className="flex flex-col gap-3 py-4 sm:flex-row sm:items-center sm:justify-between">
              <div className="flex items-center gap-3">
                <span className="inline-flex h-9 w-9 items-center justify-center rounded-lg bg-secondary text-muted-foreground">
                  <Banknote className="h-4 w-4" />
                </span>
                <div>
                  <p className="text-sm font-medium text-foreground">
                    Maximum per deposit / month
                  </p>
                  <p className="text-xs text-muted-foreground">
                    Caps on any single contribution.
                  </p>
                </div>
              </div>
              <Badge variant="outline" className="font-mono tabular">
                {formatCurrency(750)} / {formatCurrency(2000)}
              </Badge>
            </div>
          </div>
        </section>

        {/* Connected accounts */}
        <section className="rounded-2xl border border-border bg-card p-5">
          <h2 className="flex items-center gap-2 text-sm font-medium text-foreground">
            <Landmark className="h-4 w-4 text-brand" />
            Connected accounts
          </h2>
          <div className="mt-4 space-y-2">
            <AccountRow
              icon={<Building2 className="h-4 w-4" />}
              name={mockRegistry.bank.name}
              type="Checking"
              status="Connected"
            />
            <AccountRow
              icon={<Landmark className="h-4 w-4" />}
              name={mockRegistry.brokerage.name}
              type="Brokerage"
              status="Connected"
            />
          </div>
          <Button variant="outline" size="sm" className="mt-4">
            Add an account
          </Button>
        </section>

        {/* Portfolio versions */}
        <section className="rounded-2xl border border-border bg-card p-5">
          <h2 className="flex items-center gap-2 text-sm font-medium text-foreground">
            <GitBranch className="h-4 w-4 text-brand" />
            Portfolio strategy history
          </h2>
          <div className="mt-4 space-y-2">
            {versions.map((v) => (
              <div
                key={v.version}
                className="flex items-center justify-between rounded-xl bg-secondary/40 px-4 py-3"
              >
                <div className="flex items-center gap-3">
                  <span className="font-mono text-sm font-medium text-brand">
                    v{v.version}
                  </span>
                  <span className="text-sm text-foreground">
                    {v.version === 3 ? "Portfolio v3" : `Portfolio v${v.version}`}
                  </span>
                </div>
                <span className="text-xs text-muted-foreground">{v.date}</span>
              </div>
            ))}
          </div>
        </section>

        {/* Appearance */}
        <section className="rounded-2xl border border-border bg-card p-5">
          <h2 className="text-sm font-medium text-foreground">Appearance</h2>
          <div className="mt-4 flex items-center gap-3">
            <Button
              variant={resolvedTheme === "light" ? "default" : "outline"}
              size="sm"
              onClick={() => setTheme("light")}
            >
              <Sun className="h-4 w-4" />
              Light
            </Button>
            <Button
              variant={resolvedTheme === "dark" ? "default" : "outline"}
              size="sm"
              onClick={() => setTheme("dark")}
            >
              <Moon className="h-4 w-4" />
              Dark
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={() => setTheme("system")}
            >
              System
            </Button>
          </div>
        </section>

        {/* Danger zone */}
        <section className="rounded-2xl border border-destructive/30 bg-destructive/[0.03] p-5">
          <h2 className="text-sm font-medium text-destructive">Danger zone</h2>
          <p className="mt-1 text-xs text-muted-foreground">
            Disconnect all integrations and delete your Alepes data.
          </p>
          <Button variant="destructive" size="sm" className="mt-4" render={<Link href="/login" />}>
            <LogOut className="h-4 w-4" />
            Sign out
          </Button>
        </section>
      </div>
    </div>
  );
}

function ToggleRow({
  title,
  desc,
  icon,
  checked,
  onChange,
  danger,
  locked,
}: {
  title: string;
  desc: string;
  icon: React.ReactNode;
  checked: boolean;
  onChange: (v: boolean) => void;
  danger?: boolean;
  locked?: boolean;
}) {
  return (
    <div className="flex items-center justify-between gap-3 py-4">
      <div className="flex items-center gap-3">
        <span
          className={`inline-flex h-9 w-9 items-center justify-center rounded-lg bg-secondary ${
            danger ? "text-destructive" : "text-muted-foreground"
          }`}
        >
          {icon}
        </span>
        <div>
          <p className="text-sm font-medium text-foreground">
            {title}
            {locked && (
              <Badge variant="outline" className="ml-2 text-muted-foreground">
                Fixed
              </Badge>
            )}
          </p>
          <p className="text-xs text-muted-foreground">{desc}</p>
        </div>
      </div>
      <Switch
        checked={checked}
        onCheckedChange={onChange}
        disabled={locked}
        aria-label={title}
      />
    </div>
  );
}

function AccountRow({
  icon,
  name,
  type,
  status,
}: {
  icon: React.ReactNode;
  name: string;
  type: string;
  status: string;
}) {
  return (
    <button className="flex w-full items-center gap-3 rounded-xl border border-border bg-secondary/30 px-4 py-3 text-left transition-colors hover:border-brand/30">
      <span className="inline-flex h-9 w-9 items-center justify-center rounded-lg bg-card text-brand">
        {icon}
      </span>
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-medium text-foreground">{name}</p>
        <p className="text-xs text-muted-foreground">{type}</p>
      </div>
      <Badge variant="outline" className="gap-1 text-positive">
        <span className="h-1.5 w-1.5 rounded-full bg-positive" />
        {status}
      </Badge>
      <ChevronRight className="h-4 w-4 text-muted-foreground" />
    </button>
  );
}