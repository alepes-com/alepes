"use client";

import { useTheme } from "next-themes";
import { Sun, Moon } from "lucide-react";
import { Wordmark, Logo } from "@/components/brand/logo";

export function AuthShell({
  title,
  subtitle,
  children,
  footer,
}: {
  title: string;
  subtitle: string;
  children: React.ReactNode;
  footer?: React.ReactNode;
}) {
  const { resolvedTheme, setTheme } = useTheme();
  return (
    <div className="grid min-h-screen lg:grid-cols-2">
      {/* Left brand panel */}
      <div className="relative hidden overflow-hidden border-r border-border/60 bg-secondary/30 lg:flex lg:flex-col lg:justify-between lg:p-10">
        <div className="pointer-events-none absolute inset-0 bg-grid opacity-40" />
        <div className="pointer-events-none absolute -left-20 top-1/3 h-72 w-72 rounded-full bg-brand/10 blur-3xl" />
        <div className="relative">
          <Wordmark />
        </div>
        <div className="relative max-w-md">
          <div className="mb-6 flex h-14 w-14 items-center justify-center rounded-2xl bg-brand/10">
            <Logo size={30} className="text-brand" />
          </div>
          <h2 className="text-balance text-2xl font-semibold leading-snug tracking-tight text-foreground">
            &quot;Automation that keeps every dollar accountable — and every
            decision explainable.&quot;
          </h2>
          <p className="mt-4 text-sm text-muted-foreground">
            Cash-flow to investment, coordinated by rules you control.
          </p>
        </div>
        <div className="relative flex items-center gap-2 text-xs text-muted-foreground">
          <span className="inline-flex items-center gap-1.5 rounded-full bg-positive/10 px-2.5 py-1 text-positive">
            <span className="h-1.5 w-1.5 rounded-full bg-positive" />
            All systems operational
          </span>
          <span>· mock integrations active</span>
        </div>
      </div>

      {/* Right form panel */}
      <div className="flex flex-col">
        <div className="flex items-center justify-between p-6">
          <span className="lg:hidden">
            <Wordmark />
          </span>
          <button
            aria-label="Toggle theme"
            onClick={() => setTheme(resolvedTheme === "dark" ? "light" : "dark")}
            className="ml-auto inline-flex h-9 w-9 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground"
          >
            {resolvedTheme === "dark" ? (
              <Sun className="h-[18px] w-[18px]" />
            ) : (
              <Moon className="h-[18px] w-[18px]" />
            )}
          </button>
        </div>
        <div className="flex flex-1 items-center justify-center px-6 pb-16">
          <div className="w-full max-w-sm">
            <h1 className="text-2xl font-semibold tracking-tight text-foreground">
              {title}
            </h1>
            <p className="mt-2 text-sm text-muted-foreground">{subtitle}</p>
            <div className="mt-8">{children}</div>
            {footer && <div className="mt-6">{footer}</div>}
          </div>
        </div>
      </div>
    </div>
  );
}