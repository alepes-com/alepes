/**
 * Node 24 wrapper for the Plaid live certification harness.
 *
 * The live certification path must run on the supported Node 24 runtime
 * (Temporal's workflow isolate depends on V8 promiseHooks, which Bun does
 * not provide). This module performs the runtime preflight and the
 * Temporal-endpoint preflight, then dynamically imports the harness body.
 *
 * It is the ONLY entrypoint `certify:plaid-live` runs; the harness body in
 * `certify-live.ts` exports its `main` but must never be executed directly
 * from Bun or under any other Node major version.
 */

const REQUIRED_NODE_MAJOR = 24;

// ── Runtime guard — fail-closed on anything other than Node 24 ──────────────

const runtimeMajor = Number.parseInt(process.versions.node.split(".")[0] ?? "0", 10);
if (runtimeMajor !== REQUIRED_NODE_MAJOR) {
  console.error(
    `REFUSING TO RUN: certify:plaid-live requires Node ${REQUIRED_NODE_MAJOR}.x ` +
      `(the Temporal Worker runtime island), got node ${process.versions.node}. ` +
      `Bun is not an acceptable runtime for this entrypoint.`
  );
  process.exit(2);
}

// Prove we're on a genuine Node runtime (not Bun spoofing process.versions).
if (typeof (process as { versions: { bun?: string } }).versions.bun === "string") {
  console.error(
    "REFUSING TO RUN: detected Bun runtime (process.versions.bun is set). " +
      "certify:plaid-live must run under Node 24 only."
  );
  process.exit(2);
}

// ── Temporal endpoint preflight — fail-closed on anything non-local ─────────

import { preflightTemporalEndpoint } from "@alepes/temporal-workflows/certification-preflight";

const rawAddress = process.env.ALEPES_TEMPORAL_ADDRESS ?? "localhost:7233";
const classification = preflightTemporalEndpoint(rawAddress);
if (classification.kind !== "local") {
  console.error(
    `REFUSING TO RUN: certification requires the explicit LOCAL Temporal endpoint. ` +
      `Got ${classification.kind} (host classification only, no credentials): ` +
      `${classification.summary}`
  );
  process.exit(2);
}
// Endpoint classification goes to stderr pre-harness so it is durable in
// captured output; never log credentials — only host/port classification.
console.error(
  `[certify-live preflight] Node ${process.versions.node} confirmed; ` +
    `Temporal endpoint classified as ${classification.kind} (${classification.summary})`
);

// ── Source-commit provenance ────────────────────────────────────────────────
//
// Verify the harness is being run from a known, immutable source commit. In
// CI this is `GITHUB_SHA`. Locally we accept the current HEAD via `git
// rev-parse HEAD` (which requires a clean checkout). Refuse to run if the
// commit cannot be proven AND the worktree is dirty — both checks must
// succeed for any live certification.

import { execSync } from "node:child_process";

let sourceCommit: string | null = process.env.GITHUB_SHA ?? null;
if (!sourceCommit) {
  try {
    sourceCommit = execSync("git rev-parse HEAD", { encoding: "utf-8" }).trim();
  } catch {
    console.error(
      "REFUSING TO RUN: could not determine source commit (no GITHUB_SHA and `git rev-parse HEAD` failed)."
    );
    process.exit(2);
  }
  // Local path also requires a clean worktree. A dirty tree means the
  // harness we run is NOT exactly the harness at HEAD — provenance breaks.
  try {
    const dirty = execSync("git status --porcelain", { encoding: "utf-8" }).trim();
    if (dirty.length > 0) {
      console.error(
        "REFUSING TO RUN: local run with dirty worktree would certify against " +
          "code that is not exactly the HEAD commit. Commit or stash first."
      );
      process.exit(2);
    }
  } catch {
    console.error("REFUSING TO RUN: `git status --porcelain` failed; cannot prove worktree cleanliness.");
    process.exit(2);
  }
}
if (!sourceCommit || sourceCommit.length === 0) {
  console.error("REFUSING TO RUN: source commit could not be determined.");
  process.exit(2);
}
// Export so the harness reads the same value via env without recomputing.
process.env.ALEPES_CERTIFY_SOURCE_COMMIT = sourceCommit;

// ── Hand off to the harness body ────────────────────────────────────────────
//
// `certify-live.ts` reads `process.env.ALEPES_CERTIFY_SOURCE_COMMIT`,
// performs credentials preflight, then runs its chain. Importing it triggers
// side effects (top-level await via `main().catch(...)`), so we await the
// import to surface failures before this wrapper exits.

await import("./certify-live");
