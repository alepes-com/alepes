// Provider-sync persistence ports — read-only financial-data synchronization
// state, kept SEPARATE from financial decision/execution state.
//
// These interfaces are database-agnostic. The pure reconciliation logic in
// `reconcile.ts` operates against this port so it can be unit-tested without
// PostgreSQL; the Postgres adapter in `sync-postgres.ts` implements it.
//
// PostgreSQL is the authoritative store. DuckDB is NOT involved. No raw
// credentials are ever persisted, and provider external references are confined
// to this integration layer (never reaching financial policy).

import type {
  ExternalObservationRef,
  FinancialObservation,
  FinancialObservationId,
  ObservationSyncDelta,
} from "@alepes/domain";

/** A durable Alepes account binding. */
export type AccountBindingId = string & { readonly __bindingId: unique symbol };
/** A durable cycle identity for atomic recovery. */
export type SyncCycleId = string & { readonly __cycleId: unique symbol };

export interface PersistedAccountBinding {
  id: AccountBindingId;
  providerId: string;
  /** Opaque provider account reference. */
  providerAccountRef: ExternalObservationRef;
  /** Provider connection/credential reference identifier (never the secret). */
  credentialRef: string;
  active: boolean;
  metadata: Record<string, string>;
}

export type SyncStatus = "idle" | "syncing" | "reconciled" | "failed";

export interface PersistedSyncCheckpoint {
  accountBindingId: AccountBindingId;
  /** Opaque provider cursor. */
  cursor: string;
  status: SyncStatus;
  lastSuccessAt: string | null;
  /** In-progress cycle id, if a cycle is mid-flight. */
  inProgressCycleId: SyncCycleId | null;
}

/** The persisted, Alepes-owned observation state (facts + provenance). */
export type ObservationState = "active" | "removed";

export interface PersistedObservation {
  id: FinancialObservationId;
  accountBindingId: AccountBindingId;
  amountCents: number;
  direction: "credit" | "debit";
  status: "pending" | "posted";
  firstObservedAt: string;
  postedAt: string | null;
  description: string;
  normalizationVersion: string;
  state: ObservationState;
  /** Alepes-internal predecessor link (pending → posted), if provided. */
  predecessorObservationId: FinancialObservationId | null;
  createdAt: string;
  updatedAt: string;
}

export interface ReconcileAddedInput {
  observation: FinancialObservation;
}
export interface ReconcileModifiedInput {
  observation: FinancialObservation;
}
export interface ReconcileRemovedInput {
  externalRef: ExternalObservationRef;
}

/**
 * One transactionally-safe reconciliation operation over a completed sync cycle.
 * Either all of added/modified/removed + mappings + cursor advance commit, or
 * nothing does.
 */
export interface ReconcileSyncCycleInput {
  accountBindingId: AccountBindingId;
  delta: ObservationSyncDelta;
  /** The cursor to persist only after successful reconciliation. */
  nextCursor: string;
  cycleId: SyncCycleId;
  normalizationVersion: string;
}

/** Result of reconciling one cycle, listing which observation ids were touched. */
export interface ReconcileSyncCycleResult {
  added: FinancialObservationId[];
  modified: FinancialObservationId[];
  removed: FinancialObservationId[];
}

export interface ProviderSyncStore {
  /** Bind (or return existing binding for) a provider account. */
  bindAccount(input: {
    providerId: string;
    providerAccountRef: ExternalObservationRef;
    credentialRef: string;
    metadata: Record<string, string>;
  }): Promise<PersistedAccountBinding>;

  loadBinding(id: AccountBindingId): Promise<PersistedAccountBinding | null>;

  loadCheckpoint(accountBindingId: AccountBindingId): Promise<PersistedSyncCheckpoint | null>;

  /** Atomically reconcile a full cycle (add/modify/remove + mappings + cursor). */
  reconcileSyncCycle(input: ReconcileSyncCycleInput): Promise<ReconcileSyncCycleResult>;

  /** Resolve a binding + external ref to its Alepes observation id. */
  resolveObservationId(
    accountBindingId: AccountBindingId,
    externalRef: ExternalObservationRef
  ): Promise<FinancialObservationId | null>;

  listActiveObservations(accountBindingId: AccountBindingId): Promise<PersistedObservation[]>;
}

/** Aggregate port for provider-sync persistence. */
export interface SyncPorts {
  providerSync: ProviderSyncStore;
  close(): Promise<void>;
}