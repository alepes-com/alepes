import { describe, it, expect } from "vitest";
import {
  certifyFinancialDataProvider,
  type FinancialDataSyncFixture,
} from "./conformance";
import { createMockFinancialDataProvider } from "@alepes/mock-financial-data";
import type { ExternalObservationRef } from "@alepes/domain";

function fixture(): FinancialDataSyncFixture {
  const provider = createMockFinancialDataProvider({ accountRefs: ["acct-checking"] });
  return {
    provider,
    add: (ref, amountCents, direction, status) =>
      provider.addRecord({ ref, accountRef: "acct-checking", amountCents, direction, status, description: ref }),
    modify: (ref, amountCents, status) =>
      provider.modifyRecord(ref, { amountCents, ...(status ? { status } : {}) }),
    remove: (ref) => provider.removeRecord(ref),
  };
}

describe("certifyFinancialDataProvider", () => {
  it("certifies the mock financial-data provider", async () => {
    const report = await certifyFinancialDataProvider(fixture());
    expect(report.failures).toEqual([]);
    expect(report.pass).toBe(true);
  });

  it("a provider missing discoverAccounts FAILS certification", async () => {
    // A provider that throws on discoverAccounts must not pass.
    const broken: FinancialDataSyncFixture = {
      provider: {
        info: { id: "broken", version: "1.0.0" },
        discoverAccounts: async () => {
          throw new Error("no provider");
        },
        bindAccount: async (_c, ref) => ({
          id: "b",
          providerAccountRef: ref,
          credentialRef: "cred:test",
          metadata: {},
        }),
        syncObservations: async () => ({
          added: [],
          modified: [],
          removed: [],
          nextCursor: "0",
          hasMore: false,
        }),
      },
      add: () => {},
      modify: () => {},
      remove: () => {},
    };
    const report = await certifyFinancialDataProvider(broken);
    expect(report.pass).toBe(false);
    expect(report.failures.length).toBeGreaterThan(0);
  });
});