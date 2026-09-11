// @alepes/reporting — Versioned certification report schemas, allowlist sanitizer, renderers
// Pure: no React, no Next.js, no I/O, no provider SDKs. Depends on audit, money.

import type { Cents, NonNegativeCents } from "@alepes/money";
import type {
  CertificationRun,
  AuditEvent,
  EvidenceBoundary,
  FailureCode,
  RunResult,
  EvidenceKind,
} from "@alepes/audit";

// ─── Schema Version ────────────────────────────────────────────────────────

export const CERTIFICATION_REPORT_SCHEMA_VERSION = "audit-cert@1" as const;

// ─── Internal / Raw Evidence Schema (canonical source of truth) ────────────

export interface CertificationReportV1 {
  schemaVersion: typeof CERTIFICATION_REPORT_SCHEMA_VERSION;
  run: CertificationRun;
  events: AuditEvent[];
  providerCalls: ProviderCallEvidence[];
}

// Safe provider call evidence (boundary, not domain taxonomy)
export interface ProviderCallEvidence {
  evidenceId: string;
  runId: string;
  correlationId: string;
  occurredAt: string;
  operation: string;
  httpStatus?: number;
  latencyMs?: number;
  plaidErrorType?: string;
  plaidErrorCode?: string;
  plaidRequestId?: string;
  failureCode?: FailureCode;
}

// ─── Sanitized / Public Evidence Schema (allowlist only) ───────────────────

export interface SanitizedCertificationReport {
  schemaVersion: typeof CERTIFICATION_REPORT_SCHEMA_VERSION;
  run: SanitizedRun;
  // Intentionally NO events, NO providerCalls, NO request IDs
}

export interface SanitizedRun {
  runId: string;
  correlationId: string;
  milestone: string;
  provider: string;
  environment: string;
  sourceCommit: string;
  harness: string;
  harnessVersion: string;
  schemaVersion: string;
  startedAt: string;
  completedAt?: string;
  result: RunResult;
  failureCode?: FailureCode;
  evidenceBoundary: EvidenceBoundary;
  gates: SanitizedGateResult[];
  mutationCounts: {
    transfer: number;
    order: number;
    providerMutation: number;
  };
  finalState: "clean" | "dirty";
}

export interface SanitizedGateResult {
  gate: string;
  status: "PASS" | "FAIL" | "SKIPPED" | "UNSUPPORTED";
  failureCode?: FailureCode;
  // Intentionally NO detail (may contain sensitive data)
}

// ─── Allowlist-Based Sanitizer (builds public object field-by-field) ──────

export function sanitizeReport(raw: CertificationReportV1): SanitizedCertificationReport {
  // No string-replacement redactor here — this is an ALLOWLIST builder.
  // Only fields explicitly listed below are admitted to the public report.
  const s = raw.run;
  return {
    schemaVersion: CERTIFICATION_REPORT_SCHEMA_VERSION,
    run: {
      runId: s.runId,
      correlationId: s.correlationId,
      milestone: s.milestone,
      provider: s.provider,
      environment: s.environment,
      sourceCommit: s.sourceCommit,
      harness: s.harness,
      harnessVersion: s.harnessVersion,
      schemaVersion: s.schemaVersion,
      startedAt: s.startedAt,
      completedAt: s.completedAt,
      result: s.result,
      failureCode: s.failureCode,
      evidenceBoundary: s.evidenceBoundary,
      gates: s.gates.map(g => ({
        gate: g.gate,
        status: g.status,
        failureCode: g.failureCode,
        // detail is intentionally excluded
      })),
      mutationCounts: {
        transfer: s.mutationCounts.transfer,
        order: s.mutationCounts.order,
        providerMutation: s.mutationCounts.providerMutation,
      },
      finalState: s.finalState,
    },
  };
}

// ─── Unwrap branded cents for display/reporting (not financial computation) ──

function toNumberCents(c: Cents | NonNegativeCents): number {
  // SAFETY: Cents/NonNegativeCents are `number` at runtime; unwrapping for display/reporting
  // does not lose financial correctness because no arithmetic happens here.
  return c as number;
}

// ─── Type-safe event filtering for reconstruction ──────────────────────────

/**
 * Returns all succeeded events of a specific type from the event array.
 * The predicate narrows by `type` only (distributes correctly for generic T);
 * the runtime `status === "succeeded"` check doesn't affect the predicate type.
 */
function succeededOfType<T extends AuditEvent["type"]>(
  events: readonly AuditEvent[],
  type: T
): Array<Extract<AuditEvent, { type: T }>> {
  return events.filter(
    (e): e is Extract<AuditEvent, { type: T }> =>
      e.type === type && e.status === "succeeded"
  );
}

/**
 * Returns the first succeeded event of a specific type, or undefined.
 */
function firstSucceededOfType<T extends AuditEvent["type"]>(
  events: readonly AuditEvent[],
  type: T
): Extract<AuditEvent, { type: T }> | undefined {
  return events.find(
    (e): e is Extract<AuditEvent, { type: T }> =>
      e.type === type && e.status === "succeeded"
  );
}

/**
 * Returns the first event of a specific type with ANY status (for failure events
 * whose payload IS the authoritative evidence — status "failed" is the point).
 */
function firstOfType<T extends AuditEvent["type"]>(
  events: readonly AuditEvent[],
  type: T
): Extract<AuditEvent, { type: T }> | undefined {
  return events.find(
    (e): e is Extract<AuditEvent, { type: T }> => e.type === type
  );
}

// ─── Reconstruction Query (from persisted evidence) ────────────────────────

/**
 * Given a run's persisted audit events and provider call evidence, reconstruct
 * the complete narrative without any stdout.
 */
export interface ReconstructedRun {
  whatObserved: string;
  evidenceKind: EvidenceKind;
  provider: string;
  environment: string;
  normalized: boolean;
  persisted: boolean;
  qualified: boolean;
  rejectionReason?: string;
  ruleVersion: string;
  capitalPlan: { deployableCents: number } | null;
  allocationPlan: { totalDeployedCents: number; lines: number } | null;
  executionPolicy: { disposition: string; executeCount: number } | null;
  shadowOnly: boolean;
  providerMutationAttempted: boolean;
  failedGate?: string;
  safeProviderError: {
    httpStatus?: number;
    plaidErrorType?: string;
    plaidErrorCode?: string;
    // plaidRequestId: internal evidence only — excluded from sanitized public report
    plaidRequestId?: string;
  };
  sourceCommit: string;
  harnessVersion: string;
  schemaVersion: string;
  finishedCleanly: boolean;
}

export function reconstructRun(
  run: CertificationRun,
  events: AuditEvent[],
  providerCalls: ProviderCallEvidence[]
): ReconstructedRun {
  // Evidence kind from run's boundary
  const evidenceKind = run.evidenceBoundary.providerObservation;

  // Provider & environment
  const provider = run.provider;
  const environment = run.environment;

  // Normalization: OBSERVATION_NORMALIZED events exist
  const normalized = succeededOfType(events, "OBSERVATION_NORMALIZED").length > 0;

  // Persistence: OBSERVATION_PERSISTED events exist
  const persisted = succeededOfType(events, "OBSERVATION_PERSISTED").length > 0;

  // Qualification: CASH_EVENT_QUALIFIED vs CASH_EVENT_REJECTED
  const qualifiedEvent = firstSucceededOfType(events, "CASH_EVENT_QUALIFIED");
  const rejectedEvent = firstSucceededOfType(events, "CASH_EVENT_REJECTED");
  const qualified = !!qualifiedEvent;

  // Rejection reason
  const rejectionReason = rejectedEvent?.payload.reason;

  // Rule version: from RULE_EVALUATED
  const ruleEvaluated = firstSucceededOfType(events, "RULE_EVALUATED");
  const ruleVersion = ruleEvaluated?.payload.ruleId ?? "unknown";

  // Capital plan
  const capitalPlanEvent = firstSucceededOfType(events, "CAPITAL_PLAN_CREATED");
  const capitalPlan = capitalPlanEvent
    ? { deployableCents: toNumberCents(capitalPlanEvent.payload.deployableCents) }
    : null;

  // Allocation plan
  const allocationPlanEvent = firstSucceededOfType(events, "ALLOCATION_PLAN_CREATED");
  const allocationPlan = allocationPlanEvent
    ? { totalDeployedCents: toNumberCents(allocationPlanEvent.payload.totalDeployedCents), lines: allocationPlanEvent.payload.lines }
    : null;

  // Execution policy
  const executionPolicyEvent = firstSucceededOfType(events, "EXECUTION_POLICY_EVALUATED");
  const executionPolicy = executionPolicyEvent
    ? { disposition: executionPolicyEvent.payload.disposition, executeCount: executionPolicyEvent.payload.executeCount }
    : null;

  // Shadow-only invariant
  const shadowDecision = firstSucceededOfType(events, "SHADOW_DECISION_RECORDED");
  const executionBlocked = firstSucceededOfType(events, "EXECUTION_BLOCKED");
  const shadowOnly = !!shadowDecision && !!executionBlocked;

  // Provider mutation attempted
  const providerMutationAttempted = run.mutationCounts.providerMutation > 0;

  // Failed gate — prefer authoritative run gates, fall back to event evidence
  const failedGate =
    run.gates.find(g => g.status === "FAIL")?.gate ??
    firstOfType(events, "CERT_GATE_FAILED")?.payload.gate;

  // Safe provider error (from providerCalls or PROVIDER_REQUEST_FAILED)
  const failedCall = providerCalls.find(p => p.failureCode && p.failureCode.startsWith("provider."));
  const failedEvent = firstOfType(events, "PROVIDER_REQUEST_FAILED");
  const safeProviderError = {
    httpStatus: failedCall?.httpStatus ?? failedEvent?.payload.httpStatus,
    plaidErrorType: failedCall?.plaidErrorType ?? failedEvent?.payload.plaidErrorType,
    plaidErrorCode: failedCall?.plaidErrorCode ?? failedEvent?.payload.plaidErrorCode,
    plaidRequestId: failedCall?.plaidRequestId ?? failedEvent?.payload.plaidRequestId,
  };

  // Finished cleanly: CERT_RUN_COMPLETED present AND no RECONCILIATION_FAILED AND finalState === "clean"
  const completedEvent = firstSucceededOfType(events, "CERT_RUN_COMPLETED");
  const reconciliationFailed = firstOfType(events, "RECONCILIATION_FAILED");
  const finishedCleanly = !!completedEvent && !reconciliationFailed && run.finalState === "clean";

  // What observed - build from first observation
  const firstObs = firstSucceededOfType(events, "OBSERVATION_RECEIVED");
  const whatObserved = firstObs
    ? `Observed ${firstObs.payload.direction} of ${toNumberCents(firstObs.payload.amountCents)} cents (${firstObs.payload.posted ? "posted" : "pending"})`
    : "No observations received";

  return {
    whatObserved,
    evidenceKind,
    provider,
    environment,
    normalized,
    persisted,
    qualified,
    rejectionReason,
    ruleVersion,
    capitalPlan,
    allocationPlan,
    executionPolicy,
    shadowOnly,
    providerMutationAttempted,
    failedGate,
    safeProviderError,
    sourceCommit: run.sourceCommit,
    harnessVersion: run.harnessVersion,
    schemaVersion: run.schemaVersion,
    finishedCleanly,
  };
}

// ─── Markdown Renderer (derived from canonical JSON) ───────────────────────

export function renderMarkdownReport(report: CertificationReportV1): string {
  const s = sanitizeReport(report);
  const r = s.run;

  const lines: string[] = [];
  lines.push(`# Certification Report: ${r.milestone} (${r.provider}/${r.environment})`);
  lines.push("");
  lines.push(`**Run ID:** \`${r.runId}\``);
  lines.push(`**Correlation ID:** \`${r.correlationId}\``);
  lines.push(`**Source Commit:** \`${r.sourceCommit}\``);
  lines.push(`**Harness:** ${r.harness} v${r.harnessVersion}`);
  lines.push(`**Schema:** ${r.schemaVersion}`);
  lines.push(`**Started:** ${r.startedAt}`);
  lines.push(r.completedAt ? `**Completed:** ${r.completedAt}` : `**Completed:** — (in progress)`);
  lines.push(`**Result:** ${r.result}`);
  if (r.failureCode) lines.push(`**Failure Code:** \`${r.failureCode}\``);
  lines.push("");
  lines.push("## Evidence Boundary");
  lines.push(`- Provider Observation: **${r.evidenceBoundary.providerObservation}**`);
  lines.push(`- Cash Event: **${r.evidenceBoundary.cashEvent}**`);
  lines.push(`- Decision: **${r.evidenceBoundary.decision}**`);
  lines.push(`- Execution: **${r.evidenceBoundary.execution}**`);
  lines.push(`- Provider Mutation: **${r.evidenceBoundary.providerMutation ? "YES" : "NO"}**`);
  lines.push("");
  lines.push("## Gates");
  lines.push("");
  lines.push("| Gate | Status | Failure Code |");
  lines.push("|------|--------|--------------|");
  for (const g of r.gates) {
    lines.push(`| ${g.gate} | ${g.status} | ${g.failureCode ?? "—"} |`);
  }
  lines.push("");
  lines.push("## Mutation Counts");
  lines.push(`- Transfers: ${r.mutationCounts.transfer}`);
  lines.push(`- Orders: ${r.mutationCounts.order}`);
  lines.push(`- Provider Mutations: ${r.mutationCounts.providerMutation}`);
  lines.push("");
  lines.push(`**Final State:** ${r.finalState}`);
  lines.push("");

  return lines.join("\n");
}

// ─── Console Summary (derived from canonical JSON) ─────────────────────────

export function renderConsoleSummary(report: CertificationReportV1): string {
  const s = sanitizeReport(report);
  const r = s.run;

  const statusEmoji = r.result === "PASS" ? "PASS" : r.result === "FAIL" ? "FAIL" : "ABORTED";
  const gateLines = r.gates.map(g => `  ${g.gate}: ${g.status}${g.failureCode ? ` (${g.failureCode})` : ""}`).join("\n");

  return [
    `${statusEmoji} ${r.milestone} ${r.provider}/${r.environment} — ${r.result}`,
    `  Run: ${r.runId} | Commit: ${r.sourceCommit.slice(0, 8)} | ${r.startedAt}`,
    `  Evidence: obs=${r.evidenceBoundary.providerObservation} cash=${r.evidenceBoundary.cashEvent} decision=${r.evidenceBoundary.decision} exec=${r.evidenceBoundary.execution} mutation=${r.evidenceBoundary.providerMutation}`,
    `  Gates:\n${gateLines}`,
    `  Mutations: txfer=${r.mutationCounts.transfer} order=${r.mutationCounts.order} prov=${r.mutationCounts.providerMutation}`,
    `  Final: ${r.finalState}`,
  ].join("\n");
}