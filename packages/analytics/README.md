# @alepes/analytics

Read-only analytical engine for Alepes, backed by PostgreSQL:

- Shadow Mode history
- portfolio drift over time
- strategy/version comparisons
- contribution simulations
- backtesting
- cash-flow analytics
- formation analytics
- reporting

## Boundary rules

- **Read-only.** This package never initiates a transfer, order, or trade, and
  never writes to the canonical financial tables.
- **Postgres is both the system of record and the analytical query engine.**
  Analytics answer questions over the canonical tables already written by
  `@alepes/persistence` (`execution_plans`, `execution_plan_orders`,
  `execution_plan_events`, `financial_observations`, `account_balance_snapshots`).
- **No financial decisions route through analytics.** Query results inform
  simulation/reporting UIs only.
- **Domain and financial policy cannot depend on analytical storage engines.**
  Consumers depend on the provider-neutral `AnalyticsEngine` interface, never on
  a concrete SQL engine or database driver.

## Storage-engine decision — POSTGRES (deferred DuckDB)

**Postgres remains both the system of record and the initial analytical query
engine. DuckDB is deferred.**

Alepes does not currently have a workload that justifies a second runtime
boundary for analytics. Postgres already holds the authoritative financial
state, and analytical SQL (views / materialized views / plain queries) covers the
near-term needs — portfolio drift, deposit history, rule outcomes, allocation
history, Shadow comparisons, contribution summaries, and dashboard queries.

Introducing DuckDB as a runtime engine today would add a native-addon (or CLI
subprocess) boundary — plus its deployment, observability, error-handling,
packaging, and cross-platform surface — before any workload earns it. Bun 1.4
also has a real compatibility failure with `duckdb/node-api`, and there is no
DuckDB CLI/runtime distribution strategy. So:

- **No Node sidecar or CLI subprocess** is introduced solely to run DuckDB.
- **The analytics interface stays provider-neutral** so a `DuckDBAnalyticsEngine`
  can be added later behind the same `AnalyticsEngine` interface.
- **DuckDB becomes interesting later** for large historical simulations, long
  time-series scans, backtests across millions of rows, local Parquet analysis,
  or large cross-sectional research — at which point it can run as a *separate*
  analytical workload reading exported Parquet/snapshots from Postgres, rather
  than sharing responsibility for application state.

```
AnalyticsEngine
├── PostgresAnalyticsEngine  ← now
└── DuckDBAnalyticsEngine    ← later, if the workload earns it
```

## Engine interface

```ts
import { PostgresAnalyticsEngine, NullEngine, type AnalyticsEngine } from "@alepes/analytics";

const analytics: AnalyticsEngine = PostgresAnalyticsEngine.open(connectionString);
const series = await analytics.stageSeries(0);       // group audit trail by stage
const cents  = await analytics.stageCentsReport(0);  // sum integer cents by stage (string)
const stats  = await analytics.stats();              // rowsLoaded / rowsDropped / lastIngestAt
```

`NullEngine` remains the dependency-free no-op used where analytics is
unavailable or in tests that must not touch a real database.

The `PostgresAnalyticsEngine` integration tests are env-gated behind
`ALEPES_TEST_ANALYTICS_DATABASE_URL` (or `ALEPES_TEST_DATABASE_URL`), matching
`@alepes/persistence`, and prove the queries against real PostgreSQL.

### Scope note on "formation"/"drift"

The warehouse terms "portfolio drift" and "formation" refer to the in-memory
`PortfolioState` functions in `@alepes/allocation-engine` (`formationScore`,
`driftReport`), which are NOT stored in the audit table. This package therefore
exposes the audit-trail aggregations the persisted schema actually supports —
`stageSeries` (event counts by lifecycle stage) and `stageCentsReport` (integer
cents summed by stage) — rather than re-deriving portfolio formation from rows
that cannot carry it.