// @alepes/audit — Unit tests for audit event model and certification run types
// Pure: no I/O, no provider SDKs. Tests the discriminated-union narrowing, failure taxonomy mapping,
// and type-guard features.

import { describe, it, expect } from "vitest";
import type { Cents, NonNegativeCents } from "@alepes/money";
import type {
  AuditEvent,
  CertificationRun,
  EvidenceBoundary,
  FailureCode,
  GateResult,
  EvidenceKind,
  RunResult,
  ProviderErrorFields,
} from "@alepes/audit";
import {
  mapProviderErrorToFailureCode,
  isPreflightFailed,
  isProviderRequestFailed,
  isCashEventRejected,
  isCertGateFailed,
  isCertRunCompleted,
} from "@alepes/audit";

// ─── Helper: branded cents constructors ───

function c(val: number): Cents {
  return val as Cents;
}
function nc(val: number): NonNegativeCents {
  return val as NonNegativeCents;
}

// ─── Type guard tests ───

describe("AuditEvent type guards", () => {
  const baseEvent = {
    eventId: "01ARZ3NDEKTSV4RRFFQ69G5FAV",
    runId: "run-123",
    correlationId: "corr-456",
    sequence: 1,
    occurredAt: "2024-01-15T10:30:00.000Z",
    phase: "preflight" as const,
    status: "succeeded" as const,
    actor: "system" as const,
  };

  it("isPreflightFailed narrows PREFLIGHT_FAILED", () => {
    const e: AuditEvent = {
      ...baseEvent,
      type: "PREFLIGHT_FAILED",
      payload: { failureCode: "configuration.missing_secret", field: "PLAID_ACCESS_TOKEN", providerCallAttempted: false },
    };
    expect(isPreflightFailed(e)).toBe(true);
    if (isPreflightFailed(e)) {
      expect(e.payload.failureCode).toBe("configuration.missing_secret");
      expect(e.payload.field).toBe("PLAID_ACCESS_TOKEN");
      expect(e.payload.providerCallAttempted).toBe(false);
    }
  });

  it("isProviderRequestFailed narrows PROVIDER_REQUEST_FAILED with Plaid-safe fields", () => {
    const e: AuditEvent = {
      ...baseEvent,
      type: "PROVIDER_REQUEST_FAILED",
      payload: {
        failureCode: "provider.invalid_request",
        httpStatus: 400,
        plaidErrorType: "INVALID_INPUT",
        plaidErrorCode: "INVALID_FIELD",
        plaidRequestId: "req-abc-123",
      },
    };
    expect(isProviderRequestFailed(e)).toBe(true);
    if (isProviderRequestFailed(e)) {
      expect(e.payload.plaidErrorCode).toBe("INVALID_FIELD");
      expect(e.payload.plaidRequestId).toBe("req-abc-123");
    }
  });

  it("isCashEventRejected narrows CASH_EVENT_REJECTED", () => {
    const e: AuditEvent = {
      ...baseEvent,
      type: "CASH_EVENT_REJECTED",
      payload: { reason: "Amount below minimum threshold", observationId: "obs-789" },
    };
    expect(isCashEventRejected(e)).toBe(true);
    if (isCashEventRejected(e)) {
      expect(e.payload.reason).toBe("Amount below minimum threshold");
    }
  });

  it("isCertGateFailed narrows CERT_GATE_FAILED", () => {
    const e: AuditEvent = {
      ...baseEvent,
      type: "CERT_GATE_FAILED",
      payload: { gate: "qualifying_event", failureCode: "sync.no_qualifying_event" },
    };
    expect(isCertGateFailed(e)).toBe(true);
    if (isCertGateFailed(e)) {
      expect(e.payload.gate).toBe("qualifying_event");
      expect(e.payload.failureCode).toBe("sync.no_qualifying_event");
    }
  });

  it("isCertRunCompleted narrows CERT_RUN_COMPLETED", () => {
    const boundary: EvidenceBoundary = {
      providerObservation: "real",
      cashEvent: "real",
      decision: "real",
      execution: "shadow",
      providerMutation: false,
    };
    const e: AuditEvent = {
      ...baseEvent,
      type: "CERT_RUN_COMPLETED",
      payload: { result: "FAIL" as RunResult, evidenceBoundary: boundary },
    };
    expect(isCertRunCompleted(e)).toBe(true);
    if (isCertRunCompleted(e)) {
      expect(e.payload.result).toBe("FAIL");
      expect(e.payload.evidenceBoundary.providerObservation).toBe("real");
      expect(e.payload.evidenceBoundary.providerMutation).toBe(false);
    }
  });

  it("guards return false for unrelated event types", () => {
    const e: AuditEvent = {
      ...baseEvent,
      type: "OBSERVATION_RECEIVED",
      payload: { observationId: "obs-1", externalRefFingerprint: "fp-abc", direction: "credit", amountCents: c(5000), posted: true },
    };
    expect(isPreflightFailed(e)).toBe(false);
    expect(isProviderRequestFailed(e)).toBe(false);
    expect(isCashEventRejected(e)).toBe(false);
    expect(isCertGateFailed(e)).toBe(false);
    expect(isCertRunCompleted(e)).toBe(false);
  });
});

// ─── Failure taxonomy mapping tests (table-driven) ───

describe("mapProviderErrorToFailureCode", () => {
  const cases: Array<{ fields: ProviderErrorFields; expected: FailureCode; description: string }> = [
    // Plaid error_code — most specific
    { fields: { errorCode: "ITEM_LOGIN_REQUIRED" }, expected: "provider.item_login_required", description: "Plaid ITEM_LOGIN_REQUIRED error_code" },
    { fields: { errorCode: "INVALID_INPUT" }, expected: "provider.invalid_request", description: "Plaid INVALID_INPUT error_code" },
    { fields: { errorCode: "INVALID_FIELD" }, expected: "provider.invalid_request", description: "Plaid INVALID_FIELD error_code" },
    { fields: { errorCode: "AUTH" }, expected: "provider.authentication_failed", description: "Plaid AUTH error_code" },
    { fields: { errorCode: "INVALID_CREDENTIALS" }, expected: "provider.authentication_failed", description: "Plaid INVALID_CREDENTIALS error_code" },
    { fields: { errorCode: "RATE_LIMIT_EXCEEDED" }, expected: "provider.rate_limited", description: "Plaid RATE_LIMIT_EXCEEDED error_code" },
    { fields: { errorCode: "PRODUCT_NOT_ENABLED" }, expected: "provider.product_not_enabled", description: "Plaid PRODUCT_NOT_ENABLED error_code" },
    { fields: { errorCode: "PRODUCT_NOT_READY" }, expected: "provider.product_not_enabled", description: "Plaid PRODUCT_NOT_READY error_code" },
    { fields: { errorCode: "API_ERROR" }, expected: "provider.unavailable", description: "Plaid API_ERROR error_code" },
    { fields: { errorCode: "INTERNAL_SERVER_ERROR" }, expected: "provider.unavailable", description: "Plaid INTERNAL_SERVER_ERROR error_code" },

    // Plaid error_type fallback
    { fields: { errorType: "INVALID_INPUT" }, expected: "provider.invalid_request", description: "Plaid INVALID_INPUT error_type" },
    { fields: { errorType: "INVALID_FIELD" }, expected: "provider.invalid_request", description: "Plaid INVALID_FIELD error_type" },
    { fields: { errorType: "AUTH" }, expected: "provider.authentication_failed", description: "Plaid AUTH error_type" },
    { fields: { errorType: "INVALID_CREDENTIALS" }, expected: "provider.authentication_failed", description: "Plaid INVALID_CREDENTIALS error_type" },
    { fields: { errorType: "RATE_LIMIT" }, expected: "provider.rate_limited", description: "Plaid RATE_LIMIT error_type" },
    { fields: { errorType: "RATE_LIMITED" }, expected: "provider.rate_limited", description: "Plaid RATE_LIMITED error_type" },
    { fields: { errorType: "PRODUCT_NOT_READY" }, expected: "provider.product_not_enabled", description: "Plaid PRODUCT_NOT_READY error_type" },
    { fields: { errorType: "PRODUCT_NOT_ENABLED" }, expected: "provider.product_not_enabled", description: "Plaid PRODUCT_NOT_ENABLED error_type" },
    { fields: { errorType: "SERVER_ERROR" }, expected: "provider.unavailable", description: "Plaid SERVER_ERROR error_type" },
    { fields: { errorType: "API_ERROR" }, expected: "provider.unavailable", description: "Plaid API_ERROR error_type" },

    // HTTP status fallback (least specific)
    { fields: { httpStatus: 401 }, expected: "provider.authentication_failed", description: "HTTP 401" },
    { fields: { httpStatus: 403 }, expected: "provider.authentication_failed", description: "HTTP 403" },
    { fields: { httpStatus: 429 }, expected: "provider.rate_limited", description: "HTTP 429" },
    { fields: { httpStatus: 500 }, expected: "provider.unavailable", description: "HTTP 500" },
    { fields: { httpStatus: 502 }, expected: "provider.unavailable", description: "HTTP 502" },
    { fields: { httpStatus: 503 }, expected: "provider.unavailable", description: "HTTP 503" },

    // Combined: error_code takes precedence over HTTP status
    { fields: { errorCode: "ITEM_LOGIN_REQUIRED", httpStatus: 500 }, expected: "provider.item_login_required", description: "error_code wins over HTTP 500" },
    { fields: { errorType: "INVALID_INPUT", httpStatus: 401 }, expected: "provider.invalid_request", description: "error_type wins over HTTP 401" },

    // Unknown / no useful info → internal.unexpected
    { fields: {}, expected: "internal.unexpected", description: "empty fields" },
    { fields: { errorCode: "BOGUS_UNKNOWN_CODE" }, expected: "internal.unexpected", description: "unknown error_code" },
    { fields: { errorType: "BOGUS_UNKNOWN_TYPE" }, expected: "internal.unexpected", description: "unknown error_type" },
    { fields: { httpStatus: 418 }, expected: "internal.unexpected", description: "unknown HTTP status (teapot)" },
  ];

  for (const { fields, expected, description } of cases) {
    it(description, () => {
      expect(mapProviderErrorToFailureCode(fields)).toBe(expected);
    });
  }

  it("HTTP status fallback for unknown provider strings maps to provider.unavailable", () => {
    const bogusFields: ProviderErrorFields = {
      errorCode: "NOT_A_REAL_PLAID_CODE",
      errorType: "NOT_A_REAL_PLAID_TYPE",
      httpStatus: 999,
    };
    const result = mapProviderErrorToFailureCode(bogusFields);
    // HTTP 999 >= 500 falls through to provider.unavailable (least-specific fallback)
    expect(result).toBe("provider.unavailable");
    // It IS a provider.* code due to HTTP fallback - this is the honest bucket
    expect(result.startsWith("provider.")).toBe(true);
  });
});

// ─── Discriminated-union narrowing behavior ───

describe("AuditEvent discriminated-union narrowing", () => {
  const createQualifiedEvent = (): AuditEvent => ({
    eventId: "evt-1",
    runId: "run-1",
    correlationId: "corr-1",
    sequence: 5,
    occurredAt: "2024-01-15T10:30:00.000Z",
    phase: "qualification",
    type: "CASH_EVENT_QUALIFIED",
    status: "succeeded",
    actor: "system",
    payload: { cashEventId: "ce-1", amountCents: c(10000), ruleId: "rule-monthly-deposit" },
  });

  const createRejectedEvent = (): AuditEvent => ({
    eventId: "evt-2",
    runId: "run-1",
    correlationId: "corr-1",
    sequence: 5,
    occurredAt: "2024-01-15T10:30:00.000Z",
    phase: "qualification",
    type: "CASH_EVENT_REJECTED",
    status: "succeeded",
    actor: "system",
    payload: { reason: "Below minimum", observationId: "obs-1" },
  });

  it("narrows CASH_EVENT_QUALIFIED payload to branded Cents", () => {
    const e = createQualifiedEvent();
    if (e.type === "CASH_EVENT_QUALIFIED") {
      // TypeScript should know payload.amountCents is Cents (branded)
      const cents: Cents = e.payload.amountCents;
      expect(typeof cents).toBe("number");
      expect(cents).toBe(10000);
    }
  });

  it("narrows CASH_EVENT_REJECTED payload to string reason", () => {
    const e = createRejectedEvent();
    if (e.type === "CASH_EVENT_REJECTED") {
      expect(e.payload.reason).toBe("Below minimum");
      expect(e.payload.observationId).toBe("obs-1");
    }
  });

  it("exhaustive switch over all event types compiles", () => {
    const events: AuditEvent[] = [createQualifiedEvent(), createRejectedEvent()];
    for (const e of events) {
      switch (e.type) {
        case "CASH_EVENT_QUALIFIED":
          expect(e.payload.amountCents).toBeDefined();
          break;
        case "CASH_EVENT_REJECTED":
          expect(e.payload.reason).toBeDefined();
          break;
        // Intentionally not exhaustive in test — just verify narrowing works
      }
    }
  });
});

// ─── CertificationRun and EvidenceBoundary shape ───

describe("CertificationRun and EvidenceBoundary types", () => {
  it("EvidenceBoundary accepts all three EvidenceKind values", () => {
    const boundaries: EvidenceBoundary[] = [
      { providerObservation: "real", cashEvent: "real", decision: "real", execution: "shadow", providerMutation: false },
      { providerObservation: "synthetic", cashEvent: "synthetic", decision: "synthetic", execution: "shadow", providerMutation: false },
      { providerObservation: "none", cashEvent: "none", decision: "none", execution: "none", providerMutation: false },
    ];
    for (const b of boundaries) {
      expect(["real", "synthetic", "none"]).toContain(b.providerObservation);
      expect(["real", "synthetic", "none"]).toContain(b.cashEvent);
      expect(["real", "synthetic", "none"]).toContain(b.decision);
      expect(["shadow", "approval", "execute", "none"]).toContain(b.execution);
      expect(typeof b.providerMutation).toBe("boolean");
    }
  });

  it("CertificationRun captures full evidence boundary and gates", () => {
    const run: CertificationRun = {
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
    expect(run.gates.length).toBe(3);
    expect(run.evidenceBoundary.providerMutation).toBe(false);
    expect(run.mutationCounts.providerMutation).toBe(0);
  });
});

// ─── GateResult status enum ───

describe("GateResult status preserves SKIPPED/UNSUPPORTED distinctly", () => {
  const statuses: Array<GateResult["status"]> = ["PASS", "FAIL", "SKIPPED", "UNSUPPORTED"];
  for (const s of statuses) {
    it(`preserves ${s} status`, () => {
      const gate: GateResult = { gate: "test-gate", status: s };
      expect(gate.status).toBe(s);
    });
  }
});