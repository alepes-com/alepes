// Plaid financial-data adapter: the ONLY package that may import `plaid`.
// It adapts Plaid's /transactions/sync model into Alepes's provider-neutral
// FinancialDataProvider contract.
//
// It is strictly READ-ONLY: no Transfer, no payment initiation, no ACH, no
// money movement. It normalizes Plaid's facts (sign convention included) into
// Alepes-owned observations; it NEVER decides whether a record is a qualifying
// deposit, and it never lets Plaid types, IDs, or sign semantics escape this
// package's public surface.

import type {
  AccountBalanceSnapshot,
  ExternalObservationRef,
  FinancialObservation,
  FinancialObservationId,
  ObservationSyncDelta,
} from "@alepes/domain";
import {
  cents,
  nonNegativeCents,
} from "@alepes/money";
import {
  ProviderError,
  type AccountBinding,
  type FinancialDataProvider,
} from "@alepes/integration-runtime";
import {
  Configuration,
  PlaidApi,
  type RemovedTransaction,
  type Transaction,
  type TransactionsSyncResponse,
} from "plaid";

// ─── Injectably-testable SDK boundary ────────────────────────────────────────
//
// The adapter depends on a minimal client shape, not on the concrete PlaidApi.
// Production code constructs a real PlaidApi (see `createPlaidSdkClient`); tests
// inject deterministic responses. `response` carries `data` (TransactionsSyncResponse)
// mirroring axios's `.data`, which is all the adapter reads.
export interface PlaidTransactionsSyncClient {
  transactionsSync(request: {
    access_token: string;
    cursor?: string;
    count?: number;
  }): Promise<{ data: TransactionsSyncResponse }>;
}

/** A production-ready PlaidApi-backed client. Requires PLAID credentials. */
export function createPlaidSdkClient(
  clientId: string,
  secret: string,
  environment: string
): PlaidTransactionsSyncClient {
  const config = new Configuration({
    basePath: environment,
    baseOptions: {
      headers: {
        "PLAID-CLIENT-ID": clientId,
        "PLAID-SECRET": secret,
      },
    },
  });
  const api = new PlaidApi(config);
  return {
    transactionsSync: (req) =>
      api.transactionsSync(req as never) as unknown as Promise<{ data: TransactionsSyncResponse }>,
  };
}

// ─── Sign convention (Plaid → Alepes) ────────────────────────────────────────
//
// Plaid: a positive `amount` means money LEAVING the account (debit); a negative
// amount means money ENTERING (credit). Alepes: credit (incoming) is positive,
// debit (outgoing) is negative. This flip terminates HERE and never reaches the
// domain, rules, allocation, execution, or Shadow Mode.
export function normalizePlaidAmount(plaidAmount: number): {
  amountCents: ReturnType<typeof cents>;
} {
  // Plaid amounts are dollars (floating). Convert to integer cents and flip sign.
  const flipped = -plaidAmount;
  return { amountCents: cents(Math.round(flipped * 100)) };
}

function toObservation(
  bindingId: string,
  t: Transaction,
  normalizationVersion: string
): FinancialObservation {
  const { amountCents } = normalizePlaidAmount(t.amount);
  const direction = t.amount < 0 ? "credit" : "debit";
  const status = t.pending ? "pending" : "posted";
  return {
    id: `obs-${t.transaction_id}` as FinancialObservationId,
    externalRef: t.transaction_id as ExternalObservationRef,
    accountBindingId: bindingId,
    amountCents,
    direction,
    status,
    firstObservedAt: t.datetime ?? t.date,
    ...(status === "posted" ? { postedAt: t.datetime ?? t.date } : {}),
    description: t.name,
    // Opaque provider linkage for pending→posted; never an Alepes identity.
    ...(t.pending_transaction_id
      ? { predecessorRef: t.pending_transaction_id as ExternalObservationRef }
      : {}),
    normalizationVersion,
  };
}

export const PLAID_NORMALIZATION_VERSION = "plaid-sign-convention@1";

// ─── The adapter ─────────────────────────────────────────────────────────────

export interface PlaidFinancialDataProviderOptions {
  client: PlaidTransactionsSyncClient;
  /** Maps a credentialRef → an access token, resolved via the secret boundary. */
  resolveAccessToken: (credentialRef: string) => Promise<string>;
  /** Known accounts (account_id → display metadata). */
  discover?: (credentialRef: string) => Promise<Array<{ accountId: string; name?: string }>>;
  /** Optional page size for /transactions/sync. */
  count?: number;
}

export function createPlaidFinancialDataProvider(
  opts: PlaidFinancialDataProviderOptions
): FinancialDataProvider {
  const { client, resolveAccessToken, count } = opts;

  return {
    info: { id: "plaid-financial-data", version: PLAID_NORMALIZATION_VERSION },

    async discoverAccounts(credentialRef: string): Promise<AccountBinding[]> {
      // Discovery needs an account list; if the host did not inject one, this
      // adapter cannot enumerate accounts without another API call, so it
      // returns [] rather than fabricating bindings.
      const accounts = opts.discover ? await opts.discover(credentialRef) : [];
      return accounts.map((a, i) => ({
        id: `binding-${i + 1}`,
        providerAccountRef: a.accountId as ExternalObservationRef,
        credentialRef,
        name: a.name,
        metadata: { subtype: "depository" },
      }));
    },

    async bindAccount(credentialRef: string, providerAccountRef: ExternalObservationRef): Promise<AccountBinding> {
      return {
        id: `binding-${providerAccountRef}`,
        providerAccountRef,
        credentialRef,
        metadata: { subtype: "depository" },
      };
    },

    async syncObservations(binding: AccountBinding, cursor: string): Promise<ObservationSyncDelta> {
      const accessToken = await resolveAccessToken(binding.credentialRef);
      let resp: { data: TransactionsSyncResponse };
      try {
        resp = await client.transactionsSync({ access_token: accessToken, cursor, ...(count ? { count } : {}) });
      } catch (err) {
        throw classifyPlaidError(err);
      }

      const data = resp.data;
      // Normalize the account balance snapshot (account-level, NOT a per-transaction
      // "balance after"). Plaid reports balances alongside account data; this is the
      // balance used to qualify incoming-cash observations in this cycle. Selection
      // of available-vs-current happens downstream in selectAccountBalance.
      const accountBalance = normalizeAccountBalance(binding.id, data.accounts, PLAID_NORMALIZATION_VERSION);
      return {
        added: data.added.map((t) => toObservation(binding.id, t, PLAID_NORMALIZATION_VERSION)),
        modified: data.modified.map((t) => toObservation(binding.id, t, PLAID_NORMALIZATION_VERSION)),
        removed: data.removed.map((r: RemovedTransaction) => r.transaction_id as ExternalObservationRef),
        ...(accountBalance ? { accountBalance } : {}),
        nextCursor: data.next_cursor,
        hasMore: data.has_more,
      };
    },
  };
}

/**
 * Pull an Alepes AccountBalanceSnapshot out of the Plaid response's `accounts`
 * array (the first depository account). Returns undefined when no usable balance
 * is present — qualification then defers rather than fabricating a balance.
 */
function normalizeAccountBalance(
  bindingId: string,
  accounts: Array<{ balances?: { available?: number | null; current?: number | null } | null }>,
  normalizationVersion: string
): AccountBalanceSnapshot | undefined {
  const acct = accounts.find((a) => a?.balances && (a.balances.current != null || a.balances.available != null));
  if (!acct?.balances) return undefined;
  const current = acct.balances.current;
  if (current == null && acct.balances.available == null) return undefined;
  return {
    accountBindingId: bindingId,
    ...(acct.balances.available != null
      ? { availableCents: nonNegativeCents(Math.round(acct.balances.available * 100)) }
      : {}),
    currentCents: nonNegativeCents(Math.round((current ?? acct.balances.available!) * 100)),
    capturedAt: new Date().toISOString(),
    // Balances returned alongside /transactions/sync are cached by the provider.
    isCachedByProvider: true,
    normalizationVersion,
  };
}

/**
 * Map a Plaid error to the provider-neutral classification. Plaid's
 * "transactions data mutated during pagination" is surfaced as `restart_sync` so
 * the orchestrator restarts from the original cycle cursor.
 */
function classifyPlaidError(err: unknown): ProviderError {
  const message = err instanceof Error ? err.message : String(err);
  // Plaid's PRODUCT_NOT_READY / recently-mutated data maps to restart_sync.
  if (/mutat|recently changed|PRODUCT_NOT_READY/i.test(message)) {
    return new ProviderError("restart_sync", message);
  }
  const status = (err as { response?: { status?: number } })?.response?.status;
  if (status === 401 || status === 403) return new ProviderError("auth", message);
  if (status === 429) return new ProviderError("rate_limited", message);
  if (status === 404) return new ProviderError("not_found", message);
  if (typeof status === "number" && status >= 500) return new ProviderError("provider_unavailable", message);
  return new ProviderError("unknown", message);
}

// ─── Deterministic fixtures (for conformance + e2e tests) ────────────────────
// Plaid-typed internally; the public surface never exposes Plaid SDK values. The
// adapter converts these into Alepes-owned normalized observations.
export {
  plaidTransaction,
  removedTransaction,
  syncResponse,
  incomingPlaidTransaction,
  outgoingPlaidTransaction,
  plaidAccountWithBalances,
} from "./fixtures";