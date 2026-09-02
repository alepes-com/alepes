/**
 * Publisher loop glue for the Temporal outbox workflow.
 * This is the real "publisher" module: it pauses and restarts Temporal
 * workflows but all Temporal-dependency code stays in workflows.ts.
 */

export type { OutboxClaimMsg } from "./types";
export { claimOutbox, markOutboxDelivered, releaseOutboxClaim } from "./activities";
