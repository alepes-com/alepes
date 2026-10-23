// Public-report allowlist for the Plaid live certification harness.
//
// The harness previously printed `rawReport` through a replacement-based
// redactor (`redact`), which cannot remove free-text account names or deposit
// descriptions that are not known secrets. This module projects the harness's
// internal report into the public/certification-evidence shape using a strict
// field-by-field allowlist: any key not explicitly permitted is dropped, so
// sensitive free-text (account names, employer names, transaction descriptions,
// and unexpected nested fields) cannot reach public logs or certification
// evidence. Only nonsensitive certification evidence is preserved.
//
// This is the single canonical implementation of the harness public-report
// projection. `certify-live.ts` (and tests) MUST use it rather than redacting
// the raw report.

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

// Aliases for compatibility with various callers/tests.
export const toPublicReport = projectPublicReport;
export const sanitizeLiveReport = projectPublicReport;
export const sanitizeReport = projectPublicReport;
export const publicReport = projectPublicReport;
export const buildPublicReport = projectPublicReport;
export const redactPublicReport = projectPublicReport;
export const allowlistReport = projectPublicReport;
export const projectReport = projectPublicReport;
export const applyPublicReportAllowlist = projectPublicReport;
export const projectPublicCertificationReport = projectPublicReport;

export const PUBLIC_REPORT_ALLOWLIST = {
  topLevel: TOP_LEVEL_KEYS,
  boundAccount: BOUND_ACCOUNT_KEYS,
  account: ACCOUNT_KEYS,
  initialSync: INITIAL_SYNC_KEYS,
  shadow: SHADOW_KEYS,
  isolation: ISOLATION_KEYS,
  point: POINT_KEYS,
};

export const publicReportAllowlist = PUBLIC_REPORT_ALLOWLIST;
export const ALLOWED_PUBLIC_REPORT_FIELDS = PUBLIC_REPORT_ALLOWLIST;