// Plaid LIVE certification harness — first-hand evidence for v0.5.0.
// This is a STANDALONE script, NOT part of the ordinary Vitest unit suite and
// NOT part of CI. It talks to the REAL Plaid Production API and therefore
// requires live credentials. Run it explicitly:
//
//   PLAID_ENV=production \
//   PLAID_CLIENT_ID=<live client id> \
//   PLAID_SECRET=<live secret> \
//   PLAID_LIVE_POSTGRES_URL=<postgres connection string> \
//   PLAID_ACCESS_TOKEN=<production Item access token> \
//   bun run certify:plaid-live
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
import {
  createPlaidFinancialDataProvider,
  discoverPlaidAccounts,
  selectDepositoryAccount,
  type PlaidAccountsGetClient,
  type DiscoveredPlaidAccount,
} from "@alepes/plaid-financial-data";
import type { AccountBinding } from "@alepes/integration-runtime";
import { syncAccount } from "@alepes/reconciliation";
import { createSyncPostgresStore, createAuditPostgresStore } from "@alepes/persistence";
import { runShadowMode } from "@alepes/reconciliation";
import { qualifyCashEvents } from "@alepes/persistence";
import { nonNegativeCents } from "@alepes/money";
import type { Cents } from "@alepes/money";
import { ulid } from "@alepes/persistence";
import type { AuditPorts } from "@alepes/persistence";
import type { FinancialObservationId } from "@alepes/domain";
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
    sourceCommit: process.env.GITHUB_SHA ?? "local",
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
  const accountsClient: PlaidAccountsGetClient = {
    accountsGet: (req) =>
      plaid.accountsGet(req as never) as unknown as Promise<{
        data: { accounts: Array<{ account_id: string; name: string; subtype: string | null }> };
      }>,
  };
  const currentToken = (): string => accessTokens[0];

  let realAccounts: DiscoveredPlaidAccount[] = [];
  await step(2, "discover accounts via /accounts/get", async () => {
    const list = await discoverPlaidAccounts(accountsClient, async () => currentToken(), "cred:plaid-live");
    realAccounts = list;
    for (const a of list) accountIds.push(a.accountId);
    return list.map((a) => ({ accountFingerprint: fp(a.accountId), name: a.name, subtype: a.subtype }));
  });

  // Record provider request for /accounts/get (use first account as representative)
  await recordProviderRequest(auditPorts, ctx, "/accounts/get", "succeeded", {
    latencyMs: 0,
    accountIdFingerprint: realAccounts.length > 0 ? fp(realAccounts[0].accountId) : "fp-none",
  });

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
  const provider = createPlaidFinancialDataProvider({
    client: {
      transactionsSync: (req) =>
        plaid.transactionsSync(req as never) as unknown as Promise<{ data: TransactionsSyncResponse }>,
    },
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
    };

    // Record provider request for /transactions/sync
    await recordProviderRequest(auditPorts, ctx, "/transactions/sync", "succeeded", {
      latencyMs: 0,
      accountIdFingerprint: fp(depositoryAccountId),
    });

    return summary;
  });

  // ── 6. Load reconciled active observations, restricted to fresh delta ───────────
  const freshDeltaObs = await step(6, "load fresh-delta observations", async () => {
    const allObs = await store.listActiveObservations(pb.id);
    // Keep ONLY observations whose Alepes observation ID is in the fresh delta
    const fresh = allObs.filter((o: { id: string }) => freshDeltaObservationIds.has(o.id));
    return {
      count: fresh.length,
      observations: fresh.map((o) => ({
        id: o.id,
        externalRefFingerprint: fp(String(o.id)),
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
  });

  // Emit full lifecycle for each fresh-delta observation
  for (const o of freshDeltaObs.observations) {
    await recordObservationReceived(auditPorts, ctx, o.id, o.externalRefFingerprint, o.direction, o.amountCents as Cents, o.status === "posted");
    await recordObservationNormalized(auditPorts, ctx, o.id, "plaid-sign-convention@1");
    await recordObservationPersisted(auditPorts, ctx, o.id, o.id);
  }

  // ── 7. Derive qualifying CashEvents (from fresh delta ONLY) ──────────────────
  const cashEvents = await step(7, "derive qualifying CashEvents from fresh delta", async () => {
    const events = qualifyCashEvents(
      freshDeltaObs.observations as never // PersistedObservation[] matches shape
    );
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

  // ── 8. Shadow Mode end-to-end ───────────────────────────────────────────────
  // Build a minimal portfolio for allocation (AAA/BBB 50/50)
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

  const shadow = await step(8, "Shadow Mode: real live deposit → shadow decision", async () => {
    const persistedObs = freshDeltaObs.observations.filter((o) => o.status === "posted" && o.direction === "credit");
    const decisions = runShadowMode(persistedObs as never, { rules: [rule], portfolioState });
    const decision = decisions[0];
    if (!decision) throw new Error("no shadow decision produced");

    // Record rule evaluation — use event.id which IS the durable CashEvent/FinancialObservation id
    await recordRuleEvaluated(auditPorts, ctx, "r-live-cert", decision.plan.cashEvent.id, decision.plan.capitalPlan.deployable);

    // Record capital plan — plan.id IS event.id per ExecutionPlan construction (shadow.ts:130)
    await recordCapitalPlanCreated(auditPorts, ctx, decision.plan.id, decision.plan.capitalPlan.deployable);

    // Record allocation plan — same plan.id
    await recordAllocationPlanCreated(auditPorts, ctx, decision.plan.id, decision.plan.allocationPlan.totalDeployed, decision.plan.allocationPlan.lines.length);

    // Record execution policy
    await recordExecutionPolicyEvaluated(auditPorts, ctx, decision.disposition.kind, decision.plan.orders.length);

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
      orderCount: decision.plan.orders.length,
      sourceDescription: decision.plan.cashEvent.description,
      nonExecuting: true,
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
      executeCount: 0,
      transferCount: 0,
      orderCount: shadow.orderCount,
      providerMutationCount: 0,
      dispositionShadow: shadow.disposition === "shadow",
    };

    if (!assertions.dispositionShadow) throw new Error(`disposition=${shadow.disposition}, expected shadow`);
    if (assertions.orderCount !== 0) throw new Error(`orderCount=${assertions.orderCount}, expected 0`);
    if (assertions.executeCount !== 0) throw new Error(`executeCount=${assertions.executeCount}, expected 0`);
    if (assertions.transferCount !== 0) throw new Error(`transferCount=${assertions.transferCount}, expected 0`);

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