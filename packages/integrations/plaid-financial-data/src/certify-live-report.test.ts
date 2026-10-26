import { describe, it, expect } from "vitest";
import {
  projectPublicReport,
  buildPublicCertificationReport,
  redactSecrets,
  type PublicReportRedactions,
} from "./certify-live-report";

// ─── Composition fixtures ────────────────────────────────────────────────────
// Sentinels stand in for the private free-text values PR #6 Finding 1 is
// about: account names, employer names (as they appear inside deposit
// descriptions), transaction descriptions, and unexpected sensitive nested
// fields. Fake secret values (never real credentials) exercise the
// replacement-based redaction layer inside the composition.

const SENTINEL_ACCOUNT_NAME = "SENTINEL_ACCOUNT_NAME_Plaid Premier Checking";
const SENTINEL_EMPLOYER_NAME = "SENTINEL_EMPLOYER_NAME_Acme Payroll";
const SENTINEL_TX_DESCRIPTION =
  "SENTINEL_TX_DESCRIPTION_direct deposit from Acme Payroll";
const SENTINEL_UNEXPECTED_NESTED = "SENTINEL_UNEXPECTED_NESTED_official name";

const FAKE_CLIENT_ID = "client-prod-abcdef123456";
const FAKE_SECRET = "secret-prod-XYZ987";
const FAKE_ACCESS_TOKEN = "access-production-9f2b1c00";
const FAKE_ACCOUNT_ID = "acct-live-7744";

const redactions: PublicReportRedactions = {
  clientId: FAKE_CLIENT_ID,
  secret: FAKE_SECRET,
  accessTokens: [FAKE_ACCESS_TOKEN],
  itemIds: [],
  accountIds: [FAKE_ACCOUNT_ID],
};

// Mirrors the exact rawReport shape certify-live.ts assembles at its report
// print site, with synthetic sentinels in every sensitive free-text slot and
// fake secrets embedded in permitted string fields (fingerprint / run id /
// cursor / queue slots) to prove the replacement layer stays active inside the
// composition.
const harnessShapedRawReport = {
  environment: "production",
  testUser: "live",
  boundAccount: { fingerprint: `fp-${FAKE_ACCOUNT_ID}-len13`, subtype: "checking" },
  accounts: [
    {
      accountFingerprint: "fp-112233-len16",
      name: SENTINEL_ACCOUNT_NAME,
      subtype: "checking",
      officialName: SENTINEL_UNEXPECTED_NESTED,
    },
  ],
  initialSync: {
    pages: 1,
    added: 2,
    modified: 0,
    removed: 0,
    finalCursorFingerprint: `fp-${FAKE_ACCESS_TOKEN}`,
    finalCursorLength: 32,
    hasMore: false,
    balanceSnapshotPresent: true,
  },
  reconciledObservations: 2,
  cashEvents: 1,
  shadow: {
    disposition: "shadow",
    deployableCents: 1234,
    totalDeployedCents: 1234,
    cashEventIdFingerprint: "fp-cash-1",
    persistedPlanId: "ep_01ABC",
    persistedOutboxEventId: "ob_01ABC",
    proposedOrderCount: 2,
    taskQueue: `cert-queue-${FAKE_SECRET}`,
    certificationSourceCommit: "b4f1a421",
    certificationRunId: `certify-${FAKE_CLIENT_ID}`,
    sourceDescription: SENTINEL_TX_DESCRIPTION,
    nonExecuting: true,
    recomputationHash: "sha256:demo",
  },
  isolation: { totalAccounts: 1, nonDepositoryCount: 0, boundAccountIsDepository: true },
  points: [
    {
      id: 7,
      name: "derive qualifying CashEvents from fresh delta",
      status: "pass" as const,
      detail: {
        count: 1,
        events: [{ description: SENTINEL_TX_DESCRIPTION, employerName: SENTINEL_EMPLOYER_NAME }],
      },
    },
  ],
  allPass: true,
  note: "No brokerage, no money movement occurred. Shadow disposition only.",
};

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

describe("harness report projection composition (buildPublicCertificationReport)", () => {
  it("drops every sensitive sentinel from the serialized public report", () => {
    // certify-live.ts prints JSON.stringify(report, null, 2) — mirror exactly.
    const publicLine = JSON.stringify(
      buildPublicCertificationReport(harnessShapedRawReport, redactions),
      null,
      2
    );
    expect(publicLine).not.toContain(SENTINEL_ACCOUNT_NAME);
    expect(publicLine).not.toContain(SENTINEL_EMPLOYER_NAME);
    expect(publicLine).not.toContain(SENTINEL_TX_DESCRIPTION);
    expect(publicLine).not.toContain(SENTINEL_UNEXPECTED_NESTED);
  });

  it("still redacts known secret values embedded in permitted fields (defense in depth)", () => {
    const out = JSON.stringify(buildPublicCertificationReport(harnessShapedRawReport, redactions));
    expect(out).not.toContain(FAKE_CLIENT_ID);
    expect(out).not.toContain(FAKE_SECRET);
    expect(out).not.toContain(FAKE_ACCESS_TOKEN);
    expect(out).not.toContain(FAKE_ACCOUNT_ID);
    expect(out).toContain("REDACTED_CLIENT_ID");
    expect(out).toContain("REDACTED_SECRET");
    expect(out).toContain("REDACTED_ACCESS_TOKEN(");
    expect(out).toContain("REDACTED_ACCOUNT_ID(");
  });

  it("preserves permitted public evidence fields through the composition", () => {
    const out = buildPublicCertificationReport(harnessShapedRawReport, redactions) as Record<
      string,
      any
    >;
    expect(out.environment).toBe("production");
    expect(out.testUser).toBe("live");
    expect(out.reconciledObservations).toBe(2);
    expect(out.cashEvents).toBe(1);
    expect(out.allPass).toBe(true);
    expect(out.note).toContain("Shadow disposition only");
    expect((out.boundAccount as any).subtype).toBe("checking");
    expect(out.shadow.disposition).toBe("shadow");
    expect(out.shadow.deployableCents).toBe(1234);
    expect(out.shadow.persistedPlanId).toBe("ep_01ABC");
    expect(out.isolation.totalAccounts).toBe(1);
    const points = out.points as any[];
    expect(points[0]?.name).toBe("derive qualifying CashEvents from fresh delta");
    expect(points[0]?.status).toBe("pass");
  });

  it("failure path: redacts a string error message, structure unchanged", () => {
    // certify-live.ts routes its failure-path console.error payload through
    // the same canonical composition. For a string, the projection is a no-op,
    // so output stays byte-equivalent to the pre-fix `redact(message)` shape.
    const message = `no qualifying live event observed (token ${FAKE_ACCESS_TOKEN}, account ${FAKE_ACCOUNT_ID})`;
    const out = buildPublicCertificationReport(message, redactions);
    expect(typeof out).toBe("string");
    const text = out as string;
    expect(text).not.toContain(FAKE_ACCESS_TOKEN);
    expect(text).not.toContain(FAKE_ACCOUNT_ID);
    expect(text).toContain("REDACTED_ACCESS_TOKEN(");
    expect(text).toContain("REDACTED_ACCOUNT_ID(");
    expect(text).toContain("no qualifying live event observed");
  });
});

describe("F1 leak documentation (pre-fix harness behavior, kept as a guard)", () => {
  it("replacement-based redaction alone lets free-text sentinels through", () => {
    // Reproduces PR #6 Finding 1 in CI: the pinned-head harness printed
    // redact(rawReport), which replaces only KNOWN secrets — private free text
    // survives. This documents why the allowlist composition above is
    // mandatory; if this ever fails because redactSecrets grew stronger than
    // the pinned-head semantics, that change must be consciously re-reviewed.
    const legacy = JSON.stringify(redactSecrets(harnessShapedRawReport, redactions));
    // Known secrets ARE redacted by the legacy layer…
    expect(legacy).not.toContain(FAKE_CLIENT_ID);
    expect(legacy).not.toContain(FAKE_SECRET);
    expect(legacy).not.toContain(FAKE_ACCESS_TOKEN);
    // Cross-check: the module's fp() must reproduce the pinned-head harness
    // fp() byte-for-byte (verified against a git-show extraction of the
    // pinned redactor over the same fake token).
    expect(legacy).toContain("REDACTED_ACCESS_TOKEN(fp-c046c47a-len26)");
    // …but every free-text sentinel SURVIVES — the F1 leak:
    expect(legacy).toContain(SENTINEL_ACCOUNT_NAME);
    expect(legacy).toContain(SENTINEL_EMPLOYER_NAME);
    expect(legacy).toContain(SENTINEL_TX_DESCRIPTION);
    expect(legacy).toContain(SENTINEL_UNEXPECTED_NESTED);
  });
});
