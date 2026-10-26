/**
 * Unit tests for the certification source-commit provenance helper.
 *
 * These tests are PURE: they inject a fake GitProbe (no real git, no file
 * system, no network). They deliberately cover the exact adversary scenario
 * "ambient GITHUB_SHA attempts to bypass the local HEAD check".
 *
 * No Plaid calls. No Temporal. No network.
 */

import { describe, it, expect } from "vitest";
import {
  resolveSourceProvenance,
  type GitProbe,
} from "./source-provenance";

const HEAD_A = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const HEAD_B = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

function gitProbe(overrides: Partial<GitProbe> = {}): GitProbe {
  return {
    revParseHead: () => HEAD_A,
    statusPorcelain: () => "",
    ...overrides,
  };
}

describe("resolveSourceProvenance", () => {
  it("accepts a clean local tree and returns the actual HEAD (case 1)", () => {
    const r = resolveSourceProvenance({}, gitProbe());
    expect(r).toEqual({ ok: true, sourceCommit: HEAD_A, mode: "local" });
  });

  it("refuses a dirty worktree even with a clean rev-parse (case 2)", () => {
    const r = resolveSourceProvenance(
      {},
      gitProbe({ statusPorcelain: () => " M packages/foo.ts\n" })
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/dirty/i);
  });

  it("ignores an ambient GITHUB_SHA locally and still binds to actual HEAD (case 3)", () => {
    // Critical adversarial case: developer has GITHUB_SHA exported from an
    // unrelated build. It must NOT bypass local git verification, and the
    // returned sourceCommit MUST be the actual HEAD, not the ambient SHA.
    const r = resolveSourceProvenance(
      { GITHUB_SHA: HEAD_B },
      gitProbe()
    );
    expect(r).toEqual({ ok: true, sourceCommit: HEAD_A, mode: "local" });
  });

  it("fails a local dirty tree even when GITHUB_SHA tries to claim a foreign commit (case 3b)", () => {
    const r = resolveSourceProvenance(
      { GITHUB_SHA: HEAD_B },
      gitProbe({ statusPorcelain: () => "?? scratch.log\n" })
    );
    expect(r.ok).toBe(false);
  });

  it("accepts a CI run when GITHUB_SHA matches the actual HEAD (case 4)", () => {
    const r = resolveSourceProvenance(
      { GITHUB_ACTIONS: "true", GITHUB_SHA: HEAD_A },
      gitProbe()
    );
    expect(r).toEqual({ ok: true, sourceCommit: HEAD_A, mode: "ci" });
  });

  it("refuses a CI run when GITHUB_SHA does NOT match HEAD (case 5)", () => {
    const r = resolveSourceProvenance(
      { GITHUB_ACTIONS: "true", GITHUB_SHA: HEAD_B },
      gitProbe()
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/GITHUB_SHA mismatch/);
  });

  it("refuses CI when GITHUB_SHA is missing entirely", () => {
    const r = resolveSourceProvenance(
      { GITHUB_ACTIONS: "true" },
      gitProbe()
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/GITHUB_SHA is empty/i);
  });

  it("refuses when `git rev-parse HEAD` fails (case 6)", () => {
    const r = resolveSourceProvenance(
      {},
      gitProbe({
        revParseHead: () => {
          throw new Error("not a git repository");
        },
      })
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/rev-parse/);
  });

  it("refuses when `git status --porcelain` fails (case 6 variant)", () => {
    const r = resolveSourceProvenance(
      {},
      gitProbe({
        statusPorcelain: () => {
          throw new Error("git failed");
        },
      })
    );
    expect(r.ok).toBe(false);
  });

  it("refuses when rev-parse returns garbage instead of a 40-hex SHA", () => {
    const r = resolveSourceProvenance(
      {},
      gitProbe({ revParseHead: () => "not-a-sha" })
    );
    expect(r.ok).toBe(false);
  });

  it("treats GITHUB_ACTIONS values other than the exact string \"true\" as local", () => {
    for (const v of ["1", "TRUE", "yes", ""]) {
      const r = resolveSourceProvenance(
        { GITHUB_ACTIONS: v, GITHUB_SHA: HEAD_B },
        gitProbe()
      );
      expect(r).toEqual({ ok: true, sourceCommit: HEAD_A, mode: "local" });
    }
  });

  it("refuses a dirty tree in CI too (clean-tree is universal)", () => {
    const r = resolveSourceProvenance(
      { GITHUB_ACTIONS: "true", GITHUB_SHA: HEAD_A },
      gitProbe({ statusPorcelain: () => " M README.md\n" })
    );
    expect(r.ok).toBe(false);
  });
});
