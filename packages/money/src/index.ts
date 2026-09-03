// Integer-cents money type. Financial values are NEVER stored as floating point
// in the Alepes domain — the unit is integer cents. This is what makes the
// "sum reconciles exactly" and "byte-for-byte reproducible" invariants *true*,
// rather than approximately true.
//
// `number` is used as the underlying scalar (not BigInt) because it is safely
// exact for integer arithmetic up to Number.MAX_SAFE_INTEGER (9 * 10^15 cents,
// i.e. $90 trillion) — far beyond any realistic scenario, while keeping the API
// ergonomic and JSON-serializable.

/** Branded type: a signed integer number of cents. */
export type Cents = number & { readonly __cents: unique symbol };

/** Branded type: an unsigned integer number of cents (never negative). */
export type NonNegativeCents = Cents & { readonly __nonNegative: unique symbol };

const NEGATIVE_ZERO_CHARS = /-0$/;

/** Assert a value is a safe, finite integer suitable for cents. */
function assertSafeInteger(value: number, what: string): void {
  if (!Number.isSafeInteger(value)) {
    throw new RangeError(`${what} must be a safe integer (got ${value})`);
  }
}

/**
 * Wrap a raw integer number of cents into the branded Cents type.
 * Throws if the value is not a safe integer.
 */
export function cents(value: number): Cents {
  assertSafeInteger(value, "cents");
  return value as Cents;
}

/** Wrap and clamp to zero: negatives become 0 loose "non-negative" assertion. */
export function nonNegativeCents(value: number): NonNegativeCents {
  assertSafeInteger(value, "cents");
  if (value < 0) {
    throw new RangeError(`cannot construct non-negative cents from ${value}`);
  }
  return value as NonNegativeCents;
}

/** The value 0¢ (also a valid NonNegativeCents). */
export const ZERO: NonNegativeCents = nonNegativeCents(0);

/** Parse a decimal string like "24812.16" into integer cents exactly. */
export function fromDecimalString(s: string): Cents {
  const trimmed = s.trim();
  const m = trimmed.match(/^(-?)(\d*)(?:\.(\d{1,2}))?$/);
  if (!m || (m[2] === "" && m[3] === undefined)) {
    throw new RangeError(`invalid money string: "${s}"`);
  }
  const sign = m[1] === "-" ? -1 : 1;
  const whole = m[2] || "0";
  const frac = (m[3] ?? "").padEnd(2, "0");
  const value = sign * (parseInt(whole, 10) * 100 + parseInt(frac || "0", 10));
  return cents(value);
}

/**
 * Build cents from a dollars float — the ONLY place a float may enter the money
 * domain, and only by explicit opt-in (e.g. reading a provider that returns
 * floats). Rounds to nearest cent.
 */
export function centsFromDollarsFloat(dollars: number): Cents {
  if (!Number.isFinite(dollars)) throw new RangeError(`non-finite dollars: ${dollars}`);
  return cents(Math.round(dollars * 100));
}

/** Return the signed integer value of cents (for math + serialization). */
export function toNumber(c: Cents): number {
  return c as number;
}

/** Widen a NonNegativeCents back to the signed Cents type (value unchanged). */
export function asCents(c: NonNegativeCents): Cents {
  return c as number as Cents;
}

/** Format cents as a plain decimal string, e.g. "24812.16". */
export function toString(c: Cents): string {
  const sign = c < 0 ? "-" : "";
  const abs = Math.abs(c as number);
  const whole = Math.floor(abs / 100).toString();
  const frac = (abs % 100).toString().padStart(2, "0");
  let out = `${sign}${whole}.${frac}`;
  if (NEGATIVE_ZERO_CHARS.test(out)) out = out.replace(NEGATIVE_ZERO_CHARS, "0");
  return out;
}

/** Standard USD currency string, e.g. "$24,812.16" / "-$100.00". */
export function toCurrencyString(c: Cents): string {
  const sign = c < 0 ? "-" : "";
  const abs = Math.abs(c as number);
  const whole = Math.floor(abs / 100);
  const frac = (abs % 100).toString().padStart(2, "0");
  return `${sign}$${whole.toLocaleString("en-US")}.${frac}`;
}

// ---- Arithmetic (all exact, integer-only) ----

export function add(a: Cents, b: Cents): Cents {
  return cents((a as number) + (b as number));
}

export function sub(a: Cents, b: Cents): Cents {
  return cents((a as number) - (b as number));
}

export function neg(a: Cents): Cents {
  return cents(-(a as number));
}

/** Multiply cents by a whole integer — exact. */
export function mulInt(a: Cents, n: number): Cents {
  assertSafeInteger(n, "multiplier");
  return cents((a as number) * n);
}

/**
 * Multiply cents by a decimal scalar (e.g. a percentage 0.20).
 * Deterministically rounds to the nearest cent via Math.round (half toward +∞).
 * This is the ONE intentionally-lossy operation; callers decide when it applies,
 * and it is fully deterministic for byte-for-byte reproducibility.
 */
export function mulByRatio(a: Cents, ratio: number): Cents {
  if (!Number.isFinite(ratio)) throw new RangeError(`non-finite ratio: ${ratio}`);
  return cents(Math.round((a as number) * ratio));
}

/** Divide cents into `parts` equal integer-cent slices, remainder to the first slices. */
export function divideIntoParts(a: Cents, parts: number): Cents[] {
  assertSafeInteger(parts, "parts");
  if (parts <= 0) throw new RangeError("parts must be positive");
  const total = a as number;
  const base = Math.trunc(total / parts);
  const remainder = total - base * parts;
  const step = total >= 0 ? 1 : -1;
  let rem = Math.abs(remainder);
  const result: Cents[] = [];
  for (let i = 0; i < parts; i++) {
    const bump = rem-- > 0 ? step : 0;
    result.push(cents(base + bump));
  }
  return result;
}

export function min(a: Cents, b: Cents): Cents {
  return a < b ? a : b;
}
export function max(a: Cents, b: Cents): Cents {
  return a > b ? a : b;
}
export function isZero(a: Cents): boolean {
  return a === 0;
}
export function isNegative(a: Cents): boolean {
  return (a as number) < 0;
}
export function compare(a: Cents, b: Cents): number {
  return (a as number) - (b as number);
}

/** Sum an array of cents exactly. */
export function sum(values: readonly Cents[]): Cents {
  let total = 0;
  for (const v of values) total += v as number;
  return cents(total);
}