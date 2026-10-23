import { describe, it, expect } from "vitest";
import { projectPublicReport } from "./certify-live-report";

describe("certify-live public report projection (allowlist)", () => {
  it("drops synthetic account-name sentinel", () => {
    const raw = {
      environment: "production",
      accounts: [{ accountFingerprint: "fp-1", name: "SENTINEL_ACCOUNT_NAME", subtype: "checking" }],
      allPass: true,
    };
    const out = JSON.stringify(projectPublicReport(raw));
    expect(out).not.toContain("SENTINEL_ACCOUNT_NAME");
  });

  it("drops synthetic employer-name sentinel", () => {
    const raw = {
      environment: "production",
      accounts: [{ accountFingerprint: "fp-1", name: "SENTINEL_EMPLOYER_NAME_X", subtype: "checking" }],
      allPass: true,
    };
    const out = JSON.stringify(projectPublicReport(raw));
    expect(out).not.toContain("SENTINEL_EMPLOYER_NAME_X");
  });

  it("drops synthetic transaction-description sentinel", () => {
    const raw = {
      environment: "production",
      shadow: { disposition: "shadow", sourceDescription: "SENTINEL_TX_DESCRIPTION" },
      points: [{ id: 1, name: "step", status: "pass", detail: { description: "SENTINEL_TX_DESCRIPTION" } }],
      allPass: true,
    };
    const out = JSON.stringify(projectPublicReport(raw));
    expect(out).not.toContain("SENTINEL_TX_DESCRIPTION");
  });

  it("drops unexpected sensitive nested-field sentinel", () => {
    const raw = {
      environment: "production",
      unexpectedSensitiveField: "SENTINEL_UNEXPECTED_NESTED",
      nested: { secretToken: "SENTINEL_UNEXPECTED_NESTED" },
      allPass: true,
    };
    const out = JSON.stringify(projectPublicReport(raw));
    expect(out).not.toContain("SENTINEL_UNEXPECTED_NESTED");
  });

  it("preserves permitted public evidence fields", () => {
    const raw = {
      environment: "production",
      testUser: "live",
      boundAccount: { fingerprint: "fp-bound", subtype: "checking" },
      accounts: [{ accountFingerprint: "fp-1", subtype: "checking" }],
      initialSync: { pages: 2, added: 5, modified: 1, removed: 0, hasMore: false },
      reconciledObservations: 3,
      cashEvents: 2,
      shadow: { disposition: "shadow", proposedOrderCount: 1, nonExecuting: true },
      isolation: { totalAccounts: 1, nonDepositoryCount: 0, boundAccountIsDepository: true },
      points: [{ id: 1, name: "discover", status: "pass" }],
      allPass: true,
      note: "No brokerage, no money movement occurred. Shadow disposition only.",
    };
    const out = projectPublicReport(raw) as Record<string, unknown>;
    expect(out.environment).toBe("production");
    expect(out.allPass).toBe(true);
    expect(out.reconciledObservations).toBe(3);
    expect(out.cashEvents).toBe(2);
    expect((out.boundAccount as any).subtype).toBe("checking");
    expect((out.points as any)[0].status).toBe("pass");
    expect(out.note).toContain("Shadow disposition only");
  });
});