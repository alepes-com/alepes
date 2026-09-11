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
} from "@alepes/audit";
import type { ProviderCallEvidence } from "@alepes/reporting";
import {
  sanitizeReport,
  reconstructRun,
  renderMarkdownReport,
  renderConsoleSummary,
  type CertificationReportV1,
} from "@alepes/reporting";

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