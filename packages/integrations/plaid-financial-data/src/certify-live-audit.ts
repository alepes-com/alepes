// Plaid live certification audit instrumentation.
// Pure helper: emits v0.5.0 AuditEvent lifecycle through an AuditPorts implementation.
// No Plaid SDK, no secrets, no network — only deterministic event emission.

import type {
  AuditPorts,
  CreateCertificationRunInput,
  CompleteCertificationRunInput,
} from "@alepes/persistence";
import type {
  AuditEvent,
  AuditEventType,
  FailureCode,
  EvidenceBoundary,
  GateResult,
  EvidenceKind,
} from "@alepes/audit";
import type { Cents, NonNegativeCents } from "@alepes/money";
import { ulid } from "@alepes/persistence";

// ─── Event factory — single point of truth for AuditEventBase ────────────

function makeEvent<const T extends AuditEvent["type"]>(
  ctx: RunContext,
  type: T,
  phase: AuditEvent["phase"],
  status: "started" | "succeeded" | "failed" | "skipped",
  payload: Extract<AuditEvent, { type: T }>["payload"]
): Extract<AuditEvent, { type: T }> {
  return {
    eventId: ulid(),
    runId: ctx.runId,
    correlationId: ctx.correlationId,
    causationId: undefined,
    sequence: 0,
    occurredAt: new Date().toISOString(),
    phase,
    type,
    status,
    actor: "system",
    provider: type.startsWith("PROVIDER") ? "plaid" : undefined,
    attempt: undefined,
    mutated: undefined,
    verified: undefined,
    payload,
  } as Extract<AuditEvent, { type: T }>;
}

// ─── Config / Context ────────────────────────────────────────────────────────

export interface CertifyLiveAuditConfig {
  /** The audit persistence port (Postgres or fake for tests). */
  ports: AuditPorts;
  /** Provider name for evidence boundary / provenance. */
  provider: "plaid";
  /** Environment for the run (production, sandbox, paper). */
  environment: "production" | "sandbox" | "paper";
  /** Git SHA of the source code producing this run. */
  sourceCommit: string;
  /** Harness identifier (e.g. "certify-live.ts"). */
  harness: string;
  /** Harness schema version. */
  harnessVersion: string;
  /** Audit schema version (e.g. "audit-cert@1"). */
  schemaVersion: string;
  /** Optional branch name if deterministically available. */
  branch?: string;
  /** Milestone identifier (e.g. "v0.5.0"). */
  milestone: "v0.4.0" | "v0.5.0" | "v0.6.0" | string;
}

export interface RunContext {
  runId: string;
  correlationId: string;
  startedAt: string;
}

/** Start a new certification run and emit CERT_RUN_STARTED. */
export async function startRun(config: CertifyLiveAuditConfig): Promise<RunContext> {
  const runId = ulid();
  const correlationId = ulid();
  const startedAt = new Date().toISOString();

  const input: CreateCertificationRunInput = {
    runId,
    correlationId,
    milestone: config.milestone,
    provider: config.provider,
    environment: config.environment,
    sourceCommit: config.sourceCommit,
    branch: config.branch,
    harness: config.harness,
    harnessVersion: config.harnessVersion,
    schemaVersion: config.schemaVersion,
    startedAt,
  };

  await config.ports.runs.createRun(input);

  // Emit CERT_RUN_STARTED event
  const startEvent = makeEvent(
    { runId, correlationId, startedAt },
    "CERT_RUN_STARTED",
    "preflight",
    "started",
    { harness: config.harness, schemaVersion: config.schemaVersion }
  );
  await config.ports.events.append(startEvent);

  return { runId, correlationId, startedAt };
}

// ─── Preflight ───────────────────────────────────────────────────────────────

type PreflightDetail =
  | { passed: true; secretsPresent?: string[] }
  | { passed: false; failureCode: FailureCode; field?: string; providerCallAttempted: boolean };

/** Record PREFLIGHT_PASSED or PREFLIGHT_FAILED. */
export async function recordPreflight(
  ports: AuditPorts,
  ctx: RunContext,
  detail: PreflightDetail
): Promise<void> {
  if (detail.passed) {
    const event = makeEvent(ctx, "PREFLIGHT_PASSED", "preflight", "succeeded", {
      secretsPresent: detail.secretsPresent ?? [],
    });
    await ports.events.append(event);
  } else {
    const event = makeEvent(ctx, "PREFLIGHT_FAILED", "preflight", "failed", {
      failureCode: detail.failureCode,
      field: detail.field,
      providerCallAttempted: detail.providerCallAttempted,
    });
    await ports.events.append(event);
  }
}

// ─── Provider request lifecycle ──────────────────────────────────────────────

/** Record provider request lifecycle (STARTED / SUCCEEDED / FAILED). */
export async function recordProviderRequest(
  ports: AuditPorts,
  ctx: RunContext,
  operation: string,
  outcome: "started" | "succeeded" | "failed",
  detail: {
    latencyMs?: number;
    httpStatus?: number;
    plaidErrorType?: string;
    plaidErrorCode?: string;
    plaidRequestId?: string;
    accountIdFingerprint?: string;
  } = {}
): Promise<void> {
  let event: AuditEvent;

  switch (outcome) {
    case "started":
      event = makeEvent(ctx, "PROVIDER_REQUEST_STARTED", "provider", "started", {
        operation,
        accountIdFingerprint: detail.accountIdFingerprint,
      });
      break;
    case "succeeded":
      event = makeEvent(ctx, "PROVIDER_REQUEST_SUCCEEDED", "provider", "succeeded", {
        operation,
        latencyMs: detail.latencyMs ?? 0,
      });
      break;
    case "failed":
      event = makeEvent(ctx, "PROVIDER_REQUEST_FAILED", "provider", "failed", {
        failureCode: mapProviderErrorToFailureCode(detail),
        httpStatus: detail.httpStatus,
        plaidErrorType: detail.plaidErrorType,
        plaidErrorCode: detail.plaidErrorCode,
        plaidRequestId: detail.plaidRequestId,
      });
      break;
  }

  await ports.events.append(event);
}

// ─── Observation lifecycle ───────────────────────────────────────────────────

/** Record observation lifecycle. */
export async function recordObservationReceived(
  ports: AuditPorts,
  ctx: RunContext,
  observationId: string,
  externalRefFingerprint: string,
  direction: "credit" | "debit",
  amountCents: Cents,
  posted: boolean
): Promise<void> {
  const event = makeEvent(ctx, "OBSERVATION_RECEIVED", "observation", "succeeded", {
    observationId,
    externalRefFingerprint,
    direction,
    amountCents,
    posted,
  });
  await ports.events.append(event);
}

export async function recordObservationNormalized(
  ports: AuditPorts,
  ctx: RunContext,
  observationId: string,
  normalizationVersion: string
): Promise<void> {
  const event = makeEvent(ctx, "OBSERVATION_NORMALIZED", "normalization", "succeeded", {
    observationId,
    normalizationVersion,
  });
  await ports.events.append(event);
}

export async function recordObservationPersisted(
  ports: AuditPorts,
  ctx: RunContext,
  observationId: string,
  persistedId: string
): Promise<void> {
  const event = makeEvent(ctx, "OBSERVATION_PERSISTED", "persistence", "succeeded", {
    observationId,
    persistedId,
  });
  await ports.events.append(event);
}

// ─── Cash event qualification ────────────────────────────────────────────────

/** Record cash event qualification result. */
export async function recordCashEventQualified(
  ports: AuditPorts,
  ctx: RunContext,
  cashEventId: string,
  amountCents: Cents,
  ruleId: string
): Promise<void> {
  const event = makeEvent(ctx, "CASH_EVENT_QUALIFIED", "qualification", "succeeded", {
    cashEventId,
    amountCents,
    ruleId,
  });
  await ports.events.append(event);
}

export async function recordCashEventRejected(
  ports: AuditPorts,
  ctx: RunContext,
  reason: string,
  observationId: string
): Promise<void> {
  const event = makeEvent(ctx, "CASH_EVENT_REJECTED", "qualification", "failed", {
    reason,
    observationId,
  });
  await ports.events.append(event);
}

// ─── Policy pipeline ─────────────────────────────────────────────────────────

/** Record policy pipeline events. */
export async function recordRuleEvaluated(
  ports: AuditPorts,
  ctx: RunContext,
  ruleId: string,
  cashEventId: string,
  capitalAmountCents: Cents
): Promise<void> {
  const event = makeEvent(ctx, "RULE_EVALUATED", "policy", "succeeded", {
    ruleId,
    cashEventId,
    capitalAmountCents,
  });
  await ports.events.append(event);
}

export async function recordCapitalPlanCreated(
  ports: AuditPorts,
  ctx: RunContext,
  capitalPlanId: string,
  deployableCents: NonNegativeCents,
): Promise<void> {
  const event = makeEvent(ctx, "CAPITAL_PLAN_CREATED", "policy", "succeeded", {
    capitalPlanId,
    deployableCents: deployableCents as NonNegativeCents,
  });
  await ports.events.append(event);
}

export async function recordAllocationPlanCreated(
  ports: AuditPorts,
  ctx: RunContext,
  allocationPlanId: string,
  totalDeployedCents: NonNegativeCents,
  lines: number
): Promise<void> {
  const event = makeEvent(ctx, "ALLOCATION_PLAN_CREATED", "policy", "succeeded", {
    allocationPlanId,
    totalDeployedCents: totalDeployedCents as NonNegativeCents,
    lines,
  });
  await ports.events.append(event);
}

export async function recordExecutionPolicyEvaluated(
  ports: AuditPorts,
  ctx: RunContext,
  disposition: "shadow" | "approval" | "execute",
  executeCount: number
): Promise<void> {
  const event = makeEvent(ctx, "EXECUTION_POLICY_EVALUATED", "execution", "succeeded", {
    disposition,
    executeCount,
  });
  await ports.events.append(event);
}

export async function recordShadowDecisionRecorded(
  ports: AuditPorts,
  ctx: RunContext,
  decisionId: string,
  deployableCents: NonNegativeCents
): Promise<void> {
  const event = makeEvent(ctx, "SHADOW_DECISION_RECORDED", "execution", "succeeded", {
    decisionId,
    disposition: "shadow",
    deployableCents,
  });
  await ports.events.append(event);
}

export async function recordExecutionBlocked(
  ports: AuditPorts,
  ctx: RunContext,
  reason: string
): Promise<void> {
  const event = makeEvent(ctx, "EXECUTION_BLOCKED", "execution", "failed", {
    reason,
    executeCount: 0,
    transferCount: 0,
    orderCount: 0,
    providerMutationCount: 0,
  });
  await ports.events.append(event);
}

// ─── Certification gates ──────────────────────────────────────────────────────

/** Record certification gate result. */
export async function recordGate(
  ports: AuditPorts,
  ctx: RunContext,
  gate: string,
  status: "PASS" | "FAIL" | "SKIPPED" | "UNSUPPORTED",
  failureCode?: FailureCode,
  reason?: string
): Promise<void> {
  if (status === "PASS") {
    const event = makeEvent(ctx, "CERT_GATE_PASSED", "reporting", "succeeded", { gate });
    await ports.events.append(event);
  } else if (status === "FAIL") {
    const event = makeEvent(ctx, "CERT_GATE_FAILED", "reporting", "failed", {
      gate,
      failureCode: failureCode ?? "internal.unexpected",
    });
    await ports.events.append(event);
  } else {
    const event = makeEvent(ctx, "CERT_GATE_SKIPPED", "reporting", "skipped", {
      gate,
      reason: reason ?? "unsupported",
    });
    await ports.events.append(event);
  }
}

// ─── Completion ──────────────────────────────────────────────────────────────

/** Complete the run (emits CERT_RUN_COMPLETED via adapter). */
export async function completeRun(
  ports: AuditPorts,
  ctx: RunContext,
  result: "PASS" | "FAIL" | "ABORTED",
  failureCode: FailureCode | undefined,
  evidenceBoundary: EvidenceBoundary,
  gates: GateResult[],
  mutationCounts: { transfer: number; order: number; providerMutation: number },
  finalState: "clean" | "dirty"
): Promise<void> {
  const completedAt = new Date().toISOString();

  const input: CompleteCertificationRunInput = {
    runId: ctx.runId,
    completedAt,
    result,
    failureCode,
    evidenceBoundary,
    gates,
    mutationCounts,
    finalState,
  };

  await ports.runs.completeRun(input); // adapter emits CERT_RUN_COMPLETED
}

// ─── Local helper ────────────────────────────────────────────────────────────

function mapProviderErrorToFailureCode(detail: {
  httpStatus?: number;
  plaidErrorType?: string;
  plaidErrorCode?: string;
  plaidRequestId?: string;
}): FailureCode {
  // Plaid error_code first (most specific)
  if (detail.plaidErrorCode === "ITEM_LOGIN_REQUIRED") return "provider.item_login_required";
  if (detail.plaidErrorCode === "INVALID_INPUT" || detail.plaidErrorCode === "INVALID_FIELD") return "provider.invalid_request";
  if (detail.plaidErrorCode === "AUTH" || detail.plaidErrorCode === "INVALID_CREDENTIALS") return "provider.authentication_failed";
  if (detail.plaidErrorCode === "RATE_LIMIT_EXCEEDED") return "provider.rate_limited";
  if (detail.plaidErrorCode === "PRODUCT_NOT_ENABLED" || detail.plaidErrorCode === "PRODUCT_NOT_READY") return "provider.product_not_enabled";
  if (detail.plaidErrorCode === "API_ERROR" || detail.plaidErrorCode === "INTERNAL_SERVER_ERROR") return "provider.unavailable";

  // Fall back to error_type
  if (detail.plaidErrorType === "INVALID_INPUT" || detail.plaidErrorType === "INVALID_FIELD") return "provider.invalid_request";
  if (detail.plaidErrorType === "AUTH" || detail.plaidErrorType === "INVALID_CREDENTIALS") return "provider.authentication_failed";
  if (detail.plaidErrorType === "RATE_LIMIT" || detail.plaidErrorType === "RATE_LIMITED") return "provider.rate_limited";
  if (detail.plaidErrorType === "PRODUCT_NOT_READY" || detail.plaidErrorType === "PRODUCT_NOT_ENABLED") return "provider.product_not_enabled";
  if (detail.plaidErrorType === "SERVER_ERROR" || detail.plaidErrorType === "API_ERROR") return "provider.unavailable";

  // Fall back to HTTP status
  if (detail.httpStatus === 401 || detail.httpStatus === 403) return "provider.authentication_failed";
  if (detail.httpStatus === 429) return "provider.rate_limited";
  if (detail.httpStatus !== undefined && detail.httpStatus >= 500) return "provider.unavailable";

  return "internal.unexpected";
}