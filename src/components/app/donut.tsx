"use client";

// Lightweight SVG donut — no chart library needed for the core visualization.
// Returns arcs sized to each holding's value, with a center label.

import { cn } from "@/lib/utils";

export interface DonutDatum {
  label: string;
  value: number;
  color?: string;
}

const PALETTE = [
  "var(--chart-1)",
  "var(--chart-2)",
  "var(--chart-3)",
  "var(--chart-4)",
  "var(--chart-5)",
  "var(--brand)",
  "var(--flow)",
];

function polarToCartesian(cx: number, cy: number, r: number, angleDeg: number) {
  const rad = ((angleDeg - 90) * Math.PI) / 180;
  return { x: cx + r * Math.cos(rad), y: cy + r * Math.sin(rad) };
}

function arcPath(
  cx: number,
  cy: number,
  r: number,
  startAngle: number,
  endAngle: number
) {
  const start = polarToCartesian(cx, cy, r, endAngle);
  const end = polarToCartesian(cx, cy, r, startAngle);
  const largeArc = endAngle - startAngle <= 180 ? "0" : "1";
  return [
    `M ${start.x} ${start.y}`,
    `A ${r} ${r} 0 ${largeArc} 0 ${end.x} ${end.y}`,
  ].join(" ");
}

export function Donut({
  data,
  size = 180,
  thickness = 20,
  centerLabel,
  centerSub,
  className,
}: {
  data: DonutDatum[];
  size?: number;
  thickness?: number;
  centerLabel?: string;
  centerSub?: string;
  className?: string;
}) {
  const total = data.reduce((s, d) => s + d.value, 0) || 1;
  const r = (size - thickness) / 2;
  const cx = size / 2;
  const cy = size / 2;

  // Compute arcs with cumulative angles (fully immutable via reduce).
  const arcs = data.reduce<
    { start: number; end: number; color: string; label: string; value: number }[]
  >((acc, d, i) => {
    const start = acc.at(-1)?.end ?? 0;
    const sweep = (d.value / total) * 360;
    return [
      ...acc,
      {
        ...d,
        start,
        end: start + sweep,
        color: d.color ?? PALETTE[i % PALETTE.length],
      },
    ];
  }, []);

  return (
    <div
      className={cn("relative inline-flex items-center justify-center", className)}
      style={{ width: size, height: size }}
    >
      <svg width={size} height={size} className="-rotate-90">
        {arcs.map((a, i) => (
          <path
            key={i}
            d={arcPath(cx, cy, r, a.start, a.end)}
            fill="none"
            stroke={a.color}
            strokeWidth={thickness}
            strokeLinecap={a.end - a.start > 3 ? "round" : "butt"}
          />
        ))}
      </svg>
      {(centerLabel || centerSub) && (
        <div className="absolute inset-0 flex flex-col items-center justify-center">
          {centerLabel && (
            <span className="text-xl font-semibold tabular text-foreground">
              {centerLabel}
            </span>
          )}
          {centerSub && (
            <span className="text-xs text-muted-foreground">{centerSub}</span>
          )}
        </div>
      )}
    </div>
  );
}