// PostgreSQL adapter for audit + certification persistence.
// The ONLY module that knows about `pg` or SQL for audit tables.
// Mirrors the conventions of `sync-postgres.ts`.

import { Pool } from "pg";
import type {
  CreateCertificationRunInput,
  CompleteCertificationRunInput,
  PersistedCertificationRun,
  AuditEventStore,
  CertificationRunStore,
  ProviderCallEvidenceStore,
  AuditPorts,
} from "./audit-ports";
import type {
  AuditEvent,
  EvidenceBoundary,
  FailureCode,
  GateResult,
} from "@alepes/audit";
import { cents, nonNegativeCents } from "@alepes/money";
import { ulid } from "./identity";

const T_RUNS = "certification_runs";
const T_EVENTS = "audit_events";
const T_PROVIDER_CALLS = "provider_call_evidence";

/** Deterministic 32-bit advisory-lock key derived from runId (same pattern as sync-postgres). */
function advisoryLockKey(runId: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < runId.length; i++) {
    h ^= runId.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0) - 0x80000000;
}

/** Serialize AuditEvent to flat columns + payload JSONB. */
function eventToRow(
  event: AuditEvent,
  runId: string,
  correlationId: string,
  sequence: number
): {
  eventId: string;
  runId: string;
  correlationId: string;
  causationId: string | null;
  sequence: number;
  occurredAt: string;
  phase: string;
  type: string;
  status: string;
  actor: string;
  provider: string | null;
  attempt: number | null;
  mutated: boolean | null;
  verified: boolean | null;
  payload: object;
} {
  const base = {
    eventId: event.eventId,
    runId,
    correlationId,
    causationId: event.causationId ?? null,
    sequence,
    occurredAt: event.occurredAt,
    phase: event.phase,
    type: event.type,
    status: event.status,
    actor: event.actor,
    provider: event.provider ?? null,
    attempt: event.attempt ?? null,
    mutated: event.mutated ?? null,
    verified: event.verified ?? null,
  } as const;

  // Extract payload by switching on type (exhaustive for the union)
  const payload = ((): object => {
    switch (event.type) {
      case "CERT_RUN_STARTED":
        return { harness: event.payload.harness, schemaVersion: event.payload.schemaVersion };
      case "PREFLIGHT_PASSED":
        return { secretsPresent: event.payload.secretsPresent };
      case "PREFLIGHT_FAILED":
        return { failureCode: event.payload.failureCode, field: event.payload.field, providerCallAttempted: event.payload.providerCallAttempted };
      case "PROVIDER_REQUEST_STARTED":
        return { operation: event.payload.operation, accountIdFingerprint: event.payload.accountIdFingerprint };
      case "PROVIDER_REQUEST_SUCCEEDED":
        return { operation: event.payload.operation, latencyMs: event.payload.latencyMs };
      case "PROVIDER_REQUEST_FAILED":
        return {
          failureCode: event.payload.failureCode,
          httpStatus: event.payload.httpStatus,
          plaidErrorType: event.payload.plaidErrorType,
          plaidErrorCode: event.payload.plaidErrorCode,
          plaidRequestId: event.payload.plaidRequestId,
        };
      case "OBSERVATION_RECEIVED":
        return { observationId: event.payload.observationId, externalRefFingerprint: event.payload.externalRefFingerprint, direction: event.payload.direction, amountCents: event.payload.amountCents, posted: event.payload.posted };
      case "OBSERVATION_NORMALIZED":
        return { observationId: event.payload.observationId, normalizationVersion: event.payload.normalizationVersion };
      case "OBSERVATION_PERSISTED":
        return { observationId: event.payload.observationId, persistedId: event.payload.persistedId };
      case "OBSERVATION_RECONCILED":
        return { observationId: event.payload.observationId, cycleId: event.payload.cycleId };
      case "CASH_EVENT_QUALIFIED":
        return { cashEventId: event.payload.cashEventId, amountCents: event.payload.amountCents, ruleId: event.payload.ruleId };
      case "CASH_EVENT_REJECTED":
        return { reason: event.payload.reason, observationId: event.payload.observationId };
      case "RULE_EVALUATED":
        return { ruleId: event.payload.ruleId, cashEventId: event.payload.cashEventId, capitalAmountCents: event.payload.capitalAmountCents };
      case "CAPITAL_PLAN_CREATED":
        return { capitalPlanId: event.payload.capitalPlanId, deployableCents: event.payload.deployableCents };
      case "ALLOCATION_PLAN_CREATED":
        return { allocationPlanId: event.payload.allocationPlanId, totalDeployedCents: event.payload.totalDeployedCents, lines: event.payload.lines };
      case "EXECUTION_PLAN_CREATED":
        return { executionPlanId: event.payload.executionPlanId, orderCount: event.payload.orderCount };
      case "EXECUTION_POLICY_EVALUATED":
        return { disposition: event.payload.disposition, executeCount: event.payload.executeCount };
      case "SHADOW_DECISION_RECORDED":
        return { decisionId: event.payload.decisionId, disposition: event.payload.disposition, deployableCents: event.payload.deployableCents };
      case "EXECUTION_BLOCKED":
        // Match declared payload exactly: { reason, executeCount, transferCount, orderCount, providerMutationCount }
        return { reason: event.payload.reason, executeCount: event.payload.executeCount, transferCount: event.payload.transferCount, orderCount: event.payload.orderCount, providerMutationCount: event.payload.providerMutationCount };
      case "OUTBOX_RECORDED":
        return { outboxEventId: event.payload.outboxEventId };
      case "AUDIT_RECORDED":
        return { auditRecordId: event.payload.auditRecordId };
      case "RECONCILIATION_STARTED":
        return { cycleId: event.payload.cycleId };
      case "RECONCILIATION_SUCCEEDED":
        return { cycleId: event.payload.cycleId };
      case "RECONCILIATION_FAILED":
        return { cycleId: event.payload.cycleId, failureCode: event.payload.failureCode };
      case "IDEMPOTENCY_CHECK":
        return { key: event.payload.key, duplicate: event.payload.duplicate };
      case "DUPLICATE_EVENT_SUPPRESSED":
        return { key: event.payload.key };
      case "CERT_GATE_PASSED":
        return { gate: event.payload.gate };
      case "CERT_GATE_FAILED":
        return { gate: event.payload.gate, failureCode: event.payload.failureCode };
      case "CERT_GATE_SKIPPED":
        return { gate: event.payload.gate, reason: event.payload.reason };
      case "REDACTION_VIOLATION":
        return { field: event.payload.field, fingerprint: event.payload.fingerprint };
      case "CERT_RUN_COMPLETED":
        return { result: event.payload.result, evidenceBoundary: event.payload.evidenceBoundary };
      default:
        // Runtime exhaustiveness guard without `never` assignment (TS does not narrow event in default)
        throw new Error(`Unhandled audit event type: ${(event as { type: string }).type}`);
    }
  })();

  return { ...base, payload };
}

/** Rehydrate AuditEvent from row (discriminated union by `type`). */
function rowToEvent(row: {
  event_id: string;
  run_id: string;
  correlation_id: string;
  causation_id: string | null;
  sequence: string | number;
  occurred_at: string | Date;
  phase: string;
  type: string;
  status: string;
  actor: string;
  provider: string | null;
  attempt: number | null;
  mutated: boolean | null;
  verified: boolean | null;
  payload: object;
}): AuditEvent {
  const base = {
    eventId: row.event_id,
    runId: row.run_id,
    correlationId: row.correlation_id,
    causationId: row.causation_id ?? undefined,
    sequence: Number(row.sequence),
    occurredAt: typeof row.occurred_at === "string" ? row.occurred_at : (row.occurred_at as Date).toISOString(),
    phase: row.phase as AuditEvent["phase"],
    type: row.type as AuditEvent["type"],
    status: row.status as AuditEvent["status"],
    actor: row.actor as AuditEvent["actor"],
    provider: row.provider ?? undefined,
    attempt: row.attempt ?? undefined,
    mutated: row.mutated ?? undefined,
    verified: row.verified ?? undefined,
  } as const;

  const p = row.payload as Record<string, unknown>;

  switch (row.type) {
    case "CERT_RUN_STARTED":
      return { ...base, type: "CERT_RUN_STARTED", payload: { harness: p.harness as string, schemaVersion: p.schemaVersion as string } };
    case "PREFLIGHT_PASSED":
      return { ...base, type: "PREFLIGHT_PASSED", payload: { secretsPresent: p.secretsPresent as string[] } };
    case "PREFLIGHT_FAILED":
      return { ...base, type: "PREFLIGHT_FAILED", payload: { failureCode: p.failureCode as FailureCode, field: p.field as string | undefined, providerCallAttempted: p.providerCallAttempted as boolean } };
    case "PROVIDER_REQUEST_STARTED":
      return { ...base, type: "PROVIDER_REQUEST_STARTED", payload: { operation: p.operation as string, accountIdFingerprint: p.accountIdFingerprint as string | undefined } };
    case "PROVIDER_REQUEST_SUCCEEDED":
      return { ...base, type: "PROVIDER_REQUEST_SUCCEEDED", payload: { operation: p.operation as string, latencyMs: p.latencyMs as number } };
    case "PROVIDER_REQUEST_FAILED":
      return {
        ...base,
        type: "PROVIDER_REQUEST_FAILED",
        payload: {
          failureCode: p.failureCode as FailureCode,
          httpStatus: p.httpStatus as number | undefined,
          plaidErrorType: p.plaidErrorType as string | undefined,
          plaidErrorCode: p.plaidErrorCode as string | undefined,
          plaidRequestId: p.plaidRequestId as string | undefined,
        },
      };
    case "OBSERVATION_RECEIVED":
      return { ...base, type: "OBSERVATION_RECEIVED", payload: { observationId: p.observationId as string, externalRefFingerprint: p.externalRefFingerprint as string, direction: p.direction as "credit" | "debit", amountCents: cents(p.amountCents as number), posted: p.posted as boolean } };
    case "OBSERVATION_NORMALIZED":
      return { ...base, type: "OBSERVATION_NORMALIZED", payload: { observationId: p.observationId as string, normalizationVersion: p.normalizationVersion as string } };
    case "OBSERVATION_PERSISTED":
      return { ...base, type: "OBSERVATION_PERSISTED", payload: { observationId: p.observationId as string, persistedId: p.persistedId as string } };
    case "OBSERVATION_RECONCILED":
      return { ...base, type: "OBSERVATION_RECONCILED", payload: { observationId: p.observationId as string, cycleId: p.cycleId as string } };
    case "CASH_EVENT_QUALIFIED":
      return { ...base, type: "CASH_EVENT_QUALIFIED", payload: { cashEventId: p.cashEventId as string, amountCents: cents(p.amountCents as number), ruleId: p.ruleId as string } };
    case "CASH_EVENT_REJECTED":
      return { ...base, type: "CASH_EVENT_REJECTED", payload: { reason: p.reason as string, observationId: p.observationId as string } };
    case "RULE_EVALUATED":
      return { ...base, type: "RULE_EVALUATED", payload: { ruleId: p.ruleId as string, cashEventId: p.cashEventId as string, capitalAmountCents: cents(p.capitalAmountCents as number) } };
    case "CAPITAL_PLAN_CREATED":
      return { ...base, type: "CAPITAL_PLAN_CREATED", payload: { capitalPlanId: p.capitalPlanId as string, deployableCents: nonNegativeCents(p.deployableCents as number) } };
    case "ALLOCATION_PLAN_CREATED":
      return { ...base, type: "ALLOCATION_PLAN_CREATED", payload: { allocationPlanId: p.allocationPlanId as string, totalDeployedCents: nonNegativeCents(p.totalDeployedCents as number), lines: p.lines as number } };
    case "EXECUTION_PLAN_CREATED":
      return { ...base, type: "EXECUTION_PLAN_CREATED", payload: { executionPlanId: p.executionPlanId as string, orderCount: p.orderCount as number } };
    case "EXECUTION_POLICY_EVALUATED":
      return { ...base, type: "EXECUTION_POLICY_EVALUATED", payload: { disposition: p.disposition as "shadow" | "approval" | "execute", executeCount: p.executeCount as number } };
    case "SHADOW_DECISION_RECORDED":
      return { ...base, type: "SHADOW_DECISION_RECORDED", payload: { decisionId: p.decisionId as string, disposition: p.disposition as "shadow", deployableCents: nonNegativeCents(p.deployableCents as number) } };
    case "EXECUTION_BLOCKED":
      // Match declared payload exactly: { reason, executeCount: 0, transferCount: 0, orderCount: 0, providerMutationCount: 0 }
      // Persisted values must be zero by domain invariant; narrow to literal 0 for type fidelity.
      return { ...base, type: "EXECUTION_BLOCKED", payload: { reason: p.reason as string, executeCount: p.executeCount as 0, transferCount: p.transferCount as 0, orderCount: p.orderCount as 0, providerMutationCount: p.providerMutationCount as 0 } };
    case "OUTBOX_RECORDED":
      return { ...base, type: "OUTBOX_RECORDED", payload: { outboxEventId: p.outboxEventId as string } };
    case "AUDIT_RECORDED":
      return { ...base, type: "AUDIT_RECORDED", payload: { auditRecordId: p.auditRecordId as string } };
    case "RECONCILIATION_STARTED":
      return { ...base, type: "RECONCILIATION_STARTED", payload: { cycleId: p.cycleId as string } };
    case "RECONCILIATION_SUCCEEDED":
      return { ...base, type: "RECONCILIATION_SUCCEEDED", payload: { cycleId: p.cycleId as string } };
    case "RECONCILIATION_FAILED":
      return { ...base, type: "RECONCILIATION_FAILED", payload: { cycleId: p.cycleId as string, failureCode: p.failureCode as FailureCode } };
    case "IDEMPOTENCY_CHECK":
      return { ...base, type: "IDEMPOTENCY_CHECK", payload: { key: p.key as string, duplicate: p.duplicate as boolean } };
    case "DUPLICATE_EVENT_SUPPRESSED":
      return { ...base, type: "DUPLICATE_EVENT_SUPPRESSED", payload: { key: p.key as string } };
    case "CERT_GATE_PASSED":
      return { ...base, type: "CERT_GATE_PASSED", payload: { gate: p.gate as string } };
    case "CERT_GATE_FAILED":
      return { ...base, type: "CERT_GATE_FAILED", payload: { gate: p.gate as string, failureCode: p.failureCode as FailureCode } };
    case "CERT_GATE_SKIPPED":
      return { ...base, type: "CERT_GATE_SKIPPED", payload: { gate: p.gate as string, reason: p.reason as string } };
    case "REDACTION_VIOLATION":
      return { ...base, type: "REDACTION_VIOLATION", payload: { field: p.field as string, fingerprint: p.fingerprint as string } };
    case "CERT_RUN_COMPLETED":
      return { ...base, type: "CERT_RUN_COMPLETED", payload: { result: p.result as "PASS" | "FAIL" | "ABORTED", evidenceBoundary: p.evidenceBoundary as EvidenceBoundary } };
    default:
      throw new Error(`Unknown audit event type in DB: ${row.type}`);
  }
}

function toIso(v: string | Date | null): string | null {
  return v == null ? null : typeof v === "string" ? v : (v as Date).toISOString();
}

function rowToRun(row: {
  run_id: string;
  correlation_id: string;
  milestone: string;
  provider: string;
  environment: string;
  source_commit: string;
  branch: string | null;
  harness: string;
  harness_version: string;
  schema_version: string;
  started_at: string | Date;
  completed_at: string | Date | null;
  result: string | null;
  failure_code: string | null;
  evidence_boundary: EvidenceBoundary;
  gates: GateResult[];
  mutation_counts: { transfer: number; order: number; providerMutation: number };
  final_state: string;
  created_at: string | Date;
  updated_at: string | Date;
}): PersistedCertificationRun {
  return {
    runId: row.run_id,
    correlationId: row.correlation_id,
    milestone: row.milestone,
    provider: row.provider,
    environment: row.environment,
    sourceCommit: row.source_commit,
    branch: row.branch,
    harness: row.harness,
    harnessVersion: row.harness_version,
    schemaVersion: row.schema_version,
    startedAt: toIso(row.started_at)!,
    completedAt: toIso(row.completed_at),
    result: row.result as "PASS" | "FAIL" | "ABORTED" | null,
    failureCode: row.failure_code as FailureCode | null,
    evidenceBoundary: row.evidence_boundary,
    gates: row.gates,
    mutationCounts: row.mutation_counts,
    finalState: row.final_state as "clean" | "dirty",
    createdAt: toIso(row.created_at)!,
    updatedAt: toIso(row.updated_at)!,
  };
}

function rowToProviderCall(row: {
  evidence_id: string;
  run_id: string;
  correlation_id: string;
  occurred_at: string | Date;
  operation: string;
  http_status: string | number | null;
  plaid_error_type: string | null;
  plaid_error_code: string | null;
  plaid_request_id: string | null;
  failure_code: string | null;
}): {
  evidenceId: string;
  runId: string;
  correlationId: string;
  occurredAt: string;
  operation: string;
  httpStatus: number | null;
  plaidErrorType: string | null;
  plaidErrorCode: string | null;
  plaidRequestId: string | null;
  failureCode: FailureCode | null;
} {
  return {
    evidenceId: row.evidence_id,
    runId: row.run_id,
    correlationId: row.correlation_id,
    occurredAt: typeof row.occurred_at === "string" ? row.occurred_at : (row.occurred_at as Date).toISOString(),
    operation: row.operation,
    httpStatus: row.http_status == null ? null : Number(row.http_status),
    plaidErrorType: row.plaid_error_type,
    plaidErrorCode: row.plaid_error_code,
    plaidRequestId: row.plaid_request_id,
    failureCode: row.failure_code as FailureCode | null,
  };
}

export interface AuditPostgresConfig {
  connectionString: string;
}

export function createAuditPostgresStore(cfg: AuditPostgresConfig): AuditPorts {
  const pool = new Pool({ connectionString: cfg.connectionString });

  // ─── CertificationRunStore ───
  const runs: CertificationRunStore = {
    async createRun(input: CreateCertificationRunInput): Promise<void> {
      await pool.query(
        `INSERT INTO ${T_RUNS} (run_id, correlation_id, milestone, provider, environment, source_commit, branch, harness, harness_version, schema_version, started_at, evidence_boundary, gates, mutation_counts, final_state)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,'clean')
         ON CONFLICT (run_id) DO NOTHING`,
        [
          input.runId,
          input.correlationId,
          input.milestone,
          input.provider,
          input.environment,
          input.sourceCommit,
          input.branch ?? null,
          input.harness,
          input.harnessVersion,
          input.schemaVersion,
          input.startedAt,
          JSON.stringify({
            providerObservation: "none",
            cashEvent: "none",
            decision: "none",
            execution: "none",
            providerMutation: false,
          } as EvidenceBoundary),
          JSON.stringify([]),
          JSON.stringify({ transfer: 0, order: 0, providerMutation: 0 }),
        ]
      );
    },

    async completeRun(input: CompleteCertificationRunInput): Promise<void> {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");

        // Only complete if not already completed (idempotent)
        const existing = await client.query(
          `SELECT completed_at, result, failure_code, evidence_boundary, gates, mutation_counts, final_state, correlation_id
             FROM ${T_RUNS} WHERE run_id = $1`,
          [input.runId]
        );

        if (existing.rows.length === 0) {
          throw new Error(`Run ${input.runId} not found`);
        }

        const row = existing.rows[0];
        if (row.completed_at !== null) {
          // Already completed — verify it's identical using native JSONB equality
          // (Postgres JSONB equality is order-insensitive, unlike JSON.stringify)
          const check = await client.query(
            `SELECT 1 FROM ${T_RUNS}
               WHERE run_id = $1
                 AND result = $2
                 AND failure_code IS NOT DISTINCT FROM $3
                 AND evidence_boundary = $4::jsonb
                 AND gates = $5::jsonb
                 AND mutation_counts = $6::jsonb
                 AND final_state = $7`,
            [
              input.runId,
              input.result,
              input.failureCode ?? null,
              JSON.stringify(input.evidenceBoundary),
              JSON.stringify(input.gates),
              JSON.stringify(input.mutationCounts),
              input.finalState,
            ]
          );

          if (check.rows.length === 0) {
            throw new Error(`Run ${input.runId} already completed with different outcome`);
          }
          await client.query("COMMIT");
          return;
        }

        await client.query(
          `UPDATE ${T_RUNS}
             SET completed_at = $1, result = $2, failure_code = $3, evidence_boundary = $4, gates = $5, mutation_counts = $6, final_state = $7, updated_at = now()
             WHERE run_id = $8`,
          [
            input.completedAt,
            input.result,
            input.failureCode ?? null,
            JSON.stringify(input.evidenceBoundary),
            JSON.stringify(input.gates),
            JSON.stringify(input.mutationCounts),
            input.finalState,
            input.runId,
          ]
        );

        // Emit CERT_RUN_COMPLETED audit event inside the same transaction
        const seqRes = await client.query(
          `SELECT COALESCE(MAX(sequence), 0) + 1 AS next_seq FROM ${T_EVENTS} WHERE run_id = $1`,
          [input.runId]
        );
        const completionSequence = Number(seqRes.rows[0].next_seq);

        // Use the run's actual correlationId (from the SELECT above), not runId
        const runCorrelationId = row.correlation_id;

        const completionEvent: AuditEvent = {
          eventId: ulid(),
          runId: input.runId,
          correlationId: runCorrelationId,
          causationId: undefined,
          sequence: completionSequence,
          occurredAt: input.completedAt,
          phase: "reporting",
          type: "CERT_RUN_COMPLETED",
          status: input.result === "PASS" ? "succeeded" : "failed",
          actor: "system",
          provider: undefined,
          attempt: undefined,
          mutated: undefined,
          verified: undefined,
          payload: {
            result: input.result,
            evidenceBoundary: input.evidenceBoundary,
          },
        };

        const completionRow = eventToRow(completionEvent, input.runId, runCorrelationId, completionSequence);
        await client.query(
          `INSERT INTO ${T_EVENTS} (event_id, run_id, correlation_id, causation_id, sequence, occurred_at, phase, type, status, actor, provider, attempt, mutated, verified, payload)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`,
          [
            completionRow.eventId,
            completionRow.runId,
            completionRow.correlationId,
            completionRow.causationId,
            completionRow.sequence,
            completionRow.occurredAt,
            completionRow.phase,
            completionRow.type,
            completionRow.status,
            completionRow.actor,
            completionRow.provider,
            completionRow.attempt,
            completionRow.mutated,
            completionRow.verified,
            JSON.stringify(completionRow.payload),
          ]
        );

        await client.query("COMMIT");
      } catch (err) {
        await client.query("ROLLBACK");
        throw err;
      } finally {
        client.release();
      }
    },

    async loadRun(runId: string): Promise<PersistedCertificationRun | null> {
      const res = await pool.query(
        `SELECT run_id, correlation_id, milestone, provider, environment, source_commit, branch, harness, harness_version, schema_version, started_at, completed_at, result, failure_code, evidence_boundary, gates, mutation_counts, final_state, created_at, updated_at
           FROM ${T_RUNS} WHERE run_id = $1`,
        [runId]
      );
      return res.rows.length > 0 ? rowToRun(res.rows[0]) : null;
    },

    async loadRunByCorrelationId(correlationId: string): Promise<PersistedCertificationRun | null> {
      const res = await pool.query(
        `SELECT run_id, correlation_id, milestone, provider, environment, source_commit, branch, harness, harness_version, schema_version, started_at, completed_at, result, failure_code, evidence_boundary, gates, mutation_counts, final_state, created_at, updated_at
           FROM ${T_RUNS} WHERE correlation_id = $1 ORDER BY started_at DESC LIMIT 1`,
        [correlationId]
      );
      return res.rows.length > 0 ? rowToRun(res.rows[0]) : null;
    },
  };

  // ─── AuditEventStore ───
  const events: AuditEventStore = {
    async append(event: AuditEvent): Promise<void> {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");

        // Serialize per-run appends with advisory lock to assign sequence atomically
        const lockKey = advisoryLockKey(event.runId);
        await client.query("SELECT pg_advisory_xact_lock($1)", [lockKey]);

        // Get next sequence for this run
        const seqRes = await client.query(
          `SELECT COALESCE(MAX(sequence), 0) + 1 AS next_seq FROM ${T_EVENTS} WHERE run_id = $1`,
          [event.runId]
        );
        const sequence = Number(seqRes.rows[0].next_seq);

        const row = eventToRow(event, event.runId, event.correlationId, sequence);

        await client.query(
          `INSERT INTO ${T_EVENTS} (event_id, run_id, correlation_id, causation_id, sequence, occurred_at, phase, type, status, actor, provider, attempt, mutated, verified, payload)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`,
          [
            row.eventId,
            row.runId,
            row.correlationId,
            row.causationId,
            row.sequence,
            row.occurredAt,
            row.phase,
            row.type,
            row.status,
            row.actor,
            row.provider,
            row.attempt,
            row.mutated,
            row.verified,
            JSON.stringify(row.payload),
          ]
        );

        await client.query("COMMIT");
      } catch (err) {
        await client.query("ROLLBACK");
        throw err;
      } finally {
        client.release();
      }
    },

    async listByRun(runId: string): Promise<AuditEvent[]> {
      const res = await pool.query(
        `SELECT event_id, run_id, correlation_id, causation_id, sequence, occurred_at, phase, type, status, actor, provider, attempt, mutated, verified, payload
           FROM ${T_EVENTS} WHERE run_id = $1 ORDER BY sequence ASC`,
        [runId]
      );
      return res.rows.map(rowToEvent);
    },

    async listByCorrelationId(correlationId: string): Promise<AuditEvent[]> {
      const res = await pool.query(
        `SELECT event_id, run_id, correlation_id, causation_id, sequence, occurred_at, phase, type, status, actor, provider, attempt, mutated, verified, payload
           FROM ${T_EVENTS} WHERE correlation_id = $1 ORDER BY occurred_at ASC, sequence ASC`,
        [correlationId]
      );
      return res.rows.map(rowToEvent);
    },
  };

  // ─── ProviderCallEvidenceStore ───
  const providerCalls: ProviderCallEvidenceStore = {
    async record(input: {
      evidenceId: string;
      runId: string;
      correlationId: string;
      occurredAt: string;
      operation: string;
      httpStatus?: number;
      plaidErrorType?: string;
      plaidErrorCode?: string;
      plaidRequestId?: string;
      failureCode?: FailureCode;
    }): Promise<void> {
      await pool.query(
        `INSERT INTO ${T_PROVIDER_CALLS} (evidence_id, run_id, correlation_id, occurred_at, operation, http_status, plaid_error_type, plaid_error_code, plaid_request_id, failure_code)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
        [
          input.evidenceId,
          input.runId,
          input.correlationId,
          input.occurredAt,
          input.operation,
          input.httpStatus ?? null,
          input.plaidErrorType ?? null,
          input.plaidErrorCode ?? null,
          input.plaidRequestId ?? null,
          input.failureCode ?? null,
        ]
      );
    },

    async listByRun(runId: string): Promise<Array<{
      evidenceId: string;
      runId: string;
      correlationId: string;
      occurredAt: string;
      operation: string;
      httpStatus: number | null;
      plaidErrorType: string | null;
      plaidErrorCode: string | null;
      plaidRequestId: string | null;
      failureCode: FailureCode | null;
    }>> {
      const res = await pool.query(
        `SELECT evidence_id, run_id, correlation_id, occurred_at, operation, http_status, plaid_error_type, plaid_error_code, plaid_request_id, failure_code
           FROM ${T_PROVIDER_CALLS} WHERE run_id = $1 ORDER BY occurred_at ASC`,
        [runId]
      );
      return res.rows.map(rowToProviderCall);
    },
  };

  return {
    runs,
    events,
    providerCalls,
    close: async () => pool.end(),
  };
}