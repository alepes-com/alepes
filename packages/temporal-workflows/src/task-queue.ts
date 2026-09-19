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
  // Refuse lossy sanitize: if the raw input contains any character Temporal
  // would not accept verbatim, distinct (runId, sourceCommit) pairs can
  // collide (e.g. 'a.b/c' vs 'abc' both sanitize to 'abc'). Fail closed
  // instead of silently mapping to a shared queue. Callers must supply a
  // strictly-safe identifier (typically a ULID and a 40-hex SHA).
  const runId = requireSafe(input.runId, "runId");
  const sourceCommit = requireSafe(input.sourceCommit, "sourceCommit");
  return `${CERTIFICATION_TASK_QUEUE_PREFIX}-${sourceCommit}-${runId}`;
}

/**
 * Require the identifier to be non-empty and composed ONLY of characters
 * Temporal task-queue names accept verbatim: lowercase ASCII letters, digits,
 * and hyphens. Anything else — dots, slashes, underscores, uppercase,
 * whitespace, unicode — fails closed. Uppercase is rejected rather than
 * downcased to preserve input/output equality (no silent collisions).
 */
function requireSafe(value: string, label: string): string {
  if (value.length === 0) {
    throw new Error(`certificationTaskQueueName requires a non-empty ${label}`);
  }
  if (value.length > 40) {
    throw new Error(
      `certificationTaskQueueName: ${label} is ${value.length} chars; max 40 to leave room for prefix and the other segment`
    );
  }
  if (!/^[a-z0-9-]+$/.test(value)) {
    throw new Error(
      `certificationTaskQueueName: ${label} contains characters outside [a-z0-9-]; refusing to sanitize (possible collision attack vector) — got ${JSON.stringify(value).slice(0, 80)}`
    );
  }
  return value;
}
