import { describe, it, expect } from "vitest";
import {
  discoverPlaidAccounts,
  selectDepositoryAccount,
  toDiscoverShape,
  type PlaidAccountsGetClient,
} from "./discover";
import {
  SYNC_UPDATES_AVAILABLE,
  parseSyncUpdatesAvailable,
  type SyncWebhookPayload,
} from "./webhook";

const accountsGetClient = (accounts: Array<{ account_id: string; name: string; subtype: string | null }>): PlaidAccountsGetClient => ({
  accountsGet: async () => ({ data: { accounts } }),
});

describe("discoverPlaidAccounts (real /accounts/get mapping)", () => {
  it("maps Plaid accounts into the provider-neutral discovery shape without leaking the token", async () => {
    const client = accountsGetClient([
      { account_id: "acct-checking", name: "Platypus Checking", subtype: "checking" },
      { account_id: "acct-cc", name: "Platypus Card", subtype: "credit card" },
    ]);
    let resolvedRef = "";
    const accounts = await discoverPlaidAccounts(client, async (ref) => {
      resolvedRef = ref;
      return "tok-secret-do-not-leak";
    }, "cred:test");
    expect(resolvedRef).toBe("cred:test");
    expect(accounts).toHaveLength(2);
    expect(accounts[0].accountId).toBe("acct-checking");
    expect(JSON.stringify(accounts)).not.toContain("tok-secret-do-not-leak");
  });
});

describe("selectDepositoryAccount (deterministic, no first-account fallback)", () => {
  it("prefers checking over savings and never selects a credit card", () => {
    const accounts = [
      { accountId: "acct-cc", name: "Card", subtype: "credit card" },
      { accountId: "acct-sav", name: "Savings", subtype: "savings" },
      { accountId: "acct-chk", name: "Checking", subtype: "checking" },
    ];
    expect(selectDepositoryAccount(accounts)?.accountId).toBe("acct-chk");
  });

  it("falls back to savings when no checking exists, still not the card", () => {
    const accounts = [
      { accountId: "acct-cc", name: "Card", subtype: "credit card" },
      { accountId: "acct-sav", name: "Savings", subtype: "savings" },
    ];
    expect(selectDepositoryAccount(accounts)?.accountId).toBe("acct-sav");
  });

  it("returns undefined for an empty account list", () => {
    expect(selectDepositoryAccount([])).toBeUndefined();
  });

  it("toDiscoverShape flattens to the adapter's discover seam", () => {
    const accounts = [
      { accountId: "acct-1", name: "Checking", subtype: "checking" },
    ];
    expect(toDiscoverShape(accounts)).toEqual([{ accountId: "acct-1", name: "Checking" }]);
  });
});

describe("parseSyncUpdatesAvailable (webhook → durable trigger)", () => {
  it("maps SYNC_UPDATES_AVAILABLE to a resync request", () => {
    const payload: SyncWebhookPayload = {
      webhook_type: "TRANSACTIONS",
      webhook_code: SYNC_UPDATES_AVAILABLE,
      item_id: "item-1",
      new_transactions: 3,
    };
    expect(parseSyncUpdatesAvailable(payload)).toEqual({
      reason: "sync_updates_available",
      itemId: "item-1",
      newTransactions: 3,
    });
  });

  it("ignores non-SYNC_UPDATES_AVAILABLE webhooks", () => {
    expect(parseSyncUpdatesAvailable({ webhook_code: "DEFAULT_UPDATE" })).toBeNull();
    expect(parseSyncUpdatesAvailable({ webhook_code: "ERROR" })).toBeNull();
  });

  it("is idempotent for duplicate payloads", () => {
    const payload: SyncWebhookPayload = { webhook_code: SYNC_UPDATES_AVAILABLE, item_id: "i", new_transactions: 1 };
    expect(parseSyncUpdatesAvailable(payload)).toEqual(parseSyncUpdatesAvailable(payload));
  });
});