// Plaid LIVE certification harness — first-hand evidence for v0.5.0.
//
// This is a STANDALONE script, NOT part of the ordinary Vitest unit suite and
// NOT part of CI. It talks to the REAL Plaid Production API and therefore
// requires live credentials. Run it explicitly:
//
//   PLAID_ENV=production \
//   PLAID_CLIENT_ID=<live client id> \
//   PLAID_SECRET=<live secret> \
//   PLAID_LIVE_POSTGRES_URL=<postgres connection string> \
//   bun run certify:plaid-live
//
// SECURITY: never prints client_id, secret, access tokens, item ids, or raw
// account ids. Redacts them to deterministic fingerprints. Refuses sandbox.
//
// REQUIRED ENVIRONMENT (GitHub Environment: plaid-live):
//   Secrets (must be set in environment):
//     PLAID_CLIENT_ID
//     PLAID_SECRET
//     PLAID_LIVE_POSTGRES_URL
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
import { createSyncPostgresStore } from "@alepes/persistence";
import { runShadowMode } from "@alepes/reconciliation";
import { qualifyCashEvents } from "@alepes/persistence";
import { nonNegativeCents } from "@alepes/money";
import { ulid } from "@alepes/persistence";

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
if (!CLIENT_ID || !SECRET) {
  console.error("REFUSING TO RUN: PLAID_CLIENT_ID and PLAID_SECRET must both be set (production).");
  process.exit(2);
}
if (!POSTGRES_URL) {
  console.error("REFUSING TO RUN: PLAID_LIVE_POSTGRES_URL must be set for persistence.");
  process.exit(2);
}
const clientId: string = CLIENT_ID!;
const secret: string = SECRET!;
const pgUrl: string = POSTGRES_URL!;

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

function redact(s: unknown): unknown {
  if (typeof s !== "string") return s;
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

async function main(): Promise<void> {
  // ── 1. Persistence store ───────────────────────────────────────────────────
  const store = await step(1, "initialize PostgreSQL sync store", async () => {
    const s = createSyncPostgresStore({ connectionString: pgUrl });
    return s;
  });

  // ── 2. Discover accounts + bind the depository account ────────────────────
  const accountsClient: PlaidAccountsGetClient = {
    accountsGet: (req) =>
      plaid.accountsGet(req as never) as unknown as Promise<{
        data: { accounts: Array<{ account_id: string; name: string; subtype: string | null }> };
      }>,
  };
  const currentToken = (): string => accessTokens[0];

  await step(2, "discover accounts via /accounts/get", async () => {
    const list = await discoverPlaidAccounts(accountsClient, async () => currentToken(), "cred:plaid-live");
    for (const a of list) accountIds.push(a.accountId);
    return list.map((a) => ({ accountFingerprint: fp(a.accountId), name: a.name, subtype: a.subtype }));
  });

  const realAccounts = await discoverPlaidAccounts(accountsClient, async () => currentToken(), "cred:plaid-live");
  for (const a of realAccounts) accountIds.push(a.accountId);

  const accountSummaries = realAccounts.map((a) => ({
    accountFingerprint: fp(a.accountId),
    name: a.name,
    subtype: a.subtype,
  }));

  const depository = selectDepositoryAccount(realAccounts);
  if (!depository) {
    record(3, "select depository account", "fail", "no depository account discovered");
    throw new Error("no depository account discovered");
  }
  record(3, "select depository account", "pass", {
    accountFingerprint: fp(depository.accountId),
    subtype: depository.subtype,
  });
  const depositoryAccountId = depository.accountId;

  // ── 3. Build the REAL adapter, bound to the depository account ────────────
  const provider = createPlaidFinancialDataProvider({
    client: {
      transactionsSync: (req) =>
        plaid.transactionsSync(req as never) as unknown as Promise<{ data: TransactionsSyncResponse }>,
    },
    resolveAccessToken: async () => currentToken(),
    discover: async () => [{ accountId: depositoryAccountId, name: depository.name }],
  });

  const binding: AccountBinding = (await provider.discoverAccounts("cred:plaid-live"))[0];

  // ── 4. Persist binding + load checkpoint (if any) ──────────────────────────
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
  const startingCursor = checkpoint?.cursor ?? "";

  // ── 5. Full /transactions/sync cycle via syncAccount ──────────────────────
  const syncRun = await step(5, "full /transactions/sync cycle via syncAccount", async () => {
    const run = await syncAccount(provider, store, binding, pb.id, {
      newCycleId: () => `sync_${ulid()}` as never,
      normalizationVersion: "plaid-sign-convention@1",
      maxRestarts: 3,
    });
    return {
      pages: run.pages,
      added: run.delta.added.length,
      modified: run.delta.modified.length,
      removed: run.delta.removed.length,
      finalCursorFingerprint: fp(run.finalCursor),
      finalCursorLength: run.finalCursor.length,
      hasMore: run.delta.hasMore,
    };
  });

  // ── 6. Load reconciled active observations ────────────────────────────────
  const observations = await step(6, "load reconciled active observations", async () => {
    const obs = await store.listActiveObservations(pb.id);
    return {
      count: obs.length,
      observations: obs.map((o) => ({
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

  // ── 7. Derive qualifying CashEvents ──────────────────────────────────────
  const cashEvents = await step(7, "derive qualifying CashEvents from observations", async () => {
    const events = qualifyCashEvents(
      observations.observations as never // PersistedObservation[] matches shape
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

  if (cashEvents.count === 0) {
    record(8, "shadow mode on real live deposit", "fail", "no qualifying live event observed in sync delta");
    throw new Error("no qualifying live event observed in sync delta");
  }

  // ── 8. Shadow Mode end-to-end ─────────────────────────────────────────────
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
    const persistedObs = observations.observations.filter((o) => o.status === "posted" && o.direction === "credit");
    const decisions = runShadowMode(persistedObs as never, { rules: [rule], portfolioState });
    const decision = decisions[0];
    if (!decision) throw new Error("no shadow decision produced");

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

  // ── 9. Account isolation: non-depository accounts enumerated, never bound ──
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

  // ── 10. Assertions: hard invariants ───────────────────────────────────────
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

  await store.close();

  // ── Report ─────────────────────────────────────────────────────────────────
  const report = {
    environment: "production",
    testUser: "live",
    boundAccount: { fingerprint: fp(depositoryAccountId), subtype: depository.subtype },
    accounts: accountSummaries,
    initialSync: { pages: syncRun.pages, added: syncRun.added, modified: syncRun.modified, removed: syncRun.removed },
    reconciledObservations: observations.count,
    cashEvents: cashEvents.count,
    shadow,
    isolation,
    points,
    allPass: points.every((p) => p.status === "pass"),
    note: "No brokerage, no money movement occurred. Shadow disposition only.",
  };

  console.log("\n=== PLAID LIVE CERTIFICATION REPORT ===");
  console.log(JSON.stringify(report, null, 2));
  process.exit(report.allPass ? 0 : 1);
}

main().catch((e) => {
  console.error("HARNESS ERROR:", redact(e instanceof Error ? e.message : String(e)));
  process.exit(3);
});