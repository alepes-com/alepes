# ADR: Audit + Certification Evidence Contract

**Status:** Proposed  
**Date:** 2026-09-10  
**Branch:** `feat/plaid-live-real-cash-event` (HEAD `cf31ec7`)  
**Related:** AGENTS.md §1 (financial core authority), §3 (architecture), §103 (data integrity), §136 (automation boundaries), §167 (numeric correctness), §194 (evidence levels)

---

## 1. Problem & Scope

Recent Plaid live-certification failures were difficult to reconstruct from durable evidence. A failed run left only terminal stdout, which is ephemeral, unstructured, and mixes diagnostics with secrets. We need a **durable, structured, provider-neutral** audit and certification reporting system that:

- Makes "what Alepes observed, decided, recorded, blocked, reconciled, and why" machine-reconstructible
- Keeps secrets and raw provider payloads **out of all durable/report/trace paths**
- Distinguishes **authoritative financial evidence** (Postgres) from **operational telemetry** (traces) and **certification reports** (versioned JSON/Markdown)
- Preserves existing v0.5.0 real-event and Shadow-only semantics unchanged
- Requires **no credentialed Plaid Production run** to prove

---

## 2. Architectural Boundaries (Frozen)

### 2.1 Three Evidence Layers (Strictly Separated)

| Layer | Authority | Storage | Contains | Does NOT Contain |
|-------|-----------|---------|----------|------------------|
| **Durable Audit Ledger** | Authoritative financial evidence | Postgres (append-only) | Typed audit events, certification runs, gate results, provider-call evidence (safe fields only) | Raw provider bodies, secrets, tokens, request/response headers, banking credentials |
| **Operational Tracing** | Diagnostic / reconstruction | OTel-compatible (stdout / collector) | Frozen attribute contract (runId, correlationId, provider, phase, failureCode, attempt, mutated, verified, disposition) | Any secret, raw identifier, request/response body, auth header, DB URL |
| **Certification Reporting** | Versioned structured report | JSON (canonical) → Markdown/console (derived) | Schema-versioned `CertificationReport` with internal/raw and sanitized/public variants | Secrets, connection strings, raw account/Item IDs, provider bodies, banking credentials |

**Invariant:** Telemetry and Reporting are **never authoritative over the Audit Ledger**. Postgres remains the transactional authority (AGENTS.md §125).

### 2.2 Package Boundaries

| Package | Ownership | Depends On |
|---------|-----------|------------|
| `@alepes/audit` | **Types only**: `CertificationRun`, discriminated-union `AuditEvent`, `FailureCode`, `EvidenceBoundary`, `GateResult`, provider-neutral provider-call evidence shape | `domain`, `money`, `integration-runtime` (for `ProviderError`) |
| `@alepes/reporting` | **Logic**: canonical JSON schemas (`v1`), allowlist sanitizer, Markdown/console renderers, reconstruction query | `audit`, `certification-guards` (for `fingerprint`, `createRedactor`, `assertShadowOnly`) |
| `@alepes/persistence` (existing) | **Storage**: DDL + repository for `certification_runs`, `audit_events`, `provider_call_evidence` (and gate results folded in) | `audit` (types) |

**Do NOT create** `@alepes/certification-reporting` as separate from `@alepes/reporting` — one package for report logic. **Do NOT create** a second persistence package; audit tables live in `@alepes/persistence`.

### 2.3 No Event Sourcing

Existing relational state (`CashEvent`, `CapitalPlan`, `AllocationPlan`, `ExecutionPlan`, `LedgerEntry`, outbox) remains current state of the world. The audit ledger **explains how Alepes arrived there** — it does not replace it.

---

## 3. Core Domain Model (Frozen Shapes)

### 3.1 `CertificationRun` (First-Class Durable Object)

```typescript
type Milestone = "v0.4.0" | "v0.5.0" | "v0.6.0" | string;
type ProviderName = "plaid" | "alpaca" | string;
type Environment = "production" | "sandbox" | "paper" | string;
type RunResult = "PASS" | "FAIL" | "ABORTED";
type EvidenceKind = "real" | "synthetic" | "none";

interface EvidenceBoundary {
  providerObservation: EvidenceKind;
  cashEvent: EvidenceKind;
  decision: EvidenceKind;
  execution: "shadow" | "approval" | "execute" | "none";
  providerMutation: boolean;
}

interface GateResult {
  gate: string;              // stable gate identifier
  status: "PASS" | "FAIL" | "SKIPPED" | "UNSUPPORTED";
  failureCode?: FailureCode;
  detail?: unknown;          // safe, redacted
}

interface CertificationRun {
  runId: string;                    // ULID
  correlationId: string;            // for trace correlation
  milestone: Milestone;
  provider: ProviderName;
  environment: Environment;
  sourceCommit: string;             // git SHA
  branch?: string;                  // if deterministically available
  harness: string;                  // e.g. "certify-live.ts"
  harnessVersion: string;           // schema version of harness contract
  schemaVersion: string;            // "audit-cert@1"
  startedAt: string;                // ISO 8601
  completedAt?: string;
  result: RunResult;
  failureCode?: FailureCode;
  evidenceBoundary: EvidenceBoundary;
  gates: GateResult[];
  mutationCounts: {
    transfer: number;
    order: number;
    providerMutation: number;
  };
  finalState: "clean" | "dirty";   // reconciliation/final state
}
```

### 3.2 Discriminated-Union Audit Events (Strict, Only Real Producers)

```typescript
type AuditEventPhase =
  | "preflight"
  | "provider"
  | "observation"
  | "normalization"
  | "persistence"
  | "qualification"
  | "policy"
  | "execution"
  | "reconciliation"
  | "reporting";

type AuditEventType =
  // Preflight
  | "CERT_RUN_STARTED"
  | "PREFLIGHT_PASSED"
  | "PREFLIGHT_FAILED"
  // Provider boundary
  | "PROVIDER_REQUEST_STARTED"
  | "PROVIDER_REQUEST_SUCCEEDED"
  | "PROVIDER_REQUEST_FAILED"
  // Observation lifecycle
  | "OBSERVATION_RECEIVED"
  | "OBSERVATION_NORMALIZED"
  | "OBSERVATION_PERSISTED"
  | "OBSERVATION_RECONCILED"
  // Cash-event qualification
  | "CASH_EVENT_QUALIFIED"
  | "CASH_EVENT_REJECTED"
  // Policy pipeline (producers exist in v0.5.0)
  | "RULE_EVALUATED"
  | "CAPITAL_PLAN_CREATED"
  | "ALLOCATION_PLAN_CREATED"
  | "EXECUTION_PLAN_CREATED"
  | "EXECUTION_POLICY_EVALUATED"
  // Execution
  | "SHADOW_DECISION_RECORDED"
  | "EXECUTION_BLOCKED"
  // Outbox / audit
  | "OUTBOX_RECORDED"
  | "AUDIT_RECORDED"
  // Reconciliation
  | "RECONCILIATION_STARTED"
  | "RECONCILIATION_SUCCEEDED"
  | "RECONCILIATION_FAILED"
  // Idempotency / safety
  | "IDEMPOTENCY_CHECK"
  | "DUPLICATE_EVENT_SUPPRESSED"
  // Certification gates
  | "CERT_GATE_PASSED"
  | "CERT_GATE_FAILED"
  | "CERT_GATE_SKIPPED"
  | "REDACTION_VIOLATION"
  // Completion
  | "CERT_RUN_COMPLETED";

interface AuditEventBase {
  eventId: string;              // ULID
  runId: string;
  correlationId: string;
  causationId?: string;         // previous eventId in causal chain
  sequence: number;             // monotonically increasing per run
  occurredAt: string;           // ISO 8601
  phase: AuditEventPhase;
  type: AuditEventType;
  status: "started" | "succeeded" | "failed" | "skipped";
  actor: "system" | "provider" | "human";
  provider?: ProviderName;
  attempt?: number;
  mutated?: boolean;
  verified?: boolean;
}

type AuditEvent =
  | (AuditEventBase & { type: "CERT_RUN_STARTED"; payload: { harness: string; schemaVersion: string } })
  | (AuditEventBase & { type: "PREFLIGHT_PASSED"; payload: { secretsPresent: string[] } })
  | (AuditEventBase & { type: "PREFLIGHT_FAILED"; payload: { failureCode: FailureCode; field?: string; providerCallAttempted: false } })
  | (AuditEventBase & { type: "PROVIDER_REQUEST_STARTED"; payload: { operation: string; accountIdFingerprint?: string } })
  | (AuditEventBase & { type: "PROVIDER_REQUEST_SUCCEEDED"; payload: { operation: string; latencyMs: number } })
  | (AuditEventBase & { type: "PROVIDER_REQUEST_FAILED"; payload: { failureCode: FailureCode; httpStatus?: number; plaidErrorType?: string; plaidErrorCode?: string; plaidRequestId?: string } })
  | (AuditEventBase & { type: "OBSERVATION_RECEIVED"; payload: { observationId: string; externalRefFingerprint: string; direction: "credit" | "debit"; amountCents: number; posted: boolean } })
  | (AuditEventBase & { type: "OBSERVATION_NORMALIZED"; payload: { observationId: string; normalizationVersion: string } })
  | (AuditEventBase & { type: "OBSERVATION_PERSISTED"; payload: { observationId: string; persistedId: string } })
  | (AuditEventBase & { type: "OBSERVATION_RECONCILED"; payload: { observationId: string; cycleId: string } })
  | (AuditEventBase & { type: "CASH_EVENT_QUALIFIED"; payload: { cashEventId: string; amountCents: number; ruleId: string } })
  | (AuditEventBase & { type: "CASH_EVENT_REJECTED"; payload: { reason: string; observationId: string } })
  | (AuditEventBase & { type: "RULE_EVALUATED"; payload: { ruleId: string; cashEventId: string; capitalAmountCents: number } })
  | (AuditEventBase & { type: "CAPITAL_PLAN_CREATED"; payload: { capitalPlanId: string; deployableCents: number } })
  | (AuditEventBase & { type: "ALLOCATION_PLAN_CREATED"; payload: { allocationPlanId: string; totalDeployedCents: number; lines: number } })
  | (AuditEventBase & { type: "EXECUTION_PLAN_CREATED"; payload: { executionPlanId: string; orderCount: number } })
  | (AuditEventBase & { type: "EXECUTION_POLICY_EVALUATED"; payload: { disposition: "shadow" | "approval" | "execute"; executeCount: number } })
  | (AuditEventBase & { type: "SHADOW_DECISION_RECORDED"; payload: { decisionId: string; disposition: "shadow"; deployableCents: number } })
  | (AuditEventBase & { type: "EXECUTION_BLOCKED"; payload: { reason: string; executeCount: 0; transferCount: 0; orderCount: 0 } })
  | (AuditEventBase & { type: "OUTBOX_RECORDED"; payload: { outboxEventId: string } })
  | (AuditEventBase & { type: "AUDIT_RECORDED"; payload: { auditRecordId: string } })
  | (AuditEventBase & { type: "RECONCILIATION_STARTED"; payload: { cycleId: string } })
  | (AuditEventBase & { type: "RECONCILIATION_SUCCEEDED"; payload: { cycleId: string } })
  | (AuditEventBase & { type: "RECONCILIATION_FAILED"; payload: { cycleId: string; failureCode: FailureCode } })
  | (AuditEventBase & { type: "IDEMPOTENCY_CHECK"; payload: { key: string; duplicate: boolean } })
  | (AuditEventBase & { type: "DUPLICATE_EVENT_SUPPRESSED"; payload: { key: string } })
  | (AuditEventBase & { type: "CERT_GATE_PASSED"; payload: { gate: string } })
  | (AuditEventBase & { type: "CERT_GATE_FAILED"; payload: { gate: string; failureCode: FailureCode } })
  | (AuditEventBase & { type: "CERT_GATE_SKIPPED"; payload: { gate: string; reason: string } })
  | (AuditEventBase & { type: "REDACTION_VIOLATION"; payload: { field: string; fingerprint: string } })
  | (AuditEventBase & { type: "CERT_RUN_COMPLETED"; payload: { result: RunResult; evidenceBoundary: EvidenceBoundary } });
```

**Events without a real producer in v0.5.0 are explicitly listed but marked `// future: not yet emitted` in code and must not be constructed until their producer exists.**

### 3.3 Alepes-Owned Failure Taxonomy (Stable, Separate from Provider Codes)

```typescript
type FailureCode =
  | "configuration.missing_secret"
  | "configuration.invalid_environment"
  | "provider.invalid_request"
  | "provider.authentication_failed"
  | "provider.item_login_required"
  | "provider.product_not_enabled"
  | "provider.rate_limited"
  | "provider.unavailable"
  | "persistence.unavailable"
  | "sync.cursor_conflict"
  | "sync.restart_required"
  | "sync.no_qualifying_event"
  | "policy.no_match"
  | "safety.execution_surface_reachable"
  | "safety.provider_mutation_detected"
  | "redaction.violation"
  | "internal.unexpected";
```

**Mapping rule:** `classifyPlaidError` output (`error_type`/`error_code`/`request_id`) → `FailureCode` via a pure map function in `@alepes/audit` (e.g., `Plaid.INVALID_INPUT` → `provider.invalid_request`). Never leak Plaid strings into domain types.

---

## 4. Persistence (Postgres, Append-Only)

### 4.1 Tables (Reuse `@alepes/persistence` patterns)

| Table | Purpose | Key Indexes |
|-------|---------|-------------|
| `certification_runs` | One row per run | `runId` (PK), `correlationId`, `startedAt`, `provider`, `environment` |
| `audit_events` | Append-only event stream | `eventId` (PK), `runId`, `correlationId`, `occurredAt`, `type`, `phase`, `observationId`, `cashEventId`, `capitalPlanId`, `allocationPlanId`, `executionPlanId`, `outboxEventId`, `auditRecordId` |
| `provider_call_evidence` | Safe provider interaction record | `evidenceId` (PK), `runId`, `correlationId`, `occurredAt`, `operation`, `httpStatus`, `plaidErrorType`, `plaidErrorCode`, `plaidRequestId`, `failureCode` |

**Do NOT create** `certification_gate_results` or `evidence_artifacts` as separate tables — fold gates into `certification_runs.gates` (JSONB) and artifacts into `audit_events.payload` + `provider_call_evidence`.

### 4.2 Constraints & Invariants

- `audit_events.runId` FK → `certification_runs.runId` (cascade delete forbidden; runs are immutable)
- `audit_events.sequence` unique per `runId` (deterministic ordering)
- `certification_runs.result` CHECK (`PASS`|`FAIL`|`ABORTED`)
- No float money columns — `amountCents` stored as `BIGINT` (Cents)
- No secret/credential columns in any audit table

### 4.3 Transaction / Outbox Architecture (Preserved)

For internal Alepes state transitions: business state change + authoritative audit record + outbox record = **single local transaction** (existing pattern in `@alepes/persistence`).

External provider calls **cannot** participate in the same DB transaction. Record `PROVIDER_REQUEST_STARTED` before call, `PROVIDER_REQUEST_SUCCEEDED/FAILED` after — separate durable evidence.

---

## 5. Operational Tracing (Frozen Attribute Contract)

```typescript
// Only these attributes may appear on spans
interface AlepesTraceAttributes {
  "alepes.run_id": string;
  "alepes.correlation_id": string;
  "alepes.provider": ProviderName;
  "alepes.environment": Environment;
  "alepes.phase": AuditEventPhase;
  "alepes.operation": string;
  "alepes.failure_code"?: FailureCode;
  "alepes.attempt"?: number;
  "alepes.mutated"?: boolean;
  "alepes.verified"?: boolean;
  "alepes.disposition"?: "shadow" | "approval" | "execute" | "none";
}

// NEVER on spans:
const FORBIDDEN_ATTRIBUTES = [
  "plaid.access_token",
  "plaid.item_id",
  "plaid.account_id",
  "plaid.request_body",
  "plaid.response_body",
  "plaid.authorization_header",
  "database.url",
  "secret.*",
];
```

Fingerprint sensitive identifiers only when correlation actually requires it (e.g., `accountIdFingerprint = fingerprint(accountId)`).

---

## 6. Certification Reporting (Versioned, Allowlist Sanitizer)

### 6.1 Canonical JSON Schema (`audit-cert@1`)

```typescript
interface CertificationReportV1 {
  schemaVersion: "audit-cert@1";
  run: CertificationRun;                    // the run record
  events: AuditEvent[];                     // full event stream (internal)
  providerCalls: ProviderCallEvidence[];    // safe fields only
}
```

### 6.2 Two Report Variants

| Variant | Audience | Contains |
|---------|----------|----------|
| **Internal / Raw** | Engineers, auditors | Full `AuditEvent[]`, all `provider_call_evidence` safe fields, request_ids |
| **Sanitized / Public** | External sharing, CI artifacts | Allowlist-only subset: run summary, gate results, counts, evidence boundary, no request_ids, no provider call detail, no internal IDs |

### 6.3 Allowlist-Based Sanitizer (Reuse `@alepes/certification-guards`)

```typescript
// In @alepes/reporting
function sanitizeReport(raw: CertificationReportV1): SanitizedReport {
  const redactor = createRedactor(/* no secrets registered — allowlist only */);
  // Walk raw and ADMIT only known-safe fields:
  return {
    schemaVersion: raw.schemaVersion,
    run: {
      runId: raw.run.runId,
      correlationId: raw.run.correlationId,
      milestone: raw.run.milestone,
      provider: raw.run.provider,
      environment: raw.run.environment,
      sourceCommit: raw.run.sourceCommit,
      result: raw.run.result,
      failureCode: raw.run.failureCode,
      evidenceBoundary: raw.run.evidenceBoundary,
      gates: raw.run.gates.map(({ gate, status, failureCode }) => ({ gate, status, failureCode })),
      mutationCounts: raw.run.mutationCounts,
      finalState: raw.run.finalState,
    },
    // Intentionally NO events, NO providerCalls, NO request_ids
  };
}
```

**Adversarial test requirement:** Plant sentinel secrets (`"SENTINEL-PLAID-SECRET"`, `"SENTINEL-ACCESS-TOKEN"`, `"SENTINEL-DB-URL"`) in:
- audit event payloads (nested objects/arrays)
- provider error `response.data`
- thrown error paths
- trace attributes

**Assert** sentinel never reaches: sanitized report, console output, trace attributes, public evidence.

---

## 7. Plaid Live Harness Instrumentation (Slice 4)

Instrument the existing `certify-live.ts` **without changing qualification semantics**. Emit audit events at each stage:

| Stage | Audit Event(s) |
|-------|----------------|
| Start | `CERT_RUN_STARTED` |
| Preflight | `PREFLIGHT_PASSED` or `PREFLIGHT_FAILED` (missing `PLAID_ACCESS_TOKEN` → `configuration.missing_secret`) |
| `/accounts/get` | `PROVIDER_REQUEST_STARTED` → `SUCCEEDED`/`FAILED` |
| `/transactions/sync` | `PROVIDER_REQUEST_STARTED` → `SUCCEEDED`/`FAILED` (enrichment with safe Plaid fields) |
| Delta observed | `OBSERVATION_RECEIVED` (per transaction) |
| Normalization | `OBSERVATION_NORMALIZED` |
| Persistence | `OBSERVATION_PERSISTED` |
| Reconciliation | `OBSERVATION_RECONCILED` |
| Qualification | `CASH_EVENT_QUALIFIED` or `CASH_EVENT_REJECTED` (`sync.no_qualifying_event`) |
| Policy | `RULE_EVALUATED` → `CAPITAL_PLAN_CREATED` → `ALLOCATION_PLAN_CREATED` → `EXECUTION_PLAN_CREATED` → `EXECUTION_POLICY_EVALUATED` |
| Shadow | `SHADOW_DECISION_RECORDED` |
| Assertions | `EXECUTION_BLOCKED` (zero mutation counts) + `CERT_GATE_PASSED/FAILED` per gate |
| Completion | `CERT_RUN_COMPLETED` + `CERT_GATE_*` summary |

**No qualifying live event path:** emits `CASH_EVENT_REJECTED` with `failureCode: "sync.no_qualifying_event"`, marks that gate `FAILED`, produces a valid `FAIL` certification report — **no synthesis, no historical substitution**.

---

## 8. Reconstruction Query (Slice 6)

Given only `runId`, the system must reconstruct the full narrative:

```typescript
function reconstructRun(runId: string): Promise<{
  whatObserved: string;
  evidenceKind: "real" | "synthetic" | "none";
  provider: ProviderName;
  environment: Environment;
  normalized: boolean;
  persisted: boolean;
  qualified: boolean;
  rejectionReason?: string;
  ruleVersion: string;
  capitalPlan: { deployableCents: number };
  allocationPlan: { totalDeployedCents: number; lines: number };
  executionPolicy: { disposition: string; executeCount: number };
  shadowOnly: boolean;
  providerMutationAttempted: boolean;
  failedGate: string;
  safeProviderError: { httpStatus?: number; plaidErrorType?: string; plaidErrorCode?: string; requestId?: string };
  sourceCommit: string;
  harnessVersion: string;
  schemaVersion: string;
  finishedCleanly: boolean;
}>;
```

---

## 9. Slice Plan (Per Task Prescription)

| Slice | Deliverable | Validates |
|-------|-------------|-----------|
| **1** | This ADR + design doc (`docs/adr/audit-certification-evidence-contract.md`) | Boundaries frozen, no code yet |
| **2** | `@alepes/audit` types, `@alepes/reporting` schemas + sanitizer + unit tests | TypeScript clean, adversarial redaction tests pass |
| **3** | `@alepes/persistence` DDL + repos + integration tests (Postgres required) | Append-only, indexes, reconstruction query works |
| **4** | Instrument `certify-live.ts` (emit events, produce JSON report) | Failed runs emit structured evidence, no synthetic events |
| **5** | Tracing instrumentation (frozen attributes, correlation) | RunId correlates trace ↔ audit ↔ report; sentinel redaction tests |
| **6** | Report renderers (JSON canonical, Markdown/console derived) + reconstruction | One run fully reconstructible from stored evidence |
| **7** | Property/conformance tests, failure-path coverage, redaction sentinel suite | Full ladder passes, no secret leakage possible |

---

## 10. Blocking Question (Must Resolve Before Slice 2)

**HEAD is `cf31ec7` (not `9a3d3d7`).** The two Plaid fixes (`PLAID_ACCESS_TOKEN` secret boundary + safe structured error extraction) are **uncommitted** in the working tree:

```
M packages/integrations/plaid-financial-data/certify-live.ts
M packages/integrations/plaid-financial-data/src/index.ts
```

These files will be touched by **Slice 4** (harness instrumentation) and **Slice 7** (provider-error classification hardening).

**Decision required:** Authorize committing these two pre-existing changes as a small coherent commit (`fix(plaid): require PLAID_ACCESS_TOKEN secret + surface safe structured provider errors`) before Slice 2, or fold them into the first slice that modifies them. The audit work must start from a clean baseline per AGENTS.md.

---

## 11. Risks & Mitigations

| Risk | Mitigation |
|------|------------|
| Phantom commit confusion | Every checkpoint reports `git log --oneline -1` and `git status --short` |
| Opnory mechanical copy | Reference only for *patterns* (audit vs telemetry boundary, allowlist sanitizer); all schemas/types derived from Alepes domain |
| Five tables created blindly | Only three tables, folded per §4.1 |
| Over-broad event union | Only events with real v0.5.0 producers listed; others documented as future |
| Provider codes in domain types | Failure taxonomy is Alepes-owned; mapping is pure function at boundary |
| Sanitizer "copy then delete" | Allowlist-only from empty; adversarial sentinel tests mandatory |
| Credentialed live cert required | Explicitly forbidden; implementation proven via unit/integration/mock tests only |
| `IDEA.md` touched | Explicit prohibition — will not stage/restore/commit |

---

## 12. Definition of Done (Per Task)

- [ ] Certification runs are first-class durable objects in Postgres
- [ ] Audit events are typed discriminated-union, append-only
- [ ] Stable failure taxonomy exists and is used
- [ ] Live Plaid harness failures produce structured durable evidence (tested via mocks)
- [ ] JSON reports are canonical, versioned, with internal/public variants
- [ ] Sanitizer is allowlist-based; adversarial sentinel tests pass
- [ ] Operational traces correlate (runId/correlationId) but are not authoritative
- [ ] No secret/raw identifier leakage through any evidence/report/trace path
- [ ] One run fully reconstructible from stored evidence without stdout
- [ ] Existing v0.5.0 real-event and Shadow-only semantics unchanged
- [ ] Full validation ladder passes: `bunx tsc --noEmit`, `bun run test`, `bunx oxlint`, `bun run build`, `git diff --check`
- [ ] No credentialed Plaid Production certification run required

---

*This ADR is the Slice 1 deliverable. Next step: user decision on committing pre-existing Plaid fixes, then Slice 2 (domain types + tests).*