// Reconstruction tests for CertificationReportV1 from durable evidence.
// Uses a fake in-memory ReconstructionSource — no Postgres, no Plaid, no network.

import { describe, it, expect, beforeEach } from "vitest";
import {
  reconstructCertificationReport,
  createReconstructionSource,
  sanitizeReport,
  renderConsoleSummary,
  renderMarkdownReport,
  CERTIFICATION_REPORT_SCHEMA_VERSION,
  type ProviderCallEvidence,
  type ReconstructionSource,
} from "./index.js";
import type {
  CertificationRun,
  AuditEvent,
  GateResult,
  EvidenceBoundary,
  FailureCode,
  RunResult,
  Milestone,
  ProviderName,
  Environment,
} from "@alepes/audit";
import type { Cents, NonNegativeCents } from "@alepes/money";

// ── Sentinel secrets for adversarial non-leakage tests ───────────────────────
const SENTINEL_ACCESS_TOKEN = "SENTINEL_ACCESS_TOKEN";
const SENTINEL_DB_PASS = "SENTINEL_DB_PASS";
const SENTINEL_ACCOUNT_ID = "SENTINEL_ACCOUNT_ID";
const SENTINEL_ITEM_ID = "SENTINEL_ITEM_ID";
const SENTINEL_REQUEST_ID = "SENTINEL_REQUEST_ID";
const SENTINEL_AUTH_HEADER = "SENTINEL_AUTH_HEADER";

const sentinels = [
  SENTINEL_ACCESS_TOKEN,
  SENTINEL_DB_PASS,
  SENTINEL_ACCOUNT_ID,
  SENTINEL_ITEM_ID,
  SENTINEL_REQUEST_ID,
  SENTINEL_AUTH_HEADER,
];

// ── Helpers to create fake audit events matching real discriminated union ──────

function makeRun(overrides: Partial<CertificationRun> = {}): CertificationRun {
  const gates: GateResult[] = [
    { gate: "qualifying_event", status: "PASS" },
    { gate: "execution_policy", status: "PASS" },
    { gate: "capital_adequacy", status: "PASS" },
    { gate: "shadow_decision", status: "PASS" },
  ];

  return {
    runId: "run_test_123",
    correlationId: "corr_test_456",
    milestone: "v0.5.0-plaid-live-cert" as Milestone,
    provider: "plaid" as ProviderName,
    environment: "production" as Environment,
    sourceCommit: "abcdef1234567890abcdef1234567890abcdef12",
    harness: "certify-live",
    harnessVersion: "1.0.0",
    schemaVersion: CERTIFICATION_REPORT_SCHEMA_VERSION,
    startedAt: "2026-09-12T10:00:00.000Z",
    completedAt: "2026-09-12T10:00:05.000Z",
    result: "PASS",
    evidenceBoundary: {
      providerObservation: "real",
      cashEvent: "real",
      decision: "real",
      execution: "shadow",
      providerMutation: false,
    },
    gates,
    mutationCounts: { transfer: 0, order: 0, providerMutation: 0 },
    finalState: "clean",
    ...overrides,
  };
}

// Helper to create Cents/NonNegativeCents branded values
const C = (n: number): Cents => n as Cents;
const NC = (n: number): NonNegativeCents => n as NonNegativeCents;

function makeEvent(type: AuditEvent["type"], runId: string, seq: number, payload: Record<string, unknown> = {}): AuditEvent {
  // Build each discriminated union member exactly matching audit/src/index.ts
  const base = {
    eventId: `evt_test_${seq}`,
    runId,
    correlationId: "corr_test_456",
    causationId: undefined,
    sequence: seq,
    occurredAt: new Date(Date.now() + seq * 1000).toISOString(),
    phase: "preflight" as const,
    status: "succeeded" as const,
    actor: "system" as const,
    provider: "plaid" as const,
    attempt: 1,
    mutated: false,
    verified: true,
    failureCode: undefined,
    safeError: undefined,
  } as const;

  switch (type) {
    case "CERT_RUN_STARTED":
      return { ...base, type, payload: { harness: "certify-live", schemaVersion: CERTIFICATION_REPORT_SCHEMA_VERSION, ...payload } };
    case "PREFLIGHT_PASSED":
      return { ...base, type, payload: { secretsPresent: ["PLAID_CLIENT_ID", "PLAID_SECRET", "PLAID_ACCESS_TOKEN"], ...payload } };
    case "PREFLIGHT_FAILED":
      return { ...base, type, payload: { failureCode: "configuration.missing_secret", field: "PLAID_ACCESS_TOKEN", providerCallAttempted: false, ...payload } };
    case "PROVIDER_REQUEST_STARTED":
      return { ...base, type, payload: { operation: "accounts_get", ...payload } };
    case "PROVIDER_REQUEST_SUCCEEDED":
      return { ...base, type, payload: { operation: "accounts_get", latencyMs: 500, ...payload } };
    case "PROVIDER_REQUEST_FAILED":
      return { ...base, type, payload: { failureCode: "provider.unavailable", httpStatus: 500, ...payload } };
    case "OBSERVATION_RECEIVED":
      return { ...base, type, payload: { observationId: "obs_001", externalRefFingerprint: "fp_001", direction: "credit", amountCents: C(10000), posted: true, ...payload } };
    case "OBSERVATION_NORMALIZED":
      return { ...base, type, payload: { observationId: "obs_001", normalizationVersion: "1.0", ...payload } };
    case "OBSERVATION_PERSISTED":
      return { ...base, type, payload: { observationId: "obs_001", persistedId: "pers_001", ...payload } };
    case "OBSERVATION_RECONCILED":
      return { ...base, type, payload: { observationId: "obs_001", cycleId: "cycle_001", ...payload } };
    case "CASH_EVENT_QUALIFIED":
      return { ...base, type, payload: { cashEventId: "ce_001", amountCents: C(10000), ruleId: "rule_001", ...payload } };
    case "CASH_EVENT_REJECTED":
      return { ...base, type, payload: { reason: "no_rule_match", observationId: "obs_001", ...payload } };
    case "RULE_EVALUATED":
      return { ...base, type, payload: { ruleId: "rule_001", cashEventId: "ce_001", capitalAmountCents: C(10000), ...payload } };
    case "CAPITAL_PLAN_CREATED":
      return { ...base, type, payload: { capitalPlanId: "cp_001", deployableCents: NC(10000), ...payload } };
    case "ALLOCATION_PLAN_CREATED":
      return { ...base, type, payload: { allocationPlanId: "ap_001", totalDeployedCents: NC(10000), lines: 1, ...payload } };
    case "EXECUTION_PLAN_CREATED":
      return { ...base, type, payload: { executionPlanId: "ep_001", orderCount: 0, ...payload } };
    case "EXECUTION_POLICY_EVALUATED":
      return { ...base, type, payload: { disposition: "shadow", executeCount: 0, ...payload } };
    case "SHADOW_DECISION_RECORDED":
      return { ...base, type, payload: { decisionId: "dec_001", disposition: "shadow", deployableCents: NC(10000), ...payload } };
    case "EXECUTION_BLOCKED":
      return { ...base, type, payload: { reason: "shadow_only", executeCount: 0, transferCount: 0, orderCount: 0, providerMutationCount: 0, ...payload } };
    case "OUTBOX_RECORDED":
      return { ...base, type, payload: { outboxEventId: "ob_001", ...payload } };
    case "AUDIT_RECORDED":
      return { ...base, type, payload: { auditRecordId: "ar_001", ...payload } };
    case "RECONCILIATION_STARTED":
      return { ...base, type, payload: { cycleId: "cycle_001", ...payload } };
    case "RECONCILIATION_SUCCEEDED":
      return { ...base, type, payload: { cycleId: "cycle_001", ...payload } };
    case "RECONCILIATION_FAILED":
      return { ...base, type, payload: { cycleId: "cycle_001", failureCode: "internal.unexpected", ...payload } };
    case "IDEMPOTENCY_CHECK":
      return { ...base, type, payload: { key: "idem_001", duplicate: false, ...payload } };
    case "DUPLICATE_EVENT_SUPPRESSED":
      return { ...base, type, payload: { key: "idem_001", ...payload } };
    case "CERT_GATE_PASSED":
      return { ...base, type, payload: { gate: "qualifying_event", ...payload } };
    case "CERT_GATE_FAILED":
      return { ...base, type, payload: { gate: "qualifying_event", failureCode: "sync.no_qualifying_event", ...payload } };
    case "CERT_GATE_SKIPPED":
      return { ...base, type, payload: { gate: "qualifying_event", reason: "not_applicable", ...payload } };
    case "REDACTION_VIOLATION":
      return { ...base, type, payload: { field: "access_token", fingerprint: "fp_redacted", ...payload } };
    case "CERT_RUN_COMPLETED":
      return { ...base, type, payload: { result: "PASS", evidenceBoundary: { providerObservation: "real", cashEvent: "real", decision: "real", execution: "shadow", providerMutation: false }, ...payload } };
    default:
      throw new Error(`Unknown event type: ${type}`);
  }
}

function makeProviderCall(overrides: Partial<ProviderCallEvidence> = {}): ProviderCallEvidence {
  return {
    evidenceId: "call_test_789",
    runId: "run_test_123",
    correlationId: "corr_test_456",
    occurredAt: "2026-09-12T10:00:01.000Z",
    operation: "accounts_get",
    httpStatus: 200,
    latencyMs: 450,
    plaidRequestId: "req_test_001",
    ...overrides,
  };
}

// ── Fake in-memory ReconstructionSource ──────────────────────────────────────

function createFakeSource(
  run: CertificationRun,
  events: AuditEvent[],
  providerCalls: ProviderCallEvidence[]
): ReconstructionSource {
  return {
    loadRun: async (runId: string) => (runId === run.runId ? run : null),
    listEvents: async (runId: string) => (runId === run.runId ? [...events] : []),
    listProviderCalls: async (runId: string) => (runId === run.runId ? [...providerCalls] : []),
  };
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe("reconstructCertificationReport", () => {
  let run: CertificationRun;
  let events: AuditEvent[];
  let providerCalls: ProviderCallEvidence[];
  let source: ReconstructionSource;

  beforeEach(() => {
    run = makeRun();
    events = [
      makeEvent("CERT_RUN_STARTED", run.runId, 1),
      makeEvent("PREFLIGHT_PASSED", run.runId, 2),
      makeEvent("OBSERVATION_PERSISTED", run.runId, 3),
      makeEvent("CASH_EVENT_QUALIFIED", run.runId, 4),
      makeEvent("SHADOW_DECISION_RECORDED", run.runId, 5),
      makeEvent("CERT_GATE_PASSED", run.runId, 6),
      makeEvent("CERT_GATE_PASSED", run.runId, 7),
      makeEvent("CERT_GATE_PASSED", run.runId, 8),
      makeEvent("CERT_GATE_PASSED", run.runId, 9),
      makeEvent("CERT_RUN_COMPLETED", run.runId, 10),
    ];
    providerCalls = [
      makeProviderCall({ operation: "accounts_get" }),
      makeProviderCall({ operation: "transactions_sync" }),
    ];
    source = createFakeSource(run, events, providerCalls);
  });

  it("reconstructs a canonical CertificationReportV1 from durable evidence (happy path)", async () => {
    const report = await reconstructCertificationReport(source, run.runId);

    expect(report).not.toBeNull();
    expect(report!.schemaVersion).toBe(CERTIFICATION_REPORT_SCHEMA_VERSION);
    expect(report!.run).toEqual(run);
    expect(report!.events).toHaveLength(events.length);
    expect(report!.events.map(e => e.type)).toEqual(events.map(e => e.type)); // deterministic order preserved
    expect(report!.providerCalls).toHaveLength(providerCalls.length);
  });

  it("returns null for unknown runId", async () => {
    const report = await reconstructCertificationReport(source, "run_unknown_999");
    expect(report).toBeNull();
  });

  it("preserves exact event sequence from source (deterministic ordering)", async () => {
    const report = await reconstructCertificationReport(source, run.runId);
    const seq = report!.events.map(e => e.sequence);
    // Source provided events already sorted by sequence; reconstruction must not reorder
    for (let i = 1; i < seq.length; i++) {
      expect(seq[i]).toBeGreaterThan(seq[i - 1]);
    }
  });

  it("sanitized report never leaks planted sentinel secrets", async () => {
    // Plant sentinel values in event payloads and provider calls
    const taintedRun = makeRun();
    const taintedEvents: AuditEvent[] = [
      makeEvent("CERT_RUN_STARTED", taintedRun.runId, 1, { schemaVersion: CERTIFICATION_REPORT_SCHEMA_VERSION, secret: SENTINEL_DB_PASS }),
      makeEvent("PREFLIGHT_PASSED", taintedRun.runId, 2, { secretsPresent: [SENTINEL_ACCESS_TOKEN, "PLAID_CLIENT_ID"] }),
      makeEvent("OBSERVATION_PERSISTED", taintedRun.runId, 3, { accountId: SENTINEL_ACCOUNT_ID, itemId: SENTINEL_ITEM_ID }),
      makeEvent("CASH_EVENT_QUALIFIED", taintedRun.runId, 4, { requestId: SENTINEL_REQUEST_ID }),
      makeEvent("CERT_RUN_COMPLETED", taintedRun.runId, 5, { authHeader: SENTINEL_AUTH_HEADER }),
    ];
    const taintedCalls: ProviderCallEvidence[] = [
      makeProviderCall({ plaidRequestId: SENTINEL_REQUEST_ID }),
    ];
    const taintedSource = createFakeSource(taintedRun, taintedEvents, taintedCalls);

    const report = await reconstructCertificationReport(taintedSource, taintedRun.runId);
    expect(report).not.toBeNull();

    const sanitized = sanitizeReport(report!);
    const json = JSON.stringify(sanitized);
    const consoleOut = renderConsoleSummary(report!);
    const markdownOut = renderMarkdownReport(report!);

    for (const s of sentinels) {
      expect(json).not.toContain(s);
      expect(consoleOut).not.toContain(s);
      expect(markdownOut).not.toContain(s);
    }

    // Internal report legitimately retains provider call fields — verify they're present
    const internalJson = JSON.stringify(report);
    expect(internalJson).toContain(SENTINEL_REQUEST_ID); // plaidRequestId is internal-only
  });

  it("console summary renders without crashing on sanitized report", async () => {
    const report = await reconstructCertificationReport(source, run.runId);
    expect(report).not.toBeNull();
    const summary = renderConsoleSummary(report!);
    expect(summary).toContain("PASS");
    expect(summary).toContain(run.runId);
    expect(summary).toContain(run.sourceCommit.slice(0, 8));
    expect(summary).toContain("obs=real");
    expect(summary).toContain("exec=shadow");
    expect(summary).toContain("mutation=false");
  });

  it("markdown report renders without crashing on sanitized report", async () => {
    const report = await reconstructCertificationReport(source, run.runId);
    expect(report).not.toBeNull();
    const markdown = renderMarkdownReport(report!);
    expect(markdown).toContain("# Certification Report:");
    expect(markdown).toContain(run.runId);
    expect(markdown).toContain("**Result:** PASS");
    expect(markdown).toContain("## Evidence Boundary");
    expect(markdown).toContain("## Gates");
    expect(markdown).toContain("| Gate | Status | Failure Code |");
  });
});

describe("createReconstructionSource", () => {
  it("adapts full AuditPorts to ReconstructionSource interface", () => {
    const mockPorts = {
      runs: {
        loadRun: async (id: string) => ({ runId: id } as CertificationRun),
      },
      events: {
        listByRun: async (id: string) => [{ runId: id }] as AuditEvent[],
      },
      providerCalls: {
        listByRun: async (id: string) => [{ runId: id }] as ProviderCallEvidence[],
      },
    };

    const source = createReconstructionSource(mockPorts);
    expect(typeof source.loadRun).toBe("function");
    expect(typeof source.listEvents).toBe("function");
    expect(typeof source.listProviderCalls).toBe("function");
  });
});