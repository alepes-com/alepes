import { describe, it, expect } from "vitest";
import {
  certifyFinancialDataProvider,
  type FinancialDataSyncFixture,
} from "./conformance";
import {
  createPlaidFinancialDataProvider,
  type PlaidTransactionsSyncClient,
} from "@alepes/plaid-financial-data";

// Plaid-shaped transaction records as PLAIN OBJECTS (no `plaid` import): the
// conformance harness is provider-neutral and must not import the Plaid SDK.
// This also proves the adapter's public surface reads only the field names it
// documents, not SDK types.
interface PlaidShapedTransaction {
  transaction_id: string;
  amount: number;
  pending: boolean;
  pending_transaction_id: string | null;
  date: string;
  datetime: string | null;
  name: string;
}

function shapedTx(id: string, amountDollars: number, pending = false): PlaidShapedTransaction {
  return {
    transaction_id: id,
    amount: amountDollars,
    pending,
    pending_transaction_id: null,
    date: "2026-09-01",
    datetime: "2026-09-01T09:00:00Z",
    name: "Record",
  };
}

function plaidFixture(): FinancialDataSyncFixture {
  let added: PlaidShapedTransaction[] = [];
  const modified: PlaidShapedTransaction[] = [];
  const removed: string[] = [];

  const client: PlaidTransactionsSyncClient = {
    transactionsSync: async ({ cursor: inCursor }: { cursor?: string }) => {
      const data = {
        transactions_update_status: "HISTORICAL_UPDATE_COMPLETE",
        accounts: [],
        added,
        modified,
        removed: removed.map((r) => ({ transaction_id: r })),
        // Deterministic, input-derived cursor: replaying the same input cursor
        // yields the same next_cursor (idempotent), mirroring /transactions/sync.
        next_cursor: `cursor-${inCursor ?? ""}`,
        has_more: false,
        request_id: "req",
      };
      return { data: data as never };
    },
  } as unknown as PlaidTransactionsSyncClient;

  const provider = createPlaidFinancialDataProvider({
    client,
    resolveAccessToken: async () => "tok-test",
    discover: async () => [{ accountId: "acct-1", name: "Checking" }],
  });

  return {
    provider,
    add(ref, amountCents, direction) {
      // Convert Alepes convention → Plaid convention: credit (incoming, +) ⇒ negative Plaid amount.
      const plaidAmount = direction === "credit" ? -(amountCents / 100) : amountCents / 100;
      added = [...added, shapedTx(ref, plaidAmount)];
    },
    modify(ref, amountCents) {
      // Modified credit: negative Plaid amount for incoming.
      modified.push(shapedTx(ref, -(Math.abs(amountCents) / 100)));
    },
    remove(ref) {
      removed.push(ref);
    },
  };
}

describe("certifyFinancialDataProvider (Plaid fixture-backed, no SDK import)", () => {
  it("Plaid adapter passes the provider-neutral conformance harness", async () => {
    const report = await certifyFinancialDataProvider(plaidFixture());
    expect(report.failures).toEqual([]);
    expect(report.pass).toBe(true);
  });
});