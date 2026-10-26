// @alepes/audit — Pure audit event model and certification run types
// No React, no Next.js, no I/O, no provider SDKs. Depends only on domain, money.

import type { Cents, NonNegativeCents } from "@alepes/money";

// ─── Core enums / literals ────────────────────────────────────────────────

export type RunResult = "PASS" | "FAIL" | "ABORTED";
export type EvidenceKind = "real" | "synthetic" | "none";
export type GateStatus = "PASS" | "FAIL" | "SKIPPED" | "UNSUPPORTED";
export type AuditEventPhase =
  | "preflight"
  | "provider"
  | "observation"
  | "normalization"
  | "persistence"
  | "qualification"
  | "policy"
  | "execution"
  | "reconciliation"
  | "reporting";

export type AuditEventType =
  // Preflight
  | "CERT_RUN_STARTED"
  | "PREFLIGHT_PASSED"
  | "PREFLIGHT_FAILED"
  // Provider boundary
  | "PROVIDER_REQUEST_STARTED"
  | "PROVIDER_REQUEST_SUCCEEDED"
  | "PROVIDER_REQUEST_FAILED"
  // Observation lifecycle
  | "OBSERVATION_RECEIVED"
  | "OBSERVATION_NORMALIZED"
  | "OBSERVATION_PERSISTED"
  | "OBSERVATION_RECONCILED"
  // Cash-event qualification
  | "CASH_EVENT_QUALIFIED"
  | "CASH_EVENT_REJECTED"
  // Policy pipeline (real v0.5.0 producers)
  | "RULE_EVALUATED"
  | "CAPITAL_PLAN_CREATED"
  | "ALLOCATION_PLAN_CREATED"
  | "EXECUTION_PLAN_CREATED"
  | "EXECUTION_POLICY_EVALUATED"
  // Execution
  | "SHADOW_DECISION_RECORDED"
  | "EXECUTION_BLOCKED"
  // Outbox / audit
  | "OUTBOX_RECORDED"
  | "AUDIT_RECORDED"
  // Reconciliation
  | "RECONCILIATION_STARTED"
  | "RECONCILIATION_SUCCEEDED"
  | "RECONCILIATION_FAILED"
  // Idempotency / safety
  | "IDEMPOTENCY_CHECK"
  | "DUPLICATE_EVENT_SUPPRESSED"
  // Certification gates
  | "CERT_GATE_PASSED"
  | "CERT_GATE_FAILED"
  | "CERT_GATE_SKIPPED"
  | "REDACTION_VIOLATION"
  // Completion
  | "CERT_RUN_COMPLETED";

// Future events (no real v0.5.0 producer yet — do not construct):
// | "WEBHOOK_RECEIVED"
// | "SETTLEMENT_CONFIRMED"
// | "RECONCILIATION_CORRECTION"

export type ProviderName = "plaid" | "alpaca" | string;
export type Environment = "production" | "sandbox" | "paper" | string;
export type Milestone = "v0.4.0" | "v0.5.0" | "v0.6.0" | string;

// ─── Evidence Boundary (machine-readable claim) ──────────────────────────

export interface EvidenceBoundary {
  providerObservation: EvidenceKind;
  cashEvent: EvidenceKind;
  decision: EvidenceKind;
  execution: "shadow" | "approval" | "execute" | "none";
  providerMutation: boolean;
}

// ─── Gate Result ────────────────────────────────────────────────────────

export interface GateResult {
  gate: string;           // stable gate identifier
  status: GateStatus;     // PASS | FAIL | SKIPPED | UNSUPPORTED
  failureCode?: FailureCode;
  detail?: unknown;       // safe, redacted
}

// ─── Certification Run (first-class durable object) ──────────────────────

export interface CertificationRun {
  runId: string;                    // ULID
  correlationId: string;            // for trace correlation
  milestone: Milestone;
  provider: ProviderName;
  environment: Environment;
  sourceCommit: string;             // git SHA
  branch?: string;                  // if deterministically available
  harness: string;                  // e.g. "certify-live.ts"
  harnessVersion: string;           // schema version of harness contract
  schemaVersion: string;            // e.g. "audit-cert@1"
  startedAt: string;                // ISO 8601
  completedAt?: string;             // ISO 8601
  result: RunResult;
  failureCode?: FailureCode;
  evidenceBoundary: EvidenceBoundary;
  gates: GateResult[];
  mutationCounts: {
    transfer: number;
    order: number;
    providerMutation: number;
  };
  finalState: "clean" | "dirty";    // reconciliation/final state
}

// ─── Alepes-Owned Failure Taxonomy (stable, separate from provider codes) ─

export type FailureCode =
  | "configuration.missing_secret"
  | "configuration.invalid_environment"
  | "provider.invalid_request"
  | "provider.authentication_failed"
  | "provider.item_login_required"
  | "provider.product_not_enabled"
  | "provider.rate_limited"
  | "provider.unavailable"
  | "persistence.unavailable"
  | "sync.cursor_conflict"
  | "sync.restart_required"
  | "sync.no_qualifying_event"
  | "policy.no_match"
  | "safety.execution_surface_reachable"
  | "safety.provider_mutation_detected"
  | "redaction.violation"
  | "internal.unexpected";

// ─── Provider-safe error fields (boundary evidence, not domain taxonomy) ──

export interface ProviderErrorFields {
  errorType?: string;     // Plaid error_type
  errorCode?: string;     // Plaid error_code
  requestId?: string;     // Plaid request_id
  httpStatus?: number;    // HTTP status
}

// Map provider-safe fields to Alepes FailureCode (pure, at boundary)
// Plaid returns error details in response body (error_type, error_code), not HTTP status alone.
// Correct mapping: error_code/error_type first, then HTTP status as fallback.
export function mapProviderErrorToFailureCode(fields: ProviderErrorFields): FailureCode {
  // Map Plaid error_code first (most specific)
  if (fields.errorCode === "ITEM_LOGIN_REQUIRED") {
    return "provider.item_login_required";
  }
  if (fields.errorCode === "INVALID_INPUT" || fields.errorCode === "INVALID_FIELD") {
    return "provider.invalid_request";
  }
  if (fields.errorCode === "AUTH" || fields.errorCode === "INVALID_CREDENTIALS") {
    return "provider.authentication_failed";
  }
  if (fields.errorCode === "RATE_LIMIT_EXCEEDED") {
    return "provider.rate_limited";
  }
  if (fields.errorCode === "PRODUCT_NOT_ENABLED" || fields.errorCode === "PRODUCT_NOT_READY") {
    return "provider.product_not_enabled";
  }
  if (fields.errorCode === "API_ERROR" || fields.errorCode === "INTERNAL_SERVER_ERROR") {
    return "provider.unavailable";
  }

  // Fall back to error_type
  if (fields.errorType === "INVALID_INPUT" || fields.errorType === "INVALID_FIELD") {
    return "provider.invalid_request";
  }
  if (fields.errorType === "AUTH" || fields.errorType === "INVALID_CREDENTIALS") {
    return "provider.authentication_failed";
  }
  if (fields.errorType === "RATE_LIMIT" || fields.errorType === "RATE_LIMITED") {
    return "provider.rate_limited";
  }
  if (fields.errorType === "PRODUCT_NOT_READY" || fields.errorType === "PRODUCT_NOT_ENABLED") {
    return "provider.product_not_enabled";
  }
  if (fields.errorType === "SERVER_ERROR" || fields.errorType === "API_ERROR") {
    return "provider.unavailable";
  }

  // Fall back to HTTP status (least specific)
  if (fields.httpStatus === 401 || fields.httpStatus === 403) {
    return "provider.authentication_failed";
  }
  if (fields.httpStatus === 429) {
    return "provider.rate_limited";
  }
  if (fields.httpStatus !== undefined && fields.httpStatus >= 500) {
    return "provider.unavailable";
  }

  return "internal.unexpected";
}

// ─── Discriminated-Union Audit Events (only real v0.5.0 producers) ─────────

interface AuditEventBase {
  eventId: string;              // ULID
  runId: string;
  correlationId: string;
  causationId?: string;         // previous eventId in causal chain
  sequence: number;             // monotonically increasing per run
  occurredAt: string;           // ISO 8601
  phase: AuditEventPhase;
  type: AuditEventType;
  status: "started" | "succeeded" | "failed" | "skipped";
  actor: "system" | "provider" | "human";
  provider?: ProviderName;
  attempt?: number;
  mutated?: boolean;
  verified?: boolean;
}

type AuditEvent =
  | (AuditEventBase & { type: "CERT_RUN_STARTED"; payload: { harness: string; schemaVersion: string } })
  | (AuditEventBase & { type: "PREFLIGHT_PASSED"; payload: { secretsPresent: string[] } })
  | (AuditEventBase & { type: "PREFLIGHT_FAILED"; payload: { failureCode: FailureCode; field?: string; providerCallAttempted: boolean } })
  | (AuditEventBase & { type: "PROVIDER_REQUEST_STARTED"; payload: { operation: string; accountIdFingerprint?: string } })
  | (AuditEventBase & { type: "PROVIDER_REQUEST_SUCCEEDED"; payload: { operation: string; latencyMs: number } })
  | (AuditEventBase & { type: "PROVIDER_REQUEST_FAILED"; payload: { failureCode: FailureCode; httpStatus?: number; plaidErrorType?: string; plaidErrorCode?: string; plaidRequestId?: string } })
  | (AuditEventBase & { type: "OBSERVATION_RECEIVED"; payload: { observationId: string; externalRefFingerprint: string; direction: "credit" | "debit"; amountCents: Cents; posted: boolean } })
  | (AuditEventBase & { type: "OBSERVATION_NORMALIZED"; payload: { observationId: string; normalizationVersion: string } })
  | (AuditEventBase & { type: "OBSERVATION_PERSISTED"; payload: { observationId: string; persistedId: string } })
  | (AuditEventBase & { type: "OBSERVATION_RECONCILED"; payload: { observationId: string; cycleId: string } })
  | (AuditEventBase & { type: "CASH_EVENT_QUALIFIED"; payload: { cashEventId: string; amountCents: Cents; ruleId: string } })
  | (AuditEventBase & { type: "CASH_EVENT_REJECTED"; payload: { reason: string; observationId: string } })
  | (AuditEventBase & { type: "RULE_EVALUATED"; payload: { ruleId: string; cashEventId: string; capitalAmountCents: Cents } })
  | (AuditEventBase & { type: "CAPITAL_PLAN_CREATED"; payload: { capitalPlanId: string; deployableCents: NonNegativeCents } })
  | (AuditEventBase & { type: "ALLOCATION_PLAN_CREATED"; payload: { allocationPlanId: string; totalDeployedCents: NonNegativeCents; lines: number } })
  | (AuditEventBase & { type: "EXECUTION_PLAN_CREATED"; payload: { executionPlanId: string; orderCount: number } })
  | (AuditEventBase & { type: "EXECUTION_POLICY_EVALUATED"; payload: { disposition: "shadow" | "approval" | "execute"; executeCount: number } })
  | (AuditEventBase & { type: "SHADOW_DECISION_RECORDED"; payload: { decisionId: string; disposition: "shadow"; deployableCents: NonNegativeCents } })
  | (AuditEventBase & { type: "EXECUTION_BLOCKED"; payload: { reason: string; executeCount: 0; transferCount: 0; orderCount: 0; providerMutationCount: 0 } })
  | (AuditEventBase & { type: "OUTBOX_RECORDED"; payload: { outboxEventId: string } })
  | (AuditEventBase & { type: "AUDIT_RECORDED"; payload: { auditRecordId: string } })
  | (AuditEventBase & { type: "RECONCILIATION_STARTED"; payload: { cycleId: string } })
  | (AuditEventBase & { type: "RECONCILIATION_SUCCEEDED"; payload: { cycleId: string } })
  | (AuditEventBase & { type: "RECONCILIATION_FAILED"; payload: { cycleId: string; failureCode: FailureCode } })
  | (AuditEventBase & { type: "IDEMPOTENCY_CHECK"; payload: { key: string; duplicate: boolean } })
  | (AuditEventBase & { type: "DUPLICATE_EVENT_SUPPRESSED"; payload: { key: string } })
  | (AuditEventBase & { type: "CERT_GATE_PASSED"; payload: { gate: string } })
  | (AuditEventBase & { type: "CERT_GATE_FAILED"; payload: { gate: string; failureCode: FailureCode } })
  | (AuditEventBase & { type: "CERT_GATE_SKIPPED"; payload: { gate: string; reason: string } })
  | (AuditEventBase & { type: "REDACTION_VIOLATION"; payload: { field: string; fingerprint: string } })
  | (AuditEventBase & { type: "CERT_RUN_COMPLETED"; payload: { result: RunResult; evidenceBoundary: EvidenceBoundary } });

export { type AuditEvent };

// ─── Type guards for reconstruction queries ──────────────────────────────

export function isPreflightFailed(e: AuditEvent): e is AuditEvent & { type: "PREFLIGHT_FAILED" } {
  return e.type === "PREFLIGHT_FAILED";
}
export function isProviderRequestFailed(e: AuditEvent): e is AuditEvent & { type: "PROVIDER_REQUEST_FAILED" } {
  return e.type === "PROVIDER_REQUEST_FAILED";
}
export function isCashEventRejected(e: AuditEvent): e is AuditEvent & { type: "CASH_EVENT_REJECTED" } {
  return e.type === "CASH_EVENT_REJECTED";
}
export function isCertGateFailed(e: AuditEvent): e is AuditEvent & { type: "CERT_GATE_FAILED" } {
  return e.type === "CERT_GATE_FAILED";
}
export function isCertRunCompleted(e: AuditEvent): e is AuditEvent & { type: "CERT_RUN_COMPLETED" } {
  return e.type === "CERT_RUN_COMPLETED";
}