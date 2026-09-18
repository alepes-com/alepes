/**
 * Task-queue constants for the Temporal layer.
 *
 * `DEFAULT_TASK_QUEUE` ("alepes-execution") is the shared production/dev queue.
 * Certification flows MUST NOT run on this queue — they derive a dedicated,
 * fingerprinted queue via `certificationTaskQueueName` below so no ordinary
 * or stale worker can consume the certification workflow.
 */

/**
 * The default production/dev task queue. Historical name — every worker
 * and every client that doesn't explicitly override it agrees on this string.
 */
export const DEFAULT_TASK_QUEUE = "alepes-execution";

/**
 * Reserved prefix for certification task queues. Isolation invariant:
 * certification queues never start with the default queue name as an exact
 * equality, and the default queue is never derived from a certification
 * fingerprint (so a name collision is impossible by construction).
 */
export const CERTIFICATION_TASK_QUEUE_PREFIX = "alepes-certification";

/**
 * Derive a deterministic, certification-scoped task queue name.
 *
 * Inputs:
 *   - `runId`: a stable unique id for the run (e.g. ULID minted at startup).
 *   - `sourceCommit`: the exact commit SHA the certification harness is running
 *     from. Mixed into the queue name so a stale certify-worker binary at an
 *     older commit can never consume a newer certification workflow.
 *
 * Output is lowercase, safe for Temporal task-queue naming, and stable under
 * re-invocation with the same inputs (so a crashed run can resume its own
 * queue without leaking into a public one).
 */
export function certificationTaskQueueName(input: {
  runId: string;
  sourceCommit: string;
}): string {
  const runId = sanitize(input.runId);
  const commit = sanitize(input.sourceCommit);
  if (runId.length === 0) throw new Error("certificationTaskQueueName requires a non-empty runId");
  if (commit.length === 0) throw new Error("certificationTaskQueueName requires a non-empty sourceCommit");
  return `${CERTIFICATION_TASK_QUEUE_PREFIX}-${commit}-${runId}`;
}

/**
 * Temporal task-queue names allow [a-zA-Z0-9-]. Strip anything else (dots,
 * slashes, underscores in ULIDs are already safe but be strict). Cap total
 * length well under Temporal's per-queue length budget.
 */
function sanitize(value: string): string {
  return String(value).toLowerCase().replace(/[^a-z0-9-]/g, "").slice(0, 40);
}
