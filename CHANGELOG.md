# Alepes Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [v0.4.0] - 2026-09-08

### Added
- **Alpaca live read-only brokerage integration** (`@alepes/alpaca-brokerage-data`)
  - Live trading API connectivity (`api.alpaca.markets`)
  - Account discovery, balance reading, position retrieval, price queries
  - Exact decimal normalization without JS-float authoritative money
  - Provider-neutral `PortfolioState` construction via brokerage-shadow bridge

- **Full Shadow Mode pipeline on live account data**
  - Observe → Decide → Validate → Shadow pipeline proven against real Alpaca live data
  - Synthetic qualifying deposit exercises complete rules-engine + allocation-engine path
  - Zero mutation surface: no `submitOrders` capability registered or reachable

- **Temporal workflow orchestration**
  - `ExecutionPlanWorkflow` with deterministic provenance verification
  - `OutboxPublisherWorkflow` with lease-based claim processing
  - Transactional outbox for reliable event publication

- **Brokerage-shadow bridge** (`@alepes/reconciliation`)
  - Pure mapping: observed broker positions → provider-neutral `PortfolioState`
  - Integer cents throughout; equity derived from positions (excludes cash to avoid double-counting)

### Evidence Boundary (Critical)

> **Real-provider live observation is proven; the Shadow decision path is still driven by a synthetic deposit.**

The 11-gate live certification (`certify:alpaca-live`) proves:
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

**Gate 9 is the boundary**: the Shadow pipeline runs, but the qualifying cash event that triggers it is synthesized in-memory (`makeSyntheticDepositObservation`). A real qualifying cash event traversing the full pipeline end-to-end remains unproven and is the v0.5.0 milestone.

### Changed
- `packages/integrations/alpaca-brokerage-data`: live read-only provider implementation
- `packages/reconciliation`: brokerage-shadow bridge + Shadow Mode composition
- `packages/temporal-workflows`: execution + outbox workflows

### Verification
- **Structural**: annotated tag `v0.4.0` → commit `08152fc`; `main` = `08152fc`; PR #5 normal-merged; `IDEA.md` excluded from release range; paper path behaviorally unchanged
- **Certification**: 11/11 gates passed on live Alpaca (first-hand, credentials never in repo)
- **CI**: main green before tagging (`bun run lint && bunx tsc --noEmit && bun run test && bun run build`)
- **Reproducibility**: byte-identical plans confirmed via deterministic pipeline

---

## [v0.3.0] - 2026-09-07

### Added
- Alpaca brokerage read-only (Sandbox) integration
- Plaid Sandbox certification harness (`certify:plaid-sandbox`)
- PostgreSQL analytics engine (DuckDB-on-Bun certification)

---

## [v0.2.0] - 2026-09-07

### Added
- Plaid read-only financial data integration
- Transaction sync, cursor pagination, webhook idempotency

---

## [v0.1.0] - 2026-09-04

### Added
- Platform foundation: Bun 1.4, Oxlint, TypeScript, Vitest
- Pure domain packages: money, domain, rules-engine, allocation-engine, execution-policy, integration-runtime
- Mock bank/brokerage integrations
- Temporal Worker + workflow isolate (Node 24 runtime island)
- PostgreSQL persistence (plans, orders, append-only audit, transactional outbox)
- Solo-maintainer review exception policy

---

[Unreleased]: https://github.com/alepes-com/alepes/compare/v0.4.0...HEAD
[v0.4.0]: https://github.com/alepes-com/alepes/releases/tag/v0.4.0
[v0.3.0]: https://github.com/alepes-com/alepes/releases/tag/v0.3.0
[v0.2.0]: https://github.com/alepes-com/alepes/releases/tag/v0.2.0
[v0.1.0]: https://github.com/alepes-com/alepes/releases/tag/v0.1.0