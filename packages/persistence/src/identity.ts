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

/** A deterministic, collision-resistant SHA-256 hash of canonical JSON.
 *
 * Why SHA-256: `inputSnapshotHash` is financial provenance. Six months from now,
 * support may need to prove an old plan was generated from exactly the recorded
 * inputs. FNV-1a is fine for hash tables; SHA-256 is the right choice there.
 *
 * Works in both Node (crypto.subtle or node:crypto) and browsers.
 */
export async function hashCanonical(value: unknown): Promise<string> {
  const s = canonicalize(value);
  const bytes = new TextEncoder().encode(s);

  if (typeof globalThis.crypto?.subtle?.digest === "function") {
    // WebCrypto (browser or Node 18+)
    const digest = await globalThis.crypto.subtle.digest("SHA-256", bytes);
    return Array.from(new Uint8Array(digest))
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
  }

  // Node-only fallback: the module-level require for node:crypto is safe since this
  // path is only reached off-browser.
  const { createHash } = await import("crypto");
  return createHash("sha256").update(new TextEncoder().encode(s)).digest("hex");
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
export async function inputSnapshotHash(
  cashEvent: CashEvent,
  cashEventRules: readonly { id: string; order: number; trigger: string; reserveBalance: unknown; action: string; amount: unknown; maxPerDeposit?: unknown; maxPerMonth?: unknown }[],
  portfolioSnapshot: { portfolio: { holdings: { symbol: string; targetPct: number }[] }; positions: { symbol: string; value: unknown }[] }
): Promise<string> {
  return `${HASH_SEED}:${await hashCanonical({
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