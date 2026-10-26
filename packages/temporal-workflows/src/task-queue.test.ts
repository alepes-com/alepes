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

  it("rejects identifiers outside [a-z0-9-] (fail closed, no lossy sanitize)", () => {
    // Any character outside [a-z0-9-] is REJECTED (never sanitized). The failure
    // mode is fail-closed at configuration time instead of silent collision.
    expect(() =>
      certificationTaskQueueName({ runId: "R_1.A/B", sourceCommit: "ABCDEF0.G" })
    ).toThrow(/outside \[a-z0-9-\]/);
    expect(() =>
      certificationTaskQueueName({ runId: "abc", sourceCommit: "ABCDEF0.G" })
    ).toThrow(/outside \[a-z0-9-\]/);
  });

  it("ADVERSE-4: identity rests on a SHA-256 digest over the exact tuple — boundary-ambiguous tuples NEVER collide", () => {
    // The reproduced collision — both used to map to "alepes-certification-a-b-c":
    //   { sourceCommit: "a-b", runId: "c" }
    //   { sourceCommit: "a",   runId: "b-c" }
    const q1 = certificationTaskQueueName({ runId: "c", sourceCommit: "a-b" });
    const q2 = certificationTaskQueueName({ runId: "b-c", sourceCommit: "a" });
    expect(q1).not.toBe(q2);
    // Deeper boundary sweep: every hyphen split of "a-b-c" must be distinct.
    expect(certificationTaskQueueName({ runId: "c", sourceCommit: "ab" })).not.toBe(q1);
    expect(certificationTaskQueueName({ runId: "c", sourceCommit: "ab" })).not.toBe(q2);
    expect(certificationTaskQueueName({ runId: "a-b-c", sourceCommit: "a" })).not.toBe(q1);
    expect(() => certificationTaskQueueName({ runId: "", sourceCommit: "a-b-c" })).toThrow();
  });

  it("is deterministic and digest-shaped (bounded, Temporal-safe)", () => {
    const a = certificationTaskQueueName({ runId: "abc", sourceCommit: "def" });
    const b = certificationTaskQueueName({ runId: "abc", sourceCommit: "def" });
    expect(a).toBe(b);
    expect(a).toMatch(/^alepes-certification-[0-9a-f]{16}$/);
    // Queue name stays well within Temporal's task-queue limit (255 bytes).
    expect(a.length).toBeLessThanOrEqual(64);
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

  it("refuses leading/trailing whitespace (ADVERSE-1 fail-closed)", () => {
    // Previously classify-and-connect could disagree: the classifier was
    // whitespace-tolerant, but `Connection.connect` semantics differ. Now
    // any leading or trailing whitespace (including tabs/newlines) refuses.
    for (const bad of [
      " localhost:7233",
      "localhost:7233 ",
      "\tlocalhost:7233",
      "localhost:7233\n",
      "localhost:7233\r\n",
    ]) {
      const c = preflightTemporalEndpoint(bad);
      expect(c.kind).toBe("invalid");
    }
    // Internal whitespace is also refused downstream via port parse failure
    // or non-local host; assert one representative case is not local.
    expect(preflightTemporalEndpoint("local host:7233").kind).not.toBe("local");
  });

  it("rejects every known parseInt bypass as INVALID (ADVERSE-1 strict port grammar)", () => {
    // Number.parseInt is a parser, not a grammar: it silently coerces all of
    // these to 7233. The strict port grammar must refuse each outright.
    const malformed = [
      "localhost:7233abc",
      "localhost:+7233",
      "localhost: 7233",
      "localhost:7233.5",
      "localhost:07233",
      "localhost:-7233",
      "localhost:",
      "localhost:0",
      "localhost:65536",
      "localhost:-1",
      "localhost:7_233",
      "localhost:７２３３", // fullwidth digits are NOT ASCII 0-9
      "localhost:7233\u00a0", // nbsp
    ];
    for (const bad of malformed) {
      const c = preflightTemporalEndpoint(bad);
      expect(c.kind, `expected ${JSON.stringify(bad)} to be invalid, got ${JSON.stringify(c)}`).toBe("invalid");
    }
    // Bracketed IPv6 forms are parsed through the same strict grammar.
    for (const bad of ["[::1]:07233", "[::1]:+7233", "[::1]:7233x", "[::1]:", "[::1]:65536"]) {
      expect(preflightTemporalEndpoint(bad).kind).toBe("invalid");
    }
  });

  it("canonical ports still behave: 7233 local, other canonical ports remote (not invalid)", () => {
    expect(preflightTemporalEndpoint("localhost:7233").kind).toBe("local");
    expect(preflightTemporalEndpoint("127.0.0.1:7233").kind).toBe("local");
    expect(preflightTemporalEndpoint("[::1]:7233").kind).toBe("local");
    expect(preflightTemporalEndpoint("0.0.0.0:7233").kind).toBe("local");
    // Canonical numeric non-local port: remote, not invalid.
    expect(preflightTemporalEndpoint("localhost:7234").kind).toBe("remote");
    // Canonical port boundaries are valid grammar (classified remote).
    expect(preflightTemporalEndpoint("localhost:1").kind).toBe("remote");
    expect(preflightTemporalEndpoint("localhost:65535").kind).toBe("remote");
  });

  it("classification errors never echo unsafe raw endpoint data", () => {
    // Port strings may contain attacker-crafted bytes; the invalid summary is
    // a fixed label, not the raw input.
    const c = preflightTemporalEndpoint("localhost:7233<x>abc");
    expect(c.kind).toBe("invalid");
    expect(JSON.stringify(c)).not.toContain("<x>");
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
