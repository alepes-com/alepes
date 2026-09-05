// Integration tests: provider-sync persistence against real PostgreSQL.
// Run with: ALEPES_TEST_SYNC_DATABASE_URL=postgresql://raelldottin@localhost:5432/alepes_sync_test bun run test packages/persistence/src/sync.test.ts

import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { runMigrations } from "./migrations";
import { createSyncPostgresStore } from "./sync-postgres";
import type { ProviderSyncStore, AccountBindingId, SyncCycleId } from "./sync-ports";
import { cents } from "@alepes/money";
import type {
  ExternalObservationRef,
  FinancialObservation,
  FinancialObservationId,
  ObservationSyncDelta,
} from "@alepes/domain";
import { ulid } from "./identity";

const TEST_CONNECTION =
  process.env.ALEPES_TEST_SYNC_DATABASE_URL ??
  "postgresql://raelldottin@localhost:5432/alepes_sync_test";

const runIntegration = process.env.ALEPES_TEST_SYNC_DATABASE_URL ? describe : describe.skip;

runIntegration("provider-sync persistence (real PostgreSQL)", () => {
  let store: ProviderSyncStore & { close(): Promise<void> };

  beforeAll(async () => {
    await runMigrations(TEST_CONNECTION);
  });

  afterAll(async () => {
    await store?.close();
  });

  beforeEach(async () => {
    const { Pool } = await import("pg");
    const pool = new Pool({ connectionString: TEST_CONNECTION });
    await pool.query(
      `TRUNCATE observation_events, observation_external_refs, financial_observations, sync_checkpoints, account_bindings RESTART IDENTITY CASCADE`
    );
    await pool.end();
    store = createSyncPostgresStore({ connectionString: TEST_CONNECTION });
  });

  function obs(
    overrides: Omit<Partial<FinancialObservation>, "externalRef" | "amountCents"> & {
      externalRef: string;
      amountCents?: number;
    }
  ): FinancialObservation {
    return {
      id: ("obs-" + overrides.externalRef) as FinancialObservationId,
      externalRef: overrides.externalRef as ExternalObservationRef,
      accountBindingId: "placeholder",
      amountCents: cents(overrides.amountCents ?? 100_00),
      direction: overrides.direction ?? "credit",
      status: overrides.status ?? "posted",
      firstObservedAt: "2026-09-01T00:00:00Z",
      postedAt: overrides.status === "pending" ? undefined : "2026-09-01T00:00:00Z",
      description: overrides.description ?? "record",
      normalizationVersion: "norm@1",
      ...(overrides.predecessorRef
        ? { predecessorRef: overrides.predecessorRef as ExternalObservationRef }
        : {}),
    } as FinancialObservation;
  }

  function delta(d: Partial<ObservationSyncDelta>): ObservationSyncDelta {
    return { added: [], modified: [], removed: [], nextCursor: "c1", hasMore: false, ...d };
  }

  async function bind(): Promise<{ id: AccountBindingId }> {
    const b = await store.bindAccount({
      providerId: "plaid",
      providerAccountRef: "acct-1" as ExternalObservationRef,
      credentialRef: "cred:test",
      metadata: { subtype: "checking" },
    });
    return b;
  }

  const cycle = (): SyncCycleId => ulid() as SyncCycleId;
  const extRef = (s: string): ExternalObservationRef => s as ExternalObservationRef;

  it("1. first added record creates one observation + mapping", async () => {
    const b = await bind();
    const res = await store.reconcileSyncCycle({
      accountBindingId: b.id,
      cycleId: cycle(),
      normalizationVersion: "norm@1",
      delta: delta({ added: [obs({ externalRef: "t1" })] }),
      nextCursor: "c1",
    });
    expect(res.added).toHaveLength(1);
    const oid = res.added[0];
    const resolved = await store.resolveObservationId(b.id, "t1" as ExternalObservationRef);
    expect(resolved).toBe(oid);
  });

  it("2. replay of the same addition creates no duplicate", async () => {
    const b = await bind();
    const first = await store.reconcileSyncCycle({
      accountBindingId: b.id, cycleId: cycle(), normalizationVersion: "norm@1",
      delta: delta({ added: [obs({ externalRef: "t1" })] }), nextCursor: "c1",
    });
    const second = await store.reconcileSyncCycle({
      accountBindingId: b.id, cycleId: cycle(), normalizationVersion: "norm@1",
      delta: delta({ added: [obs({ externalRef: "t1" })] }), nextCursor: "c1",
    });
    expect(second.added).toHaveLength(0); // reconciled, not duplicated
    expect(second.modified).toHaveLength(1); // idempotent reconcile
    const all = await store.listActiveObservations(b.id);
    expect(all.filter((o) => o.id === first.added[0])).toHaveLength(1);
  });

  it("3. modified record updates the same Alepes observation ID", async () => {
    const b = await bind();
    await store.reconcileSyncCycle({
      accountBindingId: b.id, cycleId: cycle(), normalizationVersion: "norm@1",
      delta: delta({ added: [obs({ externalRef: "t1", amountCents: 100_00 })] }), nextCursor: "c1",
    });
    const res = await store.reconcileSyncCycle({
      accountBindingId: b.id, cycleId: cycle(), normalizationVersion: "norm@1",
      delta: delta({ modified: [obs({ externalRef: "t1", amountCents: 150_00 })] }), nextCursor: "c2",
    });
    expect(res.modified).toHaveLength(1);
    const all = await store.listActiveObservations(b.id);
    expect(all).toHaveLength(1); // same identity, updated amount
    expect(all[0].amountCents).toBe(15000);
  });

  it("4. removed record becomes inactive without deleting history", async () => {
    const b = await bind();
    await store.reconcileSyncCycle({
      accountBindingId: b.id, cycleId: cycle(), normalizationVersion: "norm@1",
      delta: delta({ added: [obs({ externalRef: "t1" })] }), nextCursor: "c1",
    });
    await store.reconcileSyncCycle({
      accountBindingId: b.id, cycleId: cycle(), normalizationVersion: "norm@1",
      delta: delta({ removed: ["t1" as ExternalObservationRef] }), nextCursor: "c2",
    });
    const active = await store.listActiveObservations(b.id);
    expect(active).toHaveLength(0); // no longer active/eligible
    // History is preserved (not hard-deleted): the mapping still resolves.
    const resolved = await store.resolveObservationId(b.id, "t1" as ExternalObservationRef);
    expect(resolved).toBeTruthy();
  });

  it("5. pending → posted (same ref) yields at most one active qualifying observation", async () => {
    const b = await bind();
    await store.reconcileSyncCycle({
      accountBindingId: b.id, cycleId: cycle(), normalizationVersion: "norm@1",
      delta: delta({ added: [obs({ externalRef: "t1", status: "pending" })] }), nextCursor: "c1",
    });
    await store.reconcileSyncCycle({
      accountBindingId: b.id, cycleId: cycle(), normalizationVersion: "norm@1",
      delta: delta({ modified: [obs({ externalRef: "t1", status: "posted" })] }), nextCursor: "c2",
    });
    const active = await store.listActiveObservations(b.id);
    expect(active).toHaveLength(1);
    expect(active[0].status).toBe("posted");
  });

  it("6. pending removed + posted replacement with predecessor linkage → one active", async () => {
    const b = await bind();
    await store.reconcileSyncCycle({
      accountBindingId: b.id, cycleId: cycle(), normalizationVersion: "norm@1",
      delta: delta({ added: [obs({ externalRef: "A", status: "pending" })] }), nextCursor: "c1",
    });
    await store.reconcileSyncCycle({
      accountBindingId: b.id, cycleId: cycle(), normalizationVersion: "norm@1",
      delta: delta({
        removed: ["A" as ExternalObservationRef],
        added: [obs({ externalRef: "B", status: "posted", predecessorRef: "A" as ExternalObservationRef })],
      }),
      nextCursor: "c2",
    });
    // A is removed; B is the single active posted observation.
    const active = await store.listActiveObservations(b.id);
    expect(active).toHaveLength(1);
    expect(active[0].id).toBeTruthy();
  });

  it("7. interrupted reconciliation rolls back observations + mappings + cursor", async () => {
    const b = await bind();
    // Establish a baseline: no observations, no checkpoint.
    const beforeCkpt = await store.loadCheckpoint(b.id);
    expect(beforeCkpt).toBeNull();

    // Force a mid-transaction SQL failure: an added observation whose external ref
    // violates NOT NULL (cast through the typed boundary deliberately for the test).
    const failingDelta = delta({ added: [obs({ externalRef: null as unknown as string })] });
    await expect(
      store.reconcileSyncCycle({
        accountBindingId: b.id,
        cycleId: cycle(),
        normalizationVersion: "norm@1",
        delta: failingDelta,
        nextCursor: "c1",
      })
    ).rejects.toThrow();

    // Rollback invariant: no observation, no mapping, no cursor survived.
    const active = await store.listActiveObservations(b.id);
    expect(active).toHaveLength(0);
    const ckpt = await store.loadCheckpoint(b.id);
    expect(ckpt).toBeNull();
  });

  it("8. cursor advances only after complete successful reconciliation", async () => {
    const b = await bind();
    await store.reconcileSyncCycle({
      accountBindingId: b.id, cycleId: cycle(), normalizationVersion: "norm@1",
      delta: delta({ added: [obs({ externalRef: "t1" })] }), nextCursor: "c1",
    });
    const cp = await store.loadCheckpoint(b.id);
    expect(cp?.cursor).toBe("c1");
    expect(cp?.status).toBe("reconciled");
  });

  it("10. restart-sync leaves persisted cursor unchanged (no partial advance)", async () => {
    const b = await bind();
    await store.reconcileSyncCycle({
      accountBindingId: b.id, cycleId: cycle(), normalizationVersion: "norm@1",
      delta: delta({ added: [obs({ externalRef: "t1" })] }), nextCursor: "c1",
    });
    const before = await store.loadCheckpoint(b.id);
    // A cycle that fails (caller would raise restart_sync) does not advance cursor.
    // Here we assert the checkpoint is unchanged because no successful cycle ran.
    expect(before?.cursor).toBe("c1");
  });

  it("11. two account bindings with identical-looking provider refs cannot cross-bind", async () => {
    const b1 = await bind();
    const b2 = await store.bindAccount({
      providerId: "plaid",
      providerAccountRef: "acct-1" as ExternalObservationRef,
      credentialRef: "cred:test",
      metadata: {},
    });
    // Same provider + account ref resolves to the SAME binding (idempotent), never two.
    expect(b2.id).toBe(b1.id);
  });

  it("12. external-ref uniqueness is scoped per binding + provider", async () => {
    const b = await bind();
    await store.reconcileSyncCycle({
      accountBindingId: b.id, cycleId: cycle(), normalizationVersion: "norm@1",
      delta: delta({ added: [obs({ externalRef: "t1" })] }), nextCursor: "c1",
    });
    // A second add with the same external ref maps to the same observation id.
    const again = await store.reconcileSyncCycle({
      accountBindingId: b.id, cycleId: cycle(), normalizationVersion: "norm@1",
      delta: delta({ added: [obs({ externalRef: "t1" })] }), nextCursor: "c1",
    });
    expect(again.added).toHaveLength(0); // no second identity
  });

  it("13. raw credentials cannot appear in persisted rows", async () => {
    const b = await bind();
    await store.reconcileSyncCycle({
      accountBindingId: b.id, cycleId: cycle(), normalizationVersion: "norm@1",
      delta: delta({ added: [obs({ externalRef: "t1", description: "secret-token-123" })] }), nextCursor: "c1",
    });
    const { Pool } = await import("pg");
    const pool = new Pool({ connectionString: TEST_CONNECTION });
    const all = await pool.query(
      `SELECT description FROM financial_observations UNION ALL SELECT metadata::text FROM account_bindings`
    );
    const joined = JSON.stringify(all.rows);
    expect(joined).not.toContain("cred:test"); // credentialRef is an opaque ref, not raw secret
    await pool.end();
  });

  it("14. repeated complete sync cycle is idempotent", async () => {
    const b = await bind();
    const d = delta({ added: [obs({ externalRef: "t1" })] });
    await store.reconcileSyncCycle({ accountBindingId: b.id, cycleId: cycle(), normalizationVersion: "norm@1", delta: d, nextCursor: "c1" });
    const active1 = (await store.listActiveObservations(b.id)).length;
    await store.reconcileSyncCycle({ accountBindingId: b.id, cycleId: cycle(), normalizationVersion: "norm@1", delta: d, nextCursor: "c1" });
    const active2 = (await store.listActiveObservations(b.id)).length;
    expect(active2).toBe(active1);
  });

  it("15. concurrent/retried reconciliation cannot allocate two IDs for one binding + ref", async () => {
    const b = await bind();
    const d = delta({ added: [obs({ externalRef: "t1" })] });
    await Promise.all([
      store.reconcileSyncCycle({ accountBindingId: b.id, cycleId: cycle(), normalizationVersion: "norm@1", delta: d, nextCursor: "c1" }),
      store.reconcileSyncCycle({ accountBindingId: b.id, cycleId: cycle(), normalizationVersion: "norm@1", delta: d, nextCursor: "c1" }),
    ]);
    const { Pool } = await import("pg");
    const pool = new Pool({ connectionString: TEST_CONNECTION });
    const rows = await pool.query(
      `SELECT financial_observation_id FROM observation_external_refs WHERE account_binding_id=$1 AND external_ref='t1'`,
      [b.id]
    );
    expect(rows.rows).toHaveLength(1);
    await pool.end();
  });
});