// Deterministic Plaid-shaped fixtures for the financial-data adapter tests and
// conformance. These are Plaid-typed INTERNALLY (the adapter's public surface
// never exposes them); the adapter converts each into Alepes-owned
// FinancialObservation.

import type {
  RemovedTransaction,
  Transaction,
  TransactionsSyncResponse,
} from "plaid";

export function plaidTransaction(overrides: Partial<Transaction> & { transaction_id: string }): Transaction {
  return {
    account_id: "acct-1",
    amount: 100, // Plaid convention: POSITIVE = money out
    pending: false,
    pending_transaction_id: null,
    date: "2026-09-01",
    name: "Payroll",
    datetime: "2026-09-01T09:00:00Z",
    transaction_type: "special",
    ...overrides,
  } as Transaction;
}

export function removedTransaction(transaction_id: string, account_id = "acct-1"): RemovedTransaction {
  return { transaction_id, account_id };
}

export function syncResponse(overrides: Partial<TransactionsSyncResponse>): TransactionsSyncResponse {
  return {
    transactions_update_status: "HISTORICAL_UPDATE_COMPLETE",
    accounts: [],
    added: [],
    modified: [],
    removed: [],
    next_cursor: "cursor-1",
    has_more: false,
    request_id: "req-1",
    ...overrides,
  } as TransactionsSyncResponse;
}

/** Incoming money in Plaid convention: negative amount (money IN). */
export function incomingPlaidTransaction(transaction_id: string, amountDollars = -2814.32): Transaction {
  return plaidTransaction({ transaction_id, amount: amountDollars });
}

/** Outgoing money in Plaid convention: positive amount (money OUT). */
export function outgoingPlaidTransaction(transaction_id: string, amountDollars = 50.0): Transaction {
  return plaidTransaction({ transaction_id, amount: amountDollars });
}