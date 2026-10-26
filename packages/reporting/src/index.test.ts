// @alepes/reporting — Unit tests for certification report schemas, allowlist sanitizer, and reconstruction
// Pure: no I/O, no provider SDKs. Tests adversarial sentinel leakage, sanitizer allowlist behavior,
// reconstruction narratives, and renderer derivation from sanitized data.

import { describe, it, expect } from "vitest";
import type { Cents, NonNegativeCents } from "@alepes/money";
import type {
  CertificationRun,
  AuditEvent,
  EvidenceBoundary,
  GateResult,
  EvidenceKind,
  RunResult,
  FailureCode,
} from "@alepes/audit";
import type { ProviderCallEvidence } from "@alepes/reporting";
import {
  sanitizeReport,
  reconstructRun,
  renderMarkdownReport,
  renderConsoleSummary,
  type CertificationReportV1,
} from "@alepes/reporting";
import { ulid } from "@alepes/persistence";
import type {
  AuditPorts,
  CreateCertificationRunInput,
  CompleteCertificationRunInput,
  PersistedCertificationRun,
} from "@alepes/persistence";
// The actual audit-store helpers (pure module: no Plaid SDK, no network — only
// deterministic event emission). Imported directly so the tests generate
// events with the SAME producers certify-live.ts uses, not hand-built fixtures.
import {
  startRun,
  recordPreflight,
  recordProviderRequest,
  recordObservationReceived,
  recordObservationNormalized,
  recordObservationPersisted,
  recordCashEventQualified,
  recordRuleEvaluated,
  recordCapitalPlanCreated,
  recordAllocationPlanCreated,
  recordExecutionPolicyEvaluated,
  recordShadowDecisionRecorded,
  recordExecutionBlocked,
  recordGate,
  completeRun,
  type CertifyLiveAuditConfig,
  type RunContext,
} from "../../integrations/plaid-financial-data/src/certify-live-audit";

// ─── Helper: branded cents constructors ───

function c(val: number): Cents {
  return val as Cents;
}
function nc(val: number): NonNegativeCents {
  return val as NonNegativeCents;
}

// ─── Build a minimal valid CertificationReportV1 for mutation ───

function buildBaseReport(overrides: Partial<CertificationReportV1> = {}): CertificationReportV1 {
  const baseRun: CertificationRun = {
    runId: "01ARZ3NDEKTSV4RRFFQ69G5FAV",
    correlationId: "corr-456",
    milestone: "v0.5.0",
    provider: "plaid",
    environment: "production",
    sourceCommit: "abc123def",
    branch: "feat/plaid-live-real-cash-event",
    harness: "certify-live.ts",
    harnessVersion: "audit-cert@1",
    schemaVersion: "audit-cert@1",
    startedAt: "2024-01-15T10:30:00.000Z",
    completedAt: "2024-01-15T10:35:00.000Z",
    result: "PASS",
    evidenceBoundary: {
      providerObservation: "real",
      cashEvent: "real",
      decision: "real",
      execution: "shadow",
      providerMutation: false,
    },
    gates: [
      { gate: "preflight", status: "PASS" },
      { gate: "qualifying_event", status: "PASS" },
      { gate: "shadow_execution", status: "PASS" },
    ],
    mutationCounts: { transfer: 0, order: 0, providerMutation: 0 },
    finalState: "clean",
  };

  const baseEvents: AuditEvent[] = [
    {
      eventId: "evt-1",
      runId: baseRun.runId,
      correlationId: baseRun.correlationId,
      sequence: 1,
      occurredAt: "2024-01-15T10:30:00.000Z",
      phase: "preflight",
      type: "CERT_RUN_STARTED",
      status: "succeeded",
      actor: "system",
      payload: { harness: "certify-live.ts", schemaVersion: "audit-cert@1" },
    },
    {
      eventId: "evt-2",
      runId: baseRun.runId,
      correlationId: baseRun.correlationId,
      sequence: 2,
      occurredAt: "2024-01-15T10:30:05.000Z",
      phase: "preflight",
      type: "PREFLIGHT_PASSED",
      status: "succeeded",
      actor: "system",
      payload: { secretsPresent: ["PLAID_CLIENT_ID", "PLAID_SECRET", "PLAID_LIVE_POSTGRES_URL", "PLAID_ACCESS_TOKEN"] },
    },
    {
      eventId: "evt-3",
      runId: baseRun.runId,
      correlationId: baseRun.correlationId,
      sequence: 3,
      occurredAt: "2024-01-15T10:30:10.000Z",
      phase: "provider",
      type: "PROVIDER_REQUEST_STARTED",
      status: "succeeded",
      actor: "provider",
      provider: "plaid",
      attempt: 1,
      payload: { operation: "transactions/sync", accountIdFingerprint: "fp-abc123" },
    },
    {
      eventId: "evt-4",
      runId: baseRun.runId,
      correlationId: baseRun.correlationId,
      sequence: 4,
      occurredAt: "2024-01-15T10:30:12.000Z",
      phase: "provider",
      type: "PROVIDER_REQUEST_SUCCEEDED",
      status: "succeeded",
      actor: "provider",
      provider: "plaid",
      attempt: 1,
      payload: { operation: "transactions/sync", latencyMs: 450 },
    },
    {
      eventId: "evt-5",
      runId: baseRun.runId,
      correlationId: baseRun.correlationId,
      sequence: 5,
      occurredAt: "2024-01-15T10:30:12.000Z",
      phase: "observation",
      type: "OBSERVATION_RECEIVED",
      status: "succeeded",
      actor: "system",
      payload: { observationId: "obs-1", externalRefFingerprint: "fp-txn-456", direction: "credit", amountCents: c(10000), posted: true },
    },
    {
      eventId: "evt-6",
      runId: baseRun.runId,
      correlationId: baseRun.correlationId,
      sequence: 6,
      occurredAt: "2024-01-15T10:30:15.000Z",
      phase: "normalization",
      type: "OBSERVATION_NORMALIZED",
      status: "succeeded",
      actor: "system",
      payload: { observationId: "obs-1", normalizationVersion: "v1" },
    },
    {
      eventId: "evt-7",
      runId: baseRun.runId,
      correlationId: baseRun.correlationId,
      sequence: 7,
      occurredAt: "2024-01-15T10:30:20.000Z",
      phase: "persistence",
      type: "OBSERVATION_PERSISTED",
      status: "succeeded",
      actor: "system",
      payload: { observationId: "obs-1", persistedId: "persisted-obs-1" },
    },
    {
      eventId: "evt-8",
      runId: baseRun.runId,
      correlationId: baseRun.correlationId,
      sequence: 8,
      occurredAt: "2024-01-15T10:30:25.000Z",
      phase: "qualification",
      type: "CASH_EVENT_QUALIFIED",
      status: "succeeded",
      actor: "system",
      payload: { cashEventId: "ce-1", amountCents: c(10000), ruleId: "rule-monthly-deposit" },
    },
    {
      eventId: "evt-9",
      runId: baseRun.runId,
      correlationId: baseRun.correlationId,
      sequence: 9,
      occurredAt: "2024-01-15T10:30:30.000Z",
      phase: "policy",
      type: "RULE_EVALUATED",
      status: "succeeded",
      actor: "system",
      payload: { ruleId: "rule-monthly-deposit", cashEventId: "ce-1", capitalAmountCents: c(10000) },
    },
    {
      eventId: "evt-10",
      runId: baseRun.runId,
      correlationId: baseRun.correlationId,
      sequence: 10,
      occurredAt: "2024-01-15T10:30:35.000Z",
      phase: "policy",
      type: "CAPITAL_PLAN_CREATED",
      status: "succeeded",
      actor: "system",
      payload: { capitalPlanId: "cp-1", deployableCents: nc(10000) },
    },
    {
      eventId: "evt-11",
      runId: baseRun.runId,
      correlationId: baseRun.correlationId,
      sequence: 11,
      occurredAt: "2024-01-15T10:30:40.000Z",
      phase: "policy",
      type: "ALLOCATION_PLAN_CREATED",
      status: "succeeded",
      actor: "system",
      payload: { allocationPlanId: "ap-1", totalDeployedCents: nc(10000), lines: 2 },
    },
    {
      eventId: "evt-12",
      runId: baseRun.runId,
      correlationId: baseRun.correlationId,
      sequence: 12,
      occurredAt: "2024-01-15T10:30:45.000Z",
      phase: "policy",
      type: "EXECUTION_POLICY_EVALUATED",
      status: "succeeded",
      actor: "system",
      payload: { disposition: "shadow", executeCount: 0 },
    },
    {
      eventId: "evt-13",
      runId: baseRun.runId,
      correlationId: baseRun.correlationId,
      sequence: 13,
      occurredAt: "2024-01-15T10:30:50.000Z",
      phase: "execution",
      type: "SHADOW_DECISION_RECORDED",
      status: "succeeded",
      actor: "system",
      payload: { decisionId: "sd-1", disposition: "shadow", deployableCents: nc(10000) },
    },
    {
      eventId: "evt-14",
      runId: baseRun.runId,
      correlationId: baseRun.correlationId,
      sequence: 14,
      occurredAt: "2024-01-15T10:30:55.000Z",
      phase: "execution",
      type: "EXECUTION_BLOCKED",
      status: "succeeded",
      actor: "system",
      payload: { reason: "Shadow mode — no execution", executeCount: 0, transferCount: 0, orderCount: 0, providerMutationCount: 0 },
    },
    {
      eventId: "evt-15",
      runId: baseRun.runId,
      correlationId: baseRun.correlationId,
      sequence: 15,
      occurredAt: "2024-01-15T10:31:00.000Z",
      phase: "reporting",
      type: "CERT_RUN_COMPLETED",
      status: "succeeded",
      actor: "system",
      payload: { result: "PASS", evidenceBoundary: baseRun.evidenceBoundary },
    },
  ];

  const baseProviderCalls: ProviderCallEvidence[] = [
    {
      evidenceId: "prov-1",
      runId: baseRun.runId,
      correlationId: baseRun.correlationId,
      occurredAt: "2024-01-15T10:30:10.000Z",
      operation: "transactions/sync",
      httpStatus: 200,
      latencyMs: 450,
    },
  ];

  return {
    schemaVersion: "audit-cert@1",
    run: { ...baseRun, ...overrides.run },
    events: overrides.events ?? baseEvents,
    providerCalls: overrides.providerCalls ?? baseProviderCalls,
  };
}

// ─── Sentinel strings (must never appear in sanitized output) ───

const SENTINELS = {
  accessToken: "access-sandbox-1234567890abcdef",
  plaidSecret: "plaid-secret-production-abcdefghijklmnop",
  pgUrl: "postgres://alepes:CorrectHorseBatteryStaple!@db.internal:5432/alepes?sslmode=require",
  creditCard: "4242 4242 4242 4242",
  accountId: "ACCT-1234567890",
  secretKey: "sk_live_abcdefghijklmnop1234567890",
  itemId: "ins_1234567890abcdef",
} as const;

function containsSentinel(text: string): string | null {
  for (const [name, value] of Object.entries(SENTINELS)) {
    if (text.includes(value)) return name;
  }
  return null;
}

// ─── Adversarial Sentinel Tests ───

describe("sanitizeReport — allowlist-based sanitizer (adversarial sentinel tests)", () => {
  it("never leaks sentinels planted in event payloads (nested objects)", () => {
    const baseReport = buildBaseReport();

    // Build malicious event from scratch — plain object with all required fields
    // Deliberate cast: test intentionally injects out-of-contract data to prove sanitizer defense
    const maliciousEvent = {
      eventId: "evt-99",
      runId: "run-1",
      correlationId: "corr-1",
      sequence: 99,
      occurredAt: "2024-01-15T10:32:00.000Z",
      phase: "observation" as const,
      type: "OBSERVATION_RECEIVED" as const,
      status: "succeeded" as const,
      actor: "system" as const,
      payload: {
        observationId: "obs-99",
        externalRefFingerprint: "fp-x",
        direction: "credit" as const,
        amountCents: c(100),
        posted: true,
      },
    } as unknown as AuditEvent;

    // Adversarial injection — runtime-only extra props (simulating hostile persisted JSONB)
    Object.assign(maliciousEvent.payload, {
      accessToken: SENTINELS.accessToken,
      plaidSecret: SENTINELS.plaidSecret,
      pgUrl: SENTINELS.pgUrl,
      creditCard: SENTINELS.creditCard,
      accountId: SENTINELS.accountId,
      secretKey: SENTINELS.secretKey,
      itemId: SENTINELS.itemId,
    });

    // Prove sentinel injection worked before sanitization
    const rawJson = JSON.stringify({ ...baseReport, events: [...baseReport.events, maliciousEvent] });
    expect(containsSentinel(rawJson)).not.toBeNull();

    const report = buildBaseReport({
      events: [...baseReport.events, maliciousEvent],
    });

    const sanitized = sanitizeReport(report);
    const json = JSON.stringify(sanitized);

    expect(containsSentinel(json)).toBeNull();
    // Allowlisted fields still present
    expect(json).toContain("runId");
    expect(json).toContain("correlationId");
    expect(json).toContain("milestone");
    expect(json).toContain("provider");
    expect(json).toContain("evidenceBoundary");
    // No events, no providerCalls in sanitized
    expect(json).not.toContain("events");
    expect(json).not.toContain("providerCalls");
    expect(json).not.toContain("observationId");
    expect(json).not.toContain("accessToken");
  });

  it("never leaks sentinels planted in providerCalls evidence", () => {
    const baseReport = buildBaseReport();
    const maliciousCall: ProviderCallEvidence = {
      evidenceId: "prov-99",
      runId: "run-1",
      correlationId: "corr-1",
      occurredAt: "2024-01-15T10:32:00.000Z",
      operation: "accounts/get",
      httpStatus: 200,
      latencyMs: 100,
      // Sentinels in non-allowlisted providerCallEvidence fields
      plaidErrorType: SENTINELS.accessToken,
      plaidErrorCode: SENTINELS.secretKey,
      plaidRequestId: SENTINELS.itemId,
    };

    // Prove sentinel injection worked
    const rawJson = JSON.stringify({ ...baseReport, providerCalls: [...baseReport.providerCalls, maliciousCall] });
    expect(containsSentinel(rawJson)).not.toBeNull();

    const report = buildBaseReport({
      providerCalls: [...baseReport.providerCalls, maliciousCall],
    });

    const sanitized = sanitizeReport(report);
    const json = JSON.stringify(sanitized);
    expect(containsSentinel(json)).toBeNull();
    // providerCalls not in sanitized at all
    expect(json).not.toContain("providerCalls");
    expect(json).not.toContain("evidenceId");
  });

  it("never leaks sentinels planted in non-allowlisted run fields (deep nested)", () => {
    const baseReport = buildBaseReport();
    const report = buildBaseReport({
      run: {
        ...baseReport.run,
        // Sentinels in fields that exist on CertificationRun but NOT on SanitizedRun
        // (there are none — but test that extra properties on the run object are dropped)
        // We simulate by putting them in gates.detail which is explicitly excluded
        gates: [
          ...baseReport.run.gates,
          { gate: "extra", status: "SKIPPED", detail: { accessToken: SENTINELS.accessToken, secretKey: SENTINELS.secretKey } },
        ],
      },
    });

    // Prove sentinel injection worked
    const rawJson = JSON.stringify(report);
    expect(containsSentinel(rawJson)).not.toBeNull();

    const sanitized = sanitizeReport(report);
    const json = JSON.stringify(sanitized);
    expect(containsSentinel(json)).toBeNull();
    // detail is intentionally excluded from sanitized gate
    expect(json).not.toContain("detail");
  });

  it("renders Markdown from sanitized data only (no sentinel leakage)", () => {
    const baseReport = buildBaseReport();
    const report = buildBaseReport({
      events: baseReport.events.map(e =>
        e.type === "OBSERVATION_RECEIVED"
          ? { ...e, payload: { ...e.payload, accessToken: SENTINELS.accessToken, creditCard: SENTINELS.creditCard } }
          : e
      ),
    });

    const markdown = renderMarkdownReport(report);
    expect(containsSentinel(markdown)).toBeNull();
    expect(markdown).toContain("# Certification Report");
    expect(markdown).toContain("v0.5.0");
    expect(markdown).toContain("plaid/production");
    expect(markdown).toContain("**Result:** PASS");
    expect(markdown).toContain("Provider Observation: **real**");
    expect(markdown).toContain("Provider Mutation: **NO**");
  });

  it("renders console summary from sanitized data only (no sentinel leakage)", () => {
    const baseReport = buildBaseReport();
    const report = buildBaseReport({
      events: baseReport.events.map(e =>
        e.type === "OBSERVATION_RECEIVED"
          ? { ...e, payload: { ...e.payload, accessToken: SENTINELS.accessToken, creditCard: SENTINELS.creditCard } }
          : e
      ),
    });

    const consoleOutput = renderConsoleSummary(report);
    expect(containsSentinel(consoleOutput)).toBeNull();
    expect(consoleOutput).toContain("PASS");
    expect(consoleOutput).toContain("v0.5.0");
    expect(consoleOutput).toContain("plaid/production");
    expect(consoleOutput).toContain("obs=real");
    expect(consoleOutput).toContain("mutation=false");
  });

  it("sanitizer is field-by-field allowlist (not copy-then-delete)", () => {
    // The sanitized report contains ONLY the fields explicitly listed in sanitizeReport
    const report = buildBaseReport();
    const sanitized = sanitizeReport(report);

    // Verify the sanitized run object has exactly the expected top-level keys
    const runKeys = Object.keys(sanitized.run).sort();
    const expectedKeys = [
      "completedAt",
      "correlationId",
      "environment",
      "evidenceBoundary",
      "failureCode",
      "finalState",
      "gates",
      "harness",
      "harnessVersion",
      "milestone",
      "mutationCounts",
      "provider",
      "result",
      "runId",
      "schemaVersion",
      "sourceCommit",
      "startedAt",
    ];
    expect(runKeys).toEqual(expectedKeys);

    // Sanitized gates have no 'detail'
    for (const gate of sanitized.run.gates) {
      expect("detail" in gate).toBe(false);
      const gateKeys = Object.keys(gate).sort();
      expect(gateKeys).toEqual(["failureCode", "gate", "status"]); // failureCode may be undefined but key exists
    }

    // mutationCounts has exactly three keys
    expect(Object.keys(sanitized.run.mutationCounts).sort()).toEqual(["order", "providerMutation", "transfer"]);
  });
});

// ─── Gate Status Distinction Tests ───

describe("GateResult status preserves PASS/FAIL/SKIPPED/UNSUPPORTED distinctly through sanitizer", () => {
  const statuses: Array<GateResult["status"]> = ["PASS", "FAIL", "SKIPPED", "UNSUPPORTED"];

  for (const status of statuses) {
    it(`preserves ${status} gate status in sanitized report`, () => {
      const baseReport = buildBaseReport();
      const report = buildBaseReport({
        run: {
          ...baseReport.run,
          gates: [{ gate: "test-gate", status }],
        },
      });

      const sanitized = sanitizeReport(report);
      expect(sanitized.run.gates[0].status).toBe(status);
      expect(sanitized.run.gates[0].gate).toBe("test-gate");
    });
  }

  it("FAIL gates carry failureCode through sanitizer", () => {
    const baseReport = buildBaseReport();
    const report = buildBaseReport({
      run: {
        ...baseReport.run,
        gates: [
          { gate: "qualifying_event", status: "FAIL", failureCode: "sync.no_qualifying_event" },
        ],
        result: "FAIL",
        failureCode: "sync.no_qualifying_event",
      },
    });

    const sanitized = sanitizeReport(report);
    expect(sanitized.run.gates[0].failureCode).toBe("sync.no_qualifying_event");
    expect(sanitized.run.failureCode).toBe("sync.no_qualifying_event");
    expect(sanitized.run.result).toBe("FAIL");
  });

  it("SKIPPED gates carry reason through original but NOT through sanitizer (detail excluded)", () => {
    const baseReport = buildBaseReport();
    const report = buildBaseReport({
      run: {
        ...baseReport.run,
        gates: [
          { gate: "optional_gate", status: "SKIPPED", detail: { reason: "not applicable in this environment" } },
        ],
      },
    });

    const sanitized = sanitizeReport(report);
    expect(sanitized.run.gates[0].status).toBe("SKIPPED");
    // detail is excluded from sanitized gate
    expect("detail" in sanitized.run.gates[0]).toBe(false);
  });
});

// ─── Reconstruction Narrative Tests ───

describe("reconstructRun — reconstruction from persisted evidence", () => {
  it("missing PLAID_ACCESS_TOKEN run reconstructs as PREFLIGHT_FAILED with providerCallAttempted=false", () => {
    const run: CertificationRun = {
      runId: "run-token-missing",
      correlationId: "corr-token-missing",
      milestone: "v0.5.0",
      provider: "plaid",
      environment: "production",
      sourceCommit: "abc123",
      harness: "certify-live.ts",
      harnessVersion: "audit-cert@1",
      schemaVersion: "audit-cert@1",
      startedAt: "2024-01-15T10:30:00.000Z",
      completedAt: "2024-01-15T10:30:05.000Z",
      result: "FAIL",
      failureCode: "configuration.missing_secret",
      evidenceBoundary: {
        providerObservation: "none",
        cashEvent: "none",
        decision: "none",
        execution: "none",
        providerMutation: false,
      },
      gates: [
        { gate: "preflight", status: "FAIL", failureCode: "configuration.missing_secret" },
      ],
      mutationCounts: { transfer: 0, order: 0, providerMutation: 0 },
      finalState: "clean",
    };

    const events: AuditEvent[] = [
      {
        eventId: "evt-1",
        runId: run.runId,
        correlationId: run.correlationId,
        sequence: 1,
        occurredAt: "2024-01-15T10:30:00.000Z",
        phase: "preflight",
        type: "CERT_RUN_STARTED",
        status: "succeeded",
        actor: "system",
        payload: { harness: "certify-live.ts", schemaVersion: "audit-cert@1" },
      },
      {
        eventId: "evt-2",
        runId: run.runId,
        correlationId: run.correlationId,
        sequence: 2,
        occurredAt: "2024-01-15T10:30:01.000Z",
        phase: "preflight",
        type: "PREFLIGHT_FAILED",
        status: "succeeded",
        actor: "system",
        payload: { failureCode: "configuration.missing_secret", field: "PLAID_ACCESS_TOKEN", providerCallAttempted: false },
      },
      {
        eventId: "evt-3",
        runId: run.runId,
        correlationId: run.correlationId,
        sequence: 3,
        occurredAt: "2024-01-15T10:30:05.000Z",
        phase: "reporting",
        type: "CERT_RUN_COMPLETED",
        status: "succeeded",
        actor: "system",
        payload: { result: "FAIL", evidenceBoundary: run.evidenceBoundary },
      },
    ];

    const reconstructed = reconstructRun(run, events, []);

    expect(reconstructed.evidenceKind).toBe("none");
    expect(reconstructed.provider).toBe("plaid");
    expect(reconstructed.environment).toBe("production");
    expect(reconstructed.normalized).toBe(false);
    expect(reconstructed.persisted).toBe(false);
    expect(reconstructed.qualified).toBe(false);
    expect(reconstructed.rejectionReason).toBeUndefined();
    expect(reconstructed.ruleVersion).toBe("unknown");
    expect(reconstructed.capitalPlan).toBeNull();
    expect(reconstructed.allocationPlan).toBeNull();
    expect(reconstructed.executionPolicy).toBeNull();
    expect(reconstructed.shadowOnly).toBe(false);
    expect(reconstructed.providerMutationAttempted).toBe(false);
    expect(reconstructed.failedGate).toBe("preflight");
    expect(reconstructed.safeProviderError).toEqual({
      httpStatus: undefined,
      plaidErrorType: undefined,
      plaidErrorCode: undefined,
      plaidRequestId: undefined,
    });
    expect(reconstructed.sourceCommit).toBe("abc123");
    expect(reconstructed.harnessVersion).toBe("audit-cert@1");
    expect(reconstructed.schemaVersion).toBe("audit-cert@1");
    expect(reconstructed.finishedCleanly).toBe(true); // completed event exists, no reconciliation failure, finalState clean
    expect(reconstructed.whatObserved).toBe("No observations received");
  });

  it("provider 400 run reconstructs with safe structured Plaid fields and correct failureCode", () => {
    const run: CertificationRun = {
      runId: "run-provider-400",
      correlationId: "corr-provider-400",
      milestone: "v0.5.0",
      provider: "plaid",
      environment: "production",
      sourceCommit: "def456",
      harness: "certify-live.ts",
      harnessVersion: "audit-cert@1",
      schemaVersion: "audit-cert@1",
      startedAt: "2024-01-15T10:30:00.000Z",
      completedAt: "2024-01-15T10:30:30.000Z",
      result: "FAIL",
      failureCode: "provider.invalid_request",
      evidenceBoundary: {
        providerObservation: "real",
        cashEvent: "none",
        decision: "none",
        execution: "none",
        providerMutation: false,
      },
      gates: [
        { gate: "preflight", status: "PASS" },
        { gate: "provider_sync", status: "FAIL", failureCode: "provider.invalid_request" },
      ],
      mutationCounts: { transfer: 0, order: 0, providerMutation: 0 },
      finalState: "clean",
    };

    const events: AuditEvent[] = [
      {
        eventId: "evt-1",
        runId: run.runId,
        correlationId: run.correlationId,
        sequence: 1,
        occurredAt: "2024-01-15T10:30:00.000Z",
        phase: "preflight",
        type: "CERT_RUN_STARTED",
        status: "succeeded",
        actor: "system",
        payload: { harness: "certify-live.ts", schemaVersion: "audit-cert@1" },
      },
      {
        eventId: "evt-2",
        runId: run.runId,
        correlationId: run.correlationId,
        sequence: 2,
        occurredAt: "2024-01-15T10:30:01.000Z",
        phase: "preflight",
        type: "PREFLIGHT_PASSED",
        status: "succeeded",
        actor: "system",
        payload: { secretsPresent: ["PLAID_CLIENT_ID", "PLAID_SECRET", "PLAID_LIVE_POSTGRES_URL", "PLAID_ACCESS_TOKEN"] },
      },
      {
        eventId: "evt-3",
        runId: run.runId,
        correlationId: run.correlationId,
        sequence: 3,
        occurredAt: "2024-01-15T10:30:10.000Z",
        phase: "provider",
        type: "PROVIDER_REQUEST_STARTED",
        status: "succeeded",
        actor: "provider",
        provider: "plaid",
        attempt: 1,
        payload: { operation: "transactions/sync", accountIdFingerprint: "fp-abc" },
      },
      {
        eventId: "evt-4",
        runId: run.runId,
        correlationId: run.correlationId,
        sequence: 4,
        occurredAt: "2024-01-15T10:30:12.000Z",
        phase: "provider",
        type: "PROVIDER_REQUEST_FAILED",
        status: "succeeded",
        actor: "provider",
        provider: "plaid",
        attempt: 1,
        payload: {
          failureCode: "provider.invalid_request",
          httpStatus: 400,
          plaidErrorType: "INVALID_INPUT",
          plaidErrorCode: "INVALID_FIELD",
          plaidRequestId: "req-plaid-123",
        },
      },
      {
        eventId: "evt-5",
        runId: run.runId,
        correlationId: run.correlationId,
        sequence: 5,
        occurredAt: "2024-01-15T10:30:30.000Z",
        phase: "reporting",
        type: "CERT_RUN_COMPLETED",
        status: "succeeded",
        actor: "system",
        payload: { result: "FAIL", evidenceBoundary: run.evidenceBoundary },
      },
    ];

    const providerCalls: ProviderCallEvidence[] = [
      {
        evidenceId: "prov-1",
        runId: run.runId,
        correlationId: run.correlationId,
        occurredAt: "2024-01-15T10:30:10.000Z",
        operation: "transactions/sync",
        httpStatus: 400,
        latencyMs: 450,
        plaidErrorType: "INVALID_INPUT",
        plaidErrorCode: "INVALID_FIELD",
        plaidRequestId: "req-plaid-123",
        failureCode: "provider.invalid_request",
      },
    ];

    const reconstructed = reconstructRun(run, events, providerCalls);

    expect(reconstructed.evidenceKind).toBe("real");
    expect(reconstructed.provider).toBe("plaid");
    expect(reconstructed.environment).toBe("production");
    expect(reconstructed.normalized).toBe(false);
    expect(reconstructed.persisted).toBe(false);
    expect(reconstructed.qualified).toBe(false);
    expect(reconstructed.failedGate).toBe("provider_sync");
    expect(reconstructed.safeProviderError).toEqual({
      httpStatus: 400,
      plaidErrorType: "INVALID_INPUT",
      plaidErrorCode: "INVALID_FIELD",
      plaidRequestId: "req-plaid-123",
    });
    expect(reconstructed.finishedCleanly).toBe(true);
  });

  it("full PASS + Shadow run reconstructs with shadowOnly=true, providerMutationAttempted=false, finishedCleanly=true", () => {
    const report = buildBaseReport();
    const run = report.run;
    const events = report.events;
    const providerCalls = report.providerCalls;

    const reconstructed = reconstructRun(run, events, providerCalls);

    expect(reconstructed.evidenceKind).toBe("real");
    expect(reconstructed.provider).toBe("plaid");
    expect(reconstructed.environment).toBe("production");
    expect(reconstructed.normalized).toBe(true);
    expect(reconstructed.persisted).toBe(true);
    expect(reconstructed.qualified).toBe(true);
    expect(reconstructed.ruleVersion).toBe("rule-monthly-deposit");
    expect(reconstructed.capitalPlan).toEqual({ deployableCents: 10000 });
    expect(reconstructed.allocationPlan).toEqual({ totalDeployedCents: 10000, lines: 2 });
    expect(reconstructed.executionPolicy).toEqual({ disposition: "shadow", executeCount: 0 });
    expect(reconstructed.shadowOnly).toBe(true);
    expect(reconstructed.providerMutationAttempted).toBe(false);
    expect(reconstructed.failedGate).toBeUndefined();
    expect(reconstructed.finishedCleanly).toBe(true);
    expect(reconstructed.whatObserved).toContain("Observed credit of 10000 cents (posted)");
  });

  it("reconciliation-failed run reconstructs finishedCleanly=false", () => {
    const report = buildBaseReport({
      run: {
        ...buildBaseReport().run,
        finalState: "dirty",
      },
      events: [
        ...buildBaseReport().events,
        {
          eventId: "evt-recon-fail",
          runId: "run-1",
          correlationId: "corr-1",
          sequence: 99,
          occurredAt: "2024-01-15T10:32:00.000Z",
          phase: "reconciliation",
          type: "RECONCILIATION_FAILED",
          status: "succeeded",
          actor: "system",
          payload: { cycleId: "cycle-1", failureCode: "persistence.unavailable" },
        },
      ],
    });

    const reconstructed = reconstructRun(report.run, report.events, report.providerCalls);

    expect(reconstructed.finishedCleanly).toBe(false);
  });

  it("uses firstOfType (any-status) for CERT_GATE_FAILED and PROVIDER_REQUEST_FAILED", () => {
    // Events with status "failed" for failure types are recorded as "succeeded" in practice
    // (the recording succeeded). But test that firstOfType ignores status.
    const baseReport = buildBaseReport();
    const run: CertificationRun = {
      ...baseReport.run,
      runId: "run-gate-failed",
      gates: [
        { gate: "preflight", status: "PASS" },
        { gate: "qualifying_event", status: "FAIL", failureCode: "sync.no_qualifying_event" },
      ],
      result: "FAIL",
      failureCode: "sync.no_qualifying_event",
    };

    const events: AuditEvent[] = [
      {
        eventId: "evt-1",
        runId: run.runId,
        correlationId: run.correlationId,
        sequence: 1,
        occurredAt: "2024-01-15T10:30:00.000Z",
        phase: "preflight",
        type: "CERT_RUN_STARTED",
        status: "succeeded",
        actor: "system",
        payload: { harness: "certify-live.ts", schemaVersion: "audit-cert@1" },
      },
      // Gate FAILED event — status is "succeeded" because recording succeeded, but payload carries failure
      {
        eventId: "evt-2",
        runId: run.runId,
        correlationId: run.correlationId,
        sequence: 2,
        occurredAt: "2024-01-15T10:30:10.000Z",
        phase: "qualification",
        type: "CERT_GATE_FAILED",
        status: "succeeded",
        actor: "system",
        payload: { gate: "qualifying_event", failureCode: "sync.no_qualifying_event" },
      },
      {
        eventId: "evt-3",
        runId: run.runId,
        correlationId: run.correlationId,
        sequence: 3,
        occurredAt: "2024-01-15T10:30:15.000Z",
        phase: "reporting",
        type: "CERT_RUN_COMPLETED",
        status: "succeeded",
        actor: "system",
        payload: { result: "FAIL", evidenceBoundary: run.evidenceBoundary },
      },
    ];

    const reconstructed = reconstructRun(run, events, []);

    expect(reconstructed.failedGate).toBe("qualifying_event");
  });
});

// ─── Round-trip: raw → sanitized → renderers consistent ───

describe("raw → sanitized → renderers are consistent (no leakage path)", () => {
  it("markdown and console derived from sanitized report (not raw)", () => {
    const baseReport = buildBaseReport();
    const report = buildBaseReport({
      events: baseReport.events.map(e =>
        e.type === "OBSERVATION_RECEIVED"
          ? { ...e, payload: { ...e.payload, accessToken: SENTINELS.accessToken } }
          : e
      ),
    });

    const markdown = renderMarkdownReport(report);
    const consoleOutput = renderConsoleSummary(report);

    // Both derived from sanitizeReport internally — must be clean
    expect(containsSentinel(markdown)).toBeNull();
    expect(containsSentinel(consoleOutput)).toBeNull();

    // Both contain the same run identity
    expect(markdown).toContain(report.run.runId);
    expect(consoleOutput).toContain(report.run.runId);
  });
});

// ─── EvidenceBoundary "none" variant reconstruction ───

describe("reconstructRun handles EvidenceBoundary.none correctly", () => {
  it("reconstructs 'none' evidenceKind when boundary says none", () => {
    const baseReport = buildBaseReport();
    const run: CertificationRun = {
      ...baseReport.run,
      evidenceBoundary: {
        providerObservation: "none",
        cashEvent: "none",
        decision: "none",
        execution: "none",
        providerMutation: false,
      },
      gates: [{ gate: "preflight", status: "PASS" }],
      result: "FAIL",
      failureCode: "sync.no_qualifying_event",
    };

    const events: AuditEvent[] = [
      {
        eventId: "evt-1",
        runId: run.runId,
        correlationId: run.correlationId,
        sequence: 1,
        occurredAt: "2024-01-15T10:30:00.000Z",
        phase: "preflight",
        type: "CERT_RUN_STARTED",
        status: "succeeded",
        actor: "system",
        payload: { harness: "certify-live.ts", schemaVersion: "audit-cert@1" },
      },
      {
        eventId: "evt-2",
        runId: run.runId,
        correlationId: run.correlationId,
        sequence: 2,
        occurredAt: "2024-01-15T10:30:10.000Z",
        phase: "qualification",
        type: "CERT_GATE_FAILED",
        status: "succeeded",
        actor: "system",
        payload: { gate: "qualifying_event", failureCode: "sync.no_qualifying_event" },
      },
      {
        eventId: "evt-3",
        runId: run.runId,
        correlationId: run.correlationId,
        sequence: 3,
        occurredAt: "2024-01-15T10:30:15.000Z",
        phase: "reporting",
        type: "CERT_RUN_COMPLETED",
        status: "succeeded",
        actor: "system",
        payload: { result: "FAIL", evidenceBoundary: run.evidenceBoundary },
      },
    ];

    const reconstructed = reconstructRun(run, events, []);

    expect(reconstructed.evidenceKind).toBe("none");
    expect(reconstructed.qualified).toBe(false);
  });
});

// ─── F4 regression (PR #6): Shadow-only reconstruction from real producer semantics ───
//
// Finding 4 (review of packages/reporting/src/index.ts:255-257 at the pinned
// head b4f1a421): reconstructRun() required a SUCCEEDED EXECUTION_BLOCKED
// event, but the actual producer recordExecutionBlocked() emits status
// "failed" — the block IS the outcome, and its zero-order payload is the
// authoritative evidence. A correctly blocked Shadow run was therefore
// misreconstructed as shadowOnly=false.
//
// These tests do not hand-build events. They drive the ACTUAL audit-store
// helpers (packages/integrations/plaid-financial-data/src/certify-live-audit.ts
// — the same helpers certify-live.ts uses) against an in-memory AuditPorts
// fake that mirrors the real Postgres adapter's emission contract:
//   - createRun only stores the run row (CERT_RUN_STARTED is emitted solely by
//     startRun()'s append, exactly like createAuditPostgresStore);
//   - completeRun stores the outcome and emits CERT_RUN_COMPLETED with status
//     "succeeded" (PASS) / "failed" otherwise, inside the same call.
// Reconstruction input is then read back through the store's own read paths
// (events.listByRun / providerCalls.listByRun), never from test-local state.

describe("reconstructRun — F4: Shadow-only runs reconstructed from real producer event semantics", () => {
  type FakeProviderCallRow = Awaited<ReturnType<AuditPorts["providerCalls"]["listByRun"]>>[number];

  // ─── In-memory AuditPorts fake (real adapter parity) ───

  function createFakeAuditPorts(): AuditPorts & {
    _events: AuditEvent[];
    _runs: Map<string, PersistedCertificationRun>;
  } {
    const runs = new Map<string, PersistedCertificationRun>();
    const events: AuditEvent[] = [];
    const providerCalls: FakeProviderCallRow[] = [];

    return {
      runs: {
        // Real adapter parity: createRun only INSERTs the run row. It does NOT
        // emit CERT_RUN_STARTED — startRun()'s explicit append is the sole
        // producer of that event (see audit-postgres.ts + certify-live-audit.ts).
        async createRun(input: CreateCertificationRunInput): Promise<void> {
          const run: PersistedCertificationRun = {
            runId: input.runId,
            correlationId: input.correlationId,
            milestone: input.milestone,
            provider: input.provider,
            environment: input.environment,
            sourceCommit: input.sourceCommit,
            branch: input.branch ?? null,
            harness: input.harness,
            harnessVersion: input.harnessVersion,
            schemaVersion: input.schemaVersion,
            startedAt: input.startedAt,
            completedAt: null,
            result: null,
            failureCode: null,
            evidenceBoundary: {
              providerObservation: "none",
              cashEvent: "none",
              decision: "none",
              execution: "none",
              providerMutation: false,
            },
            gates: [],
            mutationCounts: { transfer: 0, order: 0, providerMutation: 0 },
            finalState: "clean",
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
          };
          runs.set(input.runId, run);
        },
        // Real adapter parity: completeRun updates the run and emits
        // CERT_RUN_COMPLETED (status "succeeded" for PASS, else "failed") in
        // the same call (see audit-postgres.ts completeRun).
        async completeRun(input: CompleteCertificationRunInput): Promise<void> {
          const run = runs.get(input.runId);
          if (!run) throw new Error(`Run ${input.runId} not found`);
          run.completedAt = input.completedAt;
          run.result = input.result;
          run.failureCode = input.failureCode ?? null;
          run.evidenceBoundary = input.evidenceBoundary;
          run.gates = input.gates;
          run.mutationCounts = input.mutationCounts;
          run.finalState = input.finalState;
          run.updatedAt = new Date().toISOString();
          events.push({
            eventId: ulid(),
            runId: input.runId,
            correlationId: run.correlationId,
            causationId: undefined,
            sequence: events.length + 1,
            occurredAt: input.completedAt,
            phase: "reporting",
            type: "CERT_RUN_COMPLETED",
            status: input.result === "PASS" ? "succeeded" : "failed",
            actor: "system",
            provider: undefined,
            attempt: undefined,
            mutated: undefined,
            verified: undefined,
            payload: { result: input.result, evidenceBoundary: input.evidenceBoundary },
          } as AuditEvent);
        },
        async loadRun(): Promise<PersistedCertificationRun | null> {
          return null;
        },
        async loadRunByCorrelationId(): Promise<PersistedCertificationRun | null> {
          return null;
        },
      },
      events: {
        async append(event: AuditEvent): Promise<void> {
          events.push(event);
        },
        async listByRun(runId: string): Promise<AuditEvent[]> {
          return events.filter(e => e.runId === runId);
        },
        async listByCorrelationId(correlationId: string): Promise<AuditEvent[]> {
          return events.filter(e => e.correlationId === correlationId);
        },
      },
      providerCalls: {
        async record(input: Parameters<AuditPorts["providerCalls"]["record"]>[0]): Promise<void> {
          providerCalls.push({
            evidenceId: input.evidenceId,
            runId: input.runId,
            correlationId: input.correlationId,
            occurredAt: input.occurredAt,
            operation: input.operation,
            httpStatus: input.httpStatus ?? null,
            plaidErrorType: input.plaidErrorType ?? null,
            plaidErrorCode: input.plaidErrorCode ?? null,
            plaidRequestId: input.plaidRequestId ?? null,
            failureCode: input.failureCode ?? null,
          });
        },
        async listByRun(runId: string): Promise<FakeProviderCallRow[]> {
          return providerCalls.filter(p => p.runId === runId);
        },
      },
      close: async () => {},
      _events: events,
      _runs: runs,
    };
  }

  /** Normalize the fake store's persisted rows to the reconstruction input type. */
  function toProviderCallEvidence(rows: FakeProviderCallRow[]): ProviderCallEvidence[] {
    return rows.map(row => ({
      evidenceId: row.evidenceId,
      runId: row.runId,
      correlationId: row.correlationId,
      occurredAt: row.occurredAt,
      operation: row.operation,
      httpStatus: row.httpStatus ?? undefined,
      plaidErrorType: row.plaidErrorType ?? undefined,
      plaidErrorCode: row.plaidErrorCode ?? undefined,
      plaidRequestId: row.plaidRequestId ?? undefined,
      failureCode: row.failureCode ?? undefined,
    }));
  }

  function synthConfig(ports: AuditPorts): CertifyLiveAuditConfig {
    return {
      ports,
      provider: "plaid",
      environment: "production",
      sourceCommit: "b4f1a421",
      harness: "certify-live.ts",
      harnessVersion: "audit-cert@1",
      schemaVersion: "audit-cert@1",
      milestone: "v0.5.0",
    };
  }

  const BLOCK_REASON =
    "disposition=shadow — Shadow Mode blocks execution by design (zero-order guarantee)";

  const SYNTHETIC_GATES: GateResult[] = [
    { gate: "preflight", status: "PASS" },
    { gate: "qualifying_event", status: "PASS" },
    { gate: "shadow_execution", status: "PASS" },
  ];

  const SYNTHETIC_SHADOW_BOUNDARY: EvidenceBoundary = {
    providerObservation: "real",
    cashEvent: "real",
    decision: "real",
    execution: "shadow",
    providerMutation: false,
  };

  /**
   * Drive the ACTUAL audit-store helpers through a complete synthetic Shadow
   * certification run — the same helper sequence a real certify-live.ts Shadow
   * run emits (read-only provider sync → qualification → policy pipeline →
   * shadow decision → execution blocked → gates → completion).
   */
  async function driveSyntheticShadowRun(
    ports: AuditPorts,
    opts: { policy?: { disposition: "shadow" | "approval" | "execute"; executeCount: number } } = {}
  ): Promise<RunContext> {
    const ctx = await startRun(synthConfig(ports));
    await recordPreflight(ports, ctx, { passed: true, secretsPresent: ["PLAID_CLIENT_ID", "PLAID_SECRET"] });
    await recordProviderRequest(ports, ctx, "transactions/sync", "started");
    await recordProviderRequest(ports, ctx, "transactions/sync", "succeeded", { latencyMs: 120 });
    await recordObservationReceived(ports, ctx, "obs-synth-1", "ext-fp-synth-1", "credit", c(10000), true);
    await recordObservationNormalized(ports, ctx, "obs-synth-1", "normalize@1");
    await recordObservationPersisted(ports, ctx, "obs-synth-1", "persist-synth-1");
    await recordCashEventQualified(ports, ctx, "cash-synth-1", c(10000), "rule-monthly-deposit");
    await recordRuleEvaluated(ports, ctx, "rule-monthly-deposit", "cash-synth-1", c(10000));
    await recordCapitalPlanCreated(ports, ctx, "cap-synth-1", nc(10000));
    await recordAllocationPlanCreated(ports, ctx, "alloc-synth-1", nc(10000), 2);
    const policy = opts.policy ?? { disposition: "shadow" as const, executeCount: 0 };
    await recordExecutionPolicyEvaluated(ports, ctx, policy.disposition, policy.executeCount);
    await recordShadowDecisionRecorded(ports, ctx, "shadow-decision-synth-1", nc(10000));
    await recordExecutionBlocked(ports, ctx, BLOCK_REASON);
    await recordGate(ports, ctx, "preflight", "PASS");
    await recordGate(ports, ctx, "qualifying_event", "PASS");
    await recordGate(ports, ctx, "shadow_execution", "PASS");
    await completeRun(
      ports,
      ctx,
      "PASS",
      undefined,
      SYNTHETIC_SHADOW_BOUNDARY,
      SYNTHETIC_GATES,
      { transfer: 0, order: 0, providerMutation: 0 },
      "clean"
    );
    return ctx;
  }

  /** Adapt the fake store's persisted run row to the reconstruction input type. */
  function toReconstructionRunInput(stored: PersistedCertificationRun): CertificationRun {
    return {
      runId: stored.runId,
      correlationId: stored.correlationId,
      milestone: stored.milestone,
      provider: stored.provider,
      environment: stored.environment,
      sourceCommit: stored.sourceCommit,
      branch: stored.branch ?? undefined,
      harness: stored.harness,
      harnessVersion: stored.harnessVersion,
      schemaVersion: stored.schemaVersion,
      startedAt: stored.startedAt,
      completedAt: stored.completedAt ?? undefined,
      result: stored.result ?? "FAIL",
      failureCode: stored.failureCode ?? undefined,
      evidenceBoundary: stored.evidenceBoundary,
      gates: stored.gates,
      mutationCounts: stored.mutationCounts,
      finalState: stored.finalState,
    };
  }

  /** Reconstruct strictly from the fake store's persisted read paths. */
  async function reconstructFromStore(
    ports: AuditPorts & { _runs: Map<string, PersistedCertificationRun> },
    ctx: RunContext
  ) {
    const stored = ports._runs.get(ctx.runId);
    if (!stored) throw new Error(`synthetic run ${ctx.runId} not found in fake store`);
    const history = await ports.events.listByRun(ctx.runId);
    const providerCalls = toProviderCallEvidence(await ports.providerCalls.listByRun(ctx.runId));
    return reconstructRun(toReconstructionRunInput(stored), history, providerCalls);
  }

  function findEvent<T extends AuditEvent["type"]>(
    history: AuditEvent[],
    type: T
  ): Extract<AuditEvent, { type: T }> | undefined {
    return history.find((e): e is Extract<AuditEvent, { type: T }> => e.type === type);
  }

  it("1. generates the synthetic run's events with the actual audit-store helpers (real producer vocabulary)", async () => {
    const ports = createFakeAuditPorts();
    const ctx = await driveSyntheticShadowRun(ports);
    const history = await ports.events.listByRun(ctx.runId);

    // Full lifecycle emitted in order by the real helpers (18 events).
    expect(history.map(e => e.type)).toEqual([
      "CERT_RUN_STARTED",
      "PREFLIGHT_PASSED",
      "PROVIDER_REQUEST_STARTED",
      "PROVIDER_REQUEST_SUCCEEDED",
      "OBSERVATION_RECEIVED",
      "OBSERVATION_NORMALIZED",
      "OBSERVATION_PERSISTED",
      "CASH_EVENT_QUALIFIED",
      "RULE_EVALUATED",
      "CAPITAL_PLAN_CREATED",
      "ALLOCATION_PLAN_CREATED",
      "EXECUTION_POLICY_EVALUATED",
      "SHADOW_DECISION_RECORDED",
      "EXECUTION_BLOCKED",
      "CERT_GATE_PASSED",
      "CERT_GATE_PASSED",
      "CERT_GATE_PASSED",
      "CERT_RUN_COMPLETED",
    ]);

    // The producer contract that reconstruction must consume:
    // EXECUTION_BLOCKED is emitted with status "failed" and a zero-mutation
    // payload — the authoritative zero-order evidence.
    const blocked = findEvent(history, "EXECUTION_BLOCKED");
    expect(blocked?.status).toBe("failed");
    expect(blocked?.payload).toEqual({
      reason: BLOCK_REASON,
      executeCount: 0,
      transferCount: 0,
      orderCount: 0,
      providerMutationCount: 0,
    });

    const decision = findEvent(history, "SHADOW_DECISION_RECORDED");
    expect(decision?.status).toBe("succeeded");
    expect(decision?.payload).toEqual({
      decisionId: "shadow-decision-synth-1",
      disposition: "shadow",
      deployableCents: nc(10000),
    });

    const policy = findEvent(history, "EXECUTION_POLICY_EVALUATED");
    expect(policy?.status).toBe("succeeded");
    expect(policy?.payload).toEqual({ disposition: "shadow", executeCount: 0 });
  });

  it("2. records a valid Shadow decision via the actual recordShadowDecisionRecorded helper", async () => {
    const ports = createFakeAuditPorts();
    const ctx = await startRun(synthConfig(ports));
    await recordShadowDecisionRecorded(ports, ctx, "shadow-decision-synth-1", nc(10000));

    const history = await ports.events.listByRun(ctx.runId);
    const decision = findEvent(history, "SHADOW_DECISION_RECORDED");
    expect(decision).toBeDefined();
    expect(decision?.status).toBe("succeeded");
    expect(decision?.payload).toEqual({
      decisionId: "shadow-decision-synth-1",
      disposition: "shadow",
      deployableCents: nc(10000),
    });
  });

  it("3. records execution blocking via the actual recordExecutionBlocked helper (status \"failed\", zero orders)", async () => {
    const ports = createFakeAuditPorts();
    const ctx = await startRun(synthConfig(ports));
    await recordExecutionBlocked(ports, ctx, BLOCK_REASON);

    const history = await ports.events.listByRun(ctx.runId);
    const blocked = findEvent(history, "EXECUTION_BLOCKED");
    expect(blocked).toBeDefined();
    // The core F4 producer fact: the block is recorded as a FAILED event with
    // an all-zero payload — the event's existence IS the zero-order evidence.
    expect(blocked?.status).toBe("failed");
    expect(blocked?.payload).toEqual({
      reason: BLOCK_REASON,
      executeCount: 0,
      transferCount: 0,
      orderCount: 0,
      providerMutationCount: 0,
    });
  });

  it("4. completes the synthetic run: run row finalized and CERT_RUN_COMPLETED emitted (adapter parity)", async () => {
    const ports = createFakeAuditPorts();
    const ctx = await driveSyntheticShadowRun(ports);

    const stored = ports._runs.get(ctx.runId);
    expect(stored?.result).toBe("PASS");
    expect(stored?.completedAt).toBeTruthy();
    expect(stored?.evidenceBoundary).toEqual(SYNTHETIC_SHADOW_BOUNDARY);
    expect(stored?.mutationCounts).toEqual({ transfer: 0, order: 0, providerMutation: 0 });
    expect(stored?.finalState).toBe("clean");

    const completed = findEvent(await ports.events.listByRun(ctx.runId), "CERT_RUN_COMPLETED");
    expect(completed?.status).toBe("succeeded"); // PASS → "succeeded" (real adapter parity)
    expect(completed?.payload).toEqual({ result: "PASS", evidenceBoundary: SYNTHETIC_SHADOW_BOUNDARY });
  });

  it("5. reconstructs the completed synthetic run from the persisted event history", async () => {
    const ports = createFakeAuditPorts();
    const ctx = await driveSyntheticShadowRun(ports);
    const reconstructed = await reconstructFromStore(ports, ctx);

    // Identity + pipeline legs derived purely from the persisted history.
    expect(reconstructed.evidenceKind).toBe("real");
    expect(reconstructed.provider).toBe("plaid");
    expect(reconstructed.environment).toBe("production");
    expect(reconstructed.normalized).toBe(true);
    expect(reconstructed.persisted).toBe(true);
    expect(reconstructed.qualified).toBe(true);
    expect(reconstructed.ruleVersion).toBe("rule-monthly-deposit");
    expect(reconstructed.capitalPlan).toEqual({ deployableCents: 10000 });
    expect(reconstructed.allocationPlan).toEqual({ totalDeployedCents: 10000, lines: 2 });
    expect(reconstructed.executionPolicy).toEqual({ disposition: "shadow", executeCount: 0 });
    expect(reconstructed.finishedCleanly).toBe(true);
    expect(reconstructed.whatObserved).toBe("Observed credit of 10000 cents (posted)");
  });

  it("6. reconstructs the correctly blocked Shadow run as shadowOnly=true", async () => {
    // RED at the pinned head (b4f1a421): recordExecutionBlocked() emits
    // EXECUTION_BLOCKED with status "failed" (test 3), but reconstructRun()
    // required status "succeeded" — so this legitimately Shadow-only run
    // misreconstructed as shadowOnly=false. The fix consumes the producer's
    // actual event semantics.
    const ports = createFakeAuditPorts();
    const ctx = await driveSyntheticShadowRun(ports);
    const reconstructed = await reconstructFromStore(ports, ctx);

    expect(reconstructed.shadowOnly).toBe(true);
  });

  it("7. infers no real order execution and no order failure from the blocked Shadow run", async () => {
    const ports = createFakeAuditPorts();
    const ctx = await driveSyntheticShadowRun(ports);
    const reconstructed = await reconstructFromStore(ports, ctx);

    // The run is attested shadow-only…
    expect(reconstructed.shadowOnly).toBe(true);
    // …the expected block is NOT evidence of execution:
    expect(reconstructed.executionPolicy).toEqual({ disposition: "shadow", executeCount: 0 });
    expect(reconstructed.providerMutationAttempted).toBe(false);
    // …and it is NOT an order failure or provider error either:
    expect(reconstructed.failedGate).toBeUndefined();
    expect(reconstructed.safeProviderError).toEqual({
      httpStatus: undefined,
      plaidErrorType: undefined,
      plaidErrorCode: undefined,
      plaidRequestId: undefined,
    });
    expect(reconstructed.finishedCleanly).toBe(true);
  });

  it("8. rejects shadowOnly for incomplete or contradictory event histories", async () => {
    // (a) Incomplete: execution block without a Shadow decision — a block alone
    //     does not attest that the pipeline chose shadow.
    {
      const ports = createFakeAuditPorts();
      const ctx = await driveSyntheticShadowRun(ports);
      const stored = ports._runs.get(ctx.runId);
      if (!stored) throw new Error("synthetic run missing");
      const history = (await ports.events.listByRun(ctx.runId)).filter(
        e => e.type !== "SHADOW_DECISION_RECORDED"
      );
      const reconstructed = reconstructRun(toReconstructionRunInput(stored), history, []);
      expect(reconstructed.shadowOnly).toBe(false);
    }

    // (b) Incomplete: Shadow decision without an execution block — the
    //     zero-order guarantee is not evidenced, so it is not attested.
    {
      const ports = createFakeAuditPorts();
      const ctx = await driveSyntheticShadowRun(ports);
      const stored = ports._runs.get(ctx.runId);
      if (!stored) throw new Error("synthetic run missing");
      const history = (await ports.events.listByRun(ctx.runId)).filter(
        e => e.type !== "EXECUTION_BLOCKED"
      );
      const reconstructed = reconstructRun(toReconstructionRunInput(stored), history, []);
      expect(reconstructed.shadowOnly).toBe(false);
    }

    // (c) Incomplete: shadow decision + block, but the EXECUTION_POLICY_EVALUATED
    //     evidence is missing — internal consistency cannot be confirmed, so
    //     the shadow-only attestation is not made (fail closed).
    {
      const ports = createFakeAuditPorts();
      const ctx = await driveSyntheticShadowRun(ports);
      const stored = ports._runs.get(ctx.runId);
      if (!stored) throw new Error("synthetic run missing");
      const history = (await ports.events.listByRun(ctx.runId)).filter(
        e => e.type !== "EXECUTION_POLICY_EVALUATED"
      );
      const reconstructed = reconstructRun(toReconstructionRunInput(stored), history, []);
      expect(reconstructed.shadowOnly).toBe(false);
      expect(reconstructed.executionPolicy).toBeNull();
    }

    // (d) Contradictory: a block was recorded, but the policy itself planned
    //     real orders (disposition "execute", executeCount 2). A block must
    //     never launder a run that executed orders into shadowOnly=true.
    {
      const ports = createFakeAuditPorts();
      const ctx = await driveSyntheticShadowRun(ports, {
        policy: { disposition: "execute", executeCount: 2 },
      });
      const stored = ports._runs.get(ctx.runId);
      if (!stored) throw new Error("synthetic run missing");
      const history = await ports.events.listByRun(ctx.runId);
      const reconstructed = reconstructRun(toReconstructionRunInput(stored), history, []);
      expect(reconstructed.shadowOnly).toBe(false);
      expect(reconstructed.executionPolicy).toEqual({ disposition: "execute", executeCount: 2 });
    }
  });
});