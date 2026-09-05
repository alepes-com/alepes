// Downstream reconciliation → qualification → CashEvent. Pure and deterministic;
// no SQL, no I/O. It consumes already-reconciled Alepes-owned observation state
// and produces qualifying CashEvents. Provider observations are NEVER themselves
// executable events — only posted, incoming, balance-bearing observations become
// CashEvents, and a pending→posted transition can yield at most one.

import type {
  CashEvent,
  ExternalObservationRef,
  FinancialObservation,
} from "@alepes/domain";
import { interpretObservation, qualifyCashEvent } from "@alepes/domain";
import type { Cents, NonNegativeCents } from "@alepes/money";
import type { PersistedObservation } from "./sync-ports";

/**
 * Convert a persisted observation into the FinancialObservation shape the pure
 * interpretation layer expects. The account balance is NOT part of the
 * transaction observation (providers don't report a per-transaction "balance
 * after"); it is carried separately as `qualificationBalanceCents` and fed to
 * qualification directly.
 */
function toFinancialObservation(o: PersistedObservation): FinancialObservation {
  return {
    id: o.id,
    externalRef: "" as ExternalObservationRef,
    accountBindingId: o.accountBindingId,
    amountCents: o.amountCents as Cents,
    direction: o.direction,
    status: o.status,
    firstObservedAt: o.firstObservedAt,
    ...(o.postedAt ? { postedAt: o.postedAt } : {}),
    description: o.description,
    normalizationVersion: o.normalizationVersion,
  };
}

/**
 * Deterministically derive qualifying CashEvents from reconciled active
 * observations. Invariants:
 *  - pending observations never qualify (not yet executable);
 *  - only posted incoming-cash observations with a captured account balance qualify;
 *  - a removed observation never appears (it is inactive);
 *  - a predecessor-linked observation does NOT duplicate its predecessor's event.
 */
export function qualifyCashEvents(observations: PersistedObservation[]): CashEvent[] {
  const events: CashEvent[] = [];
  const seen = new Set<string>();

  // Only active, posted observations can qualify. Order is deterministic (caller
  // sorts by createdAt); we re-sort by firstObservedAt for determinism.
  const activePosted = observations
    .filter((o) => o.state === "active" && o.status === "posted")
    .sort((a, b) => a.firstObservedAt.localeCompare(b.firstObservedAt));

  for (const o of activePosted) {
    // A predecessor-linked observation supersedes its predecessor: do not emit a
    // second independent event for the same logical deposit. Because the
    // predecessor is itself 'removed' and absent from this list, this guard is
    // belt-and-suspenders; it also prevents a hypothetical still-active
    // predecessor from double-counting.
    if (o.predecessorObservationId && seen.has(o.predecessorObservationId)) {
      seen.add(o.id);
      continue;
    }
    const fin = toFinancialObservation(o);
    const interp = interpretObservation(fin);
    // The account balance captured for this observation's sync cycle is the
    // balance used for qualification — never a fabricated per-transaction value.
    const balance =
      o.qualificationBalanceCents === null
        ? undefined
        : (o.qualificationBalanceCents as NonNegativeCents);
    const event = qualifyCashEvent(fin, interp, balance);
    if (event) {
      events.push(event);
      seen.add(o.id);
    }
  }

  return events;
}