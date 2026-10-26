/**
 * Certification preflight — classify a Temporal endpoint without ever
 * reporting credentials or full addresses. The certification harness
 * consumes this to refuse anything other than the explicit local endpoint.
 *
 * This module NEVER initiates network I/O; it only parses and classifies.
 */

export type TemporalEndpointClassification =
  | {
      kind: "local";
      /** Safe summary for logs: protocol://host:port only, no creds. */
      summary: string;
      host: string;
      port: number;
    }
  | {
      kind: "remote";
      summary: string;
    }
  | {
      kind: "invalid";
      summary: string;
    };

const LOCAL_HOSTNAMES = new Set(["localhost", "127.0.0.1", "::1", "0.0.0.0"]);
const LOCAL_PORT = 7233;

/**
 * Strict port grammar (ADVERSE-1): Number.parseInt is a PARSER, not an
 * acceptance grammar — it silently accepts "7233abc", "+7233", " 7233",
 * "7233.5", "07233". Classification must not disagree with connection
 * semantics, so the port string is accepted ONLY if the ENTIRE string is a
 * canonical unsigned base-10 decimal in range 1..65535:
 *
 *   - at least one character, all ASCII digits 0-9;
 *   - no sign, no whitespace, no decimal point, no suffix/prefix garbage;
 *   - no leading zero ("07233" refused; "80", "65535" accepted);
 *   - value within 1..65535 ("0", "65536", "" refused).
 *
 * Only the canonical lexeme of exactly port 7233 can classify as local.
 */
function parseStrictPort(portStr: string): number | null {
  if (portStr.length === 0) return null;
  for (let i = 0; i < portStr.length; i++) {
    const ch = portStr.charCodeAt(i);
    if (ch < 48 /* "0" */ || ch > 57 /* "9" */) return null;
  }
  // No leading zeroes (except the single digit "0", which then fails range).
  if (portStr.length > 1 && portStr.charCodeAt(0) === 48) return null;
  const value = Number(portStr);
  if (!Number.isSafeInteger(value) || value < 1 || value > 65535) return null;
  return value;
}

/**
 * Classify a Temporal endpoint address string WITHOUT ever contacting it.
 *
 * Accepted forms (the only ones considered "local"):
 *   - "localhost:7233"
 *   - "127.0.0.1:7233"
 *   - "[::1]:7233"
 *   - "0.0.0.0:7233" (bind-all local)
 *
 * Anything else — remote hostname, different port scheme, missing port,
 * URL with embedded credentials — is classified non-local and the caller
 * must fail-closed.
 */
export function preflightTemporalEndpoint(raw: string): TemporalEndpointClassification {
  const original = String(raw ?? "");
  // Reject any leading/trailing whitespace outright. The classifier must not
  // silently accept a form Connection.connect would later reject — accepting
  // " localhost:7233" or "localhost:7233 \n" would reintroduce ADVERSE-1, in
  // which classify-and-connect disagree and the certified behaviour diverges
  // from the adjudicated intent. Whitespace input is ambiguous; refuse it.
  if (original.length === 0 || original !== original.trim()) {
    return {
      kind: "invalid",
      summary:
        original.length === 0 ? "empty address" : "leading or trailing whitespace not allowed",
    };
  }
  const trimmed = original;

  // Reject URLs — ALEPES_TEMPORAL_ADDRESS is a host:port pair, not a URL.
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed)) {
    return { kind: "invalid", summary: "URL form (scheme://...) is not accepted" };
  }

  // Parse [host]:port
  let host: string;
  let portStr: string;
  if (trimmed.startsWith("[")) {
    // IPv6 bracket form: [::1]:7233
    const m = trimmed.match(/^\[([^\]]+)\]:(.*)$/);
    if (!m) return { kind: "invalid", summary: "malformed IPv6 host:port" };
    host = m[1]!;
    portStr = m[2]!;
  } else {
    const idx = trimmed.lastIndexOf(":");
    if (idx < 0) return { kind: "invalid", summary: "missing port" };
    host = trimmed.slice(0, idx);
    portStr = trimmed.slice(idx + 1);
    if (host.includes(":")) {
      return { kind: "invalid", summary: "IPv6 must use bracketed form ([addr]:port)" };
    }
  }

  const port = parseStrictPort(portStr);
  if (port === null) {
    return { kind: "invalid", summary: "invalid port" };
  }

  // Local classification requires BOTH the host to be loopback AND the port
  // to be the standard Temporal dev-server port. Any deviation falls into
  // "remote" which the certification harness will refuse.
  const isLocalHost = LOCAL_HOSTNAMES.has(host.toLowerCase());
  const isLocalPort = port === LOCAL_PORT;

  if (isLocalHost && isLocalPort) {
    return {
      kind: "local",
      host,
      port,
      summary: `${host}:${port}`,
    };
  }

  return {
    kind: "remote",
    summary: `${host}:${port}`,
  };
}
