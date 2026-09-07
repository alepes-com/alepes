// Integration runtime — the Opnory-style capability/plugin architecture.
//
// The financial domain owns ALL policy and decision-making. Integrations only
// expose *capabilities*: reading balances, listing deposits, fetching prices,
// submitting orders. A plugin declares which capabilities it provides; the
// registry wires plugins to the engine. Nothing here couples to a specific
// bank or brokerage SDK.

import type {
  AuditRecord,
  BrokerageAccountState,
  BrokeragePosition,
  CashEvent,
  ExecutionOrder,
  ExternalObservationRef,
  FinancialObservation,
  ObservationSyncDelta,
  PortfolioState,
} from "@alepes/domain";
import type { Cents, NonNegativeCents } from "@alepes/money";

/**
 * A named capability — a *marker* interface. Concrete capability types extend it
 * with a precise `invoke` signature. The plugin map stores this marker type, so
 * heterogeneous capabilities coexist without contravariance fights.
 */
export interface Capability {
  readonly id: string;
  readonly name: string;
  readonly version: string;
  readonly description: string;
}

// ---- Concrete capability contracts (the evolution of Bank/BrokerageProvider) ----

export type ReadCheckingBalance = Capability & {
  invoke: () => Promise<NonNegativeCents>;
};
export type ListDeposits = Capability & {
  invoke: (limit?: number) => Promise<CashEvent[]>;
};
export type ReadPortfolio = Capability & {
  invoke: () => Promise<PortfolioState>;
};
export type ReadPrices = Capability & {
  invoke: (symbols: string[]) => Promise<Record<string, Cents>>;
};
export type SubmitOrders = Capability & {
  invoke: (orders: ExecutionOrder[]) => Promise<AuditRecord[]>;
};

//
// ─── Financial-data-provider capability (read-only) ─────────────────────────
//
// This is the Alepes-owned contract external financial-data sources must adapt
// to. It is deliberately provider-neutral: no Plaid (or any other vendor)
// response type, terminology, webhook shape, or SDK abstraction appears here.
// It exposes *observations*, never qualified `CashEvent`s — financial policy and
// CashEvent qualification live downstream in Alepes, never in a provider.
//
// READ-ONLY: there is deliberately no ACH, transfer, or money-movement method.
//

/** A durable Alepes account binding to a single external provider account. */
export interface AccountBinding {
  /** Alepes-owned binding id (durable, minted at binding time). */
  id: string;
  /** Opaque provider-issued account reference. Only the adapter interprets it. */
  providerAccountRef: ExternalObservationRef;
  /**
   * Opaque credential reference for the connection this binding belongs to.
   * The adapter resolves access/material via this reference — never a
   * hardcoded value and never raw credential material. Two bindings from
   * different connections carry different references and must never cross-resolve.
   */
  credentialRef: string;
  /** Human-readable account name for display (provider-derived, optional). */
  name?: string;
  /** Account metadata needed for ingestion (e.g. subtype), provider-neutral. */
  metadata: Record<string, string>;
}

/** Provider capability + version metadata surfaced without any SDK coupling. */
export interface ProviderInfo {
  id: string;
  version: string;
}

/**
 * Explicit, provider-neutral error classification for synchronization. The
 * adapter maps provider failures into these kinds so callers can make
 * deterministic retry/stop decisions without knowing the vendor.
 */
export type ProviderErrorKind =
  | "auth"
  | "transient"
  | "rate_limited"
  | "not_found"
  | "invalid_request"
  | "provider_unavailable"
  /**
   * The provider reported that transaction data mutated during pagination, so the
   * entire sync cycle must be restarted from the ORIGINAL cursor. Provider-neutral;
   * a Plaid adapter maps its own mutation signal onto this (never names Plaid here).
   */
  | "restart_sync"
  | "unknown";

export class ProviderError extends Error {
  readonly kind: ProviderErrorKind;
  constructor(kind: ProviderErrorKind, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "ProviderError";
    this.kind = kind;
  }
}

/**
 * The read-only financial-data-provider capability. Implementations adapt a
 * specific provider to this contract; they must NOT expose credentials, provider
 * types, or financial-policy decisions.
 */
export interface FinancialDataProvider {
  readonly info: ProviderInfo;

  /** Discover the external accounts available under a credential reference. */
  discoverAccounts(credentialRef: string): Promise<AccountBinding[]>;

  /** Bind (or return the existing binding for) one external account. */
  bindAccount(credentialRef: string, providerAccountRef: ExternalObservationRef): Promise<AccountBinding>;

  /**
   * Synchronize one logical cycle for a bound account, returning an explicit
   * delta of added / modified / removed observations plus the cursor to resume
   * from next cycle.
   *
   * Cursor transaction semantics (provider-neutral invariant the orchestrator
   * relies on): the caller retains the STARTING cursor for the whole cycle, and
   * only advances to `nextCursor` once `hasMore === false`. If data mutates
   * mid-pagination the provider raises `ProviderError("restart_sync")` and the
   * orchestrator restarts from the original cursor. Replaying a completed cycle
   * is idempotent (delta is stable for the same [cursor, nextCursor] range).
   */
  syncObservations(binding: AccountBinding, cursor: string): Promise<ObservationSyncDelta>;

  /**
   * Signal that external changes are available so the orchestrator should run a
   * sync. This is a TRIGGER ONLY — webhooks never become observations. Duplicate
   * triggers are harmless because the authoritative changes always come from
   * syncObservations against the saved cursor.
   */
  readonly onChange?: () => void;
}

/** The canonical capability id for the read-only financial-data provider. */
export type FinancialDataProviderCapability = Capability & FinancialDataProvider;

// ─── Brokerage-data-provider (brokerage read-only) ───────────────────────────
//
// The read-only brokerage observation contract. Unlike the thin `ReadPortfolio`
// / `ReadPrices` capabilities (which the mock/legacy path uses), this exposes
// ACCOUNT-LEVEL facts — cash, buying power, status — plus positions and prices,
// so Shadow Mode can operate against real account structure without submitting
// trades. It is provider-neutral: no Alpaca (or any vendor) terminology, field,
// endpoint, or SDK abstraction appears here.
//
// READ-ONLY: there is deliberately NO order, transfer, or mutation method, and
// the runtime's `capability:brokerage:submit-orders` is NOT part of this surface.
//

/** A read-only provider-neutral brokerage position list + account state. */
export interface BrokerageSnapshot {
  account: BrokerageAccountState;
  positions: BrokeragePosition[];
}

/**
 * The read-only brokerage-data-provider capability. Implementations adapt a
 * specific brokerage (e.g. Alpaca paper) to this contract; they must NOT expose
 * credentials, provider types, or financial-policy decisions, and must NOT
 * provide any order-submission surface.
 */
export interface BrokerageDataProvider {
  readonly info: ProviderInfo;

  /**
   * Discover the brokerage accounts available under a credential reference.
   * Returns zero or more opaque account bindings — never raw credential material.
   */
  discoverAccounts(credentialRef: string): Promise<AccountBinding[]>;

  /**
   * Read the account-level facts (cash, buying power, status, market value) for
   * a bound account. Facts only; no policy.
   */
  readAccount(binding: AccountBinding): Promise<BrokerageAccountState>;

  /**
   * Read the current positions for a bound account. Quantities and monetary
   * values are normalized to exact decimal strings / integer cents — never
   * JS-float authoritative money.
   */
  readPositions(binding: AccountBinding): Promise<BrokeragePosition[]>;

  /** Read the current price per share (in cents) for the requested symbols. */
  readPrices(binding: AccountBinding, symbols: string[]): Promise<Record<string, Cents>>;
}

/** The canonical capability id for the read-only brokerage-data provider. */
export type BrokerageDataProviderCapability = Capability & BrokerageDataProvider;

/** The canonical capability ids. */
export const CAPABILITIES = {
  readCheckingBalance: "capability:bank:read-checking-balance",
  listDeposits: "capability:bank:list-deposits",
  readPortfolio: "capability:brokerage:read-portfolio",
  readPrices: "capability:brokerage:read-prices",
  submitOrders: "capability:brokerage:submit-orders",
  financialDataProvider: "capability:provider:financial-data",
  brokerageDataProvider: "capability:provider:brokerage-data",
} as const;

/**
 * A plugin: one integration bundle declaring a set of capabilities plus a
 * lifecycle. Plugins are the unit of install/upgrade/disable.
 */
export interface Plugin {
  readonly id: string;
  readonly name: string;
  readonly version: string;
  readonly capabilities: ReadonlyMap<string, Capability>;
  readonly lifecycle: PluginLifecycle;
}

export interface PluginLifecycle {
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  /** Human-readable health summary; null = healthy. */
  health(): Promise<string | null>;
}

/**
 * Credential provider: supplies secrets to plugins WITHOUT the domain ever
 * seeing or holding them. The runtime stores only a reference (e.g. an external
 * vault id), never raw credentials.
 */
export interface CredentialProvider {
  resolve(ref: string): Promise<string>;
}

/**
 * The registry maps capability ids to the plugin that provides them. The engine
 * looks capabilities up by id and is therefore decoupled from any plugin impl.
 */
export class Registry {
  private plugins = new Map<string, Plugin>();
  private byCapability = new Map<string, Plugin>();

  install(plugin: Plugin): void {
    if (this.plugins.has(plugin.id)) {
      throw new Error(`plugin already installed: ${plugin.id}`);
    }
    this.plugins.set(plugin.id, plugin);
    for (const capId of plugin.capabilities.keys()) {
      if (this.byCapability.has(capId)) {
        throw new Error(`capability already provided: ${capId}`);
      }
      this.byCapability.set(capId, plugin);
    }
  }

  remove(pluginId: string): void {
    const plugin = this.plugins.get(pluginId);
    if (!plugin) return;
    for (const capId of plugin.capabilities.keys()) {
      if (this.byCapability.get(capId) === plugin) this.byCapability.delete(capId);
    }
    this.plugins.delete(pluginId);
  }

  /** Resolve a capability by id, re-typed to the precise concrete type. */
  get<C extends Capability>(capabilityId: string): C | null {
    const plugin = this.byCapability.get(capabilityId);
    if (!plugin) return null;
    return (plugin.capabilities.get(capabilityId) as C) ?? null;
  }

  has(capabilityId: string): boolean {
    return this.byCapability.has(capabilityId);
  }

  list(): Plugin[] {
    return [...this.plugins.values()];
  }
}