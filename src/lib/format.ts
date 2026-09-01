// Formatting helpers for consistent financial readouts across the app.

export function formatCurrency(
  amount: number,
  opts: { sign?: boolean; decimals?: number } = {}
): string {
  const { sign = false, decimals = 2 } = opts;
  const abs = Math.abs(amount);
  const base = new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  }).format(abs);
  if (!sign) return amount < 0 ? `-${base}` : base;
  return (amount >= 0 ? "+" : "-") + base;
}

export function formatPercent(amount: number, decimals = 1): string {
  return `${amount.toFixed(decimals)}%`;
}

/** "Today 9:13 AM", "Yesterday", or "Aug 28". */
export function formatRelativeTime(iso: string): string {
  const date = new Date(iso);
  const now = new Date();
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const startOfDate = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  const diffDays = Math.round(
    (startOfToday.getTime() - startOfDate.getTime()) / 86400000
  );

  const time = date.toLocaleTimeString("en-US", {
    hour: "numeric",
    minute: "2-digit",
  });

  if (diffDays === 0) return `Today ${time}`;
  if (diffDays === 1) return `Yesterday ${time}`;
  if (diffDays < 7) {
    return `${date.toLocaleDateString("en-US", { weekday: "long" })} ${time}`;
  }
  return date.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
  });
}

export function formatNumber(n: number): string {
  return new Intl.NumberFormat("en-US").format(n);
}

/** Compact money for tight spaces: $4.8K, $1.74M. */
export function formatCompactCurrency(n: number): string {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    notation: "compact",
    maximumFractionDigits: 1,
  }).format(n);
}

export function greeting(): string {
  const h = new Date().getHours();
  if (h < 12) return "Good morning";
  if (h < 18) return "Good afternoon";
  return "Good evening";
}