// Persistence port for Alepes execution plans.
//
// These interfaces are the ONLY contract between the pure domain and any
// database. They are database-agnostic (no `pg`, no SQL strings) so
// `packages/domain`, `packages/*engine`, etc. remain pure and testable without
// a database. Concrete implementations (PostgreSQL) live in this package.

import type { AuditRecord, ExecutionPlan } from "@alepes/domain";
import type { NonNegativeCents } from "@alepes/money";

/** A durable, ULID-based identifier minted only at the persistence boundary. */
export type PersistenceId = string & { readonly __persistenceId: unique symbol };

export interface Ports {
  execution: ExecutionRepository;
  outbox: OutboxRepository;
  close(): Promise<void>;
}

/**
 * The form of a plan that's ready to be persisted. This is the domain's
 * ExecutionPlan plus the provenance needed to reproduce it later.
 */
/**
 * Outbox-driven execution mode. Discrete from `disposition` — disposition is
 * the lifecycle state of the plan (which may later transition through
 * approval_required/approved/etc.); executionMode is the producer's explicit
 * declaration of what the outbox event is authorized to drive:
 *
 *   "shadow"  — simulate only; NEVER submit real orders.
 *   "execute" — authorized to submit real orders via the brokerage capability.
 *
 * This is REQUIRED at savePlan time and is never derived from the lifecycle
 * disposition, because mapping "anything not shadow" -> "execute" is not
 * fail-closed. For v0.5 certification, executionMode MUST be "shadow".
 */
export type OutboxExecutionMode = "shadow" | "execute";

export interface PersistableExecutionPlan {
  /** The in-memory domain plan (the actual decisions). */
  plan: ExecutionPlan;
  /** Durable, ULID-generated identity for this plan row. */
  id: PersistenceId;
  /** Durable identity of the originating cash event. */
  cashEventId: PersistenceId;
  /** Durable identity of the user the plan belongs to. */
  userId?: string;
  /** Durable identity of the portfolio this plan targets. */
  portfolioId: string;
  /** Version of the rule set that produced this plan. */
  ruleVersionId: PersistenceId;
  /** Version of the portfolio configuration that produced this plan. */
  portfolioVersionId: PersistenceId;
  /** The calculation/engine version (e.g. "allocation-engine@1", "rules-engine@1"). */
  calculationVersion: string;
  /**
   * Deterministic hash of the exact inputs that produced this plan.
   * Re-running the same inputs must produce the same hash.
   */
  inputSnapshotHash: string;
  /** The total deployable amount (integer cents, guaranteed non-negative). */
  deployableCents: NonNegativeCents;
  /** Lifecycle disposition at creation time. */
  disposition: PersistableDisposition;
  /**
   * Explicit execution authorization for the outbox event. REQUIRED — no
   * implicit default. `savePlan` throws on any value other than the two
   * typed literals. See `OutboxExecutionMode` for the contract.
   */
  executionMode: OutboxExecutionMode;
}

/**
 * The persisted lifecycle is richer than the domain's runtime disposition:
 * it includes approval_required, approved, executing, executed, rejected, failed.
 */
export type PersistableDisposition =
  | "shadow"
  | "approval_required"
  | "approved"
  | "executing"
  | "executed"
  | "rejected"
  | "failed";

export interface ExecutionRepository {
  /**
   * Persist a plan, its orders, the initial audit event, and an outbox event,
   * all in ONE transaction. On replay (identical cashEventId + ruleVersionId),
   * this MUST NOT create a duplicate plan; it returns the existing plan's id.
   */
  savePlan(input: PersistableExecutionPlan): Promise<PersistenceId>;

  /** Load a persisted plan by its persistence id. */
  loadPlan(id: PersistenceId): Promise<PersistableExecutionPlan | null>;

  /** Load all persisted plans (for reconciliation and audit enumeration). */
  listPlans(): Promise<PersistableExecutionPlan[]>;

  /**
   * Append an audit event to an existing plan. Events are immutable; once
   * written they cannot be modified or deleted.
   */
  appendEvent(planId: PersistenceId, record: AuditRecord): Promise<void>;

  /**
   * Update a plan's lifecycle disposition. This is the ONLY legal mutation to a
   * persisted plan — no financial amount, order, or order list may change.
   */
  updateDisposition(planId: PersistenceId, disposition: PersistableExecutionPlan["disposition"]): Promise<void>;

  /** Load the orders belonging to a plan. */
  loadOrders(planId: PersistenceId): Promise<Array<{ id: string; symbol: string; amountCents: number; side: string; shares: number; idempotencyKey: string }>>;
}

export interface OutboxEventInput {
  /** The event type, e.g. "ExecutionPlanCreated". */
  type: string;
  /** Opaque JSON-serializable payload for the consumer. */
  payload: Record<string, unknown>;
}

export interface OutboxClaim {
  id: PersistenceId;
  type: string;
  payload: Record<string, unknown>;
  /** When the current lease expires; null if unclaimed. */
  claimExpiresAt: string | null;
  attempts: number;
}

export interface OutboxRepository {
  /** Add an outbox event inside the SAME transaction as its producing change. */
  append(payload: OutboxEventInput): Promise<void>;

  /**
   * Atomically claim up to `limit` pending events with a lease.
   * A pending event is: delivered_at IS NULL AND (claimed_at IS NULL OR
   * claim_expires_at < now()). Claiming sets claimed_at, claim_expires_at
   * (now() + lease), and increments attempts — inside one transaction using
   * FOR UPDATE SKIP LOCKED, so concurrent publishers never double-claim.
   * Abandoned claims become claimable again after the lease expires.
   *
   * Returns the claimed rows including the lease expiry.
   */
  claimPending(limit: number, leaseMs: number): Promise<OutboxClaim[]>;

  /**
   * Bounded, certification-safe claim of exactly ONE outbox row by its id.
   *
   * Used by certification-style publishers that must prove a SPECIFIC event
   * reached `delivered_at IS NOT NULL` without ever touching unrelated pending
   * rows. Unlike `claimPending(limit, leaseMs)`, this:
   *
   *   - targets exactly one row (no created_at-ordered sweep),
   *   - throws (and claims nothing) when the row is already delivered, missing,
   *     or currently held under a non-expired lease by another worker,
   *   - is the ONLY outbox claim a bounded certification harness may use.
   *
   * Returns the single claimed row.
   */
  claimPendingById(id: PersistenceId, leaseMs: number): Promise<OutboxClaim>;

  /**
   * Mark a claimed event as delivered (terminal state). After this, the event
   * can never be claimed again.
   */
  markPublished(id: PersistenceId): Promise<void>;

  /** Release a claim without delivering (e.g. handler failed and wants retry). */
  releaseClaim(id: PersistenceId): Promise<void>;
}