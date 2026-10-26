// Public-report allowlist + canonical public projection for the Plaid live
// certification harness.
//
// The harness previously printed `rawReport` through a replacement-based
// redactor (`redact`), which cannot remove free-text account names or deposit
// descriptions that are not known secrets. This module is the single canonical
// implementation of the harness's public-report output:
//
//   buildPublicCertificationReport(rawReport, redactions)
//     = redactSecrets(projectPublicReport(rawReport), redactions)
//
// `projectPublicReport` applies a strict field-by-field allowlist: any key
// not explicitly permitted is dropped, so sensitive free-text (account names,
// employer names, transaction descriptions, and unexpected nested fields)
// cannot reach public logs or certification evidence. `redactSecrets`
// reproduces the harness's replacement-based secret redaction (client id,
// secret, access tokens, item ids, account ids) as defense-in-depth over the
// already-projected report.
//
// certify-live.ts calls `buildPublicCertificationReport` at BOTH public print
// sites (the success-path certification report and the failure-path error
// message); the tests exercise this same function. certify-live.ts itself
// remains a fail-closed standalone script and is never imported by tests.

const TOP_LEVEL_KEYS = new Set<string>([
  "environment",
  "testUser",
  "boundAccount",
  "accounts",
  "initialSync",
  "reconciledObservations",
  "cashEvents",
  "shadow",
  "isolation",
  "points",
  "allPass",
  "note",
]);

const BOUND_ACCOUNT_KEYS = new Set<string>(["fingerprint", "subtype"]);

const ACCOUNT_KEYS = new Set<string>(["accountFingerprint", "subtype"]);

const INITIAL_SYNC_KEYS = new Set<string>([
  "pages",
  "added",
  "modified",
  "removed",
  "finalCursorFingerprint",
  "finalCursorLength",
  "hasMore",
  "balanceSnapshotPresent",
]);

const SHADOW_KEYS = new Set<string>([
  "disposition",
  "deployableCents",
  "totalDeployedCents",
  "cashEventIdFingerprint",
  "persistedPlanId",
  "persistedOutboxEventId",
  "proposedOrderCount",
  "taskQueue",
  "certificationSourceCommit",
  "certificationRunId",
  "nonExecuting",
  "recomputationHash",
]);

const ISOLATION_KEYS = new Set<string>([
  "totalAccounts",
  "nonDepositoryCount",
  "nonDepositoryFingerprints",
  "boundAccountIsDepository",
]);

const POINT_KEYS = new Set<string>(["id", "name", "status"]);

type SchemaName =
  | "root"
  | "boundAccount"
  | "account"
  | "initialSync"
  | "shadow"
  | "isolation"
  | "point"
  | "accountArray"
  | "pointArray"
  | null;

function schemaFor(key: string): SchemaName {
  switch (key) {
    case "boundAccount":
      return "boundAccount";
    case "accounts":
      return "accountArray";
    case "initialSync":
      return "initialSync";
    case "shadow":
      return "shadow";
    case "isolation":
      return "isolation";
    case "points":
      return "pointArray";
    default:
      return null;
  }
}

// Array element schema names are handled by the caller via a marker; we encode
// arrays by checking the parent key. This helper projects a value given the
// schema name that applies to *objects* at that position.
function projectValue(value: unknown, schema: SchemaName | "accountArray" | "pointArray"): unknown {
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) {
    if (schema === "accountArray") {
      return value.map((v) => projectObject(v, "account"));
    }
    if (schema === "pointArray") {
      return value.map((v) => projectObject(v, "point"));
    }
    return value.map((v) => projectValue(v, null));
  }
  return projectObject(value as Record<string, unknown>, schema as SchemaName);
}

function projectObject(obj: Record<string, unknown>, schema: SchemaName): Record<string, unknown> {
  const allowed =
    schema === "root"
      ? TOP_LEVEL_KEYS
      : schema === "boundAccount"
      ? BOUND_ACCOUNT_KEYS
      : schema === "account"
      ? ACCOUNT_KEYS
      : schema === "initialSync"
      ? INITIAL_SYNC_KEYS
      : schema === "shadow"
      ? SHADOW_KEYS
      : schema === "isolation"
      ? ISOLATION_KEYS
      : schema === "point"
      ? POINT_KEYS
      : new Set<string>();

  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj ?? {})) {
    if (!allowed.has(k)) continue;
    const childSchema = schemaFor(k);
    // For object/array fields, project recursively with the child schema.
    if (childSchema !== null) {
      out[k] = projectValue(v, childSchema as SchemaName | "accountArray" | "pointArray");
    } else {
      // leaf or unknown nested object: keep primitives, drop nested objects
      // that are not explicitly modeled (defense in depth).
      if (v !== null && typeof v === "object") {
        // Only allow explicitly modeled nested objects; drop anything else.
        out[k] = undefined;
        delete out[k];
      } else {
        out[k] = v;
      }
    }
  }
  return out;
}

export function projectPublicReport(input: unknown): unknown {
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    return input;
  }
  return projectObject(input as Record<string, unknown>, "root");
}

// ─── Replacement-based secret redaction (pinned-head `redact` semantics) ────

/**
 * Redaction inputs: the live run's secret values, snapshotted at call time by
 * the harness (`reportRedactions()` in certify-live.ts).
 */
export interface PublicReportRedactions {
  readonly clientId?: string | undefined;
  readonly secret?: string | undefined;
  readonly accessTokens?: readonly string[] | undefined;
  readonly itemIds?: readonly string[] | undefined;
  readonly accountIds?: readonly string[] | undefined;
}

/**
 * Deterministic fingerprint — mirrors `fp()` in certify-live.ts so redaction
 * placeholders stay identical in shape to the rest of the harness output.
 */
function fp(value: string): string {
  let h = 0;
  for (let i = 0; i < value.length; i++) h = (h * 31 + value.charCodeAt(i)) | 0;
  return `fp-${(h >>> 0).toString(16)}-len${value.length}`;
}

function redactString(s: string, r: PublicReportRedactions): string {
  let out = s;
  if (r.clientId) out = out.replaceAll(r.clientId, "REDACTED_CLIENT_ID");
  if (r.secret) out = out.replaceAll(r.secret, "REDACTED_SECRET");
  for (const tok of r.accessTokens ?? []) {
    if (tok) out = out.replaceAll(tok, `REDACTED_ACCESS_TOKEN(${fp(tok)})`);
  }
  for (const id of r.itemIds ?? []) {
    if (id) out = out.replaceAll(id, `REDACTED_ITEM_ID(${fp(id)})`);
  }
  for (const id of r.accountIds ?? []) {
    if (id) out = out.replaceAll(id, `REDACTED_ACCOUNT_ID(${fp(id)})`);
  }
  return out;
}

/**
 * Replacement-based redaction over an arbitrary value tree — the semantics of
 * the harness's historical `redact()`: replaces only KNOWN secret values,
 * never free text. Exported so tests can document why it is insufficient
 * alone (PR #6 Finding 1) and prove the composition still redacts known
 * secrets inside the canonical projection below.
 */
export function redactSecrets(value: unknown, redactions: PublicReportRedactions): unknown {
  if (typeof value === "string") return redactString(value, redactions);
  if (Array.isArray(value)) return value.map((v) => redactSecrets(v, redactions));
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = redactSecrets(v, redactions);
    }
    return out;
  }
  return value;
}

/**
 * The canonical harness public-report projection: strict allowlist first, then
 * replacement-based secret redaction as defense-in-depth over the already
 * projected report. certify-live.ts routes every value it prints publicly
 * through this function.
 */
export function buildPublicCertificationReport(
  rawReport: unknown,
  redactions: PublicReportRedactions,
): unknown {
  return redactSecrets(projectPublicReport(rawReport), redactions);
}
