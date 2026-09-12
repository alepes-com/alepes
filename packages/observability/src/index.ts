// @alepes/observability — Diagnostic operational tracing for certification runs
// Telemetry is NOT authoritative over the durable audit ledger (AGENTS.md §15).
// It provides correlation for reconstruction; it never carries secrets or raw sensitive identifiers.
//
// This module is dependency-free. A real OTel SDK can be adapted behind the Tracer interface later.

import type { AuditEvent } from "@alepes/audit";

// ─── Frozen trace attribute contract (allowlist only) ────────────────────────

/** Frozen attribute keys — telemetry MUST NOT emit any key outside this set. */
export const TRACE_ATTRIBUTE_KEYS = [
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
] as const;

/** Type-safe union of allowed trace attribute keys. */
export type TraceAttributeKey = (typeof TRACE_ATTRIBUTE_KEYS)[number];

/** Value types allowed in trace attributes — no objects, no arrays, no raw identifiers. */
export type TraceAttributeValue = string | number | boolean;

/** A complete, sanitized set of trace attributes for a single span. */
export interface TraceAttributes {
  readonly "alepes.run_id": string;
  readonly "alepes.correlation_id": string;
  readonly "alepes.provider": string;
  readonly "alepes.environment": string;
  readonly "alepes.phase": string;
  readonly "alepes.operation": string;
  readonly "alepes.failure_code": string | undefined;
  readonly "alepes.attempt": number | undefined;
  readonly "alepes.mutated": boolean | undefined;
  readonly "alepes.verified": boolean | undefined;
  readonly "alepes.disposition": string | undefined;
}

/** Coerce unknown to string for trace attribute — returns empty string if not a string.
 *  SAFETY: Input is validated by the caller's allowlist gate; this is a deterministic coercion. */
function strForTrace(v: unknown): string {
  // Boundary parse: coerce to string primitive at I/O boundary
  return typeof v === "string" ? v : "";
}

/** Build a TraceAttributes object from a plain record, enforcing the frozen contract.
 *  Unknown keys are dropped (allowlist sanitization). Raw identifiers are never accepted —
 *  callers must fingerprint them before calling. */
export function buildTraceAttributes(
  attrs: Readonly<Record<string, unknown>>
): TraceAttributes {
  // Boundary parse: read only allowlisted keys, coerce primitives
  const out: TraceAttributes = {
    "alepes.run_id": strForTrace(attrs["alepes.run_id"]),
    "alepes.correlation_id": strForTrace(attrs["alepes.correlation_id"]),
    "alepes.provider": strForTrace(attrs["alepes.provider"]),
    "alepes.environment": strForTrace(attrs["alepes.environment"]),
    "alepes.phase": strForTrace(attrs["alepes.phase"]),
    "alepes.operation": strForTrace(attrs["alepes.operation"]),
    "alepes.failure_code": typeof attrs["alepes.failure_code"] === "string"
      ? (attrs["alepes.failure_code"] as string) // SAFETY: typeof guard above
      : undefined,
    "alepes.attempt": typeof attrs["alepes.attempt"] === "number"
      ? (attrs["alepes.attempt"] as number) // SAFETY: typeof guard above
      : undefined,
    "alepes.mutated": typeof attrs["alepes.mutated"] === "boolean"
      ? (attrs["alepes.mutated"] as boolean) // SAFETY: typeof guard above
      : undefined,
    "alepes.verified": typeof attrs["alepes.verified"] === "boolean"
      ? (attrs["alepes.verified"] as boolean) // SAFETY: typeof guard above
      : undefined,
    "alepes.disposition": typeof attrs["alepes.disposition"] === "string"
      ? (attrs["alepes.disposition"] as string) // SAFETY: typeof guard above
      : undefined,
  };
  if (!out["alepes.run_id"] || !out["alepes.correlation_id"]) {
    throw new Error("TraceAttributes requires run_id and correlation_id");
  }
  return out;
}

// ─── Fingerprinting for sensitive identifiers ────────────────────────────────

/** Deterministic fingerprint — never echoes a raw token/id into telemetry. */
export function fingerprintForTrace(value: string): string {
  let h = 0;
  for (let i = 0; i < value.length; i++) h = (h * 31 + value.charCodeAt(i)) | 0;
  return `fp-${(h >>> 0).toString(16)}-len${value.length}`;
}

// ─── Minimal Tracer interface (pluggable; no OTel SDK dependency) ───────────

/** A minimal span interface. Implementations may be no-op, in-memory, or OTel-backed. */
export interface Span {
  /** Set allowlisted attributes on this span. */
  setAttributes(attrs: Partial<TraceAttributes>): void;
  /** End the span with optional status. */
  end(status?: "ok" | "error"): void;
}

/** Tracer factory — implementations must be dependency-free and synchronous. */
export interface Tracer {
  /** Start a new span for the given operation. */
  startSpan(operation: string): Span;
}

/** No-op tracer — used when telemetry is disabled or not configured. */
export const NoopTracer: Tracer = {
  startSpan(_operation: string): Span {
    return {
      setAttributes(_attrs: Partial<TraceAttributes>): void {},
      end(_status?: "ok" | "error"): void {},
    };
  },
};

/** In-memory recording tracer for tests — captures spans for assertions. */
export class RecordingTracer implements Tracer {
  public readonly spans: Array<{
    operation: string;
    attributes: Record<string, TraceAttributeValue>;
    status: "ok" | "error" | undefined;
  }> = [];

  startSpan(operation: string): Span {
    const attrs: Record<string, TraceAttributeValue> = {};
    let status: "ok" | "error" | undefined;
    const spans = this.spans; // capture for closure
    return {
      setAttributes(newAttrs: Partial<TraceAttributes>): void {
        // Runtime allowlist sanitization — matches buildTraceAttributes contract
        for (const key of TRACE_ATTRIBUTE_KEYS) {
          const value = (newAttrs as Record<string, unknown>)[key];
          if (value !== undefined) {
            if (
              typeof value === "string" ||
              typeof value === "number" ||
              typeof value === "boolean"
            ) {
              attrs[key] = value as TraceAttributeValue;
            }
          }
        }
      },
      end(s?: "ok" | "error"): void {
        status = s;
        spans.push({ operation, attributes: attrs, status });
      },
    };
  }

  /** Reset for test isolation. */
  clear(): void {
    this.spans.length = 0;
  }
}

/** Global tracer holder — default no-op. Applications may replace with a real tracer. */
let _tracer: Tracer = NoopTracer;

/** Get the current tracer (no-op by default). */
export function getTracer(): Tracer {
  return _tracer;
}

/** Replace the global tracer (typically at application startup or test setup). */
export function setTracer(tracer: Tracer): void {
  _tracer = tracer;
}

// ─── AuditEvent → TraceAttributes adapter ────────────────────────────────────

/** Extract trace attributes from an AuditEvent for correlation.
 *  This is the single point where audit events feed telemetry — telemetry is derived, not authoritative. */
export function traceAttributesFromAuditEvent(
  event: AuditEvent,
  baseAttrs: Pick<TraceAttributes, "alepes.run_id" | "alepes.correlation_id" | "alepes.provider" | "alepes.environment">
): Partial<TraceAttributes> {
  return {
    "alepes.run_id": baseAttrs["alepes.run_id"],
    "alepes.correlation_id": baseAttrs["alepes.correlation_id"],
    "alepes.provider": baseAttrs["alepes.provider"],
    "alepes.environment": baseAttrs["alepes.environment"],
    "alepes.phase": event.phase,
    "alepes.operation": event.type,
    "alepes.failure_code": event.type === "PROVIDER_REQUEST_FAILED" || event.type === "CERT_GATE_FAILED"
      ? (event.payload as { failureCode?: string }).failureCode // SAFETY: payload shape per AuditEvent type
      : undefined,
    "alepes.attempt": event.attempt,
    "alepes.mutated": event.mutated,
    "alepes.verified": event.verified,
    "alepes.disposition": event.type === "EXECUTION_POLICY_EVALUATED"
      ? (event.payload as { disposition?: string }).disposition // SAFETY: payload shape per AuditEvent type
      : undefined,
  };
}