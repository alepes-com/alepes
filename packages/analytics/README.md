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
- **DuckDB is import-confined to this package.** The oxlint rule
  `alepes/no-duckdb-outside-analytics` (the only rule in the set promoted to
  `error` in production packages) rejects any import of `@duckdb/node-api` /
  `@duckdb/node-bindings` outside `packages/analytics/`. Consumers depend on the
  provider-neutral `ExecutionAnalyticsEngine` interface, never on DuckDB types.

## DuckDB runtime decision — CERTIFIED (2026-09-03)

**Backend selected: native `@duckdb/node-api@1.5.5-r.4` under Bun 1.4.**

The earlier "blocked" status was a false negative: the original smoke gate
(`test/duckdb-bun-compat.ts`) called `DuckDBConnection.create`, an API that does
not exist in the v1.5.5-r.4 (duckdb-node-neo) surface. The correct API is
`DuckDBInstance.create()` → `connect()` → `run()`. The failure was API misuse,
**not** a Bun/native-addon incompatibility.

### Certification evidence

`packages/analytics/test/certify-duckdb-bun.ts` exercises the pinned runtime
across a 12-point matrix and is re-run on every platform in CI
(`.github/workflows/certify-duckdb-bun.yml`):

| # | Check | Result |
|---|-------|--------|
| 1 | Load module | ✅ 247 exports |
| 2 | In-memory instance | ✅ |
| 3 | File-backed instance | ✅ persist + re-read |
| 4 | Parameterized queries | ✅ typed binding |
| 5 | Integer-cents precision | ✅ `9007199254740993` (> 2^53) round-trips as `bigint` |
| 6 | Open/query/close × 50 | ✅ |
| 7 | Concurrent analytical queries × 20 | ✅ |
| 8 | Parquet read/write | ✅ `COPY` + `read_parquet` |
| 9 | Create/destroy × 30 | ✅ |
| 10 | Stress loop × 500 | ✅ no crash |
| 11 | Clean shutdown + restart | ✅ |
| 12 | Smoke gate repeat × 30 | ✅ |

Plus a **hardened stress run** (8 full lifecycles × 2000 iterations = 16 000
query/pass units) completed with **zero crashes** and stable RSS (~120 MB).

### Platform matrix

| Platform | Status |
|----------|--------|
| macOS arm64 | ✅ certified (this host, first-hand) |
| Linux amd64 | ⏳ CI gated (`.github/workflows/certify-duckdb-bun.yml`); not runnable natively from an arm64 dev host |

The Linux amd64 row stays **CI-gated**, not "certified", until the workflow
runs on a `ubuntu-22.04` runner. It is deliberately *not* hand-certified from
the arm64 host via QEMU, because native-addon ABI/segfault behavior under
emulation is not a faithful signal.

### Decision (per the bounded certification decision rule)

`@duckdb/node-api` is stable across the certification matrix → it is used
directly behind the `packages/analytics` adapter, which is the **only** location
allowed to import DuckDB. If a future Bun/`node-api` upgrade breaks the matrix,
the fallback is the **DuckDB CLI/native executable behind a Bun-owned process
adapter** (Bun analytics package → controlled DuckDB subprocess → DuckDB/Parquet),
preserving the same `ExecutionAnalyticsEngine` interface — *not* a silent
Node.js fallback, and *not* DuckDB-Wasm as the server-side default.

## Engine interface

```ts
import { DuckDBEngine, NullEngine, type ExecutionAnalyticsEngine } from "@alepes/analytics";

const db = await DuckDBEngine.open();        // in-memory, or .open("/path/x.duckdb")
await db.ingest(auditRecords);
const series = await db.formationSeries(0);  // grouped by event id
const drift  = await db.driftReport(0);      // stage totals in integer cents (string)
const stats  = await db.stats();             // rowsLoaded / rowsDropped / lastIngestAt
db.close();
```

`NullEngine` remains the dependency-free no-op used where analytics is
unavailable or in tests that must not touch the native addon.