// Mock financial-data provider: a deterministic, in-memory implementation of
// the financial-data-provider capability. It models the provider as an append-only
// change journal keyed by an opaque integer cursor, so `syncObservations` can
// emit EXPLICIT add / modify / remove deltas — exactly the lossless form the
// reconciliation layer consumes.
//
// Sign convention is already Alepes's (credit = positive / incoming); the
// Plaid-specific sign flip is the Plaid adapter's concern, tested separately.

import type {
  ExternalObservationRef,
  FinancialObservation,
  FinancialObservationId,
  ObservationSyncDelta,
} from "@alepes/domain";
import { cents } from "@alepes/money";
import {
  CAPABILITIES,
  ProviderError,
  type AccountBinding,
  type FinancialDataProvider,
  type FinancialDataProviderCapability,
  type Plugin,
} from "@alepes/integration-runtime";

/** One external record; the mock surfaces it as observations over time. */
export interface MockExternalRecord {
  ref: string;
  accountRef: string;
  /** Amount already in Alepes convention (positive = credit/incoming). */
  amountCents: number;
  direction: "credit" | "debit";
  status: "pending" | "posted";
  description: string;
}

type JournalEntry =
  | { kind: "add"; ref: string; accountRef: string; record: MockExternalRecord }
  | { kind: "modify"; ref: string; accountRef: string; record: MockExternalRecord }
  | { kind: "remove"; ref: string; accountRef: string };

export function createMockFinancialDataProvider(
  options: { accountRefs?: string[] } = {}
): FinancialDataProvider & {
  addRecord(r: MockExternalRecord): void;
  modifyRecord(ref: string, patch: Partial<MockExternalRecord>): void;
  removeRecord(ref: string): void;
} {
  const accountRefs = options.accountRefs ?? ["acct-checking"];
  const journal: JournalEntry[] = [];
  // Map ref -> accountRef so modify/remove can record the account it belongs to.
  const accountByRef = new Map<string, string>();

  const provider: FinancialDataProvider = {
    info: { id: "mock-financial-data", version: "1.0.0" },

    async discoverAccounts(credentialRef: string): Promise<AccountBinding[]> {
      return accountRefs.map((ref, i) => ({
        id: `binding-${i + 1}`,
        providerAccountRef: ref as ExternalObservationRef,
        credentialRef,
        name: `Account ${ref}`,
        metadata: { subtype: "checking" },
      }));
    },

    async bindAccount(credentialRef: string, providerAccountRef: ExternalObservationRef): Promise<AccountBinding> {
      const idx = accountRefs.indexOf(providerAccountRef);
      if (idx < 0) throw new ProviderError("not_found", `unknown account ${providerAccountRef}`);
      return {
        id: `binding-${idx + 1}`,
        providerAccountRef,
        credentialRef,
        name: `Account ${providerAccountRef}`,
        metadata: { subtype: "checking" },
      };
    },

    async syncObservations(binding: AccountBinding, cursor: string): Promise<ObservationSyncDelta> {
      const start = parseInt(cursor || "0", 10) || 0;
      const mine = journal.filter((e) => e.accountRef === binding.providerAccountRef);

      const added: FinancialObservation[] = [];
      const modified: FinancialObservation[] = [];
      const removed: ExternalObservationRef[] = [];

      const PAGE = 3;
      const end = Math.min(start + PAGE, mine.length);
      for (let i = start; i < end; i++) {
        const e = mine[i];
        if (e.kind === "add") added.push(toObservation(binding.id, e.record));
        else if (e.kind === "modify") modified.push(toObservation(binding.id, e.record));
        else removed.push(e.ref as ExternalObservationRef);
      }

      return { added, modified, removed, nextCursor: String(end), hasMore: end < mine.length };
    },
  };

  function latestFor(ref: string): MockExternalRecord | undefined {
    for (const e of journal) {
      if (e.ref !== ref) continue;
      if (e.kind === "remove") return undefined;
      // add or modify carry the current record
      return e.record;
    }
    return undefined;
  }

  return {
    ...provider,
    addRecord(r) {
      accountByRef.set(r.ref, r.accountRef);
      journal.push({ kind: "add", ref: r.ref, accountRef: r.accountRef, record: r });
    },
    modifyRecord(ref, patch) {
      const accountRef = accountByRef.get(ref) ?? "acct-checking";
      const prior = latestFor(ref);
      const record: MockExternalRecord = { ...(prior ?? ({} as MockExternalRecord)), ...patch, ref };
      accountByRef.set(ref, record.accountRef);
      journal.push({ kind: "modify", ref, accountRef, record });
    },
    removeRecord(ref) {
      const accountRef = accountByRef.get(ref) ?? "acct-checking";
      journal.push({ kind: "remove", ref, accountRef });
    },
  };
}

function toObservation(bindingId: string, r: MockExternalRecord): FinancialObservation {
  return {
    id: `obs-${r.ref}` as FinancialObservationId,
    externalRef: r.ref as ExternalObservationRef,
    accountBindingId: bindingId,
    amountCents: cents(r.amountCents),
    direction: r.direction,
    status: r.status,
    firstObservedAt: "2026-09-01T00:00:00Z",
    ...(r.status === "posted" ? { postedAt: "2026-09-01T00:00:00Z" } : {}),
    description: r.description,
    normalizationVersion: "norm@1",
  };
}

export function createMockFinancialDataPlugin(
  provider: FinancialDataProvider
): { plugin: Plugin; provider: FinancialDataProvider } {
  const capability: FinancialDataProviderCapability = {
    id: CAPABILITIES.financialDataProvider,
    name: "Financial data provider",
    version: provider.info.version,
    description: "Read-only provider-neutral financial data synchronization.",
    ...provider,
  };
  const plugin: Plugin = {
    id: "plugin:mock-financial-data",
    name: "Mock Financial Data Provider",
    version: provider.info.version,
    capabilities: new Map([[CAPABILITIES.financialDataProvider, capability]]),
    lifecycle: { async connect() {}, async disconnect() {}, async health() { return null; } },
  };
  return { plugin, provider };
}