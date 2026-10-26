// @alepes/observability — Adversarial sentinel tests for trace attribute sanitization
// Proves: sentinel secrets never appear in trace attributes; frozen contract enforced.

import { describe, it, expect, beforeEach } from "vitest";
import {
  TRACE_ATTRIBUTE_KEYS,
  TraceAttributeKey,
  TraceAttributes,
  buildTraceAttributes,
  fingerprintForTrace,
  NoopTracer,
  RecordingTracer,
  getTracer,
  setTracer,
  traceAttributesFromAuditEvent,
} from "./index";

// ─── Sentinel constants (plant these, assert they never leak) ────────────────

const SENTINEL_ACCESS_TOKEN = "access-sandbox-SENTINEL_PLAID_TOKEN_12345";
const SENTINEL_ITEM_ID = "item-SENTINEL_ITEM_ID_67890";
const SENTINEL_ACCOUNT_ID = "acct-SENTINEL_ACCOUNT_ID_abcde";
const SENTINEL_DB_URL = "postgresql://user:SENTINEL_PASSWORD@localhost:5432/db";
const SENTINEL_REQUEST_ID = "req-SENTINEL_REQUEST_ID_xyz";
const SENTINEL_HEADER_AUTH = "Bearer SENTINEL_BEARER_TOKEN";

describe("@alepes/observability — Trace attribute sanitization", () => {
  describe("frozen contract: TRACE_ATTRIBUTE_KEYS", () => {
    it("contains exactly the 11 specified keys in correct order", () => {
      expect(TRACE_ATTRIBUTE_KEYS).toEqual([
        "alepes.run_id",
        "alepes.correlation_id",
        "alepes.provider",
        "alepes.environment",
        "alepes.phase",
        "alepes.operation",
        "alepes.failure_code",
        "alepes.attempt",
        "alepes.mutated",
        "alepes.verified",
        "alepes.disposition",
      ]);
    });

    it("has no extra keys and no duplicates", () => {
      const unique = new Set(TRACE_ATTRIBUTE_KEYS);
      expect(unique.size).toBe(TRACE_ATTRIBUTE_KEYS.length);
    });
  });

  describe("fingerprintForTrace", () => {
    it("produces deterministic fingerprint, never echoes raw value", () => {
      const fp1 = fingerprintForTrace(SENTINEL_ACCESS_TOKEN);
      const fp2 = fingerprintForTrace(SENTINEL_ACCESS_TOKEN);
      expect(fp1).toBe(fp2);
      expect(fp1).not.toContain("SENTINEL");
      expect(fp1).toMatch(/^fp-[0-9a-f]+-len\d+$/);
    });

    it("produces different fingerprints for different inputs", () => {
      expect(fingerprintForTrace(SENTINEL_ACCESS_TOKEN)).not.toBe(
        fingerprintForTrace(SENTINEL_ITEM_ID)
      );
    });

    it("handles empty string", () => {
      const fp = fingerprintForTrace("");
      expect(fp).toMatch(/^fp-[0-9a-f]+-len0$/);
    });
  });

  describe("buildTraceAttributes — allowlist sanitization", () => {
    it("accepts valid trace attributes", () => {
      const input = {
        "alepes.run_id": "01ARZ3NDEKTSV4RRFFQ69G5FAV",
        "alepes.correlation_id": "01ARZ3NDEKTSV4RRFFQ69G5FAW",
        "alepes.provider": "plaid",
        "alepes.environment": "production",
        "alepes.phase": "provider",
        "alepes.operation": "PROVIDER_REQUEST_STARTED",
        "alepes.failure_code": "provider.authentication_failed",
        "alepes.attempt": 1,
        "alepes.mutated": false,
        "alepes.verified": true,
        "alepes.disposition": "shadow",
      };
      const attrs = buildTraceAttributes(input);
      expect(attrs["alepes.run_id"]).toBe(input["alepes.run_id"]);
      expect(attrs["alepes.correlation_id"]).toBe(input["alepes.correlation_id"]);
      expect(attrs["alepes.provider"]).toBe("plaid");
      expect(attrs["alepes.failure_code"]).toBe("provider.authentication_failed");
      expect(attrs["alepes.attempt"]).toBe(1);
      expect(attrs["alepes.mutated"]).toBe(false);
      expect(attrs["alepes.verified"]).toBe(true);
      expect(attrs["alepes.disposition"]).toBe("shadow");
    });

    it("drops unknown keys (allowlist enforcement)", () => {
      const input = {
        "alepes.run_id": "run-1",
        "alepes.correlation_id": "corr-1",
        "alepes.provider": "plaid",
        "alepes.environment": "production",
        "alepes.phase": "provider",
        "alepes.operation": "TEST",
        // These should be dropped:
        "alepes.secret": SENTINEL_ACCESS_TOKEN,
        "alepes.raw_token": SENTINEL_ACCESS_TOKEN,
        "alepes.database_url": SENTINEL_DB_URL,
        "alepes.custom_field": "should not appear",
      };
      const attrs = buildTraceAttributes(input);
      expect(Object.keys(attrs)).toEqual(TRACE_ATTRIBUTE_KEYS);
      expect(attrs).not.toHaveProperty("alepes.secret");
      expect(attrs).not.toHaveProperty("alepes.raw_token");
      expect(attrs).not.toHaveProperty("alepes.database_url");
      expect(attrs).not.toHaveProperty("alepes.custom_field");
    });

    it("rejects non-primitive values (objects/arrays)", () => {
      const input = {
        "alepes.run_id": "run-1",
        "alepes.correlation_id": "corr-1",
        "alepes.provider": "plaid",
        "alepes.environment": "production",
        "alepes.phase": "provider",
        "alepes.operation": "TEST",
        "alepes.complex_obj": { nested: SENTINEL_ACCESS_TOKEN },
        "alepes.array_vals": [SENTINEL_ITEM_ID, SENTINEL_ACCOUNT_ID],
      };
      const attrs = buildTraceAttributes(input);
      expect(attrs).not.toHaveProperty("alepes.complex_obj");
      expect(attrs).not.toHaveProperty("alepes.array_vals");
    });

    it("throws when required run_id or correlation_id missing", () => {
      expect(() =>
        buildTraceAttributes({
          "alepes.correlation_id": "corr-1",
          "alepes.provider": "plaid",
          "alepes.environment": "production",
          "alepes.phase": "provider",
          "alepes.operation": "TEST",
        })
      ).toThrow("TraceAttributes requires run_id and correlation_id");

      expect(() =>
        buildTraceAttributes({
          "alepes.run_id": "run-1",
          "alepes.provider": "plaid",
          "alepes.environment": "production",
          "alepes.phase": "provider",
          "alepes.operation": "TEST",
        })
      ).toThrow("TraceAttributes requires run_id and correlation_id");
    });

    it("handles optional attributes being undefined", () => {
      const input = {
        "alepes.run_id": "run-1",
        "alepes.correlation_id": "corr-1",
        "alepes.provider": "plaid",
        "alepes.environment": "production",
        "alepes.phase": "provider",
        "alepes.operation": "TEST",
        "alepes.failure_code": undefined,
        "alepes.attempt": undefined,
        "alepes.mutated": undefined,
        "alepes.verified": undefined,
        "alepes.disposition": undefined,
      };
      const attrs = buildTraceAttributes(input);
      expect(attrs["alepes.run_id"]).toBe("run-1");
      expect(attrs["alepes.correlation_id"]).toBe("corr-1");
      expect(attrs["alepes.failure_code"]).toBeUndefined();
      expect(attrs["alepes.attempt"]).toBeUndefined();
    });
  });

  describe("sentinel secrets never leak into trace attributes", () => {
    it("sentinel access token in raw form is dropped", () => {
      const attrs = buildTraceAttributes({
        "alepes.run_id": "run-1",
        "alepes.correlation_id": "corr-1",
        "alepes.provider": "plaid",
        "alepes.environment": "production",
        "alepes.phase": "provider",
        "alepes.operation": "PROVIDER_REQUEST_FAILED",
        "alepes.failure_code": "provider.authentication_failed",
        "alepes.attempt": 1,
        "alepes.mutated": false,
        "alepes.verified": false,
        "alepes.disposition": "shadow",
        "alepes.raw_access_token": SENTINEL_ACCESS_TOKEN,
        "authorization": `Bearer ${SENTINEL_HEADER_AUTH}`,
      });
      const serialized = JSON.stringify(attrs);
      expect(serialized).not.toContain("SENTINEL");
      expect(serialized).not.toContain("access-sandbox");
      expect(serialized).not.toContain("Bearer");
    });

    it("sentinel item/account IDs are dropped", () => {
      const attrs = buildTraceAttributes({
        "alepes.run_id": "run-1",
        "alepes.correlation_id": "corr-1",
        "alepes.provider": "plaid",
        "alepes.environment": "production",
        "alepes.phase": "provider",
        "alepes.operation": "PROVIDER_REQUEST_STARTED",
        "alepes.failure_code": undefined,
        "alepes.attempt": 1,
        "alepes.mutated": false,
        "alepes.verified": false,
        "alepes.disposition": "shadow",
        "alepes.item_id": SENTINEL_ITEM_ID,
        "alepes.account_id": SENTINEL_ACCOUNT_ID,
      });
      const serialized = JSON.stringify(attrs);
      expect(serialized).not.toContain("SENTINEL");
    });

    it("sentinel DB URL with password is dropped", () => {
      const attrs = buildTraceAttributes({
        "alepes.run_id": "run-1",
        "alepes.correlation_id": "corr-1",
        "alepes.provider": "plaid",
        "alepes.environment": "production",
        "alepes.phase": "provider",
        "alepes.operation": "PROVIDER_REQUEST_STARTED",
        "alepes.failure_code": undefined,
        "alepes.attempt": 1,
        "alepes.mutated": false,
        "alepes.verified": false,
        "alepes.disposition": "shadow",
        "alepes.database_url": SENTINEL_DB_URL,
      });
      const serialized = JSON.stringify(attrs);
      expect(serialized).not.toContain("SENTINEL");
      expect(serialized).not.toContain("SENTINEL_PASSWORD");
    });

    it("sentinel request ID is dropped", () => {
      const attrs = buildTraceAttributes({
        "alepes.run_id": "run-1",
        "alepes.correlation_id": "corr-1",
        "alepes.provider": "plaid",
        "alepes.environment": "production",
        "alepes.phase": "provider",
        "alepes.operation": "PROVIDER_REQUEST_SUCCEEDED",
        "alepes.failure_code": undefined,
        "alepes.attempt": 1,
        "alepes.mutated": false,
        "alepes.verified": true,
        "alepes.disposition": "shadow",
        "alepes.request_id": SENTINEL_REQUEST_ID,
        "alepes.plaid_request_id": SENTINEL_REQUEST_ID,
      });
      const serialized = JSON.stringify(attrs);
      expect(serialized).not.toContain("SENTINEL");
    });
  });

  describe("NoopTracer", () => {
    it("is a no-op and never throws", () => {
      const tracer = NoopTracer;
      const span = tracer.startSpan("test-operation");
      expect(() => span.setAttributes({ "alepes.run_id": "run-1", "alepes.correlation_id": "corr-1" })).not.toThrow();
      expect(() => span.end("ok")).not.toThrow();
      expect(() => span.end("error")).not.toThrow();
    });
  });

  describe("RecordingTracer", () => {
    let tracer: RecordingTracer;

    beforeEach(() => {
      tracer = new RecordingTracer();
    });

    it("records span attributes and status", () => {
      const span = tracer.startSpan("test-operation");
      span.setAttributes({
        "alepes.run_id": "run-1",
        "alepes.correlation_id": "corr-1",
        "alepes.provider": "plaid",
        "alepes.environment": "production",
        "alepes.phase": "provider",
        "alepes.operation": "PROVIDER_REQUEST_STARTED",
      });
      span.end("ok");

      expect(tracer.spans).toHaveLength(1);
      expect(tracer.spans[0].operation).toBe("test-operation");
      expect(tracer.spans[0].status).toBe("ok");
      expect(tracer.spans[0].attributes["alepes.run_id"]).toBe("run-1");
      expect(tracer.spans[0].attributes["alepes.provider"]).toBe("plaid");
    });

    it("rejects unknown keys at runtime (sanitization on setAttributes)", () => {
      const span = tracer.startSpan("test-operation");
      span.setAttributes({
        "alepes.run_id": "run-1",
        "alepes.correlation_id": "corr-1",
        "alepes.provider": "plaid",
        "alepes.environment": "production",
        "alepes.phase": "provider",
        "alepes.operation": "TEST",
        "alepes.secret": SENTINEL_ACCESS_TOKEN,
      } as unknown as Partial<TraceAttributes>);
      span.end("ok");

      const attrs = tracer.spans[0].attributes;
      expect(attrs).not.toHaveProperty("alepes.secret");
      expect(JSON.stringify(attrs)).not.toContain("SENTINEL");
    });

    it("clear() resets for test isolation", () => {
      const span = tracer.startSpan("test");
      span.setAttributes({ "alepes.run_id": "run-1", "alepes.correlation_id": "corr-1" });
      span.end("ok");
      expect(tracer.spans.length).toBe(1);
      tracer.clear();
      expect(tracer.spans.length).toBe(0);
    });
  });

  describe("global tracer management", () => {
    it("getTracer returns NoopTracer by default", () => {
      // Reset to default
      setTracer(NoopTracer);
      const tracer = getTracer();
      expect(tracer).toBe(NoopTracer);
    });

    it("setTracer replaces global tracer", () => {
      const custom = new RecordingTracer();
      setTracer(custom);
      expect(getTracer()).toBe(custom);
      // Restore
      setTracer(NoopTracer);
    });
  });

  describe("traceAttributesFromAuditEvent — audit → telemetry correlation", () => {
    const baseAttrs = {
      "alepes.run_id": "01ARZ3NDEKTSV4RRFFQ69G5FAV",
      "alepes.correlation_id": "01ARZ3NDEKTSV4RRFFQ69G5FAW",
      "alepes.provider": "plaid",
      "alepes.environment": "production",
    };

    it("maps basic event fields to trace attributes", () => {
      // Create a minimal audit event-like object
      const event = {
        phase: "provider",
        type: "PROVIDER_REQUEST_STARTED",
        attempt: 1,
        mutated: false,
        verified: false,
        payload: {},
      } as any;

      const attrs = traceAttributesFromAuditEvent(event, baseAttrs);
      expect(attrs["alepes.run_id"]).toBe(baseAttrs["alepes.run_id"]);
      expect(attrs["alepes.correlation_id"]).toBe(baseAttrs["alepes.correlation_id"]);
      expect(attrs["alepes.provider"]).toBe("plaid");
      expect(attrs["alepes.environment"]).toBe("production");
      expect(attrs["alepes.phase"]).toBe("provider");
      expect(attrs["alepes.operation"]).toBe("PROVIDER_REQUEST_STARTED");
      expect(attrs["alepes.attempt"]).toBe(1);
      expect(attrs["alepes.mutated"]).toBe(false);
      expect(attrs["alepes.verified"]).toBe(false);
    });

    it("extracts failure_code from PROVIDER_REQUEST_FAILED", () => {
      const event = {
        phase: "provider",
        type: "PROVIDER_REQUEST_FAILED",
        attempt: 2,
        mutated: false,
        verified: false,
        payload: { failureCode: "provider.authentication_failed" },
      } as any;

      const attrs = traceAttributesFromAuditEvent(event, baseAttrs);
      expect(attrs["alepes.failure_code"]).toBe("provider.authentication_failed");
    });

    it("extracts failure_code from CERT_GATE_FAILED", () => {
      const event = {
        phase: "reporting",
        type: "CERT_GATE_FAILED",
        attempt: undefined,
        mutated: false,
        verified: false,
        payload: { failureCode: "sync.no_qualifying_event" },
      } as any;

      const attrs = traceAttributesFromAuditEvent(event, baseAttrs);
      expect(attrs["alepes.failure_code"]).toBe("sync.no_qualifying_event");
    });

    it("does not extract failure_code from unrelated events", () => {
      const event = {
        phase: "observation",
        type: "OBSERVATION_RECEIVED",
        attempt: undefined,
        mutated: false,
        verified: false,
        payload: {},
      } as any;

      const attrs = traceAttributesFromAuditEvent(event, baseAttrs);
      expect(attrs["alepes.failure_code"]).toBeUndefined();
    });

    it("extracts disposition from EXECUTION_POLICY_EVALUATED", () => {
      const event = {
        phase: "execution",
        type: "EXECUTION_POLICY_EVALUATED",
        attempt: undefined,
        mutated: false,
        verified: false,
        payload: { disposition: "shadow" },
      } as any;

      const attrs = traceAttributesFromAuditEvent(event, baseAttrs);
      expect(attrs["alepes.disposition"]).toBe("shadow");
    });

    it("does not extract disposition from unrelated events", () => {
      const event = {
        phase: "policy",
        type: "CAPITAL_PLAN_CREATED",
        attempt: undefined,
        mutated: false,
        verified: false,
        payload: {},
      } as any;

      const attrs = traceAttributesFromAuditEvent(event, baseAttrs);
      expect(attrs["alepes.disposition"]).toBeUndefined();
    });

    it("run_id and correlation_id are shared with audit event", () => {
      const event = {
        phase: "provider",
        type: "PROVIDER_REQUEST_STARTED",
        attempt: 1,
        mutated: false,
        verified: false,
        payload: {},
      } as any;

      const attrs = traceAttributesFromAuditEvent(event, baseAttrs);
      expect(attrs["alepes.run_id"]).toBe(baseAttrs["alepes.run_id"]);
      expect(attrs["alepes.correlation_id"]).toBe(baseAttrs["alepes.correlation_id"]);
    });

    it("trace attributes never contain raw Plaid identifiers even if event has them", () => {
      const event = {
        phase: "provider",
        type: "PROVIDER_REQUEST_STARTED",
        attempt: 1,
        mutated: false,
        verified: false,
        payload: {
          plaid_access_token: SENTINEL_ACCESS_TOKEN,
          plaid_item_id: SENTINEL_ITEM_ID,
          plaid_request_id: SENTINEL_REQUEST_ID,
        },
      } as any;

      const attrs = traceAttributesFromAuditEvent(event, baseAttrs);
      const serialized = JSON.stringify(attrs);
      expect(serialized).not.toContain("SENTINEL");
      expect(serialized).not.toContain("access-sandbox");
      expect(serialized).not.toContain("item-");
      expect(serialized).not.toContain("req-");
    });
  });
});