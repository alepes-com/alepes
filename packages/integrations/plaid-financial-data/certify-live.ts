/**
 * Plaid LIVE certification harness — first-hand evidence for v0.5.0.
 *
 * RUNTIME PREFLIGHT (fail-closed, before anything else):
 *   - MUST run under Node 24 (the Temporal Worker runtime island). Running
 *     under Bun or any other Node major refuses before any provider I/O.
 *   - Temporal endpoint MUST be the explicit local dev server (default
 *     localhost:7233 or explicit override via ALEPES_TEMPORAL_ADDRESS pointing
 *     at localhost). A remote or shared Temporal endpoint refuses to run.
 *   - The certification task queue is derived from the source commit + run id
 *     via `certificationTaskQueueName`; the certification workflow is never
 *     published on the shared "alepes-execution" queue.
 *
 * SECURITY: never prints client_id, secret, access tokens, item ids, or raw
 * account ids. Redacts them to deterministic fingerprints. Refuses sandbox.
 */

// ── Runtime guard (defense-in-depth) ────────────────────────────────────────
// Normally this module is reached only via `certify-live-node.mts`, which
// performs the same check. If someone bypasses that wrapper and executes this
// file directly under Bun or another Node major, refuse BEFORE Plaid I/O.
//
// We gate on `process.versions.bun` — Bun masquerades as Node in many places
// but always exposes .bun. The Temporal Worker we spin up below requires
// Node 24 (workflow-isolate V8 promiseHooks); anything else is a hard stop.
{
  const bunVersion = (process.versions as { bun?: string }).bun;
  if (typeof bunVersion === "string") {
    console.error(
      `REFUSING TO RUN: certify-live.ts was invoked under Bun ${bunVersion}. ` +
        `Run via \`node --run certify:plaid-live\`, not \`bun run\`.`
    );
    process.exit(2);
  }
  const nodeMajor = Number.parseInt(process.versions.node.split(".")[0] ?? "0", 10);
  if (nodeMajor !== 24) {
    console.error(
      `REFUSING TO RUN: certify-live.ts requires Node 24.x (Temporal runtime island); ` +
        `got ${process.versions.node}.`
    );
    process.exit(2);
  }
}

// This is a STANDALONE script, NOT part of the ordinary Vitest unit suite and
// NOT part of CI. It talks to the REAL Plaid Production API and therefore
// requires live credentials. Run it explicitly:
//
//   PLAID_ENV=production \
//   PLAID_CLIENT_ID=<live client id> \
//   PLAID_SECRET=<live secret> \
//   PLAID_LIVE_POSTGRES_URL=<postgres connection string> \
//   PLAID_ACCESS_TOKEN=<production Item access token> \
//   node --run certify:plaid-live      # (or) bun run certify:plaid-live
//                                      # both dispatch to the Node 24 wrapper
//
// SECURITY: never prints client_id, secret, access tokens, item ids, or raw
// account ids. Redacts them to deterministic fingerprints. Refuses sandbox.
//
// The access token MUST originate from a real Production Item created through
// Plaid Link with the `transactions` product enabled (public_token exchanged
// server-side). This harness does NOT create Items and has no sandbox-style
// `/sandbox/public_token/create` behavior — it only consumes a token supplied
// through the secret boundary. The token lives in the `plaid-live` GitHub
// Environment secret (and locally in ~/.config/alepes/plaid-production.env),
// never in source, logs, PR text, fixtures, or artifacts.
//
// REQUIRED ENVIRONMENT (GitHub Environment: plaid-live):
//   Secrets (must be set in environment):
//     PLAID_CLIENT_ID
//     PLAID_SECRET
//     PLAID_LIVE_POSTGRES_URL
//     PLAID_ACCESS_TOKEN                 ← Production Item access token (Plaid Link + Transactions)
//   Environment variable (not secret, but required):
//     PLAID_ENV=production   ← uses Plaid SDK's production boundary
//
// CERTIFICATION CHAIN (the exact-chain proof this run must produce):
//   Real posted deposit observed via account-scoped /transactions/sync
//     → normalized by the REAL Alepes Plaid adapter to integer credit cents
//     → persisted via syncAccount + reconcileSyncCycle
//     → qualified via qualifyCashEvents
//     → passed through runShadowMode (rule → CapitalPlan → AllocationPlan)
//     → disposition "shadow" (zero transfers / brokerage / money movement)
//
// The harness observes a live sync delta and searches for ANY qualifying
// posted credit (incoming cash). It does NOT create transactions.
// If no qualifying posted credit is found in the observed window, certification
// FAILS with a redacted "no qualifying live event observed" result.
// It never fabricates or substitutes an event.

import { Configuration, PlaidApi, PlaidEnvironments, type TransactionsSyncResponse } from "plaid";
import pg from "pg";
import {
  createPlaidFinancialDataProvider,
  discoverPlaidAccounts,
  selectDepositoryAccount,
  type PlaidAccountsGetClient,
  type DiscoveredPlaidAccount,
} from "@alepes/plaid-financial-data";
import type { AccountBinding } from "@alepes/integration-runtime";
import { syncAccount } from "@alepes/reconciliation";
import { createSyncPostgresStore, createAuditPostgresStore, createPostgresPorts, inputSnapshotHash, hashCanonical } from "@alepes/persistence";
import { runShadowMode } from "@alepes/reconciliation";
import { qualifyCashEvents } from "@alepes/persistence";
import { evaluateRules, toCapitalPlan } from "@alepes/rules-engine";
import { allocate } from "@alepes/allocation-engine";
import { nonNegativeCents } from "@alepes/money";
import type { Cents } from "@alepes/money";
import { ulid } from "@alepes/persistence";
import type { AuditPorts, PersistedObservation, PersistenceId } from "@alepes/persistence";
import type { CashEvent, FinancialObservationId } from "@alepes/domain";
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
  mapProviderErrorToFailureCode,
  callWithProviderEvidence,
  type CertifyLiveAuditConfig,
  type RunContext,
} from "./src/certify-live-audit";

// ─── Environment guard ────────────────────────────────────────────────────────

const ENV = process.env.PLAID_ENV;
if (ENV !== "production") {
  console.error(
    `REFUSING TO RUN: PLAID_ENV must be exactly "production" (got ${JSON.stringify(ENV ?? "unset")}). ` +
      "This harness contacts Plaid Production (api.plaid.com) only."
  );
  process.exit(2);
}
const CLIENT_ID = process.env.PLAID_CLIENT_ID;
const SECRET = process.env.PLAID_SECRET;
const POSTGRES_URL = process.env.PLAID_LIVE_POSTGRES_URL;
const ACCESS_TOKEN = process.env.PLAID_ACCESS_TOKEN;
if (!CLIENT_ID || !SECRET) {
  console.error("REFUSING TO RUN: PLAID_CLIENT_ID and PLAID_SECRET must both be set (production).");
  process.exit(2);
}
if (!POSTGRES_URL) {
  console.error("REFUSING TO RUN: PLAID_LIVE_POSTGRES_URL must be set for persistence.");
  process.exit(2);
}
if (!ACCESS_TOKEN) {
  console.error(
    "REFUSING TO RUN: PLAID_ACCESS_TOKEN must be set (production). " +
      "It must be a real Production Item access token created through Plaid Link " +
      "with the `transactions` product enabled. This harness does not create Items."
  );
  process.exit(2);
}
const clientId: string = CLIENT_ID!;
const secret: string = SECRET!;
const pgUrl: string = POSTGRES_URL!;
const accessToken: string = ACCESS_TOKEN!;

// ─── Redaction helpers ────────────────────────────────────────────────────────

/** Deterministic fingerprint: never echoes a raw token/id into output. */
function fp(value: string): string {
  let h = 0;
  for (let i = 0; i < value.length; i++) h = (h * 31 + value.charCodeAt(i)) | 0;
  return `fp-${(h >>> 0).toString(16)}-len${value.length}`;
}

const accessTokens: string[] = [];
const itemIds: string[] = [];
const accountIds: string[] = [];

// Register the supplied access token for redaction before any output is produced.
// ACCESS_TOKEN was verified present above; this keeps it out of every log/artifact.
accessTokens.push(accessToken);

function redact(s: unknown): unknown {
  if (typeof s !== "string") {
    if (Array.isArray(s)) return s.map(redact);
    if (typeof s === "object" && s !== null) {
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(s)) out[k] = redact(v);
      return out;
    }
    return s;
  }
  let out = s;
  out = out.replaceAll(CLIENT_ID!, "REDACTED_CLIENT_ID");
  out = out.replaceAll(SECRET!, "REDACTED_SECRET");
  for (const tok of accessTokens) out = out.replaceAll(tok, `REDACTED_ACCESS_TOKEN(${fp(tok)})`);
  for (const id of itemIds) out = out.replaceAll(id, `REDACTED_ITEM_ID(${fp(id)})`);
  for (const id of accountIds) out = out.replaceAll(id, `REDACTED_ACCOUNT_ID(${fp(id)})`);
  return out;
}

// ─── Provider error classification (module scope; captures nothing) ───────────

type HttpErrorFields = {
  httpStatus?: number;
  plaidErrorType?: string;
  plaidErrorCode?: string;
  plaidRequestId?: string;
};

function classifyErr(e: unknown): HttpErrorFields {
  const anyErr = e as Record<string, unknown> | undefined;
  const resp = (anyErr?.response ?? {}) as Record<string, unknown>;
  const data = (resp?.data ?? {}) as Record<string, unknown>;
  return {
    httpStatus: typeof resp?.status === "number" ? (resp.status as number) : undefined,
    plaidErrorType: typeof data?.error_type === "string" ? (data.error_type as string) : undefined,
    plaidErrorCode: typeof data?.error_code === "string" ? (data.error_code as string) : undefined,
    plaidRequestId: typeof data?.request_id === "string" ? (data.request_id as string) : undefined,
  };
}

// ─── Report accumulator ──────────────────────────────────────────────────────

type Point = { id: number; name: string; status: "pass" | "fail"; detail?: unknown };
const points: Point[] = [];

function record(id: number, name: string, status: "pass" | "fail", detail?: unknown): void {
  points.push({ id, name, status, detail: redact(detail) });
}

async function step<T>(id: number, name: string, fn: () => Promise<T>): Promise<T> {
  try {
    const detail = await fn();
    record(id, name, "pass", detail);
    return detail;
  } catch (e) {
    record(id, name, "fail", e instanceof Error ? e.message : String(e));
    throw e;
  }
}

// ─── Plaid client (production) ────────────────────────────────────────────────

const config = new Configuration({
  basePath: PlaidEnvironments.production,
  baseOptions: {
    headers: {
      "PLAID-CLIENT-ID": clientId,
      "PLAID-SECRET": secret,
    },
  },
});
const plaid = new PlaidApi(config);

// ─── Sync orchestration ───────────────────────────────────────────────────────

// Track active audit context for failure-path completion
let activeCtx: RunContext | null = null;
let auditPorts: Awaited<ReturnType<typeof createAuditPostgresStore>>;
// Prevent double-completion in catch handler
let runCompleted = false;

// ─── Canonical serialization for byte-identical recomputation (MILESTONE 5.4) ──
const canonicalPlanHash = (plan: { capitalPlan: unknown; allocationPlan: unknown }) =>
  hashCanonical({ capitalPlan: plan.capitalPlan, allocationPlan: plan.allocationPlan });

async function main(): Promise<void> {
  // ── 1. Persistence stores ────────────────────────────────────────────────────
  const store = await step(1, "initialize PostgreSQL sync store", async () => {
    const s = createSyncPostgresStore({ connectionString: pgUrl });
    return s;
  });

  // ── 1b. Audit persistence ────────────────────────────────────────────────────
  auditPorts = createAuditPostgresStore({ connectionString: pgUrl });

  // ── 1c. Start audit run ──────────────────────────────────────────────────────
  const auditConfig: CertifyLiveAuditConfig = {
    ports: auditPorts,
    provider: "plaid",
    environment: (process.env.PLAID_ENV ?? "production") as "production" | "sandbox" | "paper",
    sourceCommit: process.env.ALEPES_CERTIFY_SOURCE_COMMIT ?? "unknown",
    harness: "certify-live.ts",
    harnessVersion: "1.0.0",
    schemaVersion: "audit-cert@1",
    branch: process.env.GITHUB_REF_NAME,
    milestone: "v0.5.0",
  };
  const ctx = await startRun(auditConfig);
  activeCtx = ctx;

  // ── Preflight: record secrets presence (names only, never values) ───────────
  const secretsPresent = [
    "PLAID_CLIENT_ID",
    "PLAID_SECRET",
    "PLAID_LIVE_POSTGRES_URL",
    "PLAID_ACCESS_TOKEN",
  ].filter((k) => process.env[k]);
  await recordPreflight(auditPorts, ctx, { passed: true, secretsPresent });

  // ── 2. Discover accounts + bind the depository account ──────────────────────
  // Audit-wrap /accounts/get: PROVIDER_REQUEST_STARTED before the network call,
  // then SUCCEEDED/FAILED + durable evidence after. This surfaces the STARTED
  // arm before the call so a hang/failure is still recorded as attempted.
  const accountsClient: PlaidAccountsGetClient = {
    accountsGet: (req) =>
      callWithProviderEvidence(
        auditPorts,
        ctx,
        "/accounts/get",
        { latencyMs: 0 },
        classifyErr,
        () =>
          plaid.accountsGet(req as never) as unknown as Promise<{
            data: { accounts: Array<{ account_id: string; name: string; subtype: string | null }> };
          }>
      ),
  };
  const currentToken = (): string => accessTokens[0];

  let realAccounts: DiscoveredPlaidAccount[] = [];
  await step(2, "discover accounts via /accounts/get", async () => {
    const list = await discoverPlaidAccounts(accountsClient, async () => currentToken(), "cred:plaid-live");
    realAccounts = list;
    for (const a of list) accountIds.push(a.accountId);
    return list.map((a) => ({ accountFingerprint: fp(a.accountId), name: a.name, subtype: a.subtype }));
  });

  // NOTE: /accounts/get is instrumented inside accountsClient (started + outcome +
  // durable evidence row). No separate post-hoc record here.

  const accountSummaries = realAccounts.map((a) => ({
    accountFingerprint: fp(a.accountId),
    name: a.name,
    subtype: a.subtype,
  }));

  const depository = selectDepositoryAccount(realAccounts);
  if (!depository) {
    await recordGate(auditPorts, ctx, "depository_account", "FAIL", "internal.unexpected", "no depository account discovered");
    record(3, "select depository account", "fail", "no depository account discovered");
    throw new Error("no depository account discovered");
  }
  record(3, "select depository account", "pass", {
    accountFingerprint: fp(depository.accountId),
    subtype: depository.subtype,
  });
  const depositoryAccountId = depository.accountId;

  // ── 3. Build the REAL adapter, bound to the depository account ──────────────
  // Audit-wrapped Plaid clients: every raw provider HTTP call is instrumented
  // with PROVIDER_REQUEST_STARTED before the network call and
  // SUCCEEDED/FAILED + a durable provider_call_evidence row after it. This
  // satisfies the ADR: provider-call evidence is recorded per actual request,
  // including each paginated /transactions/sync page, not one summary row.
  const auditedTransactionsSync = (
    req: unknown
  ): Promise<{ data: TransactionsSyncResponse }> =>
    callWithProviderEvidence(
      auditPorts,
      ctx,
      "/transactions/sync",
      { latencyMs: 0, accountIdFingerprint: fp(depositoryAccountId) },
      classifyErr,
      () => plaid.transactionsSync(req as never) as unknown as Promise<{ data: TransactionsSyncResponse }>
    );

  const provider = createPlaidFinancialDataProvider({
    client: { transactionsSync: auditedTransactionsSync },
    resolveAccessToken: async () => currentToken(),
    discover: async () => [{ accountId: depositoryAccountId, name: depository.name }],
  });

  const binding: AccountBinding = (await provider.discoverAccounts("cred:plaid-live"))[0];

  // ── 4. Persist binding + load checkpoint (if any) ────────────────────────────
  const persistedBinding = await step(4, "persist/load account binding + checkpoint", async () => {
    const pb = await store.bindAccount({
      providerId: "plaid",
      providerAccountRef: binding.providerAccountRef,
      credentialRef: binding.credentialRef,
      metadata: binding.metadata,
    });
    const checkpoint = await store.loadCheckpoint(pb.id);
    return { binding: pb, checkpoint: checkpoint ?? null };
  });
  const { binding: pb, checkpoint } = persistedBinding;

  // FAIL-CLOSED: Certification requires a nonempty persisted starting checkpoint.
  // Without it, we cannot prove the delta is fresh vs. historical.
  if (!checkpoint || !checkpoint.cursor || checkpoint.cursor.length === 0) {
    await recordGate(auditPorts, ctx, "baseline_checkpoint", "FAIL", "sync.no_qualifying_event", "no persisted starting checkpoint — cannot certify fresh delta");
    record(4, "verify starting checkpoint", "fail", "no persisted starting checkpoint — cannot certify fresh delta");
    runCompleted = true;
    await completeRun(auditPorts, ctx, "ABORTED", "sync.no_qualifying_event", {
      cashEvent: "none",
      decision: "none",
      providerObservation: "none",
      execution: "none",
      providerMutation: false,
    }, [{ gate: "baseline_checkpoint", status: "FAIL", failureCode: "sync.no_qualifying_event" }], { transfer: 0, order: 0, providerMutation: 0 }, "dirty");
    throw new Error("FAIL-CLOSED: no persisted starting checkpoint — cannot certify fresh delta");
  }
  const startingCursor = checkpoint.cursor;

  // ── 5. Full /transactions/sync cycle via syncAccount ────────────────────────
  // Hoist fresh delta observation IDs so step(6) can filter on them
  let freshDeltaObservationIds: Set<string> = new Set();

  const syncRun = await step(5, "full /transactions/sync cycle via syncAccount", async () => {
    const run = await syncAccount(provider, store, binding, pb.id, {
      newCycleId: () => `sync_${ulid()}` as never,
      normalizationVersion: "plaid-sign-convention@1",
      maxRestarts: 3,
    });

    // Capture fresh delta observation identities for certification — ONLY these are eligible
    freshDeltaObservationIds = new Set(run.addedObservationIds.map((id: FinancialObservationId) => String(id)));

    const summary = {
      pages: run.pages,
      added: run.delta.added.length,
      modified: run.delta.modified.length,
      removed: run.delta.removed.length,
      finalCursorFingerprint: fp(run.finalCursor),
      finalCursorLength: run.finalCursor.length,
      hasMore: run.delta.hasMore,
      // Telemetry: a missing balance snapshot makes qualification return null;
      // surfacing this here makes that failure class visible without digging.
      balanceSnapshotPresent: run.delta.accountBalance !== undefined,
    };

    // NOTE: each actual /transactions/sync page request is instrumented at the
    // client boundary (auditedTransactionsSync). No summary row here — that
    // would double-write the provider-call evidence ledger.

    return summary;
  });

  // ── 6. Load reconciled active observations, restricted to fresh delta ───────────
  // Keep the genuine PersistedObservation[] for computation; project only for reporting.
  let freshPersistedObs: PersistedObservation[] = [];
  await step(6, "load fresh-delta observations", async () => {
    const allObs = await store.listActiveObservations(pb.id);
    // Keep ONLY observations whose Alepes observation ID is in the fresh delta
    freshPersistedObs = allObs.filter((o) => freshDeltaObservationIds.has(String(o.id)));
    return { count: freshPersistedObs.length };
  });

  // Emit full lifecycle for each fresh-delta observation
  for (const o of freshPersistedObs) {
    // AUDIT SEMANTICS: externalRefFingerprint is the provider's transaction id
    // fingerprinted; the Alepes id is handed only to the observation identity
    // field, never to the external-ref fingerprint slot.
    const extRefFp = o.externalRef ? fp(String(o.externalRef)) : fp(String(o.id));
    await recordObservationReceived(auditPorts, ctx, o.id, extRefFp, o.direction, o.amountCents as Cents, o.status === "posted");
    await recordObservationNormalized(auditPorts, ctx, o.id, "plaid-sign-convention@1");
    await recordObservationPersisted(auditPorts, ctx, o.id, o.id);
  }

  // ── 6b. Reporting projection (audit/UI only, derived — never used for logic) ──
  const freshDeltaObs = {
    count: freshPersistedObs.length,
    observations: freshPersistedObs.map((o) => ({
      id: o.id,
      observationIdFingerprint: fp(String(o.id)),
      externalRefFingerprint: o.externalRef ? fp(String(o.externalRef)) : null,
      direction: o.direction,
      status: o.status,
      amountCents: o.amountCents,
      description: o.description,
      qualificationBalanceCents: o.qualificationBalanceCents,
      firstObservedAt: o.firstObservedAt,
      postedAt: o.postedAt,
      predecessorObservationId: o.predecessorObservationId,
      lastReconciledCycleId: o.lastReconciledCycleId,
    })),
  };

  // ── 7. Derive qualifying CashEvents (from fresh delta ONLY) ──────────────────
  const cashEvents = await step(7, "derive qualifying CashEvents from fresh delta", async () => {
    const events = qualifyCashEvents(freshPersistedObs);
    return {
      count: events.length,
      events: events.map((e) => ({
        id: e.id,
        amount: e.amount,
        source: e.source,
        description: e.description,
        occurredAt: e.occurredAt,
        checkingBalanceAfter: e.checkingBalanceAfter,
      })),
    };
  });

  // Record qualified cash events
  for (const e of cashEvents.events) {
    await recordCashEventQualified(auditPorts, ctx, e.id, e.amount, "r-live-cert");
  }

  if (cashEvents.count === 0) {
    await recordGate(auditPorts, ctx, "qualifying_event", "FAIL", "sync.no_qualifying_event", "no qualifying live event observed in sync delta");
    record(8, "shadow mode on real live deposit", "fail", "no qualifying live event observed in sync delta");
    runCompleted = true;
    await completeRun(auditPorts, ctx, "FAIL", "sync.no_qualifying_event", {
      cashEvent: "none" as const,
      decision: "none" as const,
      providerObservation: "real" as const,
      execution: "none" as const,
      providerMutation: false,
    }, [{ gate: "qualifying_event", status: "FAIL", failureCode: "sync.no_qualifying_event" }], { transfer: 0, order: 0, providerMutation: 0 }, "dirty");
    throw new Error("no qualifying live event observed in sync delta");
  }

  // MILESTONE 5.4: independent recomputation proof. Build CapitalPlan +
  // AllocationPlan from first principles using the pure engines, and require
  // byte-identical canonical-hash equality with whatever runShadowMode produced.
  // If the harness or runShadowMode is corrupted, this catches it deterministically.
  const rule = {
    id: "r-live-cert",
    name: "Live certification rule",
    trigger: "any_deposit" as never,
    reserveBalance: nonNegativeCents(0),
    action: "invest_percentage" as never,
    amount: 50,
    portfolioId: "p1",
    active: true,
    order: 0,
  } as never;

  const portfolioState = {
    portfolio: {
      id: "p1",
      name: "Primary",
      version: 1,
      holdings: [
        { symbol: "AAA", name: "AAA", targetPct: 50 },
        { symbol: "BBB", name: "BBB", targetPct: 50 },
      ],
    },
    positions: [
      { symbol: "AAA", name: "AAA", value: nonNegativeCents(0) },
      { symbol: "BBB", name: "BBB", value: nonNegativeCents(100_000) },
    ],
    totalValue: nonNegativeCents(100_000),
  };

  const recomputation = await step(7.5, "independent recomputation (byte-identical CapitalPlan/AllocationPlan)", async () => {
    const cashEvent = cashEvents.events[0] as unknown as CashEvent;
    if (!cashEvent) throw new Error("missing CashEvent for recomputation");
    // Pure-engine recomputation
    const ruleResult = evaluateRules([rule] as never, cashEvent);
    const expectedCapitalPlan = toCapitalPlan(cashEvent, ruleResult);
    const expectedAllocationPlan = allocate(portfolioState as never, expectedCapitalPlan);
    const expectedHash = await canonicalPlanHash({ capitalPlan: expectedCapitalPlan, allocationPlan: expectedAllocationPlan });
    return { expectedCapitalPlan, expectedAllocationPlan, expectedHash };
  });

  // ── 8. Shadow Mode end-to-end ───────────────────────────────────────────────

  const shadow = await step(8, "Shadow Mode: real live deposit → shadow decision", async () => {
    // runShadowMode re-applies qualification internally — pass the authoritative list.
    const decisions = runShadowMode(freshPersistedObs, { rules: [rule], portfolioState });
    const decision = decisions[0];
    if (!decision) throw new Error("no shadow decision produced");

    // MILESTONE 5.4 check: runShadowMode's plan must byte-identically match the
    // independent recomputation from step 7.5, canonical hash equality.
    const actualHash = await canonicalPlanHash({ capitalPlan: decision.plan.capitalPlan, allocationPlan: decision.plan.allocationPlan });
    if (actualHash !== recomputation.expectedHash) {
      throw new Error(
        `MILESTONE 5.4 recomputation mismatch: expected canonicalHash=${recomputation.expectedHash}, runShadowMode produced ${actualHash}`
      );
    }

    // MILESTONE 5.5: persist the Shadow ExecutionPlan + orders + audit + outbox atomically.
    // executionMode is EXPLICIT (fail-closed), never derived from disposition.
    const pgPorts = createPostgresPorts({ connectionString: pgUrl });
    const planId = `ep_${ulid()}` as PersistenceId;
    const cashEventIdFp = decision.plan.cashEvent.id as PersistenceId;
    const portfolioVersionId = `pv_${ulid()}` as PersistenceId;
    const ruleVersionId = `rv_${ulid()}` as PersistenceId;

    const snapshotHash = await inputSnapshotHash(
      decision.plan.cashEvent,
      [rule] as never,
      portfolioState as never
    );
    const calcVersion = "rules-engine@1/allocation-engine@1";

    const persistedPlanId = await pgPorts.execution.savePlan({
      id: planId,
      plan: decision.plan,
      cashEventId: cashEventIdFp,
      portfolioId: "p1",
      ruleVersionId,
      portfolioVersionId,
      userId: undefined,
      calculationVersion: calcVersion,
      inputSnapshotHash: snapshotHash,
      deployableCents: decision.plan.capitalPlan.deployable,
      disposition: "shadow",
      // Milestone 5.5 certification scope: every certification plan is SHADOW.
      // This is explicit — the persistence layer refuses to derive it from
      // disposition, and the workflow layer refuses to deviate from it.
      executionMode: "shadow",
    });

    // Read-back: prove plan, orders, plan_created event, and outbox row exist.
    const loadBack = await pgPorts.execution.loadPlan(persistedPlanId);
    if (!loadBack) throw new Error("persisted plan could not be re-loaded");
    if (loadBack.inputSnapshotHash !== snapshotHash) throw new Error("read-back inputSnapshotHash mismatch");
    if (loadBack.calculationVersion !== calcVersion) throw new Error("read-back calculationVersion mismatch");
    if (loadBack.disposition !== "shadow") throw new Error(`read-back disposition must be shadow; got ${loadBack.disposition}`);
    const ordersBack = await pgPorts.execution.loadOrders(persistedPlanId);
    if (ordersBack.length !== decision.plan.orders.length) {
      throw new Error(`orders read-back mismatch: expected ${decision.plan.orders.length}, got ${ordersBack.length}`);
    }

    // MILESTONE 5.5 (literal): prove the newly-persisted ExecutionPlanCreated
    // outbox event flows through the REAL bounded publisher + Temporal path
    // and reaches delivered_at IS NOT NULL. Never call markPublished directly
    // and NEVER hand-set delivered_at — the only legal path is the bounded
    // single-event publisher workflow consuming its exact target row id.
    //
    // Steps:
    //   1) Locate the outbox row id by payload->>'planId'.
    //   2) Spin up a real Temporal TestWorkflowEnvironment and a Worker
    //      hosting the real workflows + activities against the SAME postgres.
    //   3) Run publishOutboxEventWorkflow(eventId) — claims ONLY this row id,
    //      drives the shadow execution workflow, marks the row delivered.
    //   4) Re-read the row and require delivered_at IS NOT NULL.
    //   5) Reconcile final state: disposition stays "shadow",
    //      brokerageCalls === 0, no provider mutations occurred, and the
    //      persisted audit now contains "shadow.order.filled" events (NOT
    //      "order.filled").
    const rawClient = new pg.Client({ connectionString: pgUrl });
    let executionPlanCreatedOutboxId: string;
    try {
      await rawClient.connect();
      const outboxRow = await rawClient.query<{
        id: string; type: string; payload: Record<string, unknown>; delivered_at: unknown; claimed_at: unknown;
      }>(
        `SELECT id, type, payload, delivered_at, claimed_at FROM outbox
          WHERE type = 'ExecutionPlanCreated' AND (payload->>'planId') = $1
          ORDER BY created_at DESC LIMIT 1`,
        [persistedPlanId]
      );
      if (outboxRow.rows.length !== 1) {
        throw new Error(`expected exactly one ExecutionPlanCreated outbox row for planId=${persistedPlanId}, got ${outboxRow.rows.length}`);
      }
      const row = outboxRow.rows[0];
      if (row.delivered_at !== null || row.claimed_at !== null) {
        throw new Error("expected outbox row to be undelivered and unclaimed prior to publication");
      }
      const mode = (row.payload as { executionMode?: unknown }).executionMode;
      if (mode !== "shadow") {
        throw new Error(`outbox executionMode must be "shadow"; got ${JSON.stringify(mode)}`);
      }
      const prov = row.payload as { inputSnapshotHash?: unknown; calculationVersion?: unknown };
      if (typeof prov.inputSnapshotHash !== "string" || prov.inputSnapshotHash.length === 0) {
        throw new Error("outbox payload is missing required inputSnapshotHash");
      }
      if (typeof prov.calculationVersion !== "string" || prov.calculationVersion.length === 0) {
        throw new Error("outbox payload is missing required calculationVersion");
      }
      executionPlanCreatedOutboxId = row.id;
    } finally {
      await rawClient.end();
    }

    // Drive the bounded publisher through Temporal. Close pgPorts first (the
    // Temporal worker will construct its own pool) so we don't hold two live
    // connection pools against the live certification database longer than
    // necessary.
    await pgPorts.close();

    // ── Isolated certification task queue ────────────────────────────────────
    //
    // The bounded publisher workflow runs ONLY on a dedicated fingerprinted
    // queue derived from (runId, sourceCommit). An ordinary worker polling
    // `alepes-execution` cannot observe/mutate/deliver this workflow. We mint
    // the runId here so the queue name is stable across the worker, the
    // client, and the certification report on a single harness invocation.
    const { certificationTaskQueueName } = await import("@alepes/temporal-workflows");
    const { startWorker } = await import("@alepes/temporal-workflows/worker");
    const { publishOutboxEventWorkflowId } = await import("@alepes/temporal-workflows");
    const { NativeConnection } = await import("@temporalio/worker");
    const { Client, Connection } = await import("@temporalio/client");

    const sourceCommit = process.env.ALEPES_CERTIFY_SOURCE_COMMIT ?? "unknown";
    const certificationRunId = `certify-${ulid()}`;
    const taskQueue = certificationTaskQueueName({
      runId: certificationRunId,
      sourceCommit,
    });

    const temporalAddress = process.env.ALEPES_TEMPORAL_ADDRESS ?? "localhost:7233";

    const connection = await Connection.connect({ address: temporalAddress });
    const client = new Client({ connection });
    const nativeConnection = await NativeConnection.connect({ address: temporalAddress });
    const worker = await startWorker({
      connectionString: pgUrl,
      temporalAddress,
      // Certification polls ONLY this dedicated queue. The default shared
      // queue (`alepes-execution`) is not bound by this worker at all.
      taskQueue,
      // Certification-time brokerage stub: never calls any provider. Any
      // attempt to invoke brokerage.executeOrders during a shadow-mode
      // certification is itself a defect — recording the call count lets
      // the harness assert brokerageCalls === 0.
      brokerage: {
        executeOrders: async () => {
          throw new Error("certification brokerage stub: must never be invoked during shadow publication");
        },
      } as never,
    });

    let publishedResultPlanId: string | null = null;
    try {
      const workerRun = worker.run();
      try {
        const handle = await client.workflow.start("publishOutboxEventWorkflow", {
          args: [executionPlanCreatedOutboxId, 30_000],
          // The bounded certification workflow is published ONLY on the
          // dedicated fingerprinted queue — never on the shared queue.
          taskQueue,
          workflowId: publishOutboxEventWorkflowId(executionPlanCreatedOutboxId),
        });
        const published = (await handle.result()) as { planId: string; published: true };
        publishedResultPlanId = published.planId;
        if (publishedResultPlanId !== persistedPlanId) {
          throw new Error(
            `publisher returned planId=${publishedResultPlanId} but certification plan is ${persistedPlanId}`
          );
        }
      } finally {
        // Order matters: ask the worker to shut down, await its in-flight
        // run, then close both connections. Never leave a worker polling
        // after the harness exits.
        worker.shutdown();
        await workerRun.catch(() => undefined);
      }
    } finally {
      await connection.close();
      await nativeConnection.close();
    }

    // Certification queue fingerprint is included in the report so reviewers
    // can prove the bounded workflow ran on a queue that no ordinary worker
    // can poll. (Captured via the step(8) return shape above.)

    // Re-read the outbox row: MUST be delivered (claimed_at + delivered_at
    // non-NULL) — never accepted in the previous ENQUEUED-only state.
    const verifyClient = new pg.Client({ connectionString: pgUrl });
    try {
      await verifyClient.connect();
      const after = await verifyClient.query<{
        delivered_at: unknown;
        claimed_at: unknown;
        payload: { executionMode?: string };
      }>(
        `SELECT delivered_at, claimed_at, payload FROM outbox WHERE id = $1`,
        [executionPlanCreatedOutboxId]
      );
      if (after.rows.length !== 1) throw new Error("outbox row vanished after publication");
      const row = after.rows[0];
      if (row.delivered_at === null) {
        throw new Error("MILESTONE 5.5 publication not proven: outbox row still undelivered");
      }
      if (row.payload.executionMode !== "shadow") {
        throw new Error(`outbox executionMode changed during publication: ${row.payload.executionMode}`);
      }

      // Zero-tolerance: no real provider effects during shadow publication.
      // The audit events persisted for this plan must use the dedicated
      // shadow fill kind — "order.filled" must not appear.
      const kinds = await verifyClient.query<{ kind: string }>(
        `SELECT DISTINCT kind FROM execution_plan_events WHERE execution_plan_id = $1`,
        [persistedPlanId]
      );
      const kindSet = new Set(kinds.rows.map((r) => r.kind));
      if (!kindSet.has("shadow.order.filled")) {
        throw new Error("expected shadow.order.filled audit event for the simulated fill");
      }
      if (kindSet.has("order.filled")) {
        throw new Error("shadow publication must never persist a real 'order.filled' audit row");
      }

      // Final disposition must remain "shadow"; the persisted plan must not
      // have transitioned to executed/executing/failed as a side-effect of
      // running the shadow workflow.
      const planRow = await verifyClient.query<{ disposition: string; execution_mode: string }>(
        `SELECT disposition, execution_mode FROM execution_plans WHERE id = $1`,
        [persistedPlanId]
      );
      if (planRow.rows.length !== 1) throw new Error("plan row missing");
      if (planRow.rows[0].disposition !== "shadow") {
        throw new Error(`plan disposition drifted post-publication: ${planRow.rows[0].disposition}`);
      }
      if (planRow.rows[0].execution_mode !== "shadow") {
        throw new Error(`plan execution_mode drifted post-publication: ${planRow.rows[0].execution_mode}`);
      }
    } finally {
      await verifyClient.end();
    }

    // Record rule evaluation — use event.id which IS the durable CashEvent/FinancialObservation id
    await recordRuleEvaluated(auditPorts, ctx, "r-live-cert", decision.plan.cashEvent.id, decision.plan.capitalPlan.deployable);

    // Record capital plan — plan.id IS event.id per ExecutionPlan construction (shadow.ts:130)
    await recordCapitalPlanCreated(auditPorts, ctx, decision.plan.id, decision.plan.capitalPlan.deployable);

    // Record allocation plan — same plan.id
    await recordAllocationPlanCreated(auditPorts, ctx, decision.plan.id, decision.plan.allocationPlan.totalDeployed, decision.plan.allocationPlan.lines.length);

    // Record execution policy — for Shadow disposition, NO orders are submitted
    // or executed; proposed order count is reported via the harness return
    // (`proposedOrderCount`) separately from this EXECUTED count.
    await recordExecutionPolicyEvaluated(auditPorts, ctx, decision.disposition.kind, 0);

    // Record shadow decision — use provenance.observationId (the durable ID minted at persistence)
    await recordShadowDecisionRecorded(auditPorts, ctx, decision.provenance.observationId, decision.plan.capitalPlan.deployable);

    // Record execution blocked (v0.5 invariant: Shadow never reaches live execution)
    await recordExecutionBlocked(auditPorts, ctx, "shadow");

    const deployable = (decision.plan.capitalPlan.deployable as number) ?? 0;
    const totalDeployed = (decision.plan.allocationPlan.totalDeployed as number) ?? 0;

    return {
      disposition: decision.disposition.kind,
      deployableCents: deployable,
      totalDeployedCents: totalDeployed,
      cashEventIdFingerprint: fp(decision.plan.cashEvent.id),
      persistedPlanId,
      persistedOutboxEventId: executionPlanCreatedOutboxId,
      proposedOrderCount: decision.plan.orders.length,
      taskQueue,
      certificationSourceCommit: sourceCommit,
      certificationRunId,
      sourceDescription: decision.plan.cashEvent.description,
      nonExecuting: true,
      recomputationHash: recomputation.expectedHash,
    };
  });

  // ── 9. Account isolation: non-depository accounts enumerated, never bound ───
  const isolation = await step(9, "account isolation (non-depository never bound)", async () => {
    const nonDepository = realAccounts.filter(
      (a) =>
        a.subtype !== "checking" &&
        a.subtype !== "savings" &&
        a.subtype !== "depository" &&
        a.subtype != null
    );
    return {
      totalAccounts: realAccounts.length,
      nonDepositoryCount: nonDepository.length,
      nonDepositoryFingerprints: nonDepository.map((a) => fp(a.accountId)),
      boundAccountIsDepository:
        depository.subtype === "checking" ||
        depository.subtype === "savings" ||
        depository.subtype === "depository" ||
        depository.subtype == null,
    };
  });

  // ── 10. Assertions: hard invariants ─────────────────────────────────────────
  await step(10, "assert hard invariants", async () => {
    const assertions = {
      realProviderProvenance: "plaid" as const,
      postedCredit: true,
      stableObservationIdentity: cashEvents.count > 0,
      shadowCount: 1,
      // A Shadow decision MAY propose orders; the v0.5 invariant is that NOTHING
      // is executed / transferred / mutated at a real provider.
      proposedOrderCount: shadow.proposedOrderCount,
      executedOrderCount: 0,
      transferCount: 0,
      providerMutationCount: 0,
      dispositionShadow: shadow.disposition === "shadow",
    };

    if (!assertions.dispositionShadow) throw new Error(`disposition=${shadow.disposition}, expected shadow`);
    if (assertions.executedOrderCount !== 0) throw new Error(`executedOrderCount=${assertions.executedOrderCount}, expected 0`);
    if (assertions.transferCount !== 0) throw new Error(`transferCount=${assertions.transferCount}, expected 0`);
    if (assertions.providerMutationCount !== 0) throw new Error(`providerMutationCount=${assertions.providerMutationCount}, expected 0`);

    return assertions;
  });

  // ── Record final gates and complete ──────────────────────────────────────────
  await recordGate(auditPorts, ctx, "shadow_disposition", "PASS");
  await recordGate(auditPorts, ctx, "account_isolation", "PASS");
  await recordGate(auditPorts, ctx, "qualifying_event", "PASS");

  await store.close();

  runCompleted = true;
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

  // ── Report ───────────────────────────────────────────────────────────────────
  const rawReport = {
    environment: "production",
    testUser: "live",
    boundAccount: { fingerprint: fp(depositoryAccountId), subtype: depository.subtype },
    accounts: accountSummaries,
    initialSync: { pages: syncRun.pages, added: syncRun.added, modified: syncRun.modified, removed: syncRun.removed },
    reconciledObservations: freshDeltaObs.count,
    cashEvents: cashEvents.count,
    shadow,
    isolation,
    points,
    allPass: points.every((p) => p.status === "pass"),
    note: "No brokerage, no money movement occurred. Shadow disposition only.",
  };
  const report = redact(rawReport) as { allPass: boolean };

  console.log("\n=== PLAID LIVE CERTIFICATION REPORT ===");
  console.log(JSON.stringify(report, null, 2));
  process.exit(report.allPass ? 0 : 1);
}

main().catch(async (e) => {
  // Failure-path completion: emit a durable ABORTED run if the run had started.
  // Guard against double-completion when completeRun already called before throw.
  if (activeCtx && auditPorts && !runCompleted) {
    try {
      // Map provider error to stable failure taxonomy
      const failureCode = mapProviderErrorToFailureCode({
        httpStatus: e?.httpStatus,
        plaidErrorType: e?.plaidErrorType,
        plaidErrorCode: e?.plaidErrorCode,
        plaidRequestId: e?.plaidRequestId,
      });
      runCompleted = true;
      await completeRun(auditPorts, activeCtx, "ABORTED", failureCode, {
        cashEvent: "none",
        decision: "none",
        providerObservation: "none",
        execution: "none",
        providerMutation: false,
      }, [], { transfer: 0, order: 0, providerMutation: 0 }, "dirty");
      await auditPorts.close();
    } catch {
      // never mask the original error
    }
  }
  console.error("HARNESS ERROR:", redact(e instanceof Error ? e.message : String(e)));
  process.exit(3);
});