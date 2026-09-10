// Reusable live-certification safety guards for Alepes.
//
// This package is PURE: it imports nothing from React/Next/provider SDKs and
// nothing from `src/`. It exists so every live certification harness (Plaid,
// Alpaca, and future providers) shares ONE source of truth for the fail-closed
// safety checks, instead of each harness re-deriving them (and drifting).
//
// What it enforces (see SECURITY.md for the policy that motivates these):
//   1. Refuse to run unless the exact production/live environment value is set.
//   2. Refuse to run unless every required secret + env var is present.
//   3. Deterministic fingerprinting for redaction (never echo a raw token/id).
//   4. Redaction of known secrets/identifiers from arbitrary output.
//   5. Hard Shadow-only assertions: zero transfers/orders/mutations.
//
// The guards are intentionally dependency-free and deterministic. They must NOT
// be extended to perform I/O, network calls, or credential retrieval — a guard
// that needs a secret before it can check for the secret is untestable.
//
// NOTE: these guards are Alepes-internal safety rules. They are STRICTER than
// any provider MSA/Addendum requires; they must never be described as
// contractual provider requirements. See SECURITY.md §5.

/** Everything a live-cert harness must declare before the guards will let it run. */
export interface LiveCertEnvironment {
  /** Exact value the provider SDK uses for its production/live boundary.
   *  e.g. Plaid: "production"; Alpaca: "live". Do not rename the provider's own
   *  contract value — pass it through verbatim. */
  requiredEnvValue: string;
  /** Name of the env var that selects the environment (e.g. "PLAID_ENV"). */
  envVarName: string;
  /** Secret names that MUST be present (GitHub Environment secrets). */
  requiredSecrets: string[];
  /** Non-secret env vars that MUST be present. */
  requiredEnvVars: string[];
  /** Human-readable provider name, used only in redacted error messages. */
  providerName: string;
}

/**
 * Fail-closed prerequisite check. Throws (and the caller should `process.exit(2)`)
 * when any required prerequisite is missing or wrong. Never returns partial state.
 *
 * Order of checks is deliberate: environment boundary first (cheapest, most
 * important — never contact a live API on the wrong environment), then secrets,
 * then non-secret env vars.
 */
export function assertLiveCertPrerequisites(env: LiveCertEnvironment): void {
  const actual = process.env[env.envVarName];
  if (actual !== env.requiredEnvValue) {
    throw new Error(
      `REFUSING TO RUN: ${env.envVarName} must be exactly ${JSON.stringify(
        env.requiredEnvValue
      )} (got ${JSON.stringify(actual ?? "unset")}). ` +
        `${env.providerName} production/live certification only.`
    );
  }
  const missingSecrets = env.requiredSecrets.filter((name) => !process.env[name]);
  if (missingSecrets.length > 0) {
    throw new Error(
      `REFUSING TO RUN: missing required secret(s): ${missingSecrets.map((n) => JSON.stringify(n)).join(", ")} ` +
        `(${env.providerName}).`
    );
  }
  const missingVars = env.requiredEnvVars.filter((name) => !process.env[name]);
  if (missingVars.length > 0) {
    throw new Error(
      `REFUSING TO RUN: missing required environment variable(s): ${missingVars
        .map((n) => JSON.stringify(n))
        .join(", ")} (${env.providerName}).`
    );
  }
}

/** Deterministic, non-reversible fingerprint for redacting a raw value. */
export function fingerprint(value: string): string {
  let h = 0;
  for (let i = 0; i < value.length; i++) h = (h * 31 + value.charCodeAt(i)) | 0;
  return `fp-${(h >>> 0).toString(16)}-len${value.length}`;
}

/**
 * Build a redactor that replaces every registered secret/identifier with a
 * stable placeholder. Callers register each raw value they might ever emit
 * (access tokens, account ids, item ids, secrets) BEFORE producing output.
 *
 * The redactor is safe to call on non-string values (returns them unchanged)
 * and on already-redacted output (idempotent).
 */
export function createRedactor(secretsToRedact: string[]): (value: unknown) => unknown {
  return (value: unknown): unknown => {
    if (typeof value !== "string") return value;
    let out = value;
    for (const secret of secretsToRedact) {
      if (!secret) continue;
      out = out.split(secret).join(`REDACTED(${fingerprint(secret)})`);
    }
    return out;
  };
}

/** The invariants that must hold at the end of every live certification run. */
export interface ShadowOnlyInput {
  /** Number of shadow (non-executing) decisions produced. Must be > 0. */
  shadowCount: number;
  /** Number of real executions. Must be 0. */
  executeCount: number;
  /** Number of money transfers. Must be 0. */
  transferCount: number;
  /** Number of brokerage orders. Must be 0. */
  orderCount: number;
  /** Number of provider mutations. Must be 0. */
  providerMutationCount: number;
  /** The disposition kind. Must be "shadow". */
  disposition: string;
}

/**
 * Hard Shadow-only assertion: fails closed if ANY of the mutation counters is
 * non-zero, or if the disposition is anything but "shadow". This is the exact
 * invariant that keeps live certification from ever becoming real execution.
 */
export function assertShadowOnly(a: ShadowOnlyInput): void {
  if (a.disposition !== "shadow") {
    throw new Error(`disposition=${JSON.stringify(a.disposition)}, expected "shadow"`);
  }
  if (a.shadowCount <= 0) {
    throw new Error(`shadowCount=${a.shadowCount}, expected > 0`);
  }
  if (a.executeCount !== 0) throw new Error(`executeCount=${a.executeCount}, expected 0`);
  if (a.transferCount !== 0) throw new Error(`transferCount=${a.transferCount}, expected 0`);
  if (a.orderCount !== 0) throw new Error(`orderCount=${a.orderCount}, expected 0`);
  if (a.providerMutationCount !== 0) {
    throw new Error(`providerMutationCount=${a.providerMutationCount}, expected 0`);
  }
}