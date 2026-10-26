// Audit + Certification persistence ports — durable evidence layer contract.
// Database-agnostic interfaces. PostgreSQL is the authoritative store.
// Depends on @alepes/audit types only (no domain/money needed here).

import type {
  AuditEvent,
  EvidenceBoundary,
  FailureCode,
  GateResult,
  ProviderName,
  Environment,
  Milestone,
} from "@alepes/audit";

export type { AuditEvent, EvidenceBoundary, FailureCode, GateResult, ProviderName, Environment, Milestone } from "@alepes/audit";

/** Input for creating a new certification run (all fields present). */
export interface CreateCertificationRunInput {
  runId: string;
  correlationId: string;
  milestone: Milestone;
  provider: ProviderName;
  environment: Environment;
  sourceCommit: string;
  branch?: string;
  harness: string;
  harnessVersion: string;
  schemaVersion: string;
  startedAt: string; // ISO 8601
}

/** Input for completing a run (only mutable fields). */
export interface CompleteCertificationRunInput {
  runId: string;
  completedAt: string; // ISO 8601
  result: "PASS" | "FAIL" | "ABORTED";
  failureCode?: FailureCode;
  evidenceBoundary: EvidenceBoundary;
  gates: GateResult[];
  mutationCounts: { transfer: number; order: number; providerMutation: number };
  finalState: "clean" | "dirty";
}

/** Persisted certification run row (from DB). */
export interface PersistedCertificationRun {
  runId: string;
  correlationId: string;
  milestone: string;
  provider: string;
  environment: string;
  sourceCommit: string;
  branch: string | null;
  harness: string;
  harnessVersion: string;
  schemaVersion: string;
  startedAt: string;
  completedAt: string | null;
  result: "PASS" | "FAIL" | "ABORTED" | null;
  failureCode: FailureCode | null;
  evidenceBoundary: EvidenceBoundary;
  gates: GateResult[];
  mutationCounts: { transfer: number; order: number; providerMutation: number };
  finalState: "clean" | "dirty";
  createdAt: string;
  updatedAt: string;
}

/** Append-only audit event store contract. */
export interface AuditEventStore {
  /** Append an event with an atomically-assigned per-run sequence number. */
  append(event: AuditEvent): Promise<void>;

  /** List all events for a run in deterministic order (by sequence). */
  listByRun(runId: string): Promise<AuditEvent[]>;

  /** List events by correlation ID (for cross-run traces). */
  listByCorrelationId(correlationId: string): Promise<AuditEvent[]>;
}

/** Certification run store contract. */
export interface CertificationRunStore {
  /** Create a new run row. Fails if runId already exists. */
  createRun(input: CreateCertificationRunInput): Promise<void>;

  /** Complete a run (idempotent: subsequent calls with same runId no-op or error). */
  completeRun(input: CompleteCertificationRunInput): Promise<void>;

  /** Load a run by its runId. */
  loadRun(runId: string): Promise<PersistedCertificationRun | null>;

  /** Load a run by correlationId (useful for trace correlation). */
  loadRunByCorrelationId(correlationId: string): Promise<PersistedCertificationRun | null>;
}

/** Provider call evidence store contract (safe fields only). */
export interface ProviderCallEvidenceStore {
  /** Record a provider interaction outcome (safe structured fields only). */
  record(input: {
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
  }): Promise<void>;

  /** List all provider call evidence for a run. */
  listByRun(runId: string): Promise<Array<{
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
  }>>;
}

/** Combined aggregate port for audit + certification persistence. */
export interface AuditPorts {
  runs: CertificationRunStore;
  events: AuditEventStore;
  providerCalls: ProviderCallEvidenceStore;
  close(): Promise<void>;
}

// ─── Reconstruction lives in @alepes/reporting, not in persistence ─────────
// This avoids a circular dependency: persistence → audit types → reporting → persistence
// The PG adapter provides raw loading (listByRun, loadRun); the reducer lives in reporting.