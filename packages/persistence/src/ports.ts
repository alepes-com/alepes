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
}

export interface OutboxEventInput {
  /** The event type, e.g. "ExecutionPlanCreated". */
  type: string;
  /** Opaque JSON-serializable payload for the consumer. */
  payload: Record<string, unknown>;
}

export interface OutboxRepository {
  /** Add an outbox event inside the SAME transaction as its producing change. */
  append(payload: OutboxEventInput): Promise<void>;

  /** Claim the next undelivered outbox events (for the eventual worker). */
  claimPending(limit: number): Promise<Array<{ id: PersistenceId; type: string; payload: Record<string, unknown> }>>;
}