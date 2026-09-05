// PostgreSQL adapter for the provider-sync ports. This is the ONLY module that
// knows the SQL for financial-data synchronization state.

import { Pool } from "pg";
import type { ExternalObservationRef, FinancialObservationId } from "@alepes/domain";
import { ulid } from "./identity";
import {
  type AccountBindingId,
  type PersistedAccountBinding,
  type PersistedObservation,
  type PersistedSyncCheckpoint,
  type ProviderSyncStore,
  type ReconcileSyncCycleInput,
  type ReconcileSyncCycleResult,
  type SyncCycleId,
} from "./sync-ports";

const T_BINDINGS = "account_bindings";
const T_CHECKPOINTS = "sync_checkpoints";
const T_OBSERVATIONS = "financial_observations";
const T_REFS = "observation_external_refs";
const T_EVENTS = "observation_events";

export interface SyncPostgresConfig {
  connectionString: string;
}

function newObservationId(): FinancialObservationId {
  return `obs_${ulid()}` as FinancialObservationId;
}

export function createSyncPostgresStore(cfg: SyncPostgresConfig): ProviderSyncStore & { close(): Promise<void> } {
  const pool = new Pool({ connectionString: cfg.connectionString });

  async function bindAccount(input: {
    providerId: string;
    providerAccountRef: ExternalObservationRef;
    credentialRef: string;
    metadata: Record<string, string>;
  }): Promise<PersistedAccountBinding> {
    const id = ulid() as AccountBindingId;
    const res = await pool.query(
      `INSERT INTO ${T_BINDINGS} (id, provider_id, provider_account_ref, credential_ref, metadata)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (provider_id, provider_account_ref) DO UPDATE SET updated_at = now()
       RETURNING id, provider_id, provider_account_ref, credential_ref, metadata, active, created_at, updated_at`,
      [id, input.providerId, input.providerAccountRef, input.credentialRef, JSON.stringify(input.metadata)]
    );
    const row = res.rows[0];
    return {
      id: row.id as AccountBindingId,
      providerId: row.provider_id,
      providerAccountRef: row.provider_account_ref as ExternalObservationRef,
      credentialRef: row.credential_ref,
      active: row.active,
      metadata: (row.metadata ?? {}) as Record<string, string>,
    };
  }

  async function loadBinding(id: AccountBindingId): Promise<PersistedAccountBinding | null> {
    const res = await pool.query(
      `SELECT id, provider_id, provider_account_ref, credential_ref, metadata, active FROM ${T_BINDINGS} WHERE id = $1`,
      [id]
    );
    if (res.rows.length === 0) return null;
    const row = res.rows[0];
    return {
      id: row.id as AccountBindingId,
      providerId: row.provider_id,
      providerAccountRef: row.provider_account_ref as ExternalObservationRef,
      credentialRef: row.credential_ref,
      active: row.active,
      metadata: (row.metadata ?? {}) as Record<string, string>,
    };
  }

  async function loadCheckpoint(accountBindingId: AccountBindingId): Promise<PersistedSyncCheckpoint | null> {
    const res = await pool.query(
      `SELECT account_binding_id, cursor, status, last_success_at FROM ${T_CHECKPOINTS} WHERE account_binding_id = $1`,
      [accountBindingId]
    );
    if (res.rows.length === 0) return null;
    const row = res.rows[0];
    return {
      accountBindingId: row.account_binding_id as AccountBindingId,
      cursor: row.cursor ?? "",
      status: row.status,
      lastSuccessAt: row.last_success_at ? new Date(row.last_success_at).toISOString() : null,
      inProgressCycleId: null,
    };
  }

  async function reconcileSyncCycle(input: ReconcileSyncCycleInput): Promise<ReconcileSyncCycleResult> {
    const client = await pool.connect();
    const added: FinancialObservationId[] = [];
    const modified: FinancialObservationId[] = [];
    const removed: FinancialObservationId[] = [];
    try {
      await client.query("BEGIN");

      // Resolve predecessor linkage: pending → posted via provider predecessor ref.
      const predecessorIdByRef = new Map<string, string>();
      for (const obs of input.delta.added.concat(input.delta.modified)) {
        if (obs.predecessorRef) {
          const prev = await client.query(
            `SELECT financial_observation_id FROM ${T_REFS} WHERE account_binding_id = $1 AND external_ref = $2`,
            [input.accountBindingId, obs.predecessorRef]
          );
          if (prev.rows.length > 0) predecessorIdByRef.set(obs.externalRef as string, prev.rows[0].financial_observation_id);
        }
      }

      // ADDED
      for (const obs of input.delta.added) {
        const existing = await client.query(
          `SELECT financial_observation_id FROM ${T_REFS} WHERE account_binding_id = $1 AND external_ref = $2`,
          [input.accountBindingId, obs.externalRef]
        );
        if (existing.rows.length > 0) {
          // Idempotent: already present, reconcile rather than create a new identity.
          const oid = existing.rows[0].financial_observation_id as FinancialObservationId;
          await client.query(
            `UPDATE ${T_OBSERVATIONS} SET amount_cents=$2, direction=$3, status=$4, posted_at=$5, description=$6, normalization_version=$7, balance_after_cents=$8, updated_at=now() WHERE id=$1`,
            [oid, obs.amountCents, obs.direction, obs.status, obs.postedAt ?? null, obs.description, obs.normalizationVersion, obs.balanceAfterCents ?? null]
          );
          modified.push(oid);
        } else {
          const oid = newObservationId();
          const predId = obs.predecessorRef ? (predecessorIdByRef.get(obs.externalRef as string) ?? null) : null;
          await client.query(
            `INSERT INTO ${T_OBSERVATIONS} (id, account_binding_id, amount_cents, direction, status, first_observed_at, posted_at, description, normalization_version, state, predecessor_observation_id, balance_after_cents)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'active',$10,$11)`,
            [oid, input.accountBindingId, obs.amountCents, obs.direction, obs.status, obs.firstObservedAt, obs.postedAt ?? null, obs.description, obs.normalizationVersion, predId, obs.balanceAfterCents ?? null]
          );
          await client.query(
            `INSERT INTO ${T_REFS} (account_binding_id, external_ref, financial_observation_id) VALUES ($1,$2,$3)`,
            [input.accountBindingId, obs.externalRef, oid]
          );
          await appendEvent(client, oid, input.cycleId, "added", null, obs, input.normalizationVersion);
          added.push(oid);
        }
      }

      // MODIFIED
      for (const obs of input.delta.modified) {
        const existing = await client.query(
          `SELECT financial_observation_id FROM ${T_REFS} WHERE account_binding_id = $1 AND external_ref = $2`,
          [input.accountBindingId, obs.externalRef]
        );
        if (existing.rows.length === 0) {
          // Explicit, deterministic handling: record without inventing history.
          const oid = newObservationId();
          await client.query(
            `INSERT INTO ${T_OBSERVATIONS} (id, account_binding_id, amount_cents, direction, status, first_observed_at, posted_at, description, normalization_version, state, balance_after_cents)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'active',$10)`,
            [oid, input.accountBindingId, obs.amountCents, obs.direction, obs.status, obs.firstObservedAt, obs.postedAt ?? null, obs.description, obs.normalizationVersion, obs.balanceAfterCents ?? null]
          );
          await client.query(
            `INSERT INTO ${T_REFS} (account_binding_id, external_ref, financial_observation_id) VALUES ($1,$2,$3)`,
            [input.accountBindingId, obs.externalRef, oid]
          );
          await appendEvent(client, oid, input.cycleId, "modified", null, obs, input.normalizationVersion);
          modified.push(oid);
        } else {
          const oid = existing.rows[0].financial_observation_id as FinancialObservationId;
          const prevRow = await client.query(
            `SELECT amount_cents, direction, status FROM ${T_OBSERVATIONS} WHERE id=$1`,
            [oid]
          );
          await client.query(
            `UPDATE ${T_OBSERVATIONS} SET amount_cents=$2, direction=$3, status=$4, posted_at=$5, description=$6, normalization_version=$7, balance_after_cents=$8, updated_at=now() WHERE id=$1`,
            [oid, obs.amountCents, obs.direction, obs.status, obs.postedAt ?? null, obs.description, obs.normalizationVersion, obs.balanceAfterCents ?? null]
          );
          await appendEvent(client, oid, input.cycleId, "modified", prevRow.rows[0] ?? null, obs, input.normalizationVersion);
          modified.push(oid);
        }
      }

      // REMOVED
      for (const ref of input.delta.removed) {
        const existing = await client.query(
          `SELECT financial_observation_id FROM ${T_REFS} WHERE account_binding_id = $1 AND external_ref = $2`,
          [input.accountBindingId, ref]
        );
        if (existing.rows.length > 0) {
          const oid = existing.rows[0].financial_observation_id as FinancialObservationId;
          await client.query(
            `UPDATE ${T_OBSERVATIONS} SET state='removed', updated_at=now() WHERE id=$1`,
            [oid]
          );
          await appendEvent(client, oid, input.cycleId, "removed", null, null, input.normalizationVersion);
          removed.push(oid);
        }
      }

      // Advance the cursor only after full reconciliation.
      await client.query(
        `INSERT INTO ${T_CHECKPOINTS} (account_binding_id, cursor, status, last_success_at, updated_at)
         VALUES ($1, $2, 'reconciled', now(), now())
         ON CONFLICT (account_binding_id) DO UPDATE SET cursor=$2, status='reconciled', last_success_at=now(), updated_at=now()`,
        [input.accountBindingId, input.nextCursor]
      );

      await client.query("COMMIT");
      return { added, modified, removed };
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }
  }

  async function appendEvent(
    client: import("pg").PoolClient,
    observationId: FinancialObservationId,
    cycleId: SyncCycleId,
    change: "added" | "modified" | "removed",
    prevState: unknown,
    newState: unknown,
    normalizationVersion: string
  ): Promise<void> {
    await client.query(
      `INSERT INTO ${T_EVENTS} (id, financial_observation_id, sync_cycle_id, change, prev_state, new_state, normalization_version)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [
        ulid(),
        observationId,
        cycleId,
        change,
        prevState ? JSON.stringify(prevState) : null,
        newState ? JSON.stringify(newState) : null,
        normalizationVersion,
      ]
    );
  }

  async function resolveObservationId(
    accountBindingId: AccountBindingId,
    externalRef: ExternalObservationRef
  ): Promise<FinancialObservationId | null> {
    const res = await pool.query(
      `SELECT financial_observation_id FROM ${T_REFS} WHERE account_binding_id = $1 AND external_ref = $2`,
      [accountBindingId, externalRef]
    );
    return res.rows.length > 0 ? (res.rows[0].financial_observation_id as FinancialObservationId) : null;
  }

  async function listActiveObservations(accountBindingId: AccountBindingId): Promise<PersistedObservation[]> {
    const res = await pool.query(
      `SELECT id, account_binding_id, amount_cents, direction, status, balance_after_cents, first_observed_at, posted_at, description, normalization_version, state, predecessor_observation_id, created_at, updated_at
         FROM ${T_OBSERVATIONS} WHERE account_binding_id = $1 AND state = 'active' ORDER BY created_at`,
      [accountBindingId]
    );
    return res.rows.map((row) => ({
      id: row.id as FinancialObservationId,
      accountBindingId: row.account_binding_id as AccountBindingId,
      amountCents: Number(row.amount_cents),
      direction: row.direction,
      status: row.status,
      balanceAfterCents: row.balance_after_cents === null ? null : Number(row.balance_after_cents),
      firstObservedAt: new Date(row.first_observed_at).toISOString(),
      postedAt: row.posted_at ? new Date(row.posted_at).toISOString() : null,
      description: row.description,
      normalizationVersion: row.normalization_version,
      state: row.state,
      predecessorObservationId: row.predecessor_observation_id as FinancialObservationId | null,
      createdAt: new Date(row.created_at).toISOString(),
      updatedAt: new Date(row.updated_at).toISOString(),
    }));
  }

  return {
    bindAccount,
    loadBinding,
    loadCheckpoint,
    reconcileSyncCycle,
    resolveObservationId,
    listActiveObservations,
    close: async () => pool.end(),
  };
}