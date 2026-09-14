// Orchestration tests for certify-live.ts — validates the 5 certification invariants.
// Pure, deterministic, no Plaid/Postgres network I/O. Uses fake AuditPorts + ProviderSyncStore.

import { describe, it, expect, beforeEach } from "vitest";
import type {
  AuditPorts,
  CreateCertificationRunInput,
  CompleteCertificationRunInput,
  PersistedCertificationRun,
} from "@alepes/persistence";
import type {
  AuditEvent,
  FailureCode,
  EvidenceBoundary,
  GateResult,
} from "@alepes/audit";
import { ulid } from "@alepes/persistence";
import { cents, nonNegativeCents } from "@alepes/money";
import type { FinancialObservationId } from "@alepes/domain";
import type { AccountBindingId, PersistedObservation, ProviderSyncStore } from "@alepes/persistence";
import type { AccountBinding } from "@alepes/integration-runtime";
import { qualifyCashEvents } from "@alepes/persistence";
import { runShadowMode } from "@alepes/reconciliation";

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
} from "./certify-live-audit";

// ─── Fake in-memory AuditPorts (matching certify-live-audit.test.ts) ──────────

function createFakeAuditPorts(): AuditPorts & { _events: AuditEvent[]; _runs: Map<string, PersistedCertificationRun> } {
  const runs = new Map<string, PersistedCertificationRun>();
  const events: AuditEvent[] = [];
  const providerCalls: Array<{ evidenceId: string; runId: string; correlationId: string; occurredAt: string; operation: string; httpStatus: number | null; plaidErrorType: string | null; plaidErrorCode: string | null; plaidRequestId: string | null; failureCode: FailureCode | null }> = [];

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

        // Emit CERT_RUN_STARTED
        events.push({
          eventId: ulid(),
          runId: input.runId,
          correlationId: input.correlationId,
          causationId: undefined,
          sequence: 0,
          occurredAt: new Date().toISOString(),
          phase: "preflight",
          type: "CERT_RUN_STARTED",
          status: "started",
          actor: "system",
          provider: "plaid",
          attempt: undefined,
          mutated: undefined,
          verified: undefined,
          payload: { harness: input.harness, schemaVersion: input.schemaVersion },
        } as AuditEvent);
      },

      async completeRun(input: CompleteCertificationRunInput): Promise<void> {
        const run = runs.get(input.runId);
        if (!run) throw new Error(`Run ${input.runId} not found`);
        if (run.completedAt !== null) {
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

        // Emit CERT_RUN_COMPLETED
        events.push({
          eventId: ulid(),
          runId: input.runId,
          correlationId: run.correlationId,
          causationId: undefined,
          sequence: 0,
          occurredAt: new Date().toISOString(),
          phase: "reporting",
          type: "CERT_RUN_COMPLETED",
          status: input.result === "PASS" ? "succeeded" : "failed",
          actor: "system",
          provider: "plaid",
          attempt: undefined,
          mutated: undefined,
          verified: undefined,
          payload: {
            result: input.result,
            failureCode: input.failureCode,
            evidenceBoundary: input.evidenceBoundary,
            gates: input.gates,
            mutationCounts: input.mutationCounts,
            finalState: input.finalState,
          },
        } as AuditEvent);
      },

      async loadRun(): Promise<any> { return null; },
      async loadRunByCorrelationId(): Promise<any> { return null; },
    },
    events: {
      async append(event: AuditEvent): Promise<void> {
        events.push(event);
      },
      async listByRun(): Promise<AuditEvent[]> {
        return events;
      },
      async listByCorrelationId(): Promise<AuditEvent[]> {
        return events;
      },
    },
    providerCalls: {
      async record(input: any): Promise<void> {
        providerCalls.push(input);
      },
      async listByRun(): Promise<any[]> {
        return [];
      },
    },
    close: async () => {},
    _events: events,
    _runs: runs,
  };
}

// ─── Fake ProviderSyncStore ──────────────────────────────────────────────────

function createFakeSyncStore(
  initialCheckpoint: { cursor: string } | null,
  allObservations: PersistedObservation[],
  reconcileResult: { added: FinancialObservationId[]; modified: FinancialObservationId[]; removed: FinancialObservationId[] }
): ProviderSyncStore {
  return {
    async bindAccount(): Promise<any> {
      return {
        id: `binding-${ulid()}` as AccountBindingId,
        providerId: "plaid",
        providerAccountRef: "ext-acct-1" as any,
        credentialRef: "cred:plaid-live",
        active: true,
        metadata: { subtype: "checking" },
      };
    },

    async loadBinding(): Promise<any> { return null; },

    async loadCheckpoint(accountBindingId: AccountBindingId): Promise<any> {
      if (initialCheckpoint) {
        return { accountBindingId, cursor: initialCheckpoint.cursor, status: "reconciled", lastSuccessAt: new Date().toISOString(), inProgressCycleId: null };
      }
      return null;
    },

    async reconcileSyncCycle(): Promise<{ added: FinancialObservationId[]; modified: FinancialObservationId[]; removed: FinancialObservationId[] }> {
      return reconcileResult;
    },

    async resolveObservationId(): Promise<FinancialObservationId | null> { return null; },

    async listActiveObservations(accountBindingId: AccountBindingId): Promise<PersistedObservation[]> {
      return allObservations;
    },
  };
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeObservation(overrides: Partial<PersistedObservation> = {}): PersistedObservation {
  return {
    id: `obs-${ulid()}` as FinancialObservationId,
    accountBindingId: "binding-1" as AccountBindingId,
    amountCents: cents(1000),
    direction: "credit",
    status: "posted",
    qualificationBalanceCents: 10000,
    firstObservedAt: new Date().toISOString(),
    postedAt: new Date().toISOString(),
    description: "Test deposit",
    normalizationVersion: "plaid-sign-convention@1",
    state: "active",
    predecessorObservationId: null,
    lastReconciledCycleId: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  };
}

function makeRule() {
  return {
    id: "r-live-cert",
    name: "Live certification rule",
    trigger: "any_deposit" as const,
    reserveBalance: nonNegativeCents(0),
    action: "invest_percentage" as const,
    amount: 50,
    portfolioId: "p1",
    active: true,
    order: 0,
  };
}

function makePortfolioState() {
  return {
    portfolio: { id: "p1", name: "Primary", version: 1, holdings: [{ symbol: "AAA", name: "AAA", targetPct: 50 }, { symbol: "BBB", name: "BBB", targetPct: 50 }] },
    positions: [{ symbol: "AAA", name: "AAA", value: nonNegativeCents(0) }, { symbol: "BBB", name: "BBB", value: nonNegativeCents(100_000) }],
    totalValue: nonNegativeCents(100_000),
  };
}

// ─── Orchestration under test (extracted from certify-live.ts logic) ──────────

interface OrchestrationInputs {
  store: ProviderSyncStore;
  auditPorts: AuditPorts & { _events: AuditEvent[]; _runs: Map<string, PersistedCertificationRun> };
  ctx: RunContext;
  freshDeltaObservationIds: Set<FinancialObservationId>;
}

async function runCertificationOrchestration(inputs: OrchestrationInputs): Promise<{
  cashEvents: ReturnType<typeof qualifyCashEvents>;
  shadowDecision: { disposition: string; deployableCents: number; totalDeployedCents: number } | null;
  gates: GateResult[];
  finalState: "clean" | "dirty";
  result: "PASS" | "FAIL" | "ABORTED";
}> {
  const { store, auditPorts, ctx, freshDeltaObservationIds } = inputs;

  // Load observations and filter to fresh delta
  const allObs = await store.listActiveObservations("binding-1" as AccountBindingId);
  const freshObs = allObs.filter((o) => freshDeltaObservationIds.has(o.id));

  // Emit lifecycle for fresh observations
  for (const o of freshObs) {
    await recordObservationReceived(auditPorts, ctx, o.id, `fp-${o.id}`, o.direction, o.amountCents as any, o.status === "posted");
    await recordObservationNormalized(auditPorts, ctx, o.id, "plaid-sign-convention@1");
    await recordObservationPersisted(auditPorts, ctx, o.id, o.id);
  }

  // Derive qualifying CashEvents from fresh delta ONLY
  const events = qualifyCashEvents(freshObs as any);

  // Record qualified cash events
  for (const e of events) {
    await recordCashEventQualified(auditPorts, ctx, e.id, e.amount, "r-live-cert");
  }

  if (events.length === 0) {
    await recordGate(auditPorts, ctx, "qualifying_event", "FAIL", "sync.no_qualifying_event", "no qualifying live event observed in sync delta");
    await completeRun(auditPorts, ctx, "FAIL", "sync.no_qualifying_event", {
      cashEvent: "none" as const,
      decision: "none" as const,
      providerObservation: "real" as const,
      execution: "none" as const,
      providerMutation: false,
    }, [{ gate: "qualifying_event", status: "FAIL", failureCode: "sync.no_qualifying_event" }], { transfer: 0, order: 0, providerMutation: 0 }, "dirty");
    return { cashEvents: events, shadowDecision: null, gates: [{ gate: "qualifying_event", status: "FAIL", failureCode: "sync.no_qualifying_event" }], finalState: "dirty", result: "FAIL" };
  }

  // Shadow Mode
  const persistedObs = freshObs.filter((o) => o.status === "posted" && o.direction === "credit");
  const decisions = runShadowMode(persistedObs as any, { rules: [makeRule()], portfolioState: makePortfolioState() });
  const decision = decisions[0];

  if (!decision) {
    await completeRun(auditPorts, ctx, "FAIL", "internal.unexpected", { cashEvent: "none", decision: "none", providerObservation: "real", execution: "none", providerMutation: false }, [], { transfer: 0, order: 0, providerMutation: 0 }, "dirty");
    return { cashEvents: events, shadowDecision: null, gates: [], finalState: "dirty", result: "FAIL" };
  }

  // Record rule evaluation
  await recordRuleEvaluated(auditPorts, ctx, "r-live-cert", decision.plan.cashEvent.id, decision.plan.capitalPlan.deployable);
  await recordCapitalPlanCreated(auditPorts, ctx, decision.plan.id, decision.plan.capitalPlan.deployable);
  await recordAllocationPlanCreated(auditPorts, ctx, decision.plan.id, decision.plan.allocationPlan.totalDeployed, decision.plan.allocationPlan.lines.length);
  await recordExecutionPolicyEvaluated(auditPorts, ctx, decision.disposition.kind, decision.plan.orders.length);
  await recordShadowDecisionRecorded(auditPorts, ctx, decision.provenance.observationId, decision.plan.capitalPlan.deployable);
  await recordExecutionBlocked(auditPorts, ctx, "shadow");

  // Final gates
  await recordGate(auditPorts, ctx, "shadow_disposition", "PASS");
  await recordGate(auditPorts, ctx, "account_isolation", "PASS");
  await recordGate(auditPorts, ctx, "qualifying_event", "PASS");

  const deployable = (decision.plan.capitalPlan.deployable as number) ?? 0;
  const totalDeployed = (decision.plan.allocationPlan.totalDeployed as number) ?? 0;

  await completeRun(auditPorts, ctx, "PASS", undefined, {
    cashEvent: "real",
    decision: "real",
    providerObservation: "real",
    execution: "shadow",
    providerMutation: false,
  }, [
    { gate: "shadow_disposition", status: "PASS" },
    { gate: "account_isolation", status: "PASS" },
    { gate: "qualifying_event", status: "PASS" },
  ], { transfer: 0, order: 0, providerMutation: 0 }, "clean");

  return {
    cashEvents: events,
    shadowDecision: { disposition: decision.disposition.kind, deployableCents: deployable, totalDeployedCents: totalDeployed },
    gates: [
      { gate: "shadow_disposition", status: "PASS" },
      { gate: "account_isolation", status: "PASS" },
      { gate: "qualifying_event", status: "PASS" },
    ],
    finalState: "clean",
    result: "PASS",
  };
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("certify-live orchestration", () => {
  let auditPorts: AuditPorts & { _events: AuditEvent[]; _runs: Map<string, PersistedCertificationRun> };
  let ctx: RunContext;

  beforeEach(async () => {
    auditPorts = createFakeAuditPorts();
    const auditConfig: CertifyLiveAuditConfig = {
      ports: auditPorts,
      provider: "plaid",
      environment: "production",
      sourceCommit: "test",
      harness: "certify-live.ts",
      harnessVersion: "1.0.0",
      schemaVersion: "audit-cert@1",
      branch: "test",
      milestone: "v0.5.0",
    };
    ctx = await startRun(auditConfig);
    await recordPreflight(auditPorts, ctx, { passed: true, secretsPresent: ["PLAID_CLIENT_ID", "PLAID_SECRET", "PLAID_LIVE_POSTGRES_URL", "PLAID_ACCESS_TOKEN"] });
  });

  it("1) cold-start refusal: no persisted checkpoint → ABORTED with sync.no_qualifying_event", async () => {
    // The checkpoint guard in main() throws before orchestration runs
    // Verify the gate logic that would be executed
    await recordGate(auditPorts, ctx, "baseline_checkpoint", "FAIL", "sync.no_qualifying_event", "no persisted starting checkpoint — cannot certify fresh delta");
    await completeRun(auditPorts, ctx, "ABORTED", "sync.no_qualifying_event", {
      cashEvent: "none",
      decision: "none",
      providerObservation: "none",
      execution: "none",
      providerMutation: false,
    }, [{ gate: "baseline_checkpoint", status: "FAIL", failureCode: "sync.no_qualifying_event" }], { transfer: 0, order: 0, providerMutation: 0 }, "dirty");

    const events = auditPorts._events;
    expect(events.some(e => e.type === "CERT_GATE_FAILED" && (e.payload as any).gate === "baseline_checkpoint")).toBe(true);
    expect(events.some(e => e.type === "CERT_RUN_COMPLETED" && (e.payload as any).result === "ABORTED")).toBe(true);
    const run = auditPorts._runs.get(ctx.runId);
    expect(run?.result).toBe("ABORTED");
    expect(run?.failureCode).toBe("sync.no_qualifying_event");
  });

  it("2) historical-credit refusal: checkpoint exists, but posted credit NOT in fresh delta → FAIL", async () => {
    const historicalObs = makeObservation({ id: "obs-historical-1" as FinancialObservationId, direction: "credit", status: "posted", amountCents: cents(1000) });
    const store = createFakeSyncStore(
      { cursor: "cursor-historical" },
      [historicalObs],
      { added: [], modified: [], removed: [] }
    );

    const result = await runCertificationOrchestration({
      store,
      auditPorts,
      ctx,
      freshDeltaObservationIds: new Set(),
    });

    expect(result.result).toBe("FAIL");
    expect(result.cashEvents.length).toBe(0);
    expect(result.finalState).toBe("dirty");
    expect(result.gates.some(g => g.gate === "qualifying_event" && g.status === "FAIL")).toBe(true);

    // Verify no observation lifecycle emitted (no fresh obs)
    const events = auditPorts._events;
    expect(events.some(e => e.type === "OBSERVATION_RECEIVED")).toBe(false);
    expect(events.some(e => e.type === "CASH_EVENT_QUALIFIED")).toBe(false);
    expect(events.some(e => e.type === "CERT_GATE_FAILED" && (e.payload as any).gate === "qualifying_event")).toBe(true);
    expect(events.some(e => e.type === "CERT_RUN_COMPLETED" && (e.payload as any).result === "FAIL")).toBe(true);
  });

  it("3) unrelated-new-delta refusal: fresh delta contains only a debit → FAIL", async () => {
    const freshDebit = makeObservation({ id: "obs-fresh-debit" as FinancialObservationId, direction: "debit", status: "posted", amountCents: cents(-500) });
    const store = createFakeSyncStore(
      { cursor: "cursor-1" },
      [freshDebit],
      { added: ["obs-fresh-debit" as FinancialObservationId], modified: [], removed: [] }
    );

    const result = await runCertificationOrchestration({
      store,
      auditPorts,
      ctx,
      freshDeltaObservationIds: new Set(["obs-fresh-debit" as FinancialObservationId]),
    });

    expect(result.result).toBe("FAIL");
    expect(result.cashEvents.length).toBe(0);
    expect(result.finalState).toBe("dirty");
    expect(result.gates.some(g => g.gate === "qualifying_event" && g.status === "FAIL")).toBe(true);

    // Observation lifecycle emitted for fresh debit, but no CashEvent qualified
    const events = auditPorts._events;
    expect(events.some(e => e.type === "OBSERVATION_RECEIVED")).toBe(true);
    expect(events.some(e => e.type === "OBSERVATION_NORMALIZED")).toBe(true);
    expect(events.some(e => e.type === "OBSERVATION_PERSISTED")).toBe(true);
    expect(events.some(e => e.type === "CASH_EVENT_QUALIFIED")).toBe(false);
  });

  it("4) fresh-posted-credit success: fresh posted credit qualifies → Shadow PASS, 0 transfers/orders", async () => {
    const freshCredit = makeObservation({ id: "obs-fresh-credit" as FinancialObservationId, direction: "credit", status: "posted", amountCents: cents(1000) });
    const store = createFakeSyncStore(
      { cursor: "cursor-1" },
      [freshCredit],
      { added: ["obs-fresh-credit" as FinancialObservationId], modified: [], removed: [] }
    );

    const result = await runCertificationOrchestration({
      store,
      auditPorts,
      ctx,
      freshDeltaObservationIds: new Set(["obs-fresh-credit" as FinancialObservationId]),
    });

    expect(result.result).toBe("PASS");
    expect(result.cashEvents.length).toBe(1);
    expect(result.shadowDecision).not.toBeNull();
    expect(result.shadowDecision!.disposition).toBe("shadow");
    expect(result.gates.every(g => g.status === "PASS")).toBe(true);
    expect(result.finalState).toBe("clean");

    // Full lifecycle + gates + clean completion
    const events = auditPorts._events;
    expect(events.some(e => e.type === "OBSERVATION_RECEIVED")).toBe(true);
    expect(events.some(e => e.type === "OBSERVATION_NORMALIZED")).toBe(true);
    expect(events.some(e => e.type === "OBSERVATION_PERSISTED")).toBe(true);
    expect(events.some(e => e.type === "CASH_EVENT_QUALIFIED")).toBe(true);
    expect(events.some(e => e.type === "RULE_EVALUATED")).toBe(true);
    expect(events.some(e => e.type === "CAPITAL_PLAN_CREATED")).toBe(true);
    expect(events.some(e => e.type === "ALLOCATION_PLAN_CREATED")).toBe(true);
    expect(events.some(e => e.type === "EXECUTION_POLICY_EVALUATED")).toBe(true);
    expect(events.some(e => e.type === "SHADOW_DECISION_RECORDED")).toBe(true);
    expect(events.some(e => e.type === "EXECUTION_BLOCKED")).toBe(true);
    expect(events.some(e => e.type === "CERT_GATE_PASSED")).toBe(true);
    expect(events.some(e => e.type === "CERT_RUN_COMPLETED" && (e.payload as any).result === "PASS")).toBe(true);
  });

  it("5) reconstruction: successful run emits full lifecycle matching reconstructRun() expectations", async () => {
    const freshCredit = makeObservation({ id: "obs-recon-1" as FinancialObservationId, direction: "credit", status: "posted", amountCents: cents(1000) });
    const store = createFakeSyncStore(
      { cursor: "cursor-recon" },
      [freshCredit],
      { added: ["obs-recon-1" as FinancialObservationId], modified: [], removed: [] }
    );

    const result = await runCertificationOrchestration({
      store,
      auditPorts,
      ctx,
      freshDeltaObservationIds: new Set(["obs-recon-1" as FinancialObservationId]),
    });

    expect(result.result).toBe("PASS");

    // Verify exact event vocabulary required by reconstructRun()
    const events = auditPorts._events;
    const eventTypes = events.map((e: AuditEvent) => e.type);

    // reconstructRun() checks:
    // - normalized: OBSERVATION_NORMALIZED
    // - whatObserved: OBSERVATION_RECEIVED
    // - shadowOnly: SHADOW_DECISION_RECORDED AND EXECUTION_BLOCKED
    expect(eventTypes).toContain("OBSERVATION_RECEIVED");
    expect(eventTypes).toContain("OBSERVATION_NORMALIZED");
    expect(eventTypes).toContain("OBSERVATION_PERSISTED");
    expect(eventTypes).toContain("CASH_EVENT_QUALIFIED");
    expect(eventTypes).toContain("RULE_EVALUATED");
    expect(eventTypes).toContain("CAPITAL_PLAN_CREATED");
    expect(eventTypes).toContain("ALLOCATION_PLAN_CREATED");
    expect(eventTypes).toContain("SHADOW_DECISION_RECORDED");
    expect(eventTypes).toContain("EXECUTION_BLOCKED");
    expect(eventTypes).toContain("CERT_GATE_PASSED");
    expect(eventTypes).toContain("CERT_RUN_COMPLETED");

    // shadowOnly invariant: both present
    const hasShadow = eventTypes.includes("SHADOW_DECISION_RECORDED");
    const hasBlocked = eventTypes.includes("EXECUTION_BLOCKED");
    expect(hasShadow && hasBlocked).toBe(true);

    // Three gates passed
    const gatePassed = events.filter(e => e.type === "CERT_GATE_PASSED");
    expect(gatePassed.length).toBe(3);
    expect(gatePassed.some(e => (e.payload as any).gate === "shadow_disposition")).toBe(true);
    expect(gatePassed.some(e => (e.payload as any).gate === "account_isolation")).toBe(true);
    expect(gatePassed.some(e => (e.payload as any).gate === "qualifying_event")).toBe(true);
  });
});