import Link from "next/link";
import {
  ArrowRight,
  Link2,
  Layers,
  SlidersHorizontal,
  Focus,
  ShieldCheck,
  Lock,
  FileText,
  PauseCircle,
  CloudOff,
  TrendingDown,
  Sparkles,
  Check,
  Eye,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { PublicHeader } from "@/components/marketing/public-header";
import { SiteFooter } from "@/components/marketing/site-footer";
import { HeroFlow } from "@/components/marketing/hero-flow";

export default function LandingPage() {
  return (
    <div className="min-h-screen">
      <PublicHeader />

      {/* ============ HERO ============ */}
      <section className="relative overflow-hidden">
        <div className="pointer-events-none absolute inset-0 bg-grid" />
        <div className="pointer-events-none absolute -top-40 left-1/2 h-[500px] w-[900px] -translate-x-1/2 rounded-full bg-brand/10 blur-3xl" />
        <div className="relative mx-auto grid max-w-6xl gap-12 px-5 pb-20 pt-16 md:grid-cols-2 md:items-center md:pb-28 md:pt-24">
          <div>
            <Badge variant="outline" className="gap-1.5 text-muted-foreground">
              <Sparkles className="h-3.5 w-3.5 text-brand" />
              Cash-flow automation for long-term investors
            </Badge>
            <h1 className="mt-5 text-balance text-4xl font-semibold leading-[1.05] tracking-tight text-foreground sm:text-5xl md:text-6xl">
              Your money,
              <br />
              moving together.
            </h1>
            <p className="mt-5 max-w-md text-lg leading-relaxed text-muted-foreground">
              Alepes automatically directs new cash toward the investments that
              need it most — according to rules you control.
            </p>
            <div className="mt-8 flex flex-col gap-3 sm:flex-row">
              <Button size="lg" render={<Link href="/signup" />}>
                Build your school
                <ArrowRight className="h-4 w-4" />
              </Button>
              <Button size="lg" variant="outline" render={<Link href="/#how-it-works" />}>
                See how it works
              </Button>
            </div>
            <p className="mt-5 text-xs text-muted-foreground">
              Start in Shadow Mode — test everything before any money moves.
            </p>
          </div>
          <HeroFlow />
        </div>
      </section>

      {/* ============ HOW IT WORKS ============ */}
      <section id="how-it-works" className="border-t border-border/60">
        <div className="mx-auto max-w-6xl px-5 py-20 md:py-28">
          <div className="max-w-2xl">
            <p className="text-sm font-medium uppercase tracking-wider text-brand">
              How it works
            </p>
            <h2 className="mt-3 text-balance text-3xl font-semibold tracking-tight text-foreground sm:text-4xl">
              From cash flow to formation — in four steps.
            </h2>
          </div>

          <div className="mt-12 grid gap-5 sm:grid-cols-2 lg:grid-cols-4">
            {[
              {
                icon: Link2,
                step: "01",
                title: "Connect your accounts",
                body: "Link your checking account and brokerage. Credentials stay with trusted financial-data providers — never stored by Alepes.",
              },
              {
                icon: Layers,
                step: "02",
                title: "Build your school",
                body: "Choose the stocks and ETFs you want, and assign target percentages. Your target is your formation.",
              },
              {
                icon: SlidersHorizontal,
                step: "03",
                title: "Create your rules",
                body: "Decide when money moves: how much to invest, what to keep in reserve, and how much any single deposit can send.",
              },
              {
                icon: Focus,
                step: "04",
                title: "Stay in formation",
                body: "Alepes directs each contribution toward underweight holdings — rebalancing with new money, not selling.",
              },
            ].map((s) => (
              <div
                key={s.step}
                className="group relative rounded-2xl border border-border bg-card p-6 transition-colors hover:border-brand/40"
              >
                <div className="flex items-center justify-between">
                  <span className="inline-flex h-10 w-10 items-center justify-center rounded-xl bg-secondary text-brand">
                    <s.icon className="h-5 w-5" />
                  </span>
                  <span className="font-mono text-sm text-muted-foreground/60">
                    {s.step}
                  </span>
                </div>
                <h3 className="mt-4 text-lg font-semibold text-foreground">
                  {s.title}
                </h3>
                <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
                  {s.body}
                </p>
              </div>
            ))}
          </div>

          {/* Rule example strip */}
          <div className="mt-8 grid gap-px overflow-hidden rounded-2xl border border-border bg-border md:grid-cols-4">
            {[
              ["WHEN", "Paycheck deposit arrives"],
              ["IF", "Checking remains above $2,000"],
              ["THEN", "Invest 20%"],
              ["MAX", "$750 per deposit"],
            ].map(([label, value]) => (
              <div key={label} className="bg-card p-5">
                <span className="font-mono text-xs uppercase tracking-wider text-brand">
                  {label}
                </span>
                <p className="mt-2 text-sm font-medium text-foreground">{value}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* ============ DIFFERENTIATOR ============ */}
      <section id="product" className="border-t border-border/60 bg-secondary/40">
        <div className="mx-auto max-w-6xl px-5 py-20 md:py-28">
          <div className="grid gap-12 md:grid-cols-2 md:items-center">
            <div>
              <p className="text-sm font-medium uppercase tracking-wider text-brand">
                The Alepes difference
              </p>
              <h2 className="mt-3 text-balance text-3xl font-semibold tracking-tight text-foreground sm:text-4xl">
                Rebalance with new money — not unnecessary selling.
              </h2>
              <p className="mt-5 text-lg leading-relaxed text-muted-foreground">
                Traditional rebalancing means selling winners to buy losers.
                Alepes instead routes each new contribution toward the holdings
                that are most underweight — quietly reducing drift over time
                without triggering taxable sales.
              </p>
              <ul className="mt-6 space-y-3">
                {[
                  "Contribution-only rebalancing — no forced selling",
                  "Underweight holdings get priority on every deposit",
                  "Respects your allocation bands automatically",
                ].map((t) => (
                  <li key={t} className="flex items-start gap-3 text-sm">
                    <Check className="mt-0.5 h-4 w-4 shrink-0 text-positive" />
                    <span className="text-muted-foreground">{t}</span>
                  </li>
                ))}
              </ul>
            </div>

            {/* Drift table */}
            <div className="rounded-2xl border border-border bg-card p-6 shadow-lg shadow-brand/5">
              <div className="flex items-center justify-between">
                <h3 className="text-sm font-medium text-foreground">
                  Current formation
                </h3>
                <Badge variant="outline" className="gap-1 text-warning">
                  <TrendingDown className="h-3 w-3" />
                  4.8% drift
                </Badge>
              </div>
              <table className="mt-5 w-full text-sm">
                <thead>
                  <tr className="border-b border-border text-left text-xs uppercase tracking-wider text-muted-foreground">
                    <th className="pb-2 font-medium">Symbol</th>
                    <th className="pb-2 text-right font-medium">Target</th>
                    <th className="pb-2 text-right font-medium">Current</th>
                    <th className="pb-2 text-right font-medium">Action</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border/60">
                  {[
                    { s: "AAPL", t: "20%", c: "24.8%", a: "Hold", tone: "muted" },
                    { s: "MSFT", t: "20%", c: "16.9%", a: "Buy", tone: "positive" },
                    { s: "NVDA", t: "10%", c: "7.8%", a: "Buy", tone: "positive" },
                    { s: "GOOGL", t: "15%", c: "15.4%", a: "Hold", tone: "muted" },
                  ].map((r) => (
                    <tr key={r.s}>
                      <td className="py-3 font-mono font-medium tabular">{r.s}</td>
                      <td className="py-3 text-right tabular text-muted-foreground">
                        {r.t}
                      </td>
                      <td className="py-3 text-right tabular">{r.c}</td>
                      <td className="py-3 text-right">
                        <span
                          className={
                            r.tone === "positive"
                              ? "font-medium text-positive"
                              : "text-muted-foreground"
                          }
                        >
                          {r.a}
                        </span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <p className="mt-4 rounded-lg bg-secondary/60 p-3 text-xs leading-relaxed text-muted-foreground">
                Underweight holdings (MSFT, NVDA) receive the next contribution
                — the rest stay put.
              </p>
            </div>
          </div>
        </div>
      </section>

      {/* ============ RULES ENGINE ============ */}
      <section id="rules" className="border-t border-border/60">
        <div className="mx-auto max-w-6xl px-5 py-20 md:py-28">
          <div className="max-w-2xl">
            <p className="text-sm font-medium uppercase tracking-wider text-brand">
              Rules engine
            </p>
            <h2 className="mt-3 text-balance text-3xl font-semibold tracking-tight text-foreground sm:text-4xl">
              Your automation, spelled out in plain rules.
            </h2>
            <p className="mt-4 text-lg text-muted-foreground">
              No code. No guesswork. Just clear conditions for when your money
              moves.
            </p>
          </div>

          <div className="mt-12 grid gap-5 md:grid-cols-2">
            <RuleCard
              name="Paycheck Rule"
              tone="brand"
              rows={[
                ["Trigger", "Payroll deposit detected"],
                ["Investment rate", "20%"],
                ["Minimum checking balance", "$2,000"],
                ["Maximum per deposit", "$750"],
                ["Monthly maximum", "$2,000"],
              ]}
            />
            <RuleCard
              name="Bonus Rule"
              tone="flow"
              rows={[
                ["Trigger", "Bonus deposit > $1,000"],
                ["Invest", "50%"],
                ["Reserve", "$500"],
                ["Maximum per deposit", "$1,000"],
              ]}
            />
          </div>
        </div>
      </section>

      {/* ============ SHADOW MODE ============ */}
      <section id="shadow-mode" className="border-t border-border/60 bg-secondary/40">
        <div className="mx-auto max-w-6xl px-5 py-20 md:py-28">
          <div className="grid gap-12 md:grid-cols-2 md:items-center">
            <div>
              <Badge variant="outline" className="gap-1.5 text-muted-foreground">
                <Eye className="h-3.5 w-3.5 text-brand" />
                Shadow Mode
              </Badge>
              <h2 className="mt-4 text-balance text-3xl font-semibold tracking-tight text-foreground sm:text-4xl">
                Test the whole system before it moves a dollar.
              </h2>
              <p className="mt-5 text-lg leading-relaxed text-muted-foreground">
                Shadow Mode watches your accounts, evaluates your rules, and
                shows exactly what it <em>would</em> do — without moving any
                money. When you&apos;re confident, flip it on.
              </p>

              <div className="mt-8 grid gap-4 sm:grid-cols-2">
                {[
                  ["4", "Deposits detected"],
                  ["$1,740", "Would have invested"],
                  ["1", "Transfers skipped"],
                  ["38%", "Drift reduced"],
                ].map(([v, l]) => (
                  <div key={l} className="rounded-xl border border-border bg-card p-4">
                    <p className="text-2xl font-semibold tabular text-foreground">
                      {v}
                    </p>
                    <p className="mt-1 text-sm text-muted-foreground">{l}</p>
                  </div>
                ))}
              </div>
              <Button size="lg" className="mt-8" render={<Link href="/signup" />}>
                Try Shadow Mode
              </Button>
            </div>

            {/* Shadow simulation card */}
            <div className="rounded-2xl border border-border bg-card p-6 shadow-lg shadow-brand/5">
              <div className="flex items-center justify-between">
                <h3 className="text-sm font-medium text-foreground">
                  Shadow simulation
                </h3>
                <Badge className="bg-negative/10 text-negative">No money moved</Badge>
              </div>

              <div className="mt-5 space-y-1.5 text-sm">
                <Row label="Deposit detected" value="$2,100" />
                <Row label="Would invest" value="$420" />
              </div>

              <div className="mt-4 border-t border-border pt-4">
                <p className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
                  Proposed allocation
                </p>
                <div className="mt-3 space-y-2">
                  {[
                    ["MSFT", "$155"],
                    ["GOOGL", "$117"],
                    ["NVDA", "$86"],
                    ["V", "$62"],
                  ].map(([s, v]) => (
                    <div
                      key={s}
                      className="flex items-center justify-between rounded-lg bg-secondary/50 px-3 py-2"
                    >
                      <span className="font-mono text-sm font-medium">{s}</span>
                      <span className="font-mono text-sm tabular text-muted-foreground">
                        {v}
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* ============ SECURITY ============ */}
      <section id="security" className="border-t border-border/60">
        <div className="mx-auto max-w-6xl px-5 py-20 md:py-28">
          <div className="max-w-2xl">
            <p className="text-sm font-medium uppercase tracking-wider text-brand">
              Security
            </p>
            <h2 className="mt-3 text-balance text-3xl font-semibold tracking-tight text-foreground sm:text-4xl">
              Built with a security-first architecture.
            </h2>
            <p className="mt-4 text-lg text-muted-foreground">
              Automation is powerful — so it has to be safe. Alepes is designed
              so you stay in control of every dollar.
            </p>
          </div>

          <div className="mt-12 grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
            {[
              {
                icon: CloudOff,
                title: "Credentials never stored here",
                body: "Your bank credentials are never stored directly by Alepes. Connections route through trusted financial-data providers.",
              },
              {
                icon: Lock,
                title: "Encrypted in transit and at rest",
                body: "All data is protected with encryption in transit and at rest, following industry best practices.",
              },
              {
                icon: PauseCircle,
                title: "Automation you can pause",
                body: "A global kill-switch pauses all automation instantly. You are always one tap from full control.",
              },
              {
                icon: SlidersHorizontal,
                title: "You define the rules",
                body: "Nothing moves without a rule you wrote. Amounts, reserves, and limits are yours to set.",
              },
              {
                icon: FileText,
                title: "Every action explained",
                body: "An immutable audit log records why each decision was made — traceable at any time.",
              },
              {
                icon: ShieldCheck,
                title: "Contribution-only by default",
                body: "Alepes rebalances with new money first. It never sells holdings unless you explicitly allow it.",
              },
            ].map((f) => (
              <div key={f.title} className="rounded-2xl border border-border bg-card p-6">
                <span className="inline-flex h-10 w-10 items-center justify-center rounded-xl bg-secondary text-brand">
                  <f.icon className="h-5 w-5" />
                </span>
                <h3 className="mt-4 text-base font-semibold text-foreground">
                  {f.title}
                </h3>
                <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
                  {f.body}
                </p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* ============ PRICING ============ */}
      <section id="pricing" className="border-t border-border/60 bg-secondary/40">
        <div className="mx-auto max-w-6xl px-5 py-20 md:py-28">
          <div className="mx-auto max-w-2xl text-center">
            <p className="text-sm font-medium uppercase tracking-wider text-brand">
              Pricing
            </p>
            <h2 className="mt-3 text-balance text-3xl font-semibold tracking-tight text-foreground sm:text-4xl">
              Start free. Upgrade when you automate.
            </h2>
          </div>

          <div className="mt-12 grid gap-5 lg:grid-cols-3">
            <PricingCard
              name="Free"
              price="$0"
              tagline="Explore and simulate"
              features={[
                "One portfolio",
                "Shadow Mode",
                "Manual simulations",
                "Portfolio drift tracking",
              ]}
              cta="Start free"
            />
            <PricingCard
              name="Plus"
              price="$8"
              tagline="Put automation to work"
              featured
              features={[
                "Automated deposit rules",
                "Unlimited simulations",
                "Multiple rules",
                "Advanced portfolio analytics",
              ]}
              cta="Start with Plus"
            />
            <PricingCard
              name="Pro"
              price="$15"
              tagline="For serious builders"
              features={[
                "Multiple portfolios",
                "Advanced cash-flow routing",
                "Custom allocation bands",
                "Priority automation",
                "Detailed reporting",
              ]}
              cta="Start with Pro"
            />
          </div>
          <p className="mt-8 text-center text-xs text-muted-foreground">
            Prices shown are placeholder for this preview and may change.
          </p>
        </div>
      </section>

      {/* ============ FINAL CTA ============ */}
      <section className="border-t border-border/60">
        <div className="mx-auto max-w-6xl px-5 py-20 md:py-28">
          <div className="relative overflow-hidden rounded-3xl border border-border bg-card p-10 text-center md:p-16">
            <div className="pointer-events-none absolute inset-0 bg-grid opacity-40" />
            <div className="pointer-events-none absolute -top-24 left-1/2 h-64 w-[600px] -translate-x-1/2 rounded-full bg-brand/15 blur-3xl" />
            <div className="relative">
              <h2 className="text-balance text-3xl font-semibold tracking-tight text-foreground sm:text-4xl">
                Bring your money back into formation.
              </h2>
              <p className="mx-auto mt-4 max-w-xl text-lg text-muted-foreground">
                Connect your accounts, build your school, and let your new cash
                do the rebalancing for you.
              </p>
              <div className="mt-8 flex flex-col items-center justify-center gap-3 sm:flex-row">
                <Button size="lg" render={<Link href="/signup" />}>
                  Build your school
                  <ArrowRight className="h-4 w-4" />
                </Button>
                <Button size="lg" variant="outline" render={<Link href="/login" />}>
                  Sign in
                </Button>
              </div>
            </div>
          </div>
        </div>
      </section>

      <SiteFooter />
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between">
      <span className="text-muted-foreground">{label}</span>
      <span className="font-medium tabular text-foreground">{value}</span>
    </div>
  );
}

function RuleCard({
  name,
  tone,
  rows,
}: {
  name: string;
  tone: "brand" | "flow";
  rows: [string, string][];
}) {
  return (
    <div className="overflow-hidden rounded-2xl border border-border bg-card">
      <div
        className={`flex items-center justify-between border-b border-border px-6 py-4 ${
          tone === "brand" ? "bg-brand/[0.06]" : "bg-flow/[0.08]"
        }`}
      >
        <div className="flex items-center gap-3">
          <span
            className={`inline-flex h-8 w-8 items-center justify-center rounded-lg ${
              tone === "brand" ? "bg-brand/15 text-brand" : "bg-flow/15 text-flow"
            }`}
          >
            <SlidersHorizontal className="h-4 w-4" />
          </span>
          <h3 className="text-base font-semibold text-foreground">{name}</h3>
        </div>
        <Badge variant="outline" className="gap-1 text-positive">
          <span className="h-1.5 w-1.5 rounded-full bg-positive" />
          Active
        </Badge>
      </div>
      <dl className="divide-y divide-border/60 px-6">
        {rows.map(([k, v]) => (
          <div key={k} className="flex items-center justify-between py-3.5 text-sm">
            <dt className="text-muted-foreground">{k}</dt>
            <dd className="font-medium tabular text-foreground">{v}</dd>
          </div>
        ))}
      </dl>
    </div>
  );
}

function PricingCard({
  name,
  price,
  tagline,
  features,
  cta,
  featured = false,
}: {
  name: string;
  price: string;
  tagline: string;
  features: string[];
  cta: string;
  featured?: boolean;
}) {
  return (
    <div
      className={`relative rounded-2xl border p-6 ${
        featured
          ? "border-brand/50 bg-card shadow-xl shadow-brand/10"
          : "border-border bg-card"
      }`}
    >
      {featured && (
        <Badge className="absolute -top-3 left-6 bg-brand text-brand-foreground">
          Most popular
        </Badge>
      )}
      <h3 className="text-lg font-semibold text-foreground">{name}</h3>
      <p className="mt-1 text-sm text-muted-foreground">{tagline}</p>
      <div className="mt-4 flex items-baseline gap-1">
        <span className="text-4xl font-semibold tabular text-foreground">
          {price}
        </span>
        <span className="text-sm text-muted-foreground">/month</span>
      </div>
      <ul className="mt-6 space-y-3">
        {features.map((f) => (
          <li key={f} className="flex items-start gap-3 text-sm">
            <Check className="mt-0.5 h-4 w-4 shrink-0 text-positive" />
            <span className="text-muted-foreground">{f}</span>
          </li>
        ))}
      </ul>
      <Button
        className="mt-8 w-full"
        variant={featured ? "default" : "outline"}
        size="lg"
        render={<Link href="/signup" />}
      >
        {cta}
      </Button>
    </div>
  );
}