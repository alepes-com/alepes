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
// The certification ALWAYS binds to the independently derived `git rev-parse
// HEAD` of the working tree. An ambient `GITHUB_SHA` (e.g. exported by a
// developer from an unrelated build) MUST NOT bypass local git checks — in
// particular it must not skip the clean-worktree requirement. Under GitHub
// Actions the ambient GITHUB_SHA is still mandatory AND must match HEAD.
// See packages/temporal-workflows/src/source-provenance.ts for the contract
// and its test suite for the adversarial matrix.

import { execSync } from "node:child_process";
import { resolveSourceProvenance } from "@alepes/temporal-workflows/source-provenance";

const provenance = resolveSourceProvenance(
  {
    GITHUB_ACTIONS: process.env.GITHUB_ACTIONS,
    GITHUB_SHA: process.env.GITHUB_SHA,
  },
  {
    revParseHead: () =>
      execSync("git rev-parse HEAD", { encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"] }),
    statusPorcelain: () =>
      execSync("git status --porcelain", { encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"] }),
  }
);
if (!provenance.ok) {
  console.error(`REFUSING TO RUN: ${provenance.reason}`);
  process.exit(2);
}
const sourceCommit = provenance.sourceCommit;
// Export so the harness reads the same value via env without recomputing.
process.env.ALEPES_CERTIFY_SOURCE_COMMIT = sourceCommit;

// ── Hand off to the harness body ────────────────────────────────────────────
//
// `certify-live.ts` reads `process.env.ALEPES_CERTIFY_SOURCE_COMMIT`,
// performs credentials preflight, then runs its chain. Importing it triggers
// side effects (top-level await via `main().catch(...)`), so we await the
// import to surface failures before this wrapper exits.

await import("./certify-live");
