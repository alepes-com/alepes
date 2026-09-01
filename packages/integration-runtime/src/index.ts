// Integration runtime — the Opnory-style capability/plugin architecture.
//
// The financial domain owns ALL policy and decision-making. Integrations only
// expose *capabilities*: reading balances, listing deposits, fetching prices,
// submitting orders. A plugin declares which capabilities it provides; the
// registry wires plugins to the engine. Nothing here couples to a specific
// bank or brokerage SDK.

import type {
  AuditRecord,
  CashEvent,
  ExecutionOrder,
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

/** The canonical capability ids. */
export const CAPABILITIES = {
  readCheckingBalance: "capability:bank:read-checking-balance",
  listDeposits: "capability:bank:list-deposits",
  readPortfolio: "capability:brokerage:read-portfolio",
  readPrices: "capability:brokerage:read-prices",
  submitOrders: "capability:brokerage:submit-orders",
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