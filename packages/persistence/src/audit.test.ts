// Integration tests: audit + certification persistence against real PostgreSQL.
// Run with: ALEPES_TEST_AUDIT_DATABASE_URL=postgresql://raelldottin@localhost:5432/alepes_sync_test bun run test packages/persistence/src/audit.test.ts

import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { runMigrations } from "./migrations";
import { createAuditPostgresStore } from "./audit-postgres";
import type { AuditPorts, CreateCertificationRunInput, CompleteCertificationRunInput, AuditEvent } from "./audit-ports";
import type { EvidenceBoundary, GateResult, FailureCode, RunResult } from "@alepes/audit";
import { ulid } from "./identity";
import { cents } from "@alepes/money";

const TEST_CONNECTION =
  process.env.ALEPES_TEST_AUDIT_DATABASE_URL ??
  "postgresql://raelldottin@localhost:5432/alepes_sync_test";

const runIntegration = process.env.ALEPES_TEST_AUDIT_DATABASE_URL ? describe : describe.skip;

runIntegration("audit + certification persistence (real PostgreSQL)", () => {
  let store: AuditPorts;

  beforeAll(async () => {
    await runMigrations(TEST_CONNECTION);
  });

  afterAll(async () => {
    await store?.close();
  });

  beforeEach(async () => {
    const { Pool } = await import("pg");
    const pool = new Pool({ connectionString: TEST_CONNECTION });
    // Truncate in dependency order: provider_call_evidence → audit_events → certification_runs
    await pool.query(
      `TRUNCATE provider_call_evidence, audit_events, certification_runs RESTART IDENTITY CASCADE`
    );
    await pool.end();
    store = createAuditPostgresStore({ connectionString: TEST_CONNECTION });
  });

  function runInput(overrides: Partial<CreateCertificationRunInput> = {}): CreateCertificationRunInput {
    return {
      runId: ulid(),
      correlationId: ulid(),
      milestone: "v0.5.0",
      provider: "plaid",
      environment: "production",
      sourceCommit: "abcdef1234567890",
      harness: "certify-live.ts",
      harnessVersion: "1.0.0",
      schemaVersion: "audit-cert@1",
      startedAt: new Date().toISOString(),
      ...overrides,
    };
  }

  function completeInput(runId: string, overrides: Partial<CompleteCertificationRunInput> = {}): CompleteCertificationRunInput {
    return {
      runId,
      completedAt: new Date().toISOString(),
      result: "PASS",
      failureCode: undefined,
      evidenceBoundary: {
        providerObservation: "real",
        cashEvent: "real",
        decision: "real",
        execution: "shadow",
        providerMutation: false,
      },
      gates: [
        { gate: "preflight", status: "PASS" },
        { gate: "provider_sync", status: "PASS" },
        { gate: "qualification", status: "PASS" },
        { gate: "policy", status: "PASS" },
        { gate: "execution", status: "PASS" },
      ],
      mutationCounts: { transfer: 0, order: 0, providerMutation: 0 },
      finalState: "clean",
      ...overrides,
    };
  }

  function auditEvent<T extends AuditEvent["type"]>(
    runId: string,
    correlationId: string,
    type: T,
    payload: Extract<AuditEvent, { type: T }>["payload"]
  ): AuditEvent {
    // Derive phase/status/attempt from type for semantic correctness
    const phaseByType: Record<string, AuditEvent["phase"]> = {
      CERT_RUN_STARTED: "preflight",
      PREFLIGHT_PASSED: "preflight",
      PREFLIGHT_FAILED: "preflight",
      PROVIDER_REQUEST_STARTED: "provider",
      PROVIDER_REQUEST_SUCCEEDED: "provider",
      PROVIDER_REQUEST_FAILED: "provider",
      OBSERVATION_RECEIVED: "observation",
      OBSERVATION_NORMALIZED: "normalization",
      OBSERVATION_PERSISTED: "persistence",
      OBSERVATION_RECONCILED: "reconciliation",
      CASH_EVENT_QUALIFIED: "qualification",
      CASH_EVENT_REJECTED: "qualification",
      RULE_EVALUATED: "policy",
      CAPITAL_PLAN_CREATED: "policy",
      ALLOCATION_PLAN_CREATED: "policy",
      EXECUTION_PLAN_CREATED: "execution",
      EXECUTION_POLICY_EVALUATED: "execution",
      SHADOW_DECISION_RECORDED: "execution",
      EXECUTION_BLOCKED: "execution",
      OUTBOX_RECORDED: "reconciliation",
      AUDIT_RECORDED: "reconciliation",
      RECONCILIATION_STARTED: "reconciliation",
      RECONCILIATION_SUCCEEDED: "reconciliation",
      RECONCILIATION_FAILED: "reconciliation",
      IDEMPOTENCY_CHECK: "policy",
      DUPLICATE_EVENT_SUPPRESSED: "policy",
      CERT_GATE_PASSED: "reporting",
      CERT_GATE_FAILED: "reporting",
      CERT_GATE_SKIPPED: "reporting",
      REDACTION_VIOLATION: "reporting",
      CERT_RUN_COMPLETED: "reporting",
    };

    const statusByType: Record<string, "started" | "succeeded" | "failed" | "skipped"> = {
      PREFLIGHT_FAILED: "failed",
      PROVIDER_REQUEST_FAILED: "failed",
      CASH_EVENT_REJECTED: "failed",
      EXECUTION_BLOCKED: "failed",
      RECONCILIATION_FAILED: "failed",
      CERT_GATE_FAILED: "failed",
      CERT_GATE_SKIPPED: "skipped",
      PROVIDER_REQUEST_STARTED: "started",
      CERT_RUN_COMPLETED: "succeeded", // overall run result in payload
    };

    const attemptByType: Record<string, number | undefined> = {
      PROVIDER_REQUEST_STARTED: 1,
      PROVIDER_REQUEST_SUCCEEDED: 1,
      PROVIDER_REQUEST_FAILED: 1,
    };

    const base = {
      eventId: ulid(),
      runId,
      correlationId,
      causationId: undefined,
      sequence: 0, // assigned by adapter
      occurredAt: new Date().toISOString(),
      phase: phaseByType[type] ?? "preflight",
      type,
      status: statusByType[type] ?? "succeeded",
      actor: "system" as const,
      provider: "plaid" as const,
      attempt: attemptByType[type],
      mutated: false,
      verified: true,
    } as const;

    return { ...base, type, payload } as AuditEvent;
  }

  it("1. createRun → loadRun round-trip preserves all fields (incomplete run has null result)", async () => {
    const input = runInput();
    await store.runs.createRun(input);
    const loaded = await store.runs.loadRun(input.runId);

    expect(loaded).not.toBeNull();
    expect(loaded!.runId).toBe(input.runId);
    expect(loaded!.correlationId).toBe(input.correlationId);
    expect(loaded!.milestone).toBe(input.milestone);
    expect(loaded!.provider).toBe(input.provider);
    expect(loaded!.environment).toBe(input.environment);
    expect(loaded!.sourceCommit).toBe(input.sourceCommit);
    expect(loaded!.branch).toBeNull();
    expect(loaded!.harness).toBe(input.harness);
    expect(loaded!.harnessVersion).toBe(input.harnessVersion);
    expect(loaded!.schemaVersion).toBe(input.schemaVersion);
    expect(loaded!.startedAt).toBe(input.startedAt);
    expect(loaded!.completedAt).toBeNull();
    expect(loaded!.result).toBeNull(); // incomplete run
    expect(loaded!.failureCode).toBeNull();
    expect(loaded!.finalState).toBe("clean");
    expect(loaded!.createdAt).toBeTruthy();
    expect(loaded!.updatedAt).toBeTruthy();
  });

  it("2. completeRun sets completed state; idempotent with identical input; different outcome throws", async () => {
    const input = runInput();
    await store.runs.createRun(input);
    await store.runs.completeRun(completeInput(input.runId));

    const loaded1 = await store.runs.loadRun(input.runId);
    expect(loaded1!.result).toBe("PASS");
    expect(loaded1!.completedAt).not.toBeNull();
    expect(loaded1!.evidenceBoundary.providerObservation).toBe("real");

    // Verify CERT_RUN_COMPLETED event was appended
    const events1 = await store.events.listByRun(input.runId);
    const completedEvent1 = events1.find((e) => e.type === "CERT_RUN_COMPLETED");
    expect(completedEvent1).toBeTruthy();
    expect(completedEvent1!.payload.result).toBe("PASS");
    expect(completedEvent1!.sequence).toBeGreaterThan(0);
    expect(typeof completedEvent1!.sequence).toBe("number");

    // Second completion with identical input is a no-op (no throw)
    await store.runs.completeRun(completeInput(input.runId));
    const loaded2 = await store.runs.loadRun(input.runId);
    expect(loaded2!.result).toBe("PASS");
    expect(loaded2!.completedAt).toBe(loaded1!.completedAt); // unchanged

    // Verify still only one CERT_RUN_COMPLETED event
    const events2 = await store.events.listByRun(input.runId);
    const completedCount = events2.filter((e) => e.type === "CERT_RUN_COMPLETED").length;
    expect(completedCount).toBe(1);

    // Different outcome throws
    await expect(
      store.runs.completeRun(completeInput(input.runId, { result: "FAIL", failureCode: "provider.unavailable" }))
    ).rejects.toThrow(/already completed with different outcome/);
  });

  it("3. append events → listByRun returns deterministic order by sequence", async () => {
    const runId = ulid();
    const correlationId = ulid();
    await store.runs.createRun(runInput({ runId, correlationId }));

    const e1 = auditEvent(runId, correlationId, "PREFLIGHT_PASSED", { secretsPresent: ["PLAID_ACCESS_TOKEN"] });
    const e2 = auditEvent(runId, correlationId, "PROVIDER_REQUEST_STARTED", { operation: "/accounts/get" });
    const e3 = auditEvent(runId, correlationId, "PROVIDER_REQUEST_SUCCEEDED", { operation: "/accounts/get", latencyMs: 123 });

    await store.events.append(e1);
    await store.events.append(e2);
    await store.events.append(e3);

    const events = await store.events.listByRun(runId);
    expect(events).toHaveLength(3);
    expect(events[0].type).toBe("PREFLIGHT_PASSED");
    expect(events[1].type).toBe("PROVIDER_REQUEST_STARTED");
    expect(events[2].type).toBe("PROVIDER_REQUEST_SUCCEEDED");
    // Sequence is 1..N monotonically
    expect(events[0].sequence).toBe(1);
    expect(events[1].sequence).toBe(2);
    expect(events[2].sequence).toBe(3);
    expect(typeof events[0].sequence).toBe("number");
  });

  it("4. append-only enforcement: raw UPDATE/DELETE on audit_events throws", async () => {
    const runId = ulid();
    const correlationId = ulid();
    await store.runs.createRun(runInput({ runId, correlationId }));

    const e = auditEvent(runId, correlationId, "PREFLIGHT_PASSED", { secretsPresent: [] });
    await store.events.append(e);

    const { Pool } = await import("pg");
    const pool = new Pool({ connectionString: TEST_CONNECTION });
    try {
      // Attempt UPDATE - should be blocked by trigger
      await expect(
        pool.query(`UPDATE audit_events SET status = 'failed' WHERE event_id = $1`, [e.eventId])
      ).rejects.toThrow(/audit_events are append-only/);

      // Attempt DELETE - should be blocked by trigger
      await expect(
        pool.query(`DELETE FROM audit_events WHERE event_id = $1`, [e.eventId])
      ).rejects.toThrow(/audit_events are append-only/);
    } finally {
      await pool.end();
    }
  });

  it("5. provider call evidence round-trip with safe fields only", async () => {
    const runId = ulid();
    const correlationId = ulid();
    await store.runs.createRun(runInput({ runId, correlationId }));

    const evidenceId = ulid();
    await store.providerCalls.record({
      evidenceId,
      runId,
      correlationId,
      occurredAt: new Date().toISOString(),
      operation: "/transactions/sync",
      httpStatus: 200,
      plaidErrorType: undefined,
      plaidErrorCode: undefined,
      plaidRequestId: "plaid-req-123",
      failureCode: undefined,
    });

    const calls = await store.providerCalls.listByRun(runId);
    expect(calls).toHaveLength(1);
    expect(calls[0].evidenceId).toBe(evidenceId);
    expect(calls[0].runId).toBe(runId);
    expect(calls[0].operation).toBe("/transactions/sync");
    expect(calls[0].httpStatus).toBe(200);
    expect(calls[0].plaidRequestId).toBe("plaid-req-123");
    // Sensitive fields are NOT present in the store schema
    expect(calls[0]).not.toHaveProperty("plaidAccessToken");
    expect(calls[0]).not.toHaveProperty("rawRequestBody");
  });

  it("6. missing PLAID_ACCESS_TOKEN scenario: PREFLIGHT_FAILED + CERT_RUN_COMPLETED(FAIL) reconstructs from listByRun", async () => {
    const runId = ulid();
    const correlationId = ulid();
    await store.runs.createRun(runInput({ runId, correlationId }));

    // Preflight failed - missing secret
    await store.events.append(
      auditEvent(runId, correlationId, "PREFLIGHT_FAILED", {
        failureCode: "configuration.missing_secret",
        field: "PLAID_ACCESS_TOKEN",
        providerCallAttempted: false,
      })
    );

    // Run completed with FAIL
    await store.runs.completeRun(
      completeInput(runId, {
        result: "FAIL",
        failureCode: "configuration.missing_secret",
        evidenceBoundary: {
          providerObservation: "none",
          cashEvent: "none",
          decision: "none",
          execution: "none",
          providerMutation: false,
        },
        gates: [{ gate: "preflight", status: "FAIL", failureCode: "configuration.missing_secret" }],
      })
    );

    // Reconstruction from stored evidence alone
    const loadedRun = await store.runs.loadRun(runId);
    const loadedEvents = await store.events.listByRun(runId);

    expect(loadedRun!.result).toBe("FAIL");
    expect(loadedRun!.failureCode).toBe("configuration.missing_secret");
    expect(loadedRun!.evidenceBoundary.providerObservation).toBe("none");
    expect(loadedRun!.evidenceBoundary.cashEvent).toBe("none");
    expect(loadedRun!.evidenceBoundary.execution).toBe("none");

    const preflightFailed = loadedEvents.find((e) => e.type === "PREFLIGHT_FAILED");
    expect(preflightFailed).toBeTruthy();
    expect(preflightFailed!.payload).toMatchObject({
      failureCode: "configuration.missing_secret",
      field: "PLAID_ACCESS_TOKEN",
      providerCallAttempted: false,
    });

    const completed = loadedEvents.find((e) => e.type === "CERT_RUN_COMPLETED");
    expect(completed).toBeTruthy();
    expect(completed!.payload.result).toBe("FAIL");
  });

  it("7. migration idempotency: runMigrations twice does not throw", async () => {
    await runMigrations(TEST_CONNECTION); // second call
    // If we get here without throwing, migration is idempotent
    const loaded = await store.runs.loadRun(ulid()); // should just return null
    expect(loaded).toBeNull();
  });

  it("8. listByCorrelationId returns events across runs in occurredAt order", async () => {
    const correlationId = ulid();

    // Run 1
    const runId1 = ulid();
    await store.runs.createRun(runInput({ runId: runId1, correlationId }));
    await store.events.append(auditEvent(runId1, correlationId, "PREFLIGHT_PASSED", { secretsPresent: [] }));

    // Run 2 (later)
    const runId2 = ulid();
    await store.runs.createRun(runInput({ runId: runId2, correlationId }));
    await store.events.append(auditEvent(runId2, correlationId, "PREFLIGHT_PASSED", { secretsPresent: [] }));

    const all = await store.events.listByCorrelationId(correlationId);
    expect(all).toHaveLength(2);
    expect(all[0].runId).toBe(runId1);
    expect(all[1].runId).toBe(runId2);
  });

  it("9. concurrent-ish appends to same run don't collide (advisory lock works)", async () => {
    const runId = ulid();
    const correlationId = ulid();
    await store.runs.createRun(runInput({ runId, correlationId }));

    const events = Array.from({ length: 5 }, (_, i) =>
      auditEvent(runId, correlationId, "OBSERVATION_RECEIVED", {
        observationId: `obs-${i}`,
        externalRefFingerprint: `fp-${i}`,
        direction: "credit",
        amountCents: cents(10000 + i * 100),
        posted: true,
      })
    );

    // Fire concurrently - advisory lock serializes sequence assignment
    await Promise.all(events.map((e) => store.events.append(e)));

    const loaded = await store.events.listByRun(runId);
    expect(loaded).toHaveLength(5);
    const sequences = loaded.map((e) => e.sequence).sort((a, b) => a - b);
    expect(sequences).toEqual([1, 2, 3, 4, 5]); // no gaps, no duplicates
  });
});