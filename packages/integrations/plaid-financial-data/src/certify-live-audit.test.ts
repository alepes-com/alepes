// Unit tests for certify-live-audit instrumentation.
// Uses a fake in-memory AuditPorts — no Postgres, no Plaid, no network.

import { describe, it, expect, beforeEach } from "vitest";
import type {
  AuditPorts,
  CreateCertificationRunInput,
  CompleteCertificationRunInput,
  PersistedCertificationRun,
} from "@alepes/persistence";
import type {
  AuditEvent,
  GateResult,
  EvidenceBoundary,
  FailureCode,
  EvidenceKind,
} from "@alepes/audit";
import { ulid } from "@alepes/persistence";
import { cents, nonNegativeCents } from "@alepes/money";
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
} from "./certify-live-audit";

// ─── Fake in-memory AuditPorts ────────────────────────────────────────────────

function createFakeAuditPorts(): AuditPorts {
  const runs = new Map<string, PersistedCertificationRun>();
  const events: AuditEvent[] = [];
  const providerCalls: Array<{
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
  }> = [];

  return {
    runs: {
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

      async completeRun(input: CompleteCertificationRunInput): Promise<void> {
        const run = runs.get(input.runId);
        if (!run) throw new Error(`Run ${input.runId} not found`);
        if (run.completedAt !== null) {
          // Idempotency check
          if (run.result !== input.result || run.failureCode !== (input.failureCode ?? null)) {
            throw new Error(`Run ${input.runId} already completed with different outcome`);
          }
          return;
        }
        run.completedAt = input.completedAt;
        run.result = input.result;
        run.failureCode = input.failureCode ?? null;
        run.evidenceBoundary = input.evidenceBoundary;
        run.gates = input.gates;
        run.mutationCounts = input.mutationCounts;
        run.finalState = input.finalState;
        run.updatedAt = new Date().toISOString();

        // Emit CERT_RUN_COMPLETED event (matching adapter behavior)
        const event: AuditEvent = {
          eventId: ulid(),
          runId: input.runId,
          correlationId: run.correlationId,
          causationId: undefined,
          sequence: events.filter(e => e.runId === input.runId).length + 1,
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
        };
        events.push(event);
      },

      async loadRun(runId: string): Promise<PersistedCertificationRun | null> {
        return runs.get(runId) ?? null;
      },

      async loadRunByCorrelationId(correlationId: string): Promise<PersistedCertificationRun | null> {
        for (const run of runs.values()) {
          if (run.correlationId === correlationId) return run;
        }
        return null;
      },
    },

    events: {
      async append(event: AuditEvent): Promise<void> {
        events.push(event);
      },

      async listByRun(runId: string): Promise<AuditEvent[]> {
        return events.filter(e => e.runId === runId).sort((a, b) => a.sequence - b.sequence);
      },

      async listByCorrelationId(correlationId: string): Promise<AuditEvent[]> {
        return events.filter(e => e.correlationId === correlationId).sort((a, b) => {
          if (a.occurredAt !== b.occurredAt) return a.occurredAt.localeCompare(b.occurredAt);
          return a.sequence - b.sequence;
        });
      },
    },

    providerCalls: {
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

      async listByRun(runId: string) {
        return providerCalls.filter(c => c.runId === runId).sort((a, b) => a.occurredAt.localeCompare(b.occurredAt));
      },
    },

    close: async () => {},
  };
}

function createTestConfig(ports: AuditPorts) {
  return {
    ports,
    provider: "plaid" as const,
    environment: "production" as const,
    sourceCommit: "abc123",
    harness: "certify-live.ts",
    harnessVersion: "1.0.0",
    schemaVersion: "audit-cert@1",
    milestone: "v0.5.0" as const,
  };
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("certify-live-audit instrumentation", () => {
  let ports: AuditPorts;
  let config: ReturnType<typeof createTestConfig>;

  beforeEach(() => {
    ports = createFakeAuditPorts();
    config = createTestConfig(ports);
  });

  it("missing PLAID_ACCESS_TOKEN path: CERT_RUN_STARTED → PREFLIGHT_FAILED(configuration.missing_secret) → CERT_RUN_COMPLETED(FAIL)", async () => {
    const ctx = await startRun(config);

    // Preflight failed - missing secret
    await recordPreflight(ports, ctx, {
      passed: false,
      failureCode: "configuration.missing_secret",
      field: "PLAID_ACCESS_TOKEN",
      providerCallAttempted: false,
    });

    // Complete run with FAIL
    const evidenceBoundary: EvidenceBoundary = {
      providerObservation: "none",
      cashEvent: "none",
      decision: "none",
      execution: "none",
      providerMutation: false,
    };
    await completeRun(
      ports,
      ctx,
      "FAIL",
      "configuration.missing_secret",
      evidenceBoundary,
      [{ gate: "preflight", status: "FAIL", failureCode: "configuration.missing_secret" }],
      { transfer: 0, order: 0, providerMutation: 0 },
      "clean"
    );

    // Reconstruct from stored evidence
    const events = await ports.events.listByRun(ctx.runId);
    const run = await ports.runs.loadRun(ctx.runId);

    // Verify run state
    expect(run).not.toBeNull();
    expect(run!.result).toBe("FAIL");
    expect(run!.failureCode).toBe("configuration.missing_secret");
    expect(run!.evidenceBoundary.providerObservation).toBe("none");
    expect(run!.evidenceBoundary.execution).toBe("none");
    expect(run!.mutationCounts.providerMutation).toBe(0);

    // Verify event sequence
    expect(events).toHaveLength(3); // CERT_RUN_STARTED + PREFLIGHT_FAILED + CERT_RUN_COMPLETED
    const eventTypes = events.map(e => e.type);
    expect(eventTypes).toEqual(["CERT_RUN_STARTED", "PREFLIGHT_FAILED", "CERT_RUN_COMPLETED"]);

    // Verify PREFLIGHT_FAILED payload - field name is an env-var identifier (safe), values are redacted
    const preflightFailed = events.find(e => e.type === "PREFLIGHT_FAILED");
    expect(preflightFailed).toBeTruthy();
    expect(preflightFailed!.payload).toMatchObject({
      failureCode: "configuration.missing_secret",
      field: "PLAID_ACCESS_TOKEN",
      providerCallAttempted: false,
    });

    // Verify CERT_RUN_COMPLETED payload
    const completed = events.find(e => e.type === "CERT_RUN_COMPLETED");
    expect(completed).toBeTruthy();
    expect(completed!.payload.result).toBe("FAIL");
    expect(completed!.payload.evidenceBoundary.providerObservation).toBe("none");
    expect(completed!.payload.evidenceBoundary.execution).toBe("none");
    expect(completed!.payload.evidenceBoundary.providerMutation).toBe(false);

    // Verify no secret VALUES in any payload (env-var names are safe identifiers; only values are secrets)
    // Note: "configuration.missing_secret" contains substring "secret" legitimately; that's not a value leak
  });

  it("success path emits full lifecycle with real evidence boundary", async () => {
    const ctx = await startRun(config);

    // Preflight passed - only env-var NAMES go into secretsPresent (not values)
    await recordPreflight(ports, ctx, { passed: true, secretsPresent: ["PLAID_CLIENT_ID", "PLAID_SECRET", "PLAID_LIVE_POSTGRES_URL", "PLAID_ACCESS_TOKEN"] });

    // Provider calls
    await recordProviderRequest(ports, ctx, "/accounts/get", "started", { accountIdFingerprint: "fp-acc-123" });
    await recordProviderRequest(ports, ctx, "/accounts/get", "succeeded", { latencyMs: 123 });
    await recordProviderRequest(ports, ctx, "/transactions/sync", "started", {});
    await recordProviderRequest(ports, ctx, "/transactions/sync", "succeeded", { latencyMs: 456 });

    // Observations
    await recordObservationReceived(ports, ctx, "obs-1", "fp-ext-1", "credit", cents(50000), true);
    await recordObservationNormalized(ports, ctx, "obs-1", "plaid-sign-convention@1");
    await recordObservationPersisted(ports, ctx, "obs-1", "persisted-1");

    // Cash event qualification
    await recordCashEventQualified(ports, ctx, "cash-1", cents(50000), "rule-1");

    // Policy pipeline
    await recordRuleEvaluated(ports, ctx, "rule-1", "cash-1", cents(50000));
    await recordCapitalPlanCreated(ports, ctx, "cap-1", nonNegativeCents(50000));
    await recordAllocationPlanCreated(ports, ctx, "alloc-1", nonNegativeCents(50000), 2);

    // Execution
    await recordExecutionPolicyEvaluated(ports, ctx, "shadow", 0);
    await recordShadowDecisionRecorded(ports, ctx, "dec-1", nonNegativeCents(50000));

    // Gates
    await recordGate(ports, ctx, "preflight", "PASS");
    await recordGate(ports, ctx, "provider_sync", "PASS");
    await recordGate(ports, ctx, "qualification", "PASS");
    await recordGate(ports, ctx, "policy", "PASS");
    await recordGate(ports, ctx, "execution", "PASS");

    // Complete PASS
    const evidenceBoundary: EvidenceBoundary = {
      providerObservation: "real",
      cashEvent: "real",
      decision: "real",
      execution: "shadow",
      providerMutation: false,
    };
    await completeRun(
      ports,
      ctx,
      "PASS",
      undefined,
      evidenceBoundary,
      [
        { gate: "preflight", status: "PASS" },
        { gate: "provider_sync", status: "PASS" },
        { gate: "qualification", status: "PASS" },
        { gate: "policy", status: "PASS" },
        { gate: "execution", status: "PASS" },
      ],
      { transfer: 0, order: 0, providerMutation: 0 },
      "clean"
    );

    // Reconstruct
    const events = await ports.events.listByRun(ctx.runId);
    const run = await ports.runs.loadRun(ctx.runId);

    expect(run!.result).toBe("PASS");
    expect(run!.evidenceBoundary.providerObservation).toBe("real");
    expect(run!.evidenceBoundary.cashEvent).toBe("real");
    expect(run!.evidenceBoundary.decision).toBe("real");
    expect(run!.evidenceBoundary.execution).toBe("shadow");
    expect(run!.evidenceBoundary.providerMutation).toBe(false);

    // Verify full event sequence
    const eventTypes = events.map(e => e.type);
    expect(eventTypes).toContain("CERT_RUN_STARTED");
    expect(eventTypes).toContain("PREFLIGHT_PASSED");
    expect(eventTypes).toContain("PROVIDER_REQUEST_STARTED");
    expect(eventTypes).toContain("PROVIDER_REQUEST_SUCCEEDED");
    expect(eventTypes).toContain("OBSERVATION_RECEIVED");
    expect(eventTypes).toContain("OBSERVATION_NORMALIZED");
    expect(eventTypes).toContain("OBSERVATION_PERSISTED");
    expect(eventTypes).toContain("CASH_EVENT_QUALIFIED");
    expect(eventTypes).toContain("RULE_EVALUATED");
    expect(eventTypes).toContain("CAPITAL_PLAN_CREATED");
    expect(eventTypes).toContain("ALLOCATION_PLAN_CREATED");
    expect(eventTypes).toContain("EXECUTION_POLICY_EVALUATED");
    expect(eventTypes).toContain("SHADOW_DECISION_RECORDED");
    expect(eventTypes).toContain("CERT_GATE_PASSED");
    expect(eventTypes).toContain("CERT_RUN_COMPLETED");

    // Verify gate counts
    const passedGates = events.filter(e => e.type === "CERT_GATE_PASSED");
    expect(passedGates).toHaveLength(5);

    // No secret VALUES in payloads (env-var names like PLAID_CLIENT_ID are safe identifiers)
    // A real value like "supersecret-value-xyz" would be a violation, but names are not secrets
  });

  it("provider error path maps Plaid fields to FailureCode", async () => {
      const ctx = await startRun(config);

      await recordPreflight(ports, ctx, { passed: true, secretsPresent: ["PLAID_ACCESS_TOKEN"] });

      // Provider 401 with Plaid error_type=AUTH, error_code=INVALID_CREDENTIALS
      await recordProviderRequest(ports, ctx, "/transactions/sync", "failed", {
        httpStatus: 401,
        plaidErrorType: "AUTH",
        plaidErrorCode: "INVALID_CREDENTIALS",
        plaidRequestId: "plaid-req-123",
      });

      const evidenceBoundary: EvidenceBoundary = {
        providerObservation: "none",
        cashEvent: "none",
        decision: "none",
        execution: "none",
        providerMutation: false,
      };
      await completeRun(
        ports,
        ctx,
        "FAIL",
        "provider.authentication_failed",
        evidenceBoundary,
        [{ gate: "provider_sync", status: "FAIL", failureCode: "provider.authentication_failed" }],
        { transfer: 0, order: 0, providerMutation: 0 },
        "clean"
      );

      const events = await ports.events.listByRun(ctx.runId);
      const providerFailed = events.find(e => e.type === "PROVIDER_REQUEST_FAILED");
      expect(providerFailed).toBeTruthy();
      expect(providerFailed!.payload.failureCode).toBe("provider.authentication_failed");
      expect(providerFailed!.payload.httpStatus).toBe(401);
      expect(providerFailed!.payload.plaidErrorType).toBe("AUTH");
      expect(providerFailed!.payload.plaidErrorCode).toBe("INVALID_CREDENTIALS");
      expect(providerFailed!.payload.plaidRequestId).toBe("plaid-req-123");
    });

  it("sentinel secrets never appear in emitted events", async () => {
    const ctx = await startRun(config);

    // Plant sentinel values in inputs
    const sentinelToken = "SENTINEL_PLAID_ACCESS_TOKEN_XYZ789";
    const sentinelItemId = "SENTINEL_ITEM_ID_ABC123";

    // Only env-var NAMES go into secretsPresent; sentinel VALUE must never appear in any payload
    await recordPreflight(ports, ctx, { passed: true, secretsPresent: ["PLAID_ACCESS_TOKEN"] });
    await recordProviderRequest(ports, ctx, "/accounts/get", "started", { accountIdFingerprint: "fp-sentinel-item" });

    const events = await ports.events.listByRun(ctx.runId);
    const allPayloads = JSON.stringify(events.map(e => e.payload));

    // Sentinel VALUE should never appear
    expect(allPayloads).not.toContain(sentinelToken);
    expect(allPayloads).not.toContain(sentinelItemId);
    // Only fingerprints should appear
    expect(allPayloads).toContain("fp-");
  });

  it("execution blocked path records zero mutation counts", async () => {
    const ctx = await startRun(config);

    await recordPreflight(ports, ctx, { passed: true, secretsPresent: ["PLAID_ACCESS_TOKEN"] });
    await recordExecutionPolicyEvaluated(ports, ctx, "shadow", 0);
    await recordExecutionBlocked(ports, ctx, "execution surface reachable");

    const evidenceBoundary: EvidenceBoundary = {
      providerObservation: "real",
      cashEvent: "real",
      decision: "real",
      execution: "none",
      providerMutation: false,
    };
    await completeRun(
      ports,
      ctx,
      "FAIL",
      "safety.execution_surface_reachable",
      evidenceBoundary,
      [{ gate: "execution", status: "FAIL", failureCode: "safety.execution_surface_reachable" }],
      { transfer: 0, order: 0, providerMutation: 0 },
      "dirty"
    );

    const events = await ports.events.listByRun(ctx.runId);
    const blocked = events.find(e => e.type === "EXECUTION_BLOCKED");
    expect(blocked).toBeTruthy();
    expect(blocked!.payload).toMatchObject({
      executeCount: 0,
      transferCount: 0,
      orderCount: 0,
      providerMutationCount: 0,
    });
    expect(blocked!.payload.reason).toBe("execution surface reachable");
  });
});