# @alepes/analytics

DuckDB-backed analytical engine for Alepes:

- Shadow Mode history
- portfolio drift over time
- strategy/version comparisons
- contribution simulations
- backtesting
- cash-flow analytics
- formation analytics
- reporting

## Boundary rules

- **Read-only.** This package never initiates a transfer, order, or trade.
- **Postgres remains the transactional source of truth.** Analytics consume exported projections (plan events, audit records), never the write path.
- **No financial decisions route through DuckDB.** Query results inform simulation/reporting UIs only.

## Bun 1.4 + `@duckdb/node-api` compatibility — KNOWN ISSUE

`@duckdb/node-api` requires Node-API native addons. Under Bun 1.4 the
native binding fails to load (`DuckDBConnection.create` →
`instance.connect is not a function`).

**Status: blocked in Bun runtime.** The package is scaffolded and
type-checks, but has no passing Bun runtime smoke test yet.

Decision pending:
- Option A: run analytics under Node.js (separate process/container), keeping Bun for the web app.
- Option B: contribute/await a Bun-compatible DuckDB binding.
- Option C: defer DuckDB until after real-provider integration, and ship analytics via Postgres views meanwhile.

Do NOT declare DuckDB production-ready until a Bun smoke test passes in CI.
