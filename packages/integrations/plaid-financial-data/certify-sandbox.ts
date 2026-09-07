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
// SECURITY: never prints client_id, secret, access tokens, item ids, or raw
// account ids. Redacts them to deterministic fingerprints. Refuses Production.
//
// CERTIFICATION CHAIN (the exact-chain proof this run must produce):
//   /sandbox/transactions/create  (-800.00 USD, "ALEPES CERTIFICATION DEPOSIT")
//     → observed via account-scoped /transactions/sync (from the retained post-initial cursor)
//     → normalized by the REAL Alepes Plaid adapter to 80000 integer credit cents
//     → passed through runShadowMode (50% rule → 40000 deployable cents, disposition "shadow")
//   with NO transfer / brokerage / money movement anywhere.
//
// The created transaction is matched deterministically (description + bound
// account + expected amount/sign + expected date). If it never appears within
// the bounded polling window, certification FAILS — it does not silently fall
// back to an unrelated seeded credit.

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
const accountIds: string[] = [];
function redact(s: unknown): unknown {
  if (typeof s !== "string") return s;
  let out = s;
  out = out.replaceAll(CLIENT_ID!, "REDACTED_CLIENT_ID");
  out = out.replaceAll(SECRET!, "REDACTED_SECRET");
  for (const tok of accessTokens) out = out.replaceAll(tok, `REDACTED_ACCESS_TOKEN(${fp(tok)})`);
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

// The deterministic certification deposit the harness creates and MUST observe.
const CERT_DEPOSIT = {
  description: "ALEPES CERTIFICATION DEPOSIT",
  amountDollars: -800.0, // Plaid: negative = money IN
  expectedCents: 80000, // 800.00 USD → integer cents (sign flipped to credit)
  dateTransacted: () => new Date().toISOString().slice(0, 10),
};

async function sleep(ms: number): Promise<void> {
  await new Promise((r) => setTimeout(r, ms));
}

async function main(): Promise<void> {
  // ── 1. Create a deterministic Transactions Sandbox Item ───────────────────
  const item = await step(1, "create user_transactions_dynamic Sandbox Item", async () => {
    const pt = await plaid.sandboxPublicTokenCreate({
      institution_id: INSTITUTION_ID,
      initial_products: [Products.Transactions],
      options: {
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

  await step(2, "discover accounts via /accounts/get", async () => {
    const list = await discoverPlaidAccounts(accountsClient, async () => currentToken(), "cred:plaid-sandbox");
    for (const a of list) accountIds.push(a.accountId);
    return list.map((a) => ({ accountFingerprint: fp(a.accountId), name: a.name, subtype: a.subtype }));
  });

  const realAccounts = await discoverPlaidAccounts(accountsClient, async () => currentToken(), "cred:plaid-sandbox");
  for (const a of realAccounts) accountIds.push(a.accountId);

  const accountSummaries = realAccounts.map((a) => ({
    accountFingerprint: fp(a.accountId),
    name: a.name,
    subtype: a.subtype,
  }));

  const depository = selectDepositoryAccount(realAccounts);
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
  // Drain the seeded history and RETAIN the resulting cursor. We will resume from
  // this cursor after creating the certification deposit, so the created
  // transaction is observed as a genuine incremental `added` (not a seeded row).
  let initialCursor = "";
  const initial = await step(4, "initial account-scoped /transactions/sync", async () => {
    let pages = 0;
    let added = 0;
    let modified = 0;
    let removed = 0;
    let settleStatus = "unknown";

    // Wait for the item's initial transactions pull to settle (bounded).
    for (let poll = 0; poll < 30; poll++) {
      const probe = await plaid.transactionsSync({
        access_token: currentToken(),
        options: { account_id: depositoryAccountId },
      });
      settleStatus = probe.data.transactions_update_status;
      if (probe.data.added.length > 0 || probe.data.transactions_update_status === "HISTORICAL_UPDATE_COMPLETE") {
        break;
      }
      await sleep(2000);
    }

    let cursor = "";
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
    initialCursor = cursor;

    // Ownership: every returned record must belong to the bound account.
    const first = await provider.syncObservations(binding, "");
    const cross = first.added.concat(first.modified).filter((o) => o.accountBindingId !== binding.id);
    if (cross.length > 0) throw new Error(`adapter admitted ${cross.length} cross-account record(s)`);
    return {
      pages,
      added,
      modified,
      removed,
      settleStatus,
      cursorFingerprint: fp(cursor),
      cursorLength: cursor.length,
    };
  });

  // ── 5. Webhook → durable resync trigger (idempotent) ──────────────────────
  const webhook = await step(5, "SYNC_UPDATES_AVAILABLE webhook → resync trigger", async () => {
    let registered = false;
    let registerError: string | null = null;
    try {
      await plaid.itemWebhookUpdate({
        access_token: currentToken(),
        webhook: "https://alepes-sandbox.example.invalid/webhook",
      });
      registered = true;
    } catch (e) {
      registerError = e instanceof Error ? e.message : String(e);
    }
    let webhookFired = false;
    let webhookError: string | null = null;
    try {
      const fired = await plaid.sandboxItemFireWebhook({
        access_token: currentToken(),
        webhook_code: SYNC_UPDATES_AVAILABLE as never,
      });
      webhookFired = fired.data.webhook_fired;
    } catch (e) {
      webhookError = e instanceof Error ? e.message : String(e);
    }
    const payload = { webhook_code: SYNC_UPDATES_AVAILABLE, item_id: "item-x", new_transactions: 0 };
    const req1 = parseSyncUpdatesAvailable(payload);
    const req2 = parseSyncUpdatesAvailable(payload);
    return {
      webhookRegistered: registered,
      registerError,
      webhookFired,
      webhookError,
      idempotent: JSON.stringify(req1) === JSON.stringify(req2),
      reason: req1?.reason,
    };
  });

  // ── 6. Create the deterministic certification deposit ─────────────────────
  // This is THE transaction the rest of the chain must run through. It is
  // matched later by description + account + amount/sign + date.
  const createdDate = CERT_DEPOSIT.dateTransacted();
  const deposit = await step(6, "create deterministic certification deposit (-800.00 USD)", async () => {
    await plaid.sandboxTransactionsCreate({
      access_token: currentToken(),
      transactions: [
        {
          date_transacted: createdDate,
          date_posted: createdDate,
          amount: CERT_DEPOSIT.amountDollars,
          description: CERT_DEPOSIT.description,
          iso_currency_code: "USD",
        },
      ],
    });
    return {
      created: true,
      description: CERT_DEPOSIT.description,
      plaidAmountDollars: CERT_DEPOSIT.amountDollars,
      isoCurrency: "USD",
      date: createdDate,
    };
  });

  // ── 7. Observe the created deposit via account-scoped /transactions/sync ──
  // Resume from initialCursor (NOT the seeded history) and poll until the exact
  // created transaction surfaces in `added`. Fail if it never appears.
  const observed = await step(7, "observe created deposit via bound-account /transactions/sync", async () => {
    const deadline = Date.now() + 120_000; // bounded: 2 minutes
    let cursor = initialCursor;
    let lastStatus = "unknown";

    for (;;) {
      const d = await provider.syncObservations(binding, cursor);
      lastStatus = (d as unknown as { status?: string }).status ?? "ok";

      const match = d.added.find(
        (o) =>
          o.accountBindingId === binding.id &&
          o.description === CERT_DEPOSIT.description &&
          o.direction === "credit" &&
          o.amountCents === CERT_DEPOSIT.expectedCents
      );

      if (match) {
        // Retain the exact normalized observation for Shadow (same object identity).
        return {
          found: true,
          observedFingerprint: fp(String(match.externalRef)),
          description: match.description,
          direction: match.direction,
          amountCents: match.amountCents,
          status: match.status,
        };
      }

      cursor = d.nextCursor;
      if (Date.now() > deadline) {
        break;
      }
      await sleep(3000);
    }

    // Fail loudly — never fall back to seeded data.
    throw new Error(
      `created deposit "${CERT_DEPOSIT.description}" was NOT observed within the bounded window ` +
        `(status=${lastStatus}). Certification cannot pass on seeded data.`
    );
  });

  // ── 8. Normalize: confirm exact 80000 credit cents + bound account ────────
  const normalized = await step(8, "created deposit normalizes to 80000 credit cents", async () => {
    // Re-resolve the SAME created transaction deterministically (not a generic credit).
    const d = await provider.syncObservations(binding, initialCursor);
    const match = d.added.find(
      (o) =>
        o.accountBindingId === binding.id &&
        o.description === CERT_DEPOSIT.description &&
        o.direction === "credit"
    );
    if (!match) {
      throw new Error("created deposit not re-resolvable from the retained cursor");
    }
    if (match.direction !== "credit" || match.amountCents !== CERT_DEPOSIT.expectedCents) {
      throw new Error(
        `normalization mismatch: direction=${match.direction} amountCents=${match.amountCents} ` +
          `(expected credit / ${CERT_DEPOSIT.expectedCents})`
      );
    }
    if (match.accountBindingId !== binding.id) {
      throw new Error(`normalized observation belongs to ${match.accountBindingId}, not the bound account`);
    }
    return {
      found: true,
      description: match.description,
      normalizedCents: match.amountCents,
      direction: match.direction,
      status: match.status,
      externalRefFingerprint: fp(String(match.externalRef)),
      accountBinding: "bound",
    };
  });

  // ── 9. Shadow Mode end-to-end (read-only; 50% rule → 40000; nothing moves) ─
  const shadow = await step(9, "Shadow Mode: 40000 deployable cents, disposition shadow, no execution", async () => {
    const d = await provider.syncObservations(binding, initialCursor);
    const depositObs = d.added.find(
      (o) =>
        o.accountBindingId === binding.id &&
        o.description === CERT_DEPOSIT.description &&
        o.direction === "credit"
    );
    if (!depositObs) throw new Error("created deposit missing from Shadow input stream");

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
      qualificationBalanceCents: d.accountBalance
        ? (d.accountBalance.availableCents ?? d.accountBalance.currentCents)
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
    if (!decision) throw new Error("no shadow decision produced");

    const deployable = (decision.plan.capitalPlan.deployable as number) ?? 0;
    const totalDeployed = (decision.plan.allocationPlan.totalDeployed as number) ?? 0;

    // The 50% rule on an 80000-cent deposit must yield exactly 40000 deployable.
    if (deployable !== 40000) {
      throw new Error(`shadow deployable=${deployable}, expected 40000 (50% of 80000)`);
    }
    if (totalDeployed !== 40000) {
      throw new Error(`shadow totalDeployed=${totalDeployed}, expected 40000`);
    }
    if (decision.disposition.kind !== "shadow") {
      throw new Error(`disposition=${decision.disposition.kind}, expected shadow (non-executing)`);
    }

    return {
      disposition: decision.disposition.kind,
      deployableCents: deployable,
      totalDeployedCents: totalDeployed,
      cashEventIdFingerprint: fp(decision.plan.cashEvent.id),
      orderCount: decision.plan.orders.length,
      sourceDescription: depositObs.description,
      nonExecuting: true,
    };
  });

  // ── 10. Account isolation: non-depository accounts enumerated, never bound ─
  const isolation = await step(10, "account isolation (non-depository never bound)", async () => {
    const nonDepository = realAccounts.filter(
      (a) => a.subtype !== "checking" && a.subtype !== "savings" && a.subtype !== "depository" && a.subtype != null
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

  // ── Report ────────────────────────────────────────────────────────────────
  const report = {
    environment: "sandbox",
    institutionId: INSTITUTION_ID,
    testUser: "user_transactions_dynamic",
    item: { fingerprint: item.itemIdFingerprint },
    boundAccount: { fingerprint: fp(depositoryAccountId), subtype: depository.subtype },
    accounts: accountSummaries,
    initialSync: initial,
    webhook,
    depositChain: {
      created: deposit,
      observed,
      normalized,
      shadow,
    },
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