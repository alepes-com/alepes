/**
 * Source-commit provenance for the live-certification entrypoint.
 *
 * This module is the SINGLE canonical place that decides which source commit
 * a live certification is bound to. It performs NO I/O itself: the caller
 * supplies a `git` executor (in production: a thin wrapper around `git
 * rev-parse HEAD` / `git status --porcelain`) and the process environment.
 * That makes the decision function pure, synchronously testable, and
 * impossible to bypass via ambient environment mutation alone.
 *
 * Fail-closed invariant:
 *
 *   - The certification ALWAYS runs against the independently derived
 *     `git rev-parse HEAD` of the working tree (`actualHead`).
 *   - When running under GitHub Actions (`GITHUB_ACTIONS === "true"`), the
 *     ambient `GITHUB_SHA` MUST be present AND MUST equal `actualHead`.
 *     A mismatch is a provenance failure, not a "trust GITHUB_SHA" signal.
 *   - Outside GitHub Actions, an ambient `GITHUB_SHA` is IGNORED for
 *     provenance purposes — a developer who happens to export an unrelated
 *     GITHUB_SHA cannot cause the wrapper to skip the local git checks.
 *   - BOTH paths require a clean worktree (`git status --porcelain` empty).
 *     A dirty tree means the running harness is not exactly `actualHead`.
 *   - Any git failure (rev-parse error, status error, empty output) refuses.
 *
 * No network I/O. No Plaid. No Temporal. Safe to import from anywhere.
 */

export type GitProbe = {
  /** Equivalent of `git rev-parse HEAD`. Returns the full 40-hex SHA or throws. */
  revParseHead(): string;
  /** Equivalent of `git status --porcelain`. Empty string = clean tree. Throws on error. */
  statusPorcelain(): string;
};

export type SourceProvenanceEnv = {
  /** process.env.GITHUB_ACTIONS — must be exactly the string "true" to count. */
  GITHUB_ACTIONS?: string | undefined;
  /** process.env.GITHUB_SHA — informational unless GITHUB_ACTIONS === "true". */
  GITHUB_SHA?: string | undefined;
};

export type SourceProvenance =
  | {
      ok: true;
      /** The independently verified HEAD. Always equals the audit/commit recorded downstream. */
      sourceCommit: string;
      /** "ci" when running under GitHub Actions with matching GITHUB_SHA; else "local". */
      mode: "ci" | "local";
    }
  | {
      ok: false;
      /** Human-readable reason, safe to print to stderr. Contains no secrets. */
      reason: string;
    };

const GIT_SHA_RE = /^[0-9a-f]{40}$/;

/**
 * Decide the certification source commit from the environment plus an
 * independently derived git HEAD. NEVER trusts GITHUB_SHA without an exact
 * match against `git rev-parse HEAD`. NEVER allows a dirty worktree.
 */
export function resolveSourceProvenance(
  env: SourceProvenanceEnv,
  git: GitProbe
): SourceProvenance {
  // 1. Independently derive the actual HEAD. If we cannot read git, we cannot
  //    prove anything — refuse before doing any other work.
  let actualHead: string;
  try {
    actualHead = git.revParseHead().trim();
  } catch (err) {
    return {
      ok: false,
      reason: `git rev-parse HEAD failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
  if (!GIT_SHA_RE.test(actualHead)) {
    return {
      ok: false,
      reason: `git rev-parse HEAD returned an unexpected value (not a 40-hex SHA): ${JSON.stringify(
        actualHead
      )}`,
    };
  }

  // 2. Worktree MUST be clean. A dirty tree means the bytes on disk do not
  //    equal the bytes at actualHead — provenance void in BOTH local and CI.
  let statusOut: string;
  try {
    statusOut = git.statusPorcelain();
  } catch (err) {
    return {
      ok: false,
      reason: `git status --porcelain failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
  if (statusOut.trim().length > 0) {
    return {
      ok: false,
      reason:
        "working tree is dirty (git status --porcelain non-empty); " +
        "the harness on disk is not exactly the commit it claims to be. " +
        "Commit or stash before certifying.",
    };
  }

  // 3. Environment-specific provenance check.
  const inActions = env.GITHUB_ACTIONS === "true";
  const ambientSha = (env.GITHUB_SHA ?? "").trim();

  if (inActions) {
    if (ambientSha.length === 0) {
      return {
        ok: false,
        reason: "running under GITHUB_ACTIONS=true but GITHUB_SHA is empty; cannot bind CI provenance",
      };
    }
    if (ambientSha !== actualHead) {
      return {
        ok: false,
        reason:
          `GITHUB_SHA mismatch: ambient GITHUB_SHA=${ambientSha} does not equal ` +
          `independently derived HEAD=${actualHead}. Refusing to certify: provenance broken.`,
      };
    }
    return { ok: true, sourceCommit: actualHead, mode: "ci" };
  }

  // Local path: ambient GITHUB_SHA is IGNORED for provenance. A developer
  // machine with a stale GITHUB_SHA export must not bypass the local check.
  // We do not fail on its presence — we simply do not consult it.
  return { ok: true, sourceCommit: actualHead, mode: "local" };
}
