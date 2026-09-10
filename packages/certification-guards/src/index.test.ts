import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  assertLiveCertPrerequisites,
  fingerprint,
  createRedactor,
  assertShadowOnly,
} from "./index";

const PLIST = {
  requiredEnvValue: "production",
  envVarName: "PLAID_ENV",
  requiredSecrets: ["PLAID_CLIENT_ID", "PLAID_SECRET", "PLAID_LIVE_POSTGRES_URL"],
  requiredEnvVars: [],
  providerName: "Plaid",
};

describe("assertLiveCertPrerequisites", () => {
  const savedEnv = { ...process.env };

  beforeEach(() => {
    process.env = { ...savedEnv };
  });
  afterEach(() => {
    process.env = savedEnv;
  });

  it("passes when environment, secrets, and env vars are all present", () => {
    process.env.PLAID_ENV = "production";
    process.env.PLAID_CLIENT_ID = "cid";
    process.env.PLAID_SECRET = "s";
    process.env.PLAID_LIVE_POSTGRES_URL = "postgres://x";
    expect(() => assertLiveCertPrerequisites(PLIST)).not.toThrow();
  });

  it("fails closed on wrong environment value", () => {
    process.env.PLAID_ENV = "sandbox";
    process.env.PLAID_CLIENT_ID = "cid";
    process.env.PLAID_SECRET = "s";
    process.env.PLAID_LIVE_POSTGRES_URL = "postgres://x";
    expect(() => assertLiveCertPrerequisites(PLIST)).toThrow(/must be exactly "production"/);
  });

  it("fails closed on missing environment value", () => {
    delete process.env.PLAID_ENV;
    expect(() => assertLiveCertPrerequisites(PLIST)).toThrow(/must be exactly "production"/);
  });

  it("fails closed on missing secret", () => {
    process.env.PLAID_ENV = "production";
    process.env.PLAID_CLIENT_ID = "cid";
    process.env.PLAID_SECRET = "s";
    // PLAID_LIVE_POSTGRES_URL missing
    expect(() => assertLiveCertPrerequisites(PLIST)).toThrow(/PLAID_LIVE_POSTGRES_URL/);
  });

  it("fails closed on missing non-secret env var", () => {
    process.env.PLAID_ENV = "production";
    process.env.PLAID_CLIENT_ID = "cid";
    process.env.PLAID_SECRET = "s";
    process.env.PLAID_LIVE_POSTGRES_URL = "postgres://x";
    expect(() =>
      assertLiveCertPrerequisites({ ...PLIST, requiredEnvVars: ["PLAID_ENV"] })
    ).not.toThrow(); // PLAID_ENV is present
    expect(() =>
      assertLiveCertPrerequisites({ ...PLIST, requiredEnvVars: ["SOME_OTHER_VAR"] })
    ).toThrow(/SOME_OTHER_VAR/);
  });
});

describe("fingerprint", () => {
  it("is deterministic", () => {
    expect(fingerprint("abc")).toBe(fingerprint("abc"));
  });
  it("never returns the raw value", () => {
    expect(fingerprint("secret-token")).not.toContain("secret-token");
  });
  it("distinguishes different values", () => {
    expect(fingerprint("a")).not.toBe(fingerprint("b"));
  });
});

describe("createRedactor", () => {
  it("replaces registered secrets", () => {
    const redact = createRedactor(["my-secret"]);
    expect(redact("call my-secret now")).not.toContain("my-secret");
  });
  it("leaves non-string values alone", () => {
    const redact = createRedactor(["x"]);
    expect(redact(123)).toBe(123);
    expect(redact(null)).toBe(null);
  });
  it("is idempotent on already-redacted output", () => {
    const redact = createRedactor(["my-secret"]);
    const once = redact("my-secret") as string;
    expect(redact(once)).toBe(once);
  });
  it("skips empty secrets", () => {
    const redact = createRedactor(["", "real"]);
    expect(redact("real")).not.toContain("real");
  });
});

describe("assertShadowOnly", () => {
  it("passes on a clean shadow run", () => {
    expect(() =>
      assertShadowOnly({
        shadowCount: 1,
        executeCount: 0,
        transferCount: 0,
        orderCount: 0,
        providerMutationCount: 0,
        disposition: "shadow",
      })
    ).not.toThrow();
  });

  it("fails when disposition is not shadow", () => {
    expect(() =>
      assertShadowOnly({
        shadowCount: 1,
        executeCount: 0,
        transferCount: 0,
        orderCount: 0,
        providerMutationCount: 0,
        disposition: "approval",
      })
    ).toThrow(/expected "shadow"/);
  });

  it("fails when shadowCount is not positive", () => {
    expect(() =>
      assertShadowOnly({
        shadowCount: 0,
        executeCount: 0,
        transferCount: 0,
        orderCount: 0,
        providerMutationCount: 0,
        disposition: "shadow",
      })
    ).toThrow(/shadowCount/);
  });

  it("fails on any non-zero mutation counter", () => {
    expect(() =>
      assertShadowOnly({
        shadowCount: 1,
        executeCount: 0,
        transferCount: 1,
        orderCount: 0,
        providerMutationCount: 0,
        disposition: "shadow",
      })
    ).toThrow(/transferCount/);

    expect(() =>
      assertShadowOnly({
        shadowCount: 1,
        executeCount: 0,
        transferCount: 0,
        orderCount: 1,
        providerMutationCount: 0,
        disposition: "shadow",
      })
    ).toThrow(/orderCount/);

    expect(() =>
      assertShadowOnly({
        shadowCount: 1,
        executeCount: 0,
        transferCount: 0,
        orderCount: 0,
        providerMutationCount: 1,
        disposition: "shadow",
      })
    ).toThrow(/providerMutationCount/);
  });
});