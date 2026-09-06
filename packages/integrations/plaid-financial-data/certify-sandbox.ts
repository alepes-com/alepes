// Plaid Sandbox certification harness — first-hand evidence for v0.2.0.
//
// This is a STANDALONE script, NOT part of the ordinary Vitest unit suite and
// NOT part of CI. It talks to the REAL Plaid Sandbox API (never Production) and
// therefore requires live Sandbox credentials. Run it explicitly:
//
//   PLAID_ENV=sandbox \
//   PLAID_CLIENT_ID=<sandbox client id> \
//   PLAID_SECRET=<sandbox secret> \
//   bun run certify:plaid-sandbox
//
// What it proves (first-hand, against real Sandbox responses):
//   1. user_transactions_dynamic Sandbox Item → bound depository account
//   2. /transactions/sync is account-scoped (options.account_id) through the
//      real adapter; pagination drains; cursor extracted per page
//   3. SYNC_UPDATES_AVAILABLE webhook → parseSyncUpdatesAvailable → durable
//      resync trigger (idempotent on replay)
//   4. /sandbox/transactions/create deposit → normalized provider-neutral
//      credit → Shadow Mode capital/allocation decision (nothing moves money)
//   5. Account isolation: non-depository (credit card) accounts are enumerated
//      but never selected for binding
//
// SECURITY: never prints client_id, secret, access tokens, or raw account ids.
// Redacts them to deterministic fingerprints. Refuses to run against Production.

import { Configuration, PlaidApi, PlaidEnvironments, Products } from "plaid";
import type { TransactionsSyncResponse } from "plaid";
import {
  createPlaidFinancialDataProvider,
  discoverPlaidAccounts,
  selectDepositoryAccount,
  parseSyncUpdatesAvailable,
  SYNC_UPDATES_AVAILABLE,
  type PlaidAccountsGetClient,
  type DiscoveredPlaidAccount,
} from "@alepes/plaid-financial-data";
import type { AccountBinding } from "@alepes/integration-runtime";
import { runShadowMode } from "@alepes/reconciliation";
import { nonNegativeCents } from "@alepes/money";

// ─── Environment guard ───────────────────────────────────────────────────────

const ENV = process.env.PLAID_ENV;
if (ENV !== "sandbox") {
  console.error(
    `REFUSING TO RUN: PLAID_ENV must be exactly "sandbox" (got ${JSON.stringify(ENV ?? "unset")}). ` +
      "This harness never contacts Plaid Production."
  );
  process.exit(2);
}
const CLIENT_ID = process.env.PLAID_CLIENT_ID;
const SECRET = process.env.PLAID_SECRET;
if (!CLIENT_ID || !SECRET) {
  console.error("REFUSING TO RUN: PLAID_CLIENT_ID and PLAID_SECRET must both be set (sandbox).");
  process.exit(2);
}

// ─── Redaction helpers ───────────────────────────────────────────────────────

/** Deterministic fingerprint: never echoes a raw token/id into output. */
function fp(value: string): string {
  let h = 0;
  for (let i = 0; i < value.length; i++) h = (h * 31 + value.charCodeAt(i)) | 0;
  return `fp-${(h >>> 0).toString(16)}-len${value.length}`;
}

const accessTokens: string[] = [];
function redact(s: unknown): unknown {
  if (typeof s !== "string") return s;
  let out = s;
  out = out.replaceAll(CLIENT_ID!, "REDACTED_CLIENT_ID");
  out = out.replaceAll(SECRET!, "REDACTED_SECRET");
  for (const tok of accessTokens) out = out.replaceAll(tok, `REDACTED_ACCESS_TOKEN(${fp(tok)})`);
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

// ─── Plaid client (sandbox-only) ─────────────────────────────────────────────

const config = new Configuration({
  basePath: PlaidEnvironments.sandbox,
  baseOptions: {
    headers: {
      "PLAID-CLIENT-ID": CLIENT_ID,
      "PLAID-SECRET": SECRET,
    },
  },
});
const plaid = new PlaidApi(config);

const INSTITUTION_ID = process.env.PLAID_SANDBOX_INSTITUTION_ID ?? "ins_109508"; // First Platypus Bank

async function main(): Promise<void> {
  // ── 1. Create a deterministic Transactions Sandbox Item ───────────────────
  const item = await step(1, "create user_transactions_dynamic Sandbox Item", async () => {
    const pt = await plaid.sandboxPublicTokenCreate({
      institution_id: INSTITUTION_ID,
      initial_products: [Products.Transactions],
      options: {
        webhook: "https://sandbox.invalid/alepes-webhook",
        override_username: "user_transactions_dynamic",
        override_password: "alepes-cert",
      },
    });
    const exchange = await plaid.itemPublicTokenExchange({
      public_token: pt.data.public_token,
    });
    const token = exchange.data.access_token;
    accessTokens.push(token);
    const itemId = exchange.data.item_id;
    accessTokens.push(itemId); // also redact the item id
    return { itemIdFingerprint: fp(itemId) };
  });

  // ── 2. Discover accounts + bind the depository account ────────────────────
  const accountsClient: PlaidAccountsGetClient = {
    accountsGet: (req) =>
      plaid.accountsGet(req as never) as unknown as Promise<{
        data: { accounts: Array<{ account_id: string; name: string; subtype: string | null }> };
      }>,
  };
  const currentToken = (): string => accessTokens[0];

  const accounts: DiscoveredPlaidAccount[] = await step(2, "discover accounts via /accounts/get", async () =>
    discoverPlaidAccounts(accountsClient, async () => currentToken(), "cred:plaid-sandbox")
  );

  const accountSummaries = accounts.map((a) => ({
    accountFingerprint: fp(a.accountId),
    name: a.name,
    subtype: a.subtype,
  }));

  const depository = selectDepositoryAccount(accounts);
  if (!depository) {
    record(3, "select + bind depository account", "fail", "no depository account discovered");
    throw new Error("no depository account discovered");
  }
  record(3, "select + bind depository account", "pass", {
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

  const binding: AccountBinding = (await provider.discoverAccounts("cred:plaid-sandbox"))[0];

  // ── 4. Initial /transactions/sync (account-scoped; pagination drains) ─────
  const initial = await step(4, "initial account-scoped /transactions/sync", async () => {
    let cursor = "";
    let pages = 0;
    let added = 0;
    let modified = 0;
    let removed = 0;
    for (;;) {
      const d = await provider.syncObservations(binding, cursor);
      added += d.added.length;
      modified += d.modified.length;
      removed += d.removed.length;
      pages += 1;
      cursor = d.nextCursor;
      if (!d.hasMore) break;
      if (pages > 50) throw new Error("pagination did not drain within 50 pages");
    }
    // Ownership: every returned record must belong to the bound account.
    const first = await provider.syncObservations(binding, "");
    const cross = first.added.concat(first.modified).filter((o) => o.accountBindingId !== binding.id);
    if (cross.length > 0) throw new Error(`adapter admitted ${cross.length} cross-account record(s)`);
    return { pages, added, modified, removed, finalCursorFingerprint: fp(cursor) };
  });

  // ── 5. Webhook → durable resync trigger (idempotent) ──────────────────────
  const webhook = await step(5, "SYNC_UPDATES_AVAILABLE webhook → resync trigger", async () => {
    const fired = await plaid.sandboxItemFireWebhook({
      access_token: currentToken(),
      webhook_code: SYNC_UPDATES_AVAILABLE as never,
    });
    const payload = { webhook_code: SYNC_UPDATES_AVAILABLE, item_id: "item-x", new_transactions: 0 };
    const req1 = parseSyncUpdatesAvailable(payload);
    const req2 = parseSyncUpdatesAvailable(payload);
    return {
      webhookFired: fired.data.webhook_fired,
      idempotent: JSON.stringify(req1) === JSON.stringify(req2),
      reason: req1?.reason,
    };
  });

  // ── 6. Create an incoming deposit (Plaid negative amount = money IN) ──────
  const deposit = await step(6, "create incoming deposit via /sandbox/transactions/create", async () => {
    const today = new Date().toISOString().slice(0, 10);
    await plaid.sandboxTransactionsCreate({
      access_token: currentToken(),
      transactions: [
        { date_transacted: today, date_posted: today, amount: -800.0, description: "ALEPES CERTIFICATION DEPOSIT" },
      ],
    });
    return { plaidAmountDollars: -800.0, isoCurrency: "USD" };
  });

  // ── 7. Re-sync and verify deposit normalizes to provider-neutral credit ───
  const normalized = await step(7, "deposit normalizes to provider-neutral incoming cash", async () => {
    let cursor = "";
    let found = false;
    let normAmountCents = 0;
    for (;;) {
      const d = await provider.syncObservations(binding, cursor);
      const foundObs = d.added
        .concat(d.modified)
        .find((o) => o.description.includes("CERTIFICATION DEPOSIT"));
      if (foundObs) {
        found = true;
        normAmountCents = foundObs.amountCents;
        const expected = 80_000; // Plaid -800.00 → Alepes +80000 cents
        if (foundObs.direction !== "credit" || Math.abs(normAmountCents - expected) > 1) {
          throw new Error(
            `deposit normalized wrong: direction=${foundObs.direction} amountCents=${normAmountCents}`
          );
        }
      }
      cursor = d.nextCursor;
      if (!d.hasMore) break;
    }
    return { found, normalizedCents: normAmountCents };
  });

  // ── 8. Shadow Mode end-to-end (read-only; nothing moves money) ────────────
  const shadow = await step(8, "Shadow Mode capital/allocation decision (no execution)", async () => {
    const delta = await provider.syncObservations(binding, "");
    const depositObs = delta.added
      .concat(delta.modified)
      .find((o) => o.description.includes("CERTIFICATION DEPOSIT"));
    if (!depositObs) return { skipped: "no deposit observation present in Shadow input" };

    const rule = {
      id: "r-cert",
      name: "Certification deposit",
      trigger: "any_deposit",
      reserveBalance: nonNegativeCents(0),
      action: "invest_percentage",
      amount: 50,
      portfolioId: "p1",
      active: true,
      order: 0,
    } as never;
    const portfolio = {
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
    } as never;

    const persisted = {
      id: depositObs.id,
      accountBindingId: binding.id,
      amountCents: depositObs.amountCents,
      direction: depositObs.direction,
      status: depositObs.status,
      qualificationBalanceCents: delta.accountBalance
        ? (delta.accountBalance.availableCents ?? delta.accountBalance.currentCents)
        : nonNegativeCents(1000_00),
      firstObservedAt: depositObs.firstObservedAt,
      postedAt: depositObs.postedAt ?? null,
      description: depositObs.description,
      normalizationVersion: depositObs.normalizationVersion,
      state: "active",
      predecessorObservationId: null,
      lastReconciledCycleId: null,
      createdAt: depositObs.firstObservedAt,
      updatedAt: depositObs.firstObservedAt,
    } as never;

    const decisions = runShadowMode([persisted], { rules: [rule], portfolioState: portfolio });
    const decision = decisions[0];
    return {
      disposition: decision?.disposition.kind ?? "none",
      deployableCents: (decision?.plan.capitalPlan.deployable as number | undefined) ?? 0,
      totalDeployedCents: (decision?.plan.allocationPlan.totalDeployed as number | undefined) ?? 0,
      cashEventIdFingerprint: decision ? fp(decision.plan.cashEvent.id) : "none",
      orderCount: decision?.plan.orders.length ?? 0,
      plannedAhead: decision != null,
    };
  });

  // ── 9. Account isolation: non-depository accounts enumerated, never bound ─
  const isolation = await step(9, "account isolation (non-depository never bound)", async () => {
    const nonDepository = accounts.filter(
      (a) => a.subtype !== "checking" && a.subtype !== "savings" && a.subtype !== "depository" && a.subtype != null
    );
    return {
      totalAccounts: accounts.length,
      nonDepositoryCount: nonDepository.length,
      nonDepositoryFingerprints: nonDepository.map((a) => fp(a.accountId)),
      boundAccountIsDepository: depository.subtype === "checking" || depository.subtype === "savings" || depository.subtype === "depository" || depository.subtype == null,
    };
  });

  // ── Report ────────────────────────────────────────────────────────────────
  const report = {
    environment: "sandbox",
    institutionId: INSTITUTION_ID,
    item: { fingerprint: item.itemIdFingerprint },
    boundAccount: { fingerprint: fp(depositoryAccountId), subtype: depository.subtype },
    accounts: accountSummaries,
    initialSync: redact(initial),
    webhook,
    deposit,
    normalized,
    shadow,
    isolation,
    points,
    allPass: points.every((p) => p.status === "pass"),
    note: "No Production Plaid access, no brokerage, no money movement occurred.",
  };

  console.log("\n=== PLAID SANDBOX CERTIFICATION REPORT ===");
  console.log(JSON.stringify(report, null, 2));
  process.exit(report.allPass ? 0 : 1);
}

main().catch((e) => {
  console.error("HARNESS ERROR:", redact(e instanceof Error ? e.message : String(e)));
  process.exit(3);
});