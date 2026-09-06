// Provider-neutral webhook handling for the read-only sync lifecycle.
//
// Plaid fires `SYNC_UPDATES_AVAILABLE` when new transaction data is available
// for an Item. Alepes treats a webhook as a TRIGGER ONLY — it never becomes an
// observation and never carries financial meaning. The authoritative changes
// always come from a subsequent `/transactions/sync` against the saved cursor,
// so a duplicate or repeated webhook is harmless by construction.
//
// This module is provider-neutral on its public surface: it accepts a plain
// payload shape and returns a durable resync request. The only Plaid-specific
// knowledge is the `SYNC_UPDATES_AVAILABLE` code string, kept as a named
// constant.

/** The webhook codes Alepes's read-only sync path responds to. */
export const SYNC_UPDATES_AVAILABLE = "SYNC_UPDATES_AVAILABLE" as const;

/** A minimal, provider-neutral webhook payload (post-auth, pre-verification). */
export interface SyncWebhookPayload {
  webhook_type?: string;
  webhook_code?: string;
  item_id?: string;
  /** Newly available transaction count, per Plaid's payload semantics. */
  new_transactions?: number;
}

/**
 * A durable resync request derived from a webhook. Carries everything the
 * orchestrator needs to run a scoped sync; carries NO credentials.
 */
export interface SyncUpdatesRequest {
  /** Why this request exists (for the audit trail / explanation). */
  reason: "sync_updates_available";
  /** The Item the webhook referenced (opaque, correlation only). */
  itemId?: string;
  /** Count of newly-available transactions reported (0 when unknown). */
  newTransactions: number;
}

/**
 * Parse a webhook payload into a durable resync request, or null when the
 * payload is not a `SYNC_UPDATES_AVAILABLE` event. Pure and deterministic:
 * duplicate payloads produce identical requests (idempotent trigger).
 */
export function parseSyncUpdatesAvailable(
  payload: SyncWebhookPayload
): SyncUpdatesRequest | null {
  if (payload.webhook_code !== SYNC_UPDATES_AVAILABLE) return null;
  return {
    reason: "sync_updates_available",
    ...(payload.item_id ? { itemId: payload.item_id } : {}),
    newTransactions: payload.new_transactions ?? 0,
  };
}