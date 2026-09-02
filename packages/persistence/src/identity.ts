// Deterministic provenance + identity for the persistence boundary.
//
// - inputSnapshotHash: a stable, content-addressed hash of the exact inputs
//   that produced a plan. Re-running the same inputs must give the same hash,
//   so persistence is reproducible and replay-safe.
// - calculationVersion: a pinned, human-readable identifier of the engine
//   versions that generated the plan. Bumps when the math changes.
// - ulid48: a short, URL-safe, lexicographically-sortable identifier minted
//   ONLY here (at the persistence boundary). Existing in-repo string ids are
//   left unchanged; this adds the durable chain identifier.

import type { CashEvent } from "@alepes/domain";

const HASH_SEED = "alepes-input-v1";

/** A canonical, deterministic string form of any JSON-serializable value. */
function canonicalize(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalize).join(",")}]`;
  }
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalize(obj[k])}`).join(",")}}`;
}

/** A simple, deterministic, content-addressed FNV-1a 32-bit hash (hex). */
export function hashCanonical(value: unknown): string {
  const s = canonicalize(value);
  // FNV-1a 32-bit, hex-encoded. Deterministic and dependency-free.
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, "0");
}

/** Version that identifies the engine set that produced a plan. */
export function calculationVersion(): string {
  return "rules-engine@1/allocation-engine@1";
}

/**
 * Deterministic input snapshot hash for a full planning run.
 * Includes the cash event, the rules (as they were at evaluation), and the
 * portfolio state — everything that can affect the resulting plan.
 */
export function inputSnapshotHash(
  cashEvent: CashEvent,
  cashEventRules: readonly { id: string; order: number; trigger: string; reserveBalance: unknown; action: string; amount: unknown; maxPerDeposit?: unknown; maxPerMonth?: unknown }[],
  portfolioSnapshot: { portfolio: { holdings: { symbol: string; targetPct: number }[] }; positions: { symbol: string; value: unknown }[] }
): string {
  return `${HASH_SEED}:${hashCanonical({
    cashEvent,
    rules: cashEventRules,
    portfolio: portfolioSnapshot,
  })}`;
}

/**
 * Mint a durable, ULID-style identifier. 48 characters of base32 from a
 * timestamp + randomness. Deterministic ORDER by timestamp; unique enough for
 * a single node.
 *
 * Format: 64-bit epoch-ms (12 base32 chars) + 80 bits randomness (16 base32 chars).
 */
const ALPHABET = "0123456789abcdefghjkmnpqrstvwxyz";

function toBase32(value: number, length: number): string {
  let out = "";
  let v = value;
  for (let i = 0; i < length; i++) {
    out = ALPHABET[v % 32] + out;
    v = Math.floor(v / 32);
  }
  return out;
}

export function ulid(): string {
  const time = toBase32(Date.now(), 12);
  let rand = "";
  // 16 base32 chars of randomness (80 bits).
  const iv: Uint8Array = globalThis.crypto?.getRandomValues
    ? globalThis.crypto.getRandomValues(new Uint8Array(10))
    : // Fallback for environments without WebCrypto (shouldn't happen)
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      new Uint8Array(require("crypto").randomBytes(10));
  for (const b of iv) {
    rand += ALPHABET[b % 32];
  }
  return time + rand.slice(0, 16);
}