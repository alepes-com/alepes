// Provider-neutral synchronization orchestrator.
//
// The `FinancialDataProvider` emits one *page* at a time via `syncObservations`
// (explicit add/modify/remove deltas split by the adapter). This orchestrator is
// the single boundary that decides WHEN a cursor becomes authoritative:
//
//   - It accumulates every page's delta in memory and does NOT touch the store
//     until the provider reports `hasMore === false` (the full cycle is complete).
//   - The persisted checkpoint advances to a page's `nextCursor` ONLY at the end
//     of a fully-completed cycle, atomically with that cycle's reconciliation.
//   - Therefore an intermediate page cursor (C1, C2, …) can NEVER become
//     authoritative — there is no code path that persists a page's cursor early.
//   - If the provider raises `ProviderError("restart_sync")` (data mutated during
//     pagination), the orchestrator restarts the whole cycle from the STARTING
//     cursor, discarding everything accumulated so far (bounded to a small number
//     of attempts to avoid a livelock on a persistently-mutating provider).
//
// This module is pure orchestration: it imports no SQL and no provider SDK. It
// runs against the `ProviderSyncStore` port and the `FinancialDataProvider`
// capability, so it is testable against mocks and the real PostgreSQL adapter
// alike.
//
// SECURITY: no credentials are read, returned, or stored here. The provider's
// `credentialRef` is opaque and only ever forwarded from a binding.

import type { ObservationSyncDelta } from "@alepes/domain";
import type { AccountBinding, FinancialDataProvider } from "@alepes/integration-runtime";
import type { AccountBindingId, ProviderSyncStore, SyncCycleId } from "@alepes/persistence";

export interface SyncRun {
  /** The reconciled full-cycle delta persisted (all pages merged). */
  delta: ObservationSyncDelta;
  /** The final authoritative cursor committed with the cycle. */
  finalCursor: string;
  /** Number of provider pages fetched to complete the cycle. */
  pages: number;
}

export interface SyncOrchestratorOptions {
  /** Mint a fresh, durable cycle identity per full sync attempt. */
  newCycleId: () => SyncCycleId;
  /** Normalization version attached to every reconciled cycle. */
  normalizationVersion: string;
  /** Maximum `restart_sync` restarts before giving up (livelock guard). */
  maxRestarts?: number;
}

/** Merge a page's delta into the running full-cycle accumulator. */
function mergeDelta(acc: ObservationSyncDelta, page: ObservationSyncDelta): ObservationSyncDelta {
  return {
    added: [...acc.added, ...page.added],
    modified: [...acc.modified, ...page.modified],
    removed: [...acc.removed, ...page.removed],
    nextCursor: page.nextCursor, // the FINAL page's cursor wins; intermediate ones are discarded
    hasMore: page.hasMore,
  };
}

/**
 * Synchronize one bound account to completion.
 *
 * `providerBinding` is the account binding the adapter expects (provider `id`),
 * while `persistedBindingId` is the durable Alepes `AccountBindingId` minted by
 * `store.bindAccount` — the identity the store keys checkpoints and observations
 * on. These are distinct and must never be conflated.
 *
 * Reads the persisted starting cursor, pages the provider until `hasMore === false`
 * (or a `restart_sync` forces a full restart from the original cursor), then
 * reconciles exactly ONE merged cycle — atomically advancing the cursor to the
 * final page's `nextCursor`. If the provider fails before the final page (throw
 * or `restart_sync` without completing), nothing is persisted.
 */
export async function syncAccount(
  provider: FinancialDataProvider,
  store: ProviderSyncStore,
  providerBinding: AccountBinding,
  persistedBindingId: AccountBindingId,
  opts: SyncOrchestratorOptions
): Promise<SyncRun> {
  const checkpoint = await store.loadCheckpoint(persistedBindingId);
  const startingCursor = checkpoint?.cursor ?? "";

  const maxRestarts = opts.maxRestarts ?? 5;
  let restarts = 0;
  let cycleId = opts.newCycleId();

  let acc: ObservationSyncDelta = {
    added: [],
    modified: [],
    removed: [],
    nextCursor: startingCursor,
    hasMore: true,
  };
  let pages = 0;
  let cursor = startingCursor;

  for (;;) {
    let page: ObservationSyncDelta;
    try {
      page = await provider.syncObservations(providerBinding, cursor);
    } catch (err) {
      if (err instanceof Error && isRestartSync(err) && restarts < maxRestarts) {
        // Provider reported mid-pagination mutation: restart the WHOLE cycle from
        // the starting cursor. Nothing accumulated so far is authoritative.
        restarts += 1;
        acc = { added: [], modified: [], removed: [], nextCursor: startingCursor, hasMore: true };
        cursor = startingCursor;
        pages = 0;
        cycleId = opts.newCycleId();
        continue;
      }
      // Any other failure (transient, auth, …) or an exhausted restart budget
      // leaves the checkpoint untouched; the caller retries from the same
      // starting cursor next time.
      throw err;
    }

    acc = mergeDelta(acc, page);
    cursor = page.nextCursor;
    pages += 1;

    if (!page.hasMore) break;
  }

  // Full cycle complete: atomically reconcile the merged delta AND advance the
  // cursor to the final page's cursor. Only now is anything persisted.
  await store.reconcileSyncCycle({
    accountBindingId: persistedBindingId,
    delta: {
      added: acc.added,
      modified: acc.modified,
      removed: acc.removed,
      nextCursor: acc.nextCursor,
      hasMore: false,
    },
    nextCursor: acc.nextCursor,
    cycleId,
    normalizationVersion: opts.normalizationVersion,
  });

  return { delta: acc, finalCursor: acc.nextCursor, pages };
}

function isRestartSync(err: Error): boolean {
  return err.name === "ProviderError" && (err as { kind?: string }).kind === "restart_sync";
}