"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  LayoutDashboard,
  Layers,
  SlidersHorizontal,
  Activity,
  FlaskConical,
  Settings,
  Sun,
  Moon,
  Menu,
  X,
} from "lucide-react";
import { useTheme } from "next-themes";
import { Wordmark } from "@/components/brand/logo";
import { cn } from "@/lib/utils";
import { useState } from "react";

const NAV = [
  { label: "Overview", href: "/app/overview", icon: LayoutDashboard },
  { label: "Portfolio", href: "/app/portfolio", icon: Layers },
  { label: "Rules", href: "/app/rules", icon: SlidersHorizontal },
  { label: "Activity", href: "/app/activity", icon: Activity },
  { label: "Simulate", href: "/app/simulate", icon: FlaskConical },
  { label: "Settings", href: "/app/settings", icon: Settings },
];

function NavItems({ onNavigate }: { onNavigate?: () => void }) {
  const pathname = usePathname();
  return (
    <nav className="flex flex-col gap-1">
      {NAV.map((item) => {
        const active = pathname === item.href;
        return (
          <Link
            key={item.href}
            href={item.href}
            onClick={onNavigate}
            className={cn(
              "flex items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium transition-colors",
              active
                ? "bg-brand/10 text-brand"
                : "text-muted-foreground hover:bg-secondary hover:text-foreground"
            )}
          >
            <item.icon className="h-[18px] w-[18px]" />
            {item.label}
          </Link>
        );
      })}
    </nav>
  );
}

function ThemeToggle() {
  const { resolvedTheme, setTheme } = useTheme();
  return (
    <button
      aria-label="Toggle theme"
      onClick={() => setTheme(resolvedTheme === "dark" ? "light" : "dark")}
      className="inline-flex h-9 w-9 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground"
    >
      {resolvedTheme === "dark" ? (
        <Sun className="h-[18px] w-[18px]" />
      ) : (
        <Moon className="h-[18px] w-[18px]" />
      )}
    </button>
  );
}

export function AppShell({ children }: { children: React.ReactNode }) {
  const [open, setOpen] = useState(false);

  return (
    <div className="min-h-screen">
      {/* Desktop sidebar */}
      <aside className="fixed inset-y-0 left-0 z-40 hidden w-60 flex-col border-r border-border/60 bg-secondary/30 px-4 py-5 md:flex">
        <div className="flex items-center px-2">
          <Wordmark logoSize={24} textClassName="text-lg" />
        </div>
        <div className="mt-8 flex-1">
          <NavItems />
        </div>
        <div className="space-y-3 border-t border-border/60 pt-4">
          <div className="flex items-center gap-3 px-2">
            <div className="relative flex h-9 w-9 items-center justify-center rounded-full bg-brand/10">
              <span className="text-sm font-semibold text-brand">J</span>
              <span className="absolute -bottom-0.5 -right-0.5 h-2.5 w-2.5 rounded-full border-2 border-background bg-positive" />
            </div>
            <div className="min-w-0">
              <p className="truncate text-sm font-medium text-foreground">
                Jordan Lee
              </p>
              <p className="truncate text-xs text-muted-foreground">
                Shadow Mode
              </p>
            </div>
          </div>
          <div className="flex items-center justify-between px-2">
            <Link
              href="/"
              className="text-xs text-muted-foreground hover:text-foreground"
            >
              ← Back to site
            </Link>
            <ThemeToggle />
          </div>
        </div>
      </aside>

      {/* Mobile top bar */}
      <header className="sticky top-0 z-40 flex h-14 items-center justify-between border-b border-border/60 bg-background/90 px-4 backdrop-blur md:hidden">
        <Wordmark logoSize={22} textClassName="text-base" />
        <button
          aria-label="Menu"
          onClick={() => setOpen((v) => !v)}
          className="inline-flex h-9 w-9 items-center justify-center rounded-lg text-muted-foreground hover:bg-secondary"
        >
          {open ? <X className="h-5 w-5" /> : <Menu className="h-5 w-5" />}
        </button>
      </header>

      {/* Mobile drawer */}
      {open && (
        <div className="fixed inset-0 z-50 md:hidden">
          <div
            className="absolute inset-0 bg-black/40"
            onClick={() => setOpen(false)}
          />
          <div className="absolute inset-y-0 right-0 w-72 border-l border-border bg-background p-4">
            <div className="mb-6 flex items-center justify-between">
              <Wordmark logoSize={22} />
              <button
                aria-label="Close"
                onClick={() => setOpen(false)}
                className="inline-flex h-9 w-9 items-center justify-center rounded-lg text-muted-foreground hover:bg-secondary"
              >
                <X className="h-5 w-5" />
              </button>
            </div>
            <NavItems onNavigate={() => setOpen(false)} />
            <div className="mt-6 border-t border-border/60 pt-4">
              <ThemeToggle />
            </div>
          </div>
        </div>
      )}

      {/* Main content */}
      <main className="md:pl-60">
        <div className="mx-auto max-w-5xl px-4 py-6 md:px-8 md:py-8">
          {children}
        </div>
      </main>
    </div>
  );
}