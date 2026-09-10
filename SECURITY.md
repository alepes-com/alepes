# Alepes Live Testing Safety Policy

**Status:** Canonical, enforceable policy for all live financial-institution certification in Alepes.
**Scope:** Applies to every live certification harness (Plaid, Alpaca, future providers) and any code path that contacts a real financial API.
**Version:** 1.0 (initial)

---

## 1. Non-Negotiable Constraints

### 1.1 Transport & Encryption
- **HTTPS only** for all public traffic. No HTTP, no mixed content.
- **Live test / certification data must** use encrypted-at-rest storage (PostgreSQL TLS, filesystem encryption, or managed-service equivalent) **or** ephemeral/non-persistent storage. There is no current claim that Alepes universally guarantees encrypted-at-rest test data; production provider encryption must be verified before use.
- **No plaintext secrets** in environment dumps, process lists, or container images.

### 1.2 Secrets Handling
- **Never** hardcode, commit, snapshot, log, print, or place API keys/secrets in:
  - Source code, test fixtures, or mock data
  - PR text, descriptions, or comments
  - Screenshots, terminal output, or artifacts
  - Command-line arguments (use env vars only)
- **All live credentials** must be stored in GitHub Environment secrets (not repository secrets), restricted to the specific environment (e.g., `plaid-live`, `alpaca-live`).
- **Secrets must be rotated** per provider policy or on any suspected exposure.

### 1.3 Data Minimization & Retention
- **Minimize live test data**: Only the accounts, transactions, and positions required for certification.
- **Securely delete temporary certification data** after the run (test databases dropped after CI, no persistent local stores of live data).
- **Delete data outside the consent scope promptly**, and honor prompt deletion on an End User request.
- **No production PII** in logs, metrics, or error reporting beyond what is required for deterministic redaction.

### 1.4 Dependency Hygiene
- **Keep dependencies patched**: Automated security/dependency checks (Dependabot or equivalent) must be enabled and passing.
- **No unpinned transitive dependencies** in production lockfiles.
- **License review** before adding new dependencies that process financial data or credentials.

### 1.5 Human Access Control
- **Privileged human accounts** (GitHub admins, cloud console access) use strong unique password-manager credentials and **MFA**.
- **Live Plaid/Alpaca testing limited to** the account owner or consenting people personally known to the tester.
- **Every live financial-institution connection** must be established through the provider's authorized connection flow (Plaid Link for Plaid; OAuth for Alpaca). No direct credential submission to Alepes.

### 1.6 Credential Scope (Alepes-Specific, Stricter Than Provider Contracts)
- **Alepes must never request, collect, transmit, or store** bank usernames, passwords, PINs, security answers, or bank MFA codes. These remain entirely between the user and Plaid Link.
- Alepes receives only opaque `access_token`/`item_id` from Plaid Link — never the underlying credentials.

### 1.7 Execution Boundaries
- **Live certification must remain Shadow-only**: zero transfers, zero brokerage orders, zero provider mutations.
- The harness must assert `executeCount = 0`, `transferCount = 0`, `orderCount = 0`, `providerMutationCount = 0` as hard invariants.

### 1.8 Test/Admin Surface Protection
- **Authentication, authorization, rate limiting, and least privilege** applied to any test/admin surfaces exposed to live credentials.
- GitHub Environment protection rules (required reviewers, branch restrictions) enforced on all live-cert environments.

### 1.9 Fail-Closed Principle
- **Fail closed** whenever any required security prerequisite is missing:
  - Wrong environment value (e.g., `sandbox` when `production` required)
  - Missing secrets or Postgres URL
  - Expired/invalid credentials detected
  - Any redaction failure
  - Unexpected provider mutation capability detected

---

## 2. Enforcement Mapping

| Requirement | Enforcement Layer | Status |
|---|---|---|
| HTTPS for public traffic | CI workflow `environment:` gate + provider SDK defaults | **Auto-enforced (CI)** |
| Encrypted-at-rest (or ephemeral) live test data | Managed Postgres (CI service + prod); must verify prod provider encryption before use | **Auto-enforced (infra) + preflight verification** |
| Secrets never in code/artifacts | `.gitignore` (`.env*`, `*.pem`), TruffleHog secret scan | **Auto-enforced (repo)** |
| Secrets only in GitHub Env secrets | Workflow `environment:` declaration; CI logs show `***` | **Auto-enforced (CI)** |
| No bank credentials in Alepes | Architectural: Plaid Link only; harness receives only `access_token` | **Architectural (code)** |
| Shadow-only disposition | Harness hard assertions (`executeCount = 0`, etc.) | **Runtime-enforced (existing harness inline guards)** |
| Redaction of all identifiers | `fp()` fingerprint + `redact()` in every harness | **Runtime-enforced (existing harness inline guards)** |
| Environment guard (refuse wrong env) | `if (ENV !== "production") process.exit(2)` | **Runtime-enforced (existing harness inline guards)** |
| Fail-closed on missing prerequisites | `process.exit(2)` with explicit message | **Runtime-enforced (existing harness inline guards)** |
| Dependency patching | Dependabot workflow | **CI-enforced** |
| Human MFA / access control | GitHub org policy (org-level, not repo) | **Human attestation** |
| Live testing limited to known users | GitHub Environment protection rules | **Human attestation + CI gate** |
| Plaid Link / authorized flow only | Not enforceable in repo; documented as human requirement | **Human attestation** |
| Secure temp certification data deletion | CI service cleanup; no local persistence | **Auto-enforced (infra)** |
| Rate limiting / auth on test surfaces | Not currently exposed; future work | **Gap** |
| Least privilege on test surfaces | GitHub Environment restrictions | **Partial (CI gate)** |

---

## 3. Reusable Safety Guards (Code)

`@alepes/certification-guards` is the **tested shared implementation** of the fail-closed safety guards. It is prepared for the existing Plaid/Alpaca harnesses to adopt. Current harnesses do **not** yet import it — they still enforce the same rules through their existing inline guards. This package exists so future harnesses (and the eventual migration) share one source of truth instead of re-deriving the checks.

### 3.1 Guard Functions (implemented)

```typescript
// packages/certification-guards/src/index.ts
import {
  assertLiveCertPrerequisites,  // fail-closed env + secret + env-var check
  fingerprint,                   // deterministic non-reversible redaction helper
  createRedactor,                // build a secret/identifier redactor
  assertShadowOnly,              // hard Shadow-only invariant assertions
} from "@alepes/certification-guards";
```

- `assertLiveCertPrerequisites(env)` — throws when the exact production/live env
  value is not set, or any required secret/env var is missing. Caller should
  `process.exit(2)` on throw.
- `fingerprint(value)` — deterministic, non-reversible fingerprint; never echo a
  raw token/id.
- `createRedactor(secrets)` — returns a redactor that replaces every registered
  secret/identifier; safe on non-strings and idempotent.
- `assertShadowOnly({...})` — asserts `disposition === "shadow"`, `shadowCount > 0`,
  and `executeCount/transferCount/orderCount/providerMutationCount === 0`.

The package is PURE (no React/Next/provider SDKs, no I/O) and unit-tested in
`packages/certification-guards/src/index.test.ts`.

### 3.2 Migration Status

- `@alepes/certification-guards` is implemented and its tests pass (16 unit tests).
- **Current harnesses enforce the safeguards through their existing inline guards** (fail-closed env check, `fp()`/`redact()`, Shadow-only assertions). These remain correct and fail-closed.
- Migrating the harnesses to import the shared guards is a follow-up that must NOT change the real-event semantics of the v0.5.0 harness.

---

## 4. Human Preflight Checklist (CI-Cannot-Verify)

Before running a credentialed live certification, the operator must attest:

- [ ] **Plaid MSA/Addendum reviewed** — Alepes's testing rules are stricter than Plaid's contractual requirements. No claim is made that Plaid requires these rules; they are Alepes-internal.
- [ ] **Live Item created via Plaid Link** — The tester personally completed Link flow; no credentials were shared with Alepes.
- [ ] **GitHub Environment `plaid-live` configured** — Secrets `PLAID_CLIENT_ID`, `PLAID_SECRET`, `PLAID_LIVE_POSTGRES_URL` set; protection rules enabled (required reviewers, branch restriction to `main` or `feat/plaid-live-real-cash-event`).
- [ ] **Storage posture verified** — Live test data uses encrypted-at-rest storage (e.g. PostgreSQL TLS `sslmode=require`) **or** ephemeral/non-persistent storage; production provider encryption confirmed.
- [ ] **Temporary data deletion planned** — Temporary certification data will be securely deleted after the run.
- [ ] **Test account selected** — Only the account owner or personally known consenting user.
- [ ] **No bank credentials ever entered into Alepes** — Confirmed.
- [ ] **Shadow-only expectation understood** — Zero orders/transfers/mutations will be produced; harness will fail if any are detected.
- [ ] **Redaction verified** — A dry-run (or previous run) output was inspected to confirm no raw secrets appear.
- [ ] **Dependabot/security alerts clear** — No critical/unpatched vulnerabilities in `package.json`/`bun.lock`.

---

## 5. Plaid Agreement Distinction

Alepes keeps the Plaid agreement itself **out of this repository**: the copy
supplied is Plaid Confidential Information and must not be committed. This policy
is framed as Alepes-internal policy plus references to applicable Plaid terms.

**Alepes does not claim** that the Plaid agreement requires:
- Shadow-only execution (Alepes internal rule)
- `fp()` fingerprinting of all identifiers (Alepes internal rule)
- GitHub Environment secret storage (Alepes internal rule)
- Human preflight checklist (Alepes internal rule)
- Fail-closed on missing posted credit (Alepes internal rule)

**Applicable Plaid terms DO include** (referenced, not restated as if contract text):
- An information-security program covering security, unauthorized access, and threats
- Proper disposal of End User Data
- Deletion of data outside the consent scope, and prompt deletion on an End User request
- Authorized access via Plaid Link only
- No storage of bank credentials

Alepes's policy is **stricter than** Plaid's contractual requirements where it adds
Shadow-only execution, deterministic fingerprinting, and GitHub-Environment secret
gating. This is intentional and documented to avoid misrepresentation.

---

## 6. Gaps & Future Work

1. **Dependabot/security workflow** — Now configured (`.github/dependabot.yml` + `.github/workflows/secret-scan.yml`). Requires GitHub to pick them up on next push; verify alerts fire.
2. **Secret scanning** — TruffleHog added as a CI workflow; needs first green run to confirm it does not false-positive on the repo.
3. **Rate limiting / auth on test surfaces** — No admin/test endpoints currently exposed; if added, must enforce.
4. **Harness migration to shared guards** — `@alepes/certification-guards` exists and is tested, but the existing Plaid/Alpaca harnesses still enforce guards inline. Migrate without changing real-event semantics (see §3.2).
5. **Automated redaction test** — CI check that a harness's output contains no raw secret patterns (regex for known formats) — not yet wired; the shared redactor + fingerprints make this feasible.
6. **Verified storage posture (fail-closed preflight blocker)** — Alepes does not yet universally guarantee encrypted-at-rest test data. Until a production storage provider's at-rest encryption is verified (and temporary-data deletion is confirmed), credentialed live certification must **fail closed** at the human preflight step. This is an active blocker, not merely a TODO.

---

## 7. References

- Existing harness implementations (inline guards; to migrate to shared guards later):
  - `packages/integrations/plaid-financial-data/certify-live.ts`
  - `packages/integrations/plaid-financial-data/certify-sandbox.ts`
  - `packages/integrations/alpaca-brokerage-data/certify-live.ts`
  - `packages/integrations/alpaca-brokerage-data/certify-paper.ts`
- Shared guards implementation + tests:
  - `packages/certification-guards/src/index.ts`
  - `packages/certification-guards/src/index.test.ts`
- CI workflows using GitHub Environments:
  - `.github/workflows/alpaca-paper-certify.yml`
- Repository security config:
  - `.gitignore` (excludes `.env*`, `*.pem`)
- Financial core invariants (AGENTS.md): integer cents, deterministic pipeline, reproducibility

---

**End of Policy.** This document is the canonical reference. All live certification work must comply.