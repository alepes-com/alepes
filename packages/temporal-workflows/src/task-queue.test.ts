/**
 * Unit tests for the certification task-queue helper and the Temporal
 * endpoint preflight classifier. These run under any Node (or Bun) test
 * runner — no Temporal test server, no Postgres, no network.
 */

import { describe, it, expect } from "vitest";
import {
  DEFAULT_TASK_QUEUE,
  CERTIFICATION_TASK_QUEUE_PREFIX,
  certificationTaskQueueName,
} from "./task-queue";
import { preflightTemporalEndpoint } from "./certification-preflight";

describe("certificationTaskQueueName", () => {
  it("produces a queue distinct from the default shared queue", () => {
    const q = certificationTaskQueueName({ runId: "abc", sourceCommit: "deadbee" });
    expect(q).not.toBe(DEFAULT_TASK_QUEUE);
    expect(q.startsWith(CERTIFICATION_TASK_QUEUE_PREFIX)).toBe(true);
  });

  it("is deterministic for the same input", () => {
    const a = certificationTaskQueueName({ runId: "r1", sourceCommit: "abc" });
    const b = certificationTaskQueueName({ runId: "r1", sourceCommit: "abc" });
    expect(a).toBe(b);
  });

  it("incorporates BOTH runId and sourceCommit (commit change ⇒ queue change)", () => {
    const a = certificationTaskQueueName({ runId: "r1", sourceCommit: "abc" });
    const b = certificationTaskQueueName({ runId: "r1", sourceCommit: "def" });
    const c = certificationTaskQueueName({ runId: "r2", sourceCommit: "abc" });
    expect(a).not.toBe(b);
    expect(a).not.toBe(c);
  });

  it("sanitizes special characters (no dots, slashes, uppercase)", () => {
    const q = certificationTaskQueueName({ runId: "R_1.A/B", sourceCommit: "ABCDEF0.G" });
    expect(q).toMatch(/^[a-z0-9-]+$/);
  });

  it("throws on empty runId", () => {
    expect(() => certificationTaskQueueName({ runId: "", sourceCommit: "abc" })).toThrow();
  });

  it("throws on empty sourceCommit", () => {
    expect(() => certificationTaskQueueName({ runId: "r1", sourceCommit: "" })).toThrow();
  });
});

describe("preflightTemporalEndpoint", () => {
  it("accepts the sanctioned local dev server", () => {
    for (const addr of ["localhost:7233", "127.0.0.1:7233", "[::1]:7233"]) {
      const c = preflightTemporalEndpoint(addr);
      expect(c.kind).toBe("local");
    }
  });

  it("refuses remote addresses", () => {
    const remote = preflightTemporalEndpoint("temporal.example.com:7233");
    expect(remote.kind).toBe("remote");
  });

  it("refuses localhost with a non-default port (paranoia)", () => {
    const c = preflightTemporalEndpoint("localhost:17333");
    expect(c.kind).toBe("remote");
  });

  it("refuses URL-form input (no scheme allowed)", () => {
    const c = preflightTemporalEndpoint("http://localhost:7233");
    expect(c.kind).toBe("invalid");
  });

  it("refuses empty/malformed input", () => {
    expect(preflightTemporalEndpoint("").kind).toBe("invalid");
    expect(preflightTemporalEndpoint("localhost").kind).toBe("invalid");
    expect(preflightTemporalEndpoint("localhost:notaport").kind).toBe("invalid");
  });

  it("never echoes credentials in any classification", () => {
    const c = preflightTemporalEndpoint("user:pass@localhost:7233");
    // This must classify as invalid (not local) — and crucially the summary
    // must not contain the password bytes.
    if (c.kind === "local") {
      throw new Error("credential-laden address must not classify as local");
    }
    expect(JSON.stringify(c)).not.toContain("pass");
  });
});
