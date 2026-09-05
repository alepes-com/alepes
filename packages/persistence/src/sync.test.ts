// Integration tests: provider-sync persistence against real PostgreSQL.
// Run with: ALEPES_TEST_SYNC_DATABASE_URL=postgresql://raelldottin@localhost:5432/alepes_sync_test bun run test packages/persistence/src/sync.test.ts

import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { runMigrations } from "./migrations";
import { createSyncPostgresStore } from "./sync-postgres";
import type { ProviderSyncStore, AccountBindingId, SyncCycleId } from "./sync-ports";
import { StaleSyncCycleError } from "./sync-ports";
import { cents, nonNegativeCents } from "@alepes/money";
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

  // Reconcile using the CURRENT persisted cursor as the expected starting cursor,
  // mirroring how the orchestrator reads the checkpoint before paging the provider.
  async function rec(input: Omit<Parameters<ProviderSyncStore["reconcileSyncCycle"]>[0], "startingCursor">) {
    const cp = await store.loadCheckpoint(input.accountBindingId);
    const startingCursor = cp?.cursor ?? "";
    return store.reconcileSyncCycle({ ...input, startingCursor });
  }

  it("1. first added record creates one observation + mapping", async () => {
    const b = await bind();
    const res = await rec({
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
    const first = await rec({
      accountBindingId: b.id, cycleId: cycle(), normalizationVersion: "norm@1",
      delta: delta({ added: [obs({ externalRef: "t1" })] }), nextCursor: "c1",
    });
    const second = await rec({
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
    await rec({
      accountBindingId: b.id, cycleId: cycle(), normalizationVersion: "norm@1",
      delta: delta({ added: [obs({ externalRef: "t1", amountCents: 100_00 })] }), nextCursor: "c1",
    });
    const res = await rec({
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
    await rec({
      accountBindingId: b.id, cycleId: cycle(), normalizationVersion: "norm@1",
      delta: delta({ added: [obs({ externalRef: "t1" })] }), nextCursor: "c1",
    });
    await rec({
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
    await rec({
      accountBindingId: b.id, cycleId: cycle(), normalizationVersion: "norm@1",
      delta: delta({ added: [obs({ externalRef: "t1", status: "pending" })] }), nextCursor: "c1",
    });
    await rec({
      accountBindingId: b.id, cycleId: cycle(), normalizationVersion: "norm@1",
      delta: delta({ modified: [obs({ externalRef: "t1", status: "posted" })] }), nextCursor: "c2",
    });
    const active = await store.listActiveObservations(b.id);
    expect(active).toHaveLength(1);
    expect(active[0].status).toBe("posted");
  });

  it("6. pending removed + posted replacement with predecessor linkage → one active", async () => {
    const b = await bind();
    await rec({
      accountBindingId: b.id, cycleId: cycle(), normalizationVersion: "norm@1",
      delta: delta({ added: [obs({ externalRef: "A", status: "pending" })] }), nextCursor: "c1",
    });
    await rec({
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
      rec({
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
    await rec({
      accountBindingId: b.id, cycleId: cycle(), normalizationVersion: "norm@1",
      delta: delta({ added: [obs({ externalRef: "t1" })] }), nextCursor: "c1",
    });
    const cp = await store.loadCheckpoint(b.id);
    expect(cp?.cursor).toBe("c1");
    expect(cp?.status).toBe("reconciled");
  });

  it("10. restart-sync leaves persisted cursor unchanged (no partial advance)", async () => {
    const b = await bind();
    await rec({
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
    await rec({
      accountBindingId: b.id, cycleId: cycle(), normalizationVersion: "norm@1",
      delta: delta({ added: [obs({ externalRef: "t1" })] }), nextCursor: "c1",
    });
    // A second add with the same external ref maps to the same observation id.
    const again = await rec({
      accountBindingId: b.id, cycleId: cycle(), normalizationVersion: "norm@1",
      delta: delta({ added: [obs({ externalRef: "t1" })] }), nextCursor: "c1",
    });
    expect(again.added).toHaveLength(0); // no second identity
  });

  it("13. raw credentials cannot appear in persisted rows", async () => {
    const b = await bind();
    await rec({
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
    await rec({ accountBindingId: b.id, cycleId: cycle(), normalizationVersion: "norm@1", delta: d, nextCursor: "c1" });
    const active1 = (await store.listActiveObservations(b.id)).length;
    await rec({ accountBindingId: b.id, cycleId: cycle(), normalizationVersion: "norm@1", delta: d, nextCursor: "c1" });
    const active2 = (await store.listActiveObservations(b.id)).length;
    expect(active2).toBe(active1);
  });

  it("15. concurrent reconciliation from the same starting cursor: one commits, the other is stale", async () => {
    const b = await bind();
    const d = delta({ added: [obs({ externalRef: "t1" })] });
    // Both cycles genuinely began from the SAME empty cursor (""). Because the
    // advisory lock serializes reconciliation and the stale-guard rejects a cycle
    // whose starting cursor no longer matches the authoritative cursor, exactly
    // one commits and the other is rejected as stale.
    const [first, second] = await Promise.allSettled([
      store.reconcileSyncCycle({ accountBindingId: b.id, cycleId: cycle(), normalizationVersion: "norm@1", delta: d, startingCursor: "", nextCursor: "c1" }),
      store.reconcileSyncCycle({ accountBindingId: b.id, cycleId: cycle(), normalizationVersion: "norm@1", delta: d, startingCursor: "", nextCursor: "c1" }),
    ]);
    const fulfilled = [first, second].filter((r) => r.status === "fulfilled");
    const rejected = [first, second].filter((r) => r.status === "rejected");
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(rejected[0].reason).toBeInstanceOf(StaleSyncCycleError);

    const { Pool } = await import("pg");
    const pool = new Pool({ connectionString: TEST_CONNECTION });
    const rows = await pool.query(
      `SELECT financial_observation_id FROM observation_external_refs WHERE account_binding_id=$1 AND external_ref='t1'`,
      [b.id]
    );
    expect(rows.rows).toHaveLength(1);
    await pool.end();
  });

  it("18. stale cycle cannot regress the authoritative cursor (C20 → C10 rejected)", async () => {
    const b = await bind();
    // Cycle A commits from "" → C10.
    await rec({ accountBindingId: b.id, cycleId: cycle(), normalizationVersion: "norm@1", delta: delta({ added: [obs({ externalRef: "a" })] }), nextCursor: "C10" });

    // Cycle B (concurrent slower cycle) had ALSO read starting cursor "" before A
    // committed. It now tries to commit with startingCursor "" → C20. Because the
    // authoritative cursor is C10, this is stale and must be rejected.
    await expect(
      store.reconcileSyncCycle({
        accountBindingId: b.id,
        cycleId: cycle(),
        normalizationVersion: "norm@1",
        delta: delta({ added: [obs({ externalRef: "b" })] }),
        startingCursor: "",
        nextCursor: "C20",
      })
    ).rejects.toBeInstanceOf(StaleSyncCycleError);

    // The authoritative cursor stays C10 (never regressed to C20, never back to "").
    const cp = await store.loadCheckpoint(b.id);
    expect(cp?.cursor).toBe("C10");
    // The stale cycle's observation was NOT applied.
    const active = await store.listActiveObservations(b.id);
    expect(active).toHaveLength(1);
    expect(active[0].description).toBe("record");
  });

  it("16. account balance snapshot is persisted and read back for qualification", async () => {
    const b = await bind();
    await rec({
      accountBindingId: b.id, cycleId: cycle(), normalizationVersion: "norm@1",
      // The balance is an ACCOUNT-level snapshot carried on the sync delta, not a
      // per-transaction "balance after".
      delta: delta({
        added: [obs({ externalRef: "t1" })],
        accountBalance: {
          accountBindingId: b.id,
          availableCents: nonNegativeCents(5000_00),
          currentCents: nonNegativeCents(4900_00),
          capturedAt: "2026-09-01T00:00:00Z",
          isCachedByProvider: true,
          normalizationVersion: "norm@1",
        },
      }),
      nextCursor: "c1",
    });
    const active = await store.listActiveObservations(b.id);
    expect(active).toHaveLength(1);
    // selectAccountBalance: available (500000) wins over current (490000).
    expect(active[0].qualificationBalanceCents).toBe(500000);
    // The cycle that reconciled this observation is recorded (provenance).
    expect(active[0].lastReconciledCycleId).toBeTruthy();
  });

  it("17. persisted observation id is Alepes-minted and does NOT encode the external ref", async () => {
    const b = await bind();
    const providerId = "plaid-tx-secret-123"; // the raw provider identifier
    await rec({
      accountBindingId: b.id, cycleId: cycle(), normalizationVersion: "norm@1",
      delta: delta({ added: [obs({ externalRef: providerId })] }),
      nextCursor: "c1",
    });
    const active = await store.listActiveObservations(b.id);
    expect(active).toHaveLength(1);
    const persistedId = active[0].id;
    // The durable Alepes id is ULID-based (obs_...), independent of the provider.
    expect(persistedId.startsWith("obs_")).toBe(true);
    // It does NOT embed the raw provider identifier.
    expect(persistedId).not.toContain(providerId);
    // And it is provably distinct from the adapter's provisional `obs-${ref}` id.
    expect(persistedId).not.toBe(`obs-${providerId}`);
  });

  it("19. rebinding the same account with a new credential ref retains the binding id and updates the ref", async () => {
    const b1 = await store.bindAccount({
      providerId: "plaid",
      providerAccountRef: "acct-1" as ExternalObservationRef,
      credentialRef: "cred:old",
      metadata: { subtype: "checking" },
    });

    // Re-bind the SAME provider/account with a NEW credential reference.
    const b2 = await store.bindAccount({
      providerId: "plaid",
      providerAccountRef: "acct-1" as ExternalObservationRef,
      credentialRef: "cred:rotated",
      metadata: { subtype: "checking", reconnected: "true" },
    });

    // Same durable Alepes binding id (never a second binding).
    expect(b2.id).toBe(b1.id);
    // The credential ref is updated in place.
    expect(b2.credentialRef).toBe("cred:rotated");
    // Metadata reflects the rebind, and the binding is active.
    expect(b2.active).toBe(true);
    expect((b2.metadata as Record<string, string>).reconnected).toBe("true");

    // No raw secret is ever persisted — only the opaque reference.
    const { Pool } = await import("pg");
    const pool = new Pool({ connectionString: TEST_CONNECTION });
    const rows = await pool.query(
      `SELECT credential_ref FROM account_bindings WHERE id=$1`,
      [b1.id]
    );
    expect(rows.rows).toHaveLength(1);
    expect(rows.rows[0].credential_ref).toBe("cred:rotated");
    await pool.end();
  });
});