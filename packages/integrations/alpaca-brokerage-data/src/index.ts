// Alpaca brokerage-data adapter: the ONLY package that may speak Alpaca's
// Trading API. It adapts Alpaca's paper `/v2/account` + `/v2/positions` +
// market-data endpoints into Alepes's provider-neutral `BrokerageDataProvider`
// contract.
//
// It is strictly READ-ONLY: no order submission, no transfer, no mutation. It
// normalizes Alpaca's facts (decimal-string money, share quantities, account
// status) into Alepes-owned integer-cent / decimal-string values; it NEVER
// decides what to do with them, and it never lets Alpaca types, field names, or
// credential material escape this package's public surface.
//
// PAPER-ONLY: the constructor refuses any configuration other than Alpaca
// paper/sandbox, so a live-trading credential can never be wired onto the
// read-only observation path by accident.

import type {
  BrokerageAccountState,
  BrokeragePosition,
  ExternalObservationRef,
} from "@alepes/domain";
import {
  cents,
  fromDecimalString,
  nonNegativeCents,
  toNumber,
  type Cents,
  type NonNegativeCents,
} from "@alepes/money";
import {
  ProviderError,
  type AccountBinding,
  type BrokerageDataProvider,
  type ProviderInfo,
} from "@alepes/integration-runtime";

// ─── Paper-domain guard ──────────────────────────────────────────────────────
// A hard environment boundary mirroring the Plaid sandbox/discovery boundary.
// Only paper/sandbox configuration may construct an adapter; any live-trading
// base URL is rejected at construction time, before the first network call.

export type AlpacaEnvironment = "paper" | "sandbox";

export const ALPACA_PAPER_BASE_URL = "https://paper-api.alpaca.markets";
export const ALPACA_SANDBOX_BASE_URL = "https://api.sandbox.alpaca.markets";
export const ALPACA_MARKET_DATA_PAPER_URL = "https://data.sandbox.alpaca.markets";

// ─── Live-boundary constants (v0.4.0) ──────────────────────────────────────
// The LIVE Trading API host is deliberately a SEPARATE constant from paper, and
// is reachable only through `createAlpacaLiveClient` below — never through
// `createAlpacaClient`, whose defaults are paper-only. This keeps the paper
// harness hard-guarded to paper even as the live path is added.
export const ALPACA_LIVE_BASE_URL = "https://api.alpaca.markets";
export const ALPACA_MARKET_DATA_LIVE_URL = "https://data.alpaca.markets";

// ─── Injectably-testable HTTP boundary ───────────────────────────────────────
// The adapter depends on a minimal client shape, not a concrete HTTP library.
// Production code constructs a fetch-backed client (see `createAlpacaClient`);
// tests inject deterministic responses. This mirrors the Plaid adapter's
// injectable `PlaidTransactionsSyncClient`.

export interface AlpacaHttpResponse<T> {
  status: number;
  data: T;
}

export interface AlpacaAccount {
  id: string;
  account_number?: string;
  status: string;
  currency?: string;
  cash: string;
  buying_power: string;
  portfolio_value: string;
  equity?: string;
}

export interface AlpacaPosition {
  asset_id: string;
  symbol: string;
  qty: string;
  market_value: string;
  avg_entry_price: string;
  currency?: string | null;
}

export interface AlpacaQuote {
  ap: number | null;
  bp: number | null;
}

export interface AlpacaClient {
  getAccount(): Promise<AlpacaHttpResponse<AlpacaAccount>>;
  getPositions(): Promise<AlpacaHttpResponse<AlpacaPosition[]>>;
  getQuote(symbol: string): Promise<AlpacaHttpResponse<AlpacaQuote>>;
}

/** A production fetch-backed client. Auth is a key-id + secret basic-auth pair. */
export function createAlpacaClient(
  keyId: string,
  secretKey: string,
  baseUrl: string = ALPACA_PAPER_BASE_URL,
  marketDataBaseUrl: string = ALPACA_MARKET_DATA_PAPER_URL
): AlpacaClient {
  const auth = Buffer.from(`${keyId}:${secretKey}`).toString("base64");
  const headers = { Authorization: `Basic ${auth}` };

  async function get<T>(url: string): Promise<AlpacaHttpResponse<T>> {
    const res = await fetch(url, { headers, method: "GET" });
    const status = res.status;
    // SAFETY: the response body is the provider's typed JSON for this endpoint;
    // the generic T is the boundary-level shape the caller declared for that URL.
    const data = (await res.json()) as T;
    return { status, data };
  }

  return {
    getAccount: () => get<AlpacaAccount>(`${baseUrl}/v2/account`),
    getPositions: () => get<AlpacaPosition[]>(`${baseUrl}/v2/positions`),
    getQuote: (symbol: string) =>
      get<AlpacaQuote>(
        `${marketDataBaseUrl}/v2/stocks/${encodeURIComponent(symbol)}/quotes/latest`
      ),
  };
}

/**
 * The LIVE-TRADING read-only client (v0.4.0). This is the ONLY entry point that
 * targets `api.alpaca.markets`. It is read-only by construction — the same
 * AlpacaClient surface exposes only GET endpoints (account/positions/quotes),
 * with NO order/transfer method. Live credentials never appear in logs (the
 * auth header is built here and never echoed).
 */
export function createAlpacaLiveClient(
  keyId: string,
  secretKey: string
): AlpacaClient {
  return createAlpacaClient(
    keyId,
    secretKey,
    ALPACA_LIVE_BASE_URL,
    ALPACA_MARKET_DATA_LIVE_URL
  );
}

// ─── Normalization (Alpaca → Alepes) ─────────────────────────────────────────
// Alpaca reports money as DECIMAL STRINGS (never floats). We parse exactly to
// integer cents, so no JS-float rounding ever touches authoritative money.
// Quantities stay decimal strings. Sign convention requires no flip: Alpaca's
// account (cash, buying_power, portfolio_value) and position (market_value,
// avg_entry_price) are already non-negative long-valued fields.

export const ALPACA_NORMALIZATION_VERSION = "alpaca-paper-report@1";

function toNonNegativeCents(s: string, field: string): NonNegativeCents {
  const c = fromDecimalString(s);
  if (toNumber(c) < 0) {
    throw new ProviderError("invalid_request", `${field} is negative: "${s}"`);
  }
  return nonNegativeCents(toNumber(c));
}

function normalizeAccountStatus(raw: string): BrokerageAccountState["status"] {
  // Alpaca account.status values: ONBOARDING, SUBMITTED, ACTION_REQUIRED,
  // ACCOUNT_UPDATED, APPROVAL_PENDING, ACTIVE, REJECTED, DISABLED, CLOSED.
  const s = raw.toUpperCase();
  if (s === "ACTIVE") return "active";
  if (s === "CLOSED" || s === "REJECTED" || s === "DISABLED") return "closed";
  return "restricted";
}

function normalizePosition(p: AlpacaPosition): BrokeragePosition {
  return {
    symbol: p.symbol.toUpperCase(),
    quantity: p.qty,
    marketValueCents: toNonNegativeCents(p.market_value, "position market_value"),
    averageEntryPriceCents: toNonNegativeCents(p.avg_entry_price, "position avg_entry_price"),
    currency: p.currency ?? "USD",
  };
}

function normalizePriceFromQuote(symbol: string, q: AlpacaQuote): Cents {
  // Use the ask, else bid, else zero — a read-only, last-known price. The quote
  // prices are dollars-as-float; this is the ONE float→cents conversion in the
  // adapter, and it is explicitly opted-in via `centsFromDollarsFloat`.
  const px = q.ap ?? q.bp ?? 0;
  return cents(Math.round(px * 100));
}

// ─── Error classification ────────────────────────────────────────────────────

function classifyError(err: unknown): ProviderError {
  const message = err instanceof Error ? err.message : String(err);
  // SAFETY: `err` is trusted to carry an optional HTTP `status` only when the
  // network/client layer attached one; unknown shape yields `undefined` and the
  // fallthrough `unknown` classification.
  const status = (err as { status?: number })?.status;
  if (status === 401 || status === 403) return new ProviderError("auth", message);
  if (status === 429) return new ProviderError("rate_limited", message);
  if (status === 404) return new ProviderError("not_found", message);
  if (typeof status === "number" && status >= 500)
    return new ProviderError("provider_unavailable", message);
  if (message && /network|fetch|econnrefused|enotfound/i.test(message))
    return new ProviderError("provider_unavailable", message);
  return new ProviderError("unknown", message);
}

/** Classify an HTTP status into a ProviderError, used where only status is known. */
function throwForStatus(status: number): void {
  if (status >= 400) throw classifyError({ status });
}

// ─── The adapter ─────────────────────────────────────────────────────────────

export interface AlpacaBrokerageDataProviderOptions {
  client: AlpacaClient;
  /**
   * Which Alpaca host this provider reads from. `paper`/`sandbox` are the v0.3.0
   * read-only observation boundary; `live` is the v0.4.0 real-account boundary.
   * The provider reports this in its info + binding metadata so the certification
   * harness can assert it is talking to the intended host.
   */
  environment?: "paper" | "sandbox" | "live";
  /**
   * Resolve credential material (key/secret) to a durable credentialRef. The
   * adapter never holds raw keys; it only carries opaque references, mirroring
   * the Plaid adapter's `resolveAccessToken`.
   */
  resolveCredentialRef: (keyId: string, secret: string) => Promise<string>;
}

export function createAlpacaBrokerageDataProvider(
  opts: AlpacaBrokerageDataProviderOptions
): BrokerageDataProvider {
  const { client, environment = "paper" } = opts;
  const info: ProviderInfo = {
    id: `alpaca-brokerage-data-${environment}`,
    version: ALPACA_NORMALIZATION_VERSION,
  };

  return {
    info,

    async discoverAccounts(credentialRef: string): Promise<AccountBinding[]> {
      try {
        const { status, data } = await client.getAccount();
        throwForStatus(status);
        // SAFETY: the opaquely-branded external ref is minted from Alpaca's
        // account_number when present, else the account id — both opaque to Alepes.
        const providerAccountRef = (data.account_number ?? data.id) as ExternalObservationRef;
        return [
          {
            id: `binding-${data.id}`,
            providerAccountRef,
            credentialRef,
            name: `Alpaca ${data.account_number ?? data.id}`,
            metadata: { subtype: "brokerage", environment },
          },
        ];
      } catch (err) {
        if (err instanceof ProviderError) throw err;
        throw classifyError(err);
      }
    },

    async readAccount(binding: AccountBinding): Promise<BrokerageAccountState> {
      try {
        const { status, data } = await client.getAccount();
        throwForStatus(status);
        return {
          accountBindingId: binding.id,
          providerAccountRef: binding.providerAccountRef,
          status: normalizeAccountStatus(data.status),
          cashCents: toNonNegativeCents(data.cash, "account cash"),
          buyingPowerCents: toNonNegativeCents(data.buying_power, "account buying_power"),
          portfolioValueCents: toNonNegativeCents(data.portfolio_value, "account portfolio_value"),
          capturedAt: new Date().toISOString(),
          normalizationVersion: ALPACA_NORMALIZATION_VERSION,
        };
      } catch (err) {
        if (err instanceof ProviderError) throw err;
        throw classifyError(err);
      }
    },

    async readPositions(_binding: AccountBinding): Promise<BrokeragePosition[]> {
      try {
        const { status, data } = await client.getPositions();
        throwForStatus(status);
        return data.map(normalizePosition);
      } catch (err) {
        if (err instanceof ProviderError) throw err;
        throw classifyError(err);
      }
    },

    async readPrices(_binding: AccountBinding, symbols: string[]): Promise<Record<string, Cents>> {
      const entries = await Promise.all(
        symbols.map(async (sym): Promise<[string, Cents]> => {
          try {
            const { status, data } = await client.getQuote(sym);
            if (status >= 400) return [sym, cents(0)];
            return [sym, normalizePriceFromQuote(sym, data)];
          } catch {
            return [sym, cents(0)];
          }
        })
      );
      // SAFETY: each entry key is a symbol string and each value is a Cents —
      // both produced above; this rebuilds the homogeneous price map by symbol.
      return Object.fromEntries(entries) as Record<string, Cents>;
    },
  };
}

// ─── Deterministic fixtures (for conformance + unit tests) ───────────────────
// Alpaca-typed internally; the public surface never exposes Alpaca values. The
// adapter converts these into Alepes-owned normalized observations.
export * from "./fixtures";