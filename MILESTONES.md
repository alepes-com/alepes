# Alepes Milestones

This document defines the concrete acceptance criteria for each milestone. A milestone is claimable only when every gate passes; "mostly working" does not count.

---

## v0.1.0 — Platform Foundation ✅ CLAIMED 2026-09-04

**Delivered**: Bun 1.4 toolchain, Oxlint, TypeScript, Vitest, pure domain packages (`money`, `domain`, `rules-engine`, `allocation-engine`, `execution-policy`, `integration-runtime`), mock bank/brokerage integrations, Temporal Worker + workflow isolate (Node 24), PostgreSQL persistence (plans, orders, append-only audit, transactional outbox), solo-maintainer review exception policy.

**Gates passed**:
- All packages type-check and unit-test green
- Temporal workflow-isolate tests pass on Node 24
- `bun run lint && bunx tsc --noEmit && bun run test && bun run build` green
- Tagged `v0.1.0` from clean `main` with green CI

---

## v0.2.0 — Bank Data / Plaid Read-Only ✅ CLAIMED 2026-09-07

**Delivered**: Plaid read-only financial data integration (`@alepes/plaid-financial-data`), transaction sync with cursor pagination, webhook idempotency, Plaid Sandbox certification harness (`certify:plaid-sandbox`) that proves the adapter against live Sandbox responses.

**Gates passed**:
- Environment guard: refuses non-Sandbox `PLAID_ENV`
- Creates `user_transactions_dynamic` Sandbox Item, binds depository account
- `/transactions/sync` account-scoped (`options.account_id`), pagination drains, cursor behind adapter boundary
- `SYNC_UPDATES_AVAILABLE` webhook → resync trigger idempotent
- Custom deposit via `/sandbox/transactions/create` normalizes to provider-neutral credit, reaches Shadow Mode
- Credentials redacted to deterministic fingerprints; never in repo

---

## v0.3.0 — Brokerage Read-Only / Alpaca Paper ✅ CLAIMED 2026-09-07

**Delivered**: Alpaca paper/sandbox brokerage read-only adapter (`@alepes/alpaca-brokerage-data` with `environment: "paper" | "sandbox"`), provider-neutral `BrokerageDataProvider` contract, brokerage-shadow bridge (`@alepes/reconciliation`), PostgreSQL analytics engine (DuckDB-on-Bun certified).

**Gates passed**:
- Paper-domain guard: rejects live base URL at construction time
- Account discovery, balance reading, position retrieval, price queries on paper
- Exact decimal normalization (Alpaca reports decimal strings → integer cents, no float money)
- Provider-neutral `PortfolioState` via brokerage-shadow bridge
- Analytics engine certified on real PostgreSQL

---

## v0.4.0 — Real-Account Shadow Mode ✅ CLAIMED 2026-09-08

**Delivered**: Alpaca live read-only brokerage integration (`@alepes/alpaca-brokerage-data` with `environment: "live"`), full Observe→Decide→Validate→Shadow pipeline on live account data, Temporal workflow orchestration (`ExecutionPlanWorkflow`, `OutboxPublisherWorkflow`), brokerage-shadow bridge.

**Gates passed (11/11 live certification)**:
1. Environment guard: refuses anything except explicit `"live"` configuration
2. Live authentication without credential exposure
3. Exact live account discovery with provider ID fingerprinting
4. Live cash / buying-power / account status reads
5. Real live position reads
6. Exact decimal normalization (no float money)
7. Live position pricing
8. Provider-neutral `PortfolioState` via brokerage-shadow bridge
9. **Full Observe→Decide→Validate→Shadow pipeline on SYNTHETIC deposit** (not a real live cash event)
10. No mutative capability (`submitOrders`) registered or reachable
11. Zero live orders, transfers, or brokerage mutations produced

### Evidence Boundary (Critical — defines v0.5.0)

> **Real-provider live observation is proven; the Shadow decision path is still driven by a synthetic deposit.**

Gate 9 is the boundary: the Shadow pipeline runs, but the qualifying cash event that triggers it is synthesized in-memory (`makeSyntheticDepositObservation` in `certify-live.ts`). A real qualifying cash event traversing the full pipeline end-to-end remains unproven and is the v0.5.0 milestone.

---

## v0.5.0 — Real Qualifying Cash Event Through Full Pipeline 🎯 NEXT

### The Gap

v0.4.0 proved the **pipeline machinery** works on live account data. It did **not** prove that a **real qualifying cash event** (a genuine deposit observed from a live provider) can traverse Observe→Decide→Validate→Shadow and produce an audited, reproducible plan.

### Acceptance Criteria (all must pass)

| Gate | Criterion | Evidence Level (per AGENTS.md) |
|------|-----------|-------------------------------|
| **5.1** | A **real** qualifying cash event is observed from a live provider — Plaid live `/transactions/sync` returning a genuine deposit transaction, or a real brokerage inbound transfer observed via Alpaca live — **not** a sandbox-created or in-memory synthetic event. | 5 (end-to-end with real providers) |
| **5.2** | That real event normalizes to a provider-neutral credit (`CashEvent` / `PersistedObservation`) with full provenance (provider ref, normalization version, posted timestamp). | 5 |
| **5.3** | The complete Observe→Decide→Validate→Shadow pipeline executes on that real event: rules-engine evaluates triggers/reserve/caps, allocation-engine produces drift-correcting orders, execution-policy emits Shadow disposition. | 5 |
| **5.4** | The resulting `CapitalPlan` and `AllocationPlan` are **byte-identical** to an independently recomputed expected plan (reproducibility invariant). | 4 (property test / unit test) |
| **5.5** | The event is **persisted** with: `ExecutionPlan` row, `AuditRecord[]` explaining every decision, outbox event (`ExecutionPlanCreated`) published. | 4 |
| **5.6** | Disposition at the execution gate is **Shadow** (no live orders submitted). | 5 |
| **5.7** | A certification harness extension (likely `certify:alpaca-live` gaining a real-event gate, or a new `certify:plaid-live` harness) produces a first-hand report proving all gates above. | 5 |

### Explicitly Out of Scope for v0.5.0

- Real settlement / cash movement out of the brokerage
- Real order execution (`submitOrders` capability)
- `approval` disposition (queued intent) — still Shadow-only
- Reconciliation of provider-reported settlement (no settlement yet)
- Multi-provider event correlation (single live provider is sufficient)

### Definition of Done

v0.5.0 is claimable when a first-hand certification run (credentials sourced from environment, never in repo) produces a report showing Gates 5.1–5.7 passing against a real live provider, with the same redaction and safety guarantees as v0.4.0's 11-gate run.

---

## v0.6.0+ — Controlled Execution (Directional, Not Yet Authorized)

Per AGENTS.md execution-policy gate and IDEA.md delivery sequence:

- v0.6.0: `approval` disposition (queued intent, not executed)
- v0.7.0: sandbox/live execution capabilities (real transfers, real orders) with substantially stronger safety, regulatory, reconciliation, and provider-specific controls
- Each step requires deliberate approval, first-hand certification, and the full validation ladder

> **Do not infer permission** to begin Plaid live, Schwab, money movement, or live trading merely because v0.5.0 is merged. Each capability requires its own milestone, branch, certification, and review.

---

## Release Boundary Discipline

| Rule | Enforcement |
|------|-------------|
| Tags only from `main` with green CI | CI workflow gate |
| No tag from feature branch | Git hook / PR template |
| Milestone criteria defined **before** implementation starts | This document |
| "Unproven" steps named explicitly, not hedged | Milestone criteria table |
| Docs-only commits do not carry tags | Release workflow |

---

*Last updated: 2026-09-08 (v0.4.0 claimed, v0.5.0 criteria defined)*