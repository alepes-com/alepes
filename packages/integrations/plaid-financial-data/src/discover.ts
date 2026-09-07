// Real Plaid account discovery for the read-only financial-data adapter.
//
// The adapter's `discover` callback is an injectable seam (for tests and for
// hosts that already hold an account list). This module provides the production
// implementation of that seam: it calls Plaid's `/accounts/get` and maps the
// result into the provider-neutral `{ accountId, name }` shape the adapter
// consumes. No Plaid type escapes this package's public surface.

import type { ExternalObservationRef } from "@alepes/domain";

/** A minimal Plaid `/accounts/get` client call, injectable for tests. */
export interface PlaidAccountsGetClient {
  accountsGet(request: {
    access_token: string;
    options?: { account_ids?: string[] };
  }): Promise<{
    data: {
      accounts: Array<{
        account_id: string;
        name: string;
        subtype: string | null;
      }>;
    };
  }>;
}

export interface DiscoveredPlaidAccount {
  accountId: string;
  name: string;
  /** Provider-reportedaccount subtype (e.g. "checking", "savings", "credit card"). */
  subtype: string | null;
}

/**
 * Discover accounts for a credential-ref via Plaid `/accounts/get`.
 *
 * `resolveAccessToken` is the same secret boundary the adapter uses: it maps an
 * opaque `credentialRef` to an access token without the caller holding raw
 * credentials. Never prints or returns the token.
 */
export async function discoverPlaidAccounts(
  client: PlaidAccountsGetClient,
  resolveAccessToken: (credentialRef: string) => Promise<string>,
  credentialRef: string
): Promise<DiscoveredPlaidAccount[]> {
  const accessToken = await resolveAccessToken(credentialRef);
  const resp = await client.accountsGet({ access_token: accessToken });
  return resp.data.accounts.map((a) => ({
    accountId: a.account_id,
    name: a.name,
    subtype: a.subtype,
  }));
}

/**
 * Select the depository/checking account that becomes the Alepes bound account.
 *
 * Returns the first account whose subtype is depository-like (`checking` is
 * preferred when present). When the Item contains a credit card or other
 * non-depository account, that account is NOT eligible to be the bound
 * depository account — an explicit, deterministic selection, never a silent
 * "first account" fallback.
 */
export function selectDepositoryAccount(
  accounts: DiscoveredPlaidAccount[]
): DiscoveredPlaidAccount | undefined {
  if (accounts.length === 0) return undefined;
  return (
    accounts.find((a) => a.subtype === "checking") ??
    accounts.find((a) => a.subtype === "savings") ??
    accounts.find((a) => a.subtype === "depository") ??
    accounts.find((a) => a.subtype == null)
  );
}

/** Map discovered accounts into the adapter's `discover` callback shape. */
export function toDiscoverShape(
  accounts: DiscoveredPlaidAccount[]
): Array<{ accountId: string; name?: string }> {
  return accounts.map((a) => ({ accountId: a.accountId, name: a.name }));
}

// Opaque provider account reference: re-typed at the adapter boundary only.
export type PlaidAccountRef = ExternalObservationRef;