// Bun 1.4 + @duckdb/node-api compatibility gate.
//
// EXITS 0 (pass): DuckDB loads, creates a connection, and executes a query
// under the pinned Bun runtime.
// EXITS 1 (fail): any exception or the native addon is unavailable.
//
// NOTE: the correct v1.5.5-r.4 API is `DuckDBInstance.create()` ->
// `connect()` -> `run()`. The earlier gate called `DuckDBConnection.create`,
// which never existed — its failure was API misuse, not a Bun incompatibility.
//
// Run manually:
//   bun packages/analytics/test/duckdb-bun-compat.ts
// In CI:
//   bun test packages/analytics/test/duckdb-bun-compat.ts

async function main() {
  console.log("Testing @duckdb/node-api under Bun...");
  try {
    const mod = await import("@duckdb/node-api");
    const { DuckDBInstance } = mod as any;
    const instance = await DuckDBInstance.create(":memory:");
    const conn = await instance.connect();
    await conn.run("CREATE TABLE t(x INTEGER);");
    await conn.run("INSERT INTO t VALUES (42);");
    await conn.run("SELECT x FROM t");
    conn.closeSync();
    instance.closeSync();
    console.log("PASS: duckdb under bun");
    process.exit(0);
  } catch (err) {
    console.error("FAIL: duckdb under bun");
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }
}

main();