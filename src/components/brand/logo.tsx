import { cn } from "@/lib/utils";

/**
 * Alepes logomark — several streamlined fish moving in coordinated formation,
 * together forming an abstract "A". Designed to hold up at favicon size.
 */
export function Logo({
  className,
  size = 28,
}: {
  className?: string;
  size?: number;
}) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 32 32"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      className={cn("shrink-0", className)}
      aria-hidden="true"
    >
      {/* Three fish sweeping into an "A" formation, apex at top. */}
      {/* Left fish — sweeps down-left */}
      <path
        d="M6.5 12c4.5-3 9 1.5 9 6.5s-1 5.5-3.5 6c-1.5.3-3.5-.5-4-2-.4-1.2 0-2.4 1-3.2-7.2 0-7.2-9 0-9 .8-.3 1.6-.4 2.3-.4Z"
        fill="currentColor"
        opacity="0.72"
      />
      {/* Right fish — sweeps down-right */}
      <path
        d="M25.5 12c-4.5-3-9 1.5-9 6.5s1 5.5 3.5 6c1.5.3 3.5-.5 4-2 .4-1.2 0-2.4-1-3.2 7.2 0 7.2-9 0-9-.8-.3-1.6-.4-2.3-.4Z"
        fill="currentColor"
        opacity="0.72"
      />
      {/* Center fish — the spine / apex of the "A" */}
      <path
        d="M16 4.5c1.2 4.2 1.2 8.5 0 12.6-1.2 4.1-3 7.1-4.4 9.4-.4.7.5 1.1 1 .6 1.6-1.7 3-4.8 4.2-8.9 1.2 4.1 2.6 7.2 4.2 8.9.5.5 1.4.1 1-.6-1.4-2.3-3.2-5.3-4.4-9.4C16.6 13 16.6 8.7 16 4.5Z"
        fill="currentColor"
      />
    </svg>
  );
}

/** Full wordmark — logo + "Alepes" set in a clean, slightly tight sans. */
export function Wordmark({
  className,
  logoSize = 26,
  textClassName,
}: {
  className?: string;
  logoSize?: number;
  textClassName?: string;
}) {
  return (
    <span className={cn("inline-flex items-center gap-2.5", className)}>
      <Logo size={logoSize} className="text-brand" />
      <span
        className={cn(
          "text-[1.25rem] font-semibold tracking-tight text-foreground",
          textClassName
        )}
      >
        Alepes
      </span>
    </span>
  );
}