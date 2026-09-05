// Proof #9 — intermediate pagination cursors are never authoritative.
// Exercises the sync orchestrator (the smallest provider-neutral synchronization
// boundary above ProviderSyncStore), NOT merely the DB port's lack of a
// partial-cursor setter. Uses an in-memory ProviderSyncStore fake so the test is
// deterministic and needs no database; the store's own atomic commit behavior is
// separately proven against real PostgreSQL in packages/persistence/src/sync.test.ts.

import { describe, it, expect } from "vitest";
import type {
  AccountBindingId,
  ProviderSyncStore,
  SyncCycleId,
  ReconcileSyncCycleInput,
  ReconcileSyncCycleResult,
} from "@alepes/persistence";
import { StaleSyncCycleError } from "@alepes/persistence";
import type {
  ExternalObservationRef,
  FinancialObservation,
  FinancialObservationId,
  ObservationSyncDelta,
} from "@alepes/domain";
import type { AccountBinding, FinancialDataProvider } from "@alepes/integration-runtime";
import { ProviderError } from "@alepes/integration-runtime";
import { syncAccount } from "./sync-orchestrator";

// ---- In-memory ProviderSyncStore fake ---------------------------------------
// Records the EXACT moments reconcileSyncCycle / loadCheckpoint are called, so the
// test can assert no partial cursor was ever persisted mid-cycle.
class FakeStore implements ProviderSyncStore {
  checkpoint: { cursor: string } | null = null;
  reconcileCalls: ReconcileSyncCycleInput[] = [];

  async bindAccount(input: { providerId: string; providerAccountRef: ExternalObservationRef; credentialRef: string; metadata: Record<string, string> }) {
    return { id: ("binding-" + input.providerAccountRef) as AccountBindingId, providerId: input.providerId, providerAccountRef: input.providerAccountRef, credentialRef: input.credentialRef, active: true, metadata: input.metadata };
  }
  async loadBinding() { return null; }
  async loadCheckpoint(bindingId: AccountBindingId) {
    // For this test we key the checkpoint by the single fake binding; the
    // orchestrator passes the persisted binding id through.
    void bindingId;
    return this.checkpoint ? { accountBindingId: "b" as AccountBindingId, cursor: this.checkpoint.cursor, status: "reconciled" as const, lastSuccessAt: null, inProgressCycleId: null } : null;
  }
  async reconcileSyncCycle(input: ReconcileSyncCycleInput): Promise<ReconcileSyncCycleResult> {
    // Mirror the real store's stale-guard: reject if the current authoritative
    // cursor does not match the cycle's starting cursor.
    const current = this.checkpoint?.cursor ?? "";
    if (current !== input.startingCursor) {
      throw new StaleSyncCycleError(input.accountBindingId, input.startingCursor, current);
    }
    this.reconcileCalls.push(input);
    this.checkpoint = { cursor: input.nextCursor }; // atomically advance the cursor
    return { added: input.delta.added.map((o) => o.id), modified: input.delta.modified.map((o) => o.id), removed: [] };
  }
  async resolveObservationId() { return null; }
  async listActiveObservations() { return []; }
}

// ---- Scripted multi-page provider -------------------------------------------
function scriptedProvider(pages: ObservationSyncDelta[]): FinancialDataProvider {
  let fetchCount = 0;
  return {
    info: { id: "scripted", version: "1.0.0" },
    async discoverAccounts() { return []; },
    async bindAccount() { return {} as AccountBinding; },
    async syncObservations(_binding, _cursor) {
      if (fetchCount < pages.length) return pages[fetchCount++];
      throw new Error("scripted provider exhausted");
    },
  };
}

function page(nextCursor: string, hasMore: boolean, addedRefs: string[] = []): ObservationSyncDelta {
  return {
    added: addedRefs.map((ref) => obs(ref)),
    modified: [],
    removed: [],
    nextCursor,
    hasMore,
  };
}

function obs(ref: string): FinancialObservation {
  return {
    id: ("obs-" + ref) as FinancialObservationId,
    externalRef: ref as ExternalObservationRef,
    accountBindingId: "placeholder",
    amountCents: 100_00 as FinancialObservation["amountCents"],
    direction: "credit",
    status: "posted",
    firstObservedAt: "2026-09-01T00:00:00Z",
    postedAt: "2026-09-01T00:00:00Z",
    description: "deposit",
    normalizationVersion: "norm@1",
  };
}

const binding: AccountBinding = { id: "provider-binding", providerAccountRef: "acct" as ExternalObservationRef, credentialRef: "cred:test", metadata: {} };
const persistedBindingId = "binding-acct" as AccountBindingId;
let seq = 0;
const newCycleId = (): SyncCycleId => ("cycle-" + ++seq) as SyncCycleId;

describe("sync orchestrator — intermediate pagination cursors never authoritative (proof #9)", () => {
  it("persists only the final cursor; C1/C2 never become authoritative", async () => {
    const store = new FakeStore();
    store.checkpoint = { cursor: "C0" };

    const provider = scriptedProvider([
      page("C1", true, ["t1", "t2"]),   // page 1 → nextCursor C1, hasMore true
      page("C2", true, ["t3", "t4"]),   // page 2 → nextCursor C2, hasMore true
      page("C3", false, ["t5"]),        // final page → hasMore false
    ]);

    const run = await syncAccount(provider, store, binding, persistedBindingId, {
      newCycleId,
      normalizationVersion: "norm@1",
    });

    // Exactly ONE reconcile call, with only the FINAL cursor.
    expect(store.reconcileCalls).toHaveLength(1);
    expect(store.reconcileCalls[0].nextCursor).toBe("C3");
    // All three pages merged into the single cycle.
    expect(store.reconcileCalls[0].delta.added).toHaveLength(5);
    // Persisted cursor is the final one.
    expect(store.checkpoint?.cursor).toBe("C3");
    expect(run.finalCursor).toBe("C3");
    expect(run.pages).toBe(3);
  });

  it("failure before the final page leaves the persisted cursor at C0 (nothing partial)", async () => {
    const store = new FakeStore();
    store.checkpoint = { cursor: "C0" };

    // First two pages succeed, then the provider throws before the final page.
    let calls = 0;
    const provider: FinancialDataProvider = {
      info: { id: "scripted", version: "1.0.0" },
      async discoverAccounts() { return []; },
      async bindAccount() { return {} as AccountBinding; },
      async syncObservations() {
        calls += 1;
        if (calls === 1) return page("C1", true, ["t1"]);
        if (calls === 2) return page("C2", true, ["t2"]);
        throw new ProviderError("transient", "interrupted before final page");
      },
    };

    await expect(
      syncAccount(provider, store, binding, persistedBindingId, { newCycleId, normalizationVersion: "norm@1" })
    ).rejects.toThrow();

    // No reconcile ever ran, so the cursor is untouched at C0.
    expect(store.reconcileCalls).toHaveLength(0);
    expect(store.checkpoint?.cursor).toBe("C0");
  });

  it("retry from the persisted C0 completes all pages and advances to Cfinal", async () => {
    const store = new FakeStore();
    store.checkpoint = { cursor: "C0" };

    // A provider whose behavior is driven by a mutable failNext flag: the first
    // syncAccount call is interrupted after page 1; the retry completes fully.
    let failNext = true;
    let pageNum = 0;
    const provider: FinancialDataProvider = {
      info: { id: "scripted", version: "1.0.0" },
      async discoverAccounts() { return []; },
      async bindAccount() { return {} as AccountBinding; },
      async syncObservations() {
        pageNum += 1;
        if (failNext && pageNum === 2) {
          throw new ProviderError("transient", "interrupted before final page");
        }
        const s = pageNum;
        if (s === 1) return page("C1", true, ["t1"]);
        if (s === 2) return page("C2", true, ["t2"]);
        return page("C3", false, ["t3"]);
      },
    };

    // First attempt fails; nothing persisted, cursor still C0.
    await expect(syncAccount(provider, store, binding, persistedBindingId, { newCycleId, normalizationVersion: "norm@1" })).rejects.toThrow();
    expect(store.checkpoint?.cursor).toBe("C0");
    expect(store.reconcileCalls).toHaveLength(0);

    // Retry from the persisted C0: full sequence completes, cursor → C3.
    failNext = false;
    pageNum = 0;
    const run = await syncAccount(provider, store, binding, persistedBindingId, { newCycleId, normalizationVersion: "norm@1" });
    expect(store.checkpoint?.cursor).toBe("C3");
    expect(run.finalCursor).toBe("C3");
    expect(store.reconcileCalls).toHaveLength(1);
    expect(store.reconcileCalls[0].nextCursor).toBe("C3");
  });

  it("restart_sync discards accumulated pages and restarts from the original cursor", async () => {
    const store = new FakeStore();
    store.checkpoint = { cursor: "C0" };

    // Page 1 served, then page 2 raises restart_sync, then a clean full sequence.
    const events: Array<ObservationSyncDelta | "restart"> = [
      page("C1", true, ["t1"]),
      "restart",
      page("C1", true, ["t1"]),
      page("C2", true, ["t2"]),
      page("C3", false, ["t3"]),
    ];
    let i = 0;
    const provider: FinancialDataProvider = {
      info: { id: "scripted", version: "1.0.0" },
      async discoverAccounts() { return []; },
      async bindAccount() { return {} as AccountBinding; },
      async syncObservations() {
        const e = events[i++];
        if (e === "restart") throw new ProviderError("restart_sync", "mutation detected");
        return e as ObservationSyncDelta;
      },
    };

    const run = await syncAccount(provider, store, binding, persistedBindingId, { newCycleId, normalizationVersion: "norm@1" });

    // After a restart, "t1" must not be duplicated (the whole cycle restarted).
    expect(store.reconcileCalls).toHaveLength(1);
    const addedRefs = store.reconcileCalls[0].delta.added.map((o) => o.externalRef);
    expect(addedRefs).toEqual(["t1" as ExternalObservationRef, "t2" as ExternalObservationRef, "t3" as ExternalObservationRef]);
    expect(store.checkpoint?.cursor).toBe("C3");
    expect(run.finalCursor).toBe("C3");
  });
});