import { describe, it, expect } from "vitest";
import {
  createPlaidFinancialDataProvider,
  normalizePlaidAmount,
  PLAID_NORMALIZATION_VERSION,
  type PlaidTransactionsSyncClient,
} from "./index";
import {
  incomingPlaidTransaction,
  outgoingPlaidTransaction,
  plaidTransaction,
  removedTransaction,
  syncResponse,
  plaidAccountWithBalances,
} from "./fixtures";
import type { AccountBinding } from "@alepes/integration-runtime";
import type { ExternalObservationRef } from "@alepes/domain";

function makeProvider(responses: Array<{ data: unknown }>, opts?: { discover?: Array<{ accountId: string; name?: string }> }) {
  let i = 0;
  const client: PlaidTransactionsSyncClient = {
    transactionsSync: async () => {
      const r = responses[Math.min(i, responses.length - 1)];
      i += 1;
      return r as { data: never };
    },
  };
  const provider = createPlaidFinancialDataProvider({
    client,
    resolveAccessToken: async () => "tok-test",
    discover: opts?.discover ? async () => opts.discover! : async () => [{ accountId: "acct-1", name: "Checking" }],
  });
  return { provider, get calls() { return i; } };
}

async function firstBinding(provider: ReturnType<typeof makeProvider>["provider"]): Promise<AccountBinding> {
  const accts = await provider.discoverAccounts("cred:test");
  return accts[0];
}

describe("Plaid sign normalization", () => {
  it("negates Plaid amount and uses integer cents", () => {
    // Plaid +100.00 (money OUT) -> Alepes -10000 cents.
    expect(normalizePlaidAmount(100).amountCents).toBe(-10000);
    // Plaid -2814.32 (money IN) -> Alepes +281432 cents.
    expect(normalizePlaidAmount(-2814.32).amountCents).toBe(281432);
  });

  it("incoming (negative Plaid amount) becomes credit/positive observation", async () => {
    const { provider } = makeProvider([
      { data: syncResponse({ added: [incomingPlaidTransaction("t-in")] }) },
    ]);
    const b = await firstBinding(provider);
    const d = await provider.syncObservations(b, "");
    const o = d.added[0];
    expect(o.direction).toBe("credit");
    expect(o.amountCents).toBeGreaterThan(0);
  });

  it("outgoing (positive Plaid amount) becomes debit/negative observation", async () => {
    const { provider } = makeProvider([
      { data: syncResponse({ added: [outgoingPlaidTransaction("t-out")] }) },
    ]);
    const b = await firstBinding(provider);
    const d = await provider.syncObservations(b, "");
    const o = d.added[0];
    expect(o.direction).toBe("debit");
    expect(o.amountCents).toBeLessThan(0);
  });
});

describe("Plaid adapter sync translation", () => {
  it("maps added/modified/removed + cursor + hasMore", async () => {
    const { provider } = makeProvider([
      {
        data: syncResponse({
          added: [incomingPlaidTransaction("a1")],
          modified: [incomingPlaidTransaction("m1")],
          removed: [removedTransaction("r1")],
          next_cursor: "cursor-9",
          has_more: false,
        }),
      },
    ]);
    const b = await firstBinding(provider);
    const d = await provider.syncObservations(b, "cursor-0");
    expect(d.added).toHaveLength(1);
    expect(d.modified).toHaveLength(1);
    expect(d.removed).toEqual(["r1" as ExternalObservationRef]);
    expect(d.nextCursor).toBe("cursor-9");
    expect(d.hasMore).toBe(false);
  });

  it("pending transaction carries pending status + opaque predecessor", async () => {
    const pending = plaidTransaction({ transaction_id: "txn-p", pending: true, amount: -80 });
    const { provider } = makeProvider([{ data: syncResponse({ added: [pending] }) }]);
    const b = await firstBinding(provider);
    const d = await provider.syncObservations(b, "");
    const o = d.added[0];
    expect(o.status).toBe("pending");
    // External ref is the Plaid transaction_id (opaque), NOT exposed as Alepes identity.
    expect(o.externalRef).toBe("txn-p" as ExternalObservationRef);
  });

  it("pending→posted keeps the same external ref (one logical identity)", async () => {
    // Sequence: pending added first, then posted version with pending_transaction_id link.
    const pending = plaidTransaction({ transaction_id: "txn-p", pending: true, amount: -80 });
    const posted = plaidTransaction({
      transaction_id: "txn-posted",
      pending: false,
      pending_transaction_id: "txn-p",
      amount: -80,
    });
    const { provider } = makeProvider([
      { data: syncResponse({ added: [pending], next_cursor: "c1" }) },
      { data: syncResponse({ added: [posted], next_cursor: "c2" }) },
    ]);
    const b = await firstBinding(provider);
    const d1 = await provider.syncObservations(b, "");
    const d2 = await provider.syncObservations(b, "c1");
    expect(d1.added[0].externalRef).toBe("txn-p" as ExternalObservationRef);
    // The posted record's opaque predecessor points to the pending transaction id.
    expect(d2.added[0].predecessorRef).toBe("txn-p" as ExternalObservationRef);
  });

  it("classifies pagination-mutation error as restart_sync", async () => {
    // Build a provider whose client throws a mutation error. Discover injects an
    // account so the binding carries a credential reference (required to reach
    // syncObservations).
    const throwing = createPlaidFinancialDataProvider({
      resolveAccessToken: async () => "tok",
      discover: async () => [{ accountId: "acct-1", name: "Checking" }],
      client: {
        transactionsSync: async () => {
          throw new Error("transactions data mutated during pagination");
        },
      },
    });
    const b = (await throwing.discoverAccounts("cred:test"))[0];
    await expect(throwing.syncObservations(b, "")).rejects.toMatchObject({ kind: "restart_sync" });
  });

  it("does not leak credentials or access token into the delta", async () => {
    const { provider } = makeProvider([{ data: syncResponse({ added: [incomingPlaidTransaction("t-1")] }) }]);
    const b = await firstBinding(provider);
    const d = await provider.syncObservations(b, "");
    const serialized = JSON.stringify(d);
    expect(serialized).not.toContain("tok-test");
    expect(serialized).not.toContain("secret");
    expect(serialized).not.toContain("access_token");
  });

  it("exposes no Plaid SDK identifiers as Alepes observation ids", async () => {
    const { provider } = makeProvider([{ data: syncResponse({ added: [incomingPlaidTransaction("plaid-tx-id-123")] }) }]);
    const b = await firstBinding(provider);
    const d = await provider.syncObservations(b, "");
    const o = d.added[0];
    // Alepes id is mints its own prefixed id, not the raw Plaid transaction_id.
    expect(o.id.startsWith("obs-")).toBe(true);
    expect(o.id).toBe(`obs-plaid-tx-id-123`);
    // Provider link stays in externalRef.
    expect(o.externalRef).toBe("plaid-tx-id-123" as ExternalObservationRef);
  });

  it("normalizationVersion is stamped on every observation", async () => {
    const { provider } = makeProvider([{ data: syncResponse({ added: [incomingPlaidTransaction("t-v")] }) }]);
    const b = await firstBinding(provider);
    const d = await provider.syncObservations(b, "");
    expect(d.added[0].normalizationVersion).toBe(PLAID_NORMALIZATION_VERSION);
  });

  it("resolves the credential reference carried on the binding (never hardcoded, never cross-resolved)", async () => {
    // Track which credential reference the adapter asked to resolve, and echo the
    // requested account scope back with a matching transaction.
    const resolved: string[] = [];
    const lastAccountId: string[] = [];
    const provider = createPlaidFinancialDataProvider({
      resolveAccessToken: async (ref) => {
        resolved.push(ref);
        return `token-for-${ref}`;
      },
      discover: async () => [
        { accountId: "acct-a", name: "A" },
        { accountId: "acct-b", name: "B" },
      ],
      client: {
        transactionsSync: async (req) => {
          const accountId = req.options?.account_id ?? "";
          lastAccountId.push(accountId);
          return {
            data: syncResponse({
              added: [{ ...incomingPlaidTransaction("t-1"), account_id: accountId }],
            }),
          };
        },
      },
    });

    const bindingA = (await provider.discoverAccounts("cred:a"))[0];
    const bindingB = (await provider.discoverAccounts("cred:b"))[1];

    // Each binding carries its own credential reference.
    expect(bindingA.credentialRef).toBe("cred:a");
    expect(bindingB.credentialRef).toBe("cred:b");

    await provider.syncObservations(bindingA, "");
    expect(resolved).toContain("cred:a");
    expect(resolved).not.toContain("cred:b");
    // The request was scoped to binding A's account.
    expect(lastAccountId).toContain("acct-a");

    await provider.syncObservations(bindingB, "");
    expect(resolved).toContain("cred:b");
    // The request was scoped to binding B's account.
    expect(lastAccountId).toContain("acct-b");
    // The adapter never hardcodes a credential reference.
    expect(resolved).not.toContain("cred:test");
  });

  it("asserts the account balance snapshot (not a per-transaction balance) flows from Plaid account data", async () => {
    const provider = createPlaidFinancialDataProvider({
      resolveAccessToken: async () => "tok",
      discover: async () => [{ accountId: "acct-1", name: "Checking" }],
      client: {
        transactionsSync: async () => ({
          data: syncResponse({
            added: [incomingPlaidTransaction("t-in", -800.0)],
            accounts: [plaidAccountWithBalances({ available: 5000, current: 4900 }) as never],
          }),
        }),
      },
    });
    const b = (await provider.discoverAccounts("cred:a"))[0];
    const d = await provider.syncObservations(b, "");
    expect(d.accountBalance).toBeDefined();
    expect(d.accountBalance!.availableCents).toBe(500_000);
    expect(d.accountBalance!.currentCents).toBe(490_000);
    // The observation does NOT carry a fabricated per-transaction balance.
    expect("balanceAfterCents" in d.added[0]).toBe(false);
  });
});

describe("Plaid adapter — account scoping (one Item, multiple accounts)", () => {
  const CHECKING = "acct-checking";
  const SAVINGS = "acct-savings";

  function scopedProvider(overrides?: {
    checkingBalance?: { available?: number | null; current: number } | null;
    savingsBalance?: { available?: number | null; current: number } | null;
  }) {
    const requested: Array<{ token: string; accountId?: string; cursor?: string }> = [];
    const provider = createPlaidFinancialDataProvider({
      resolveAccessToken: async (ref) => `token-${ref}`,
      discover: async () => [
        { accountId: CHECKING, name: "Checking" },
        { accountId: SAVINGS, name: "Savings" },
      ],
      client: {
        transactionsSync: async (req) => {
          requested.push({ token: req.access_token, accountId: req.options?.account_id, cursor: req.cursor });
          const scope = req.options?.account_id;
          const accounts = [];
          if (overrides?.checkingBalance !== null) {
            accounts.push(plaidAccountWithBalances({
              accountId: CHECKING,
              available: overrides?.checkingBalance?.available ?? 1000,
              current: overrides?.checkingBalance?.current ?? 999,
            }));
          }
          if (overrides?.savingsBalance !== null) {
            accounts.push(plaidAccountWithBalances({
              accountId: SAVINGS,
              available: overrides?.savingsBalance?.available ?? 5000,
              current: overrides?.savingsBalance?.current ?? 4999,
            }));
          }
          const added = scope
            ? [{ ...incomingPlaidTransaction(`${scope}-txn`, -50), account_id: scope }]
            : [];
          return { data: syncResponse({ added, accounts: accounts as never[], next_cursor: `cursor-${scope}`, has_more: false }) };
        },
      },
    });
    return { provider, requested };
  }

  it("sends options.account_id = the bound account for each binding, and cursors stay independent", async () => {
    const { provider, requested } = scopedProvider();
    const checking = (await provider.discoverAccounts("cred:c"))[0];
    const savings = (await provider.discoverAccounts("cred:c"))[1];

    const dc = await provider.syncObservations(checking, "c0");
    const ds = await provider.syncObservations(savings, "s0");

    // Each request carried the bound account_id.
    expect(requested[0].accountId).toBe(CHECKING);
    expect(requested[1].accountId).toBe(SAVINGS);
    // Each binding advanced its own cursor independently.
    expect(requested[0].cursor).toBe("c0");
    expect(requested[1].cursor).toBe("s0");
    expect(dc.nextCursor).toBe(`cursor-${CHECKING}`);
    expect(ds.nextCursor).toBe(`cursor-${SAVINGS}`);
  });

  it("checking transactions cannot appear under the savings binding (and vice versa)", async () => {
    const { provider } = scopedProvider();
    const checking = (await provider.discoverAccounts("cred:c"))[0];
    const savings = (await provider.discoverAccounts("cred:c"))[1];

    const dc = await provider.syncObservations(checking, "");
    const ds = await provider.syncObservations(savings, "");

    // Each observation is scoped to its own binding's account.
    expect(dc.added[0].accountBindingId).toBe(checking.id);
    expect(ds.added[0].accountBindingId).toBe(savings.id);
    expect(dc.added[0].externalRef).toContain(CHECKING);
    expect(ds.added[0].externalRef).toContain(SAVINGS);
  });

  it("checking uses checking balance only; savings uses savings balance only", async () => {
    const { provider } = scopedProvider({
      checkingBalance: { current: 1111 },
      savingsBalance: { current: 2222 },
    });
    const checking = (await provider.discoverAccounts("cred:c"))[0];
    const savings = (await provider.discoverAccounts("cred:c"))[1];

    const dc = await provider.syncObservations(checking, "");
    const ds = await provider.syncObservations(savings, "");

    expect(dc.accountBalance!.currentCents).toBe(1111_00);
    expect(ds.accountBalance!.currentCents).toBe(2222_00);
  });

  it("missing checking balance does not fall back to savings balance", async () => {
    const { provider } = scopedProvider({ checkingBalance: null, savingsBalance: { current: 2222 } });
    const checking = (await provider.discoverAccounts("cred:c"))[0];

    const dc = await provider.syncObservations(checking, "");
    // No accountBalance snapshot: qualification should defer, not borrow savings.
    expect(dc.accountBalance).toBeUndefined();
  });

  it("a mismatched transaction account_id fails as an invariant error (never silently rebound)", async () => {
    const provider = createPlaidFinancialDataProvider({
      resolveAccessToken: async () => "tok",
      discover: async () => [{ accountId: CHECKING, name: "Checking" }],
      client: {
        transactionsSync: async () => ({
          data: syncResponse({
            // Provider returned a SAVINGS transaction despite a CHECKING-scoped request.
            added: [{ ...incomingPlaidTransaction("savings-txn"), account_id: SAVINGS }],
          }),
        }),
      },
    });
    const checking = (await provider.discoverAccounts("cred:c"))[0];
    await expect(provider.syncObservations(checking, "")).rejects.toMatchObject({ kind: "invalid_request" });
  });
});