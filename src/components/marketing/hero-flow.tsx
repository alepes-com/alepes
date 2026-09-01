"use client";

import { useEffect, useState } from "react";
import { motion, AnimatePresence } from "framer-motion";

// A self-playing "flow" sequence: deposit arrives → reserve held → contribution
// split across underweight holdings → formation restored.

const STEPS = [
  {
    key: "deposit",
    title: "Paycheck +$3,200",
    sub: "Payroll deposit detected",
    tone: "accent",
  },
  {
    key: "reserve",
    title: "$2,720 available to invest",
    sub: "$2,000 kept in checking reserve",
    tone: "neutral",
  },
  {
    key: "allocate",
    title: "Directed to underweight holdings",
    sub: "Contribution-based rebalancing",
    tone: "neutral",
  },
  {
    key: "formation",
    title: "Portfolio back in formation",
    sub: "No unnecessary selling",
    tone: "positive",
  },
];

const ALLOCATIONS = [
  { symbol: "MSFT", amount: "+$172", width: "62%" },
  { symbol: "GOOGL", amount: "+$133", width: "48%" },
  { symbol: "V", amount: "+$101", width: "37%" },
  { symbol: "NVDA", amount: "+$74", width: "27%" },
];

function useStepCycle() {
  const [step, setStep] = useState(0);
  useEffect(() => {
    const id = setInterval(
      () => setStep((s) => (s + 1) % STEPS.length),
      2600
    );
    return () => clearInterval(id);
  }, []);
  return step;
}

export function HeroFlow() {
  const step = useStepCycle();
  const current = STEPS[step];

  return (
    <div className="relative w-full overflow-hidden rounded-2xl border border-border bg-card/80 p-6 shadow-xl shadow-brand/5 sm:p-7">
      {/* Subtle grid backdrop */}
      <div className="pointer-events-none absolute inset-0 bg-grid opacity-40" />

      <div className="relative space-y-5">
        <div className="flex items-center justify-between">
          <span className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
            Live flow
          </span>
          <span className="inline-flex items-center gap-1.5 rounded-full bg-positive/10 px-2.5 py-1 text-xs font-medium text-positive">
            <span className="relative flex h-1.5 w-1.5">
              <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-positive opacity-60" />
              <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-positive" />
            </span>
            Shadow Mode
          </span>
        </div>

        {/* Step indicator dots */}
        <div className="flex items-center gap-1.5">
          {STEPS.map((s, i) => (
            <span
              key={s.key}
              className={`h-1 rounded-full transition-all duration-500 ${
                i === step ? "w-6 bg-brand" : "w-2 bg-border"
              }`}
            />
          ))}
        </div>

        <AnimatePresence mode="wait">
          <motion.div
            key={current.key}
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -8 }}
            transition={{ duration: 0.35 }}
          >
            <h3 className="text-2xl font-semibold tracking-tight text-foreground">
              {current.title}
            </h3>
            <p className="mt-1 text-sm text-muted-foreground">{current.sub}</p>
          </motion.div>
        </AnimatePresence>

        {/* Allocation bars */}
        <div className="space-y-2.5 pt-1">
          {ALLOCATIONS.map((a, i) => {
            const active = step >= 2;
            return (
              <div key={a.symbol} className="flex items-center gap-3">
                <span className="w-14 font-mono text-sm font-medium tabular">
                  {a.symbol}
                </span>
                <div className="h-2 flex-1 overflow-hidden rounded-full bg-secondary">
                  <motion.div
                    className="h-full rounded-full bg-gradient-to-r from-brand to-flow"
                    initial={{ width: 0 }}
                    animate={{
                      width: active ? a.width : "4%",
                      opacity: active ? 1 : 0.3,
                    }}
                    transition={{
                      delay: active ? i * 0.12 : 0,
                      duration: 0.6,
                      ease: "easeOut",
                    }}
                  />
                </div>
                <span className="w-14 text-right font-mono text-sm font-medium tabular text-muted-foreground">
                  {a.amount}
                </span>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}