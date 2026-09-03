// Bun 1.4 + @duckdb/node-api compatibility gate.
//
// EXITS 0 (pass): DuckDB loads, creates a connection, and executes a query.
// EXITS 1 (fail): any exception or the native addon is unavailable.
//
// Run manually:
//   bun packages/analytics/test/duckdb-bun-compat.ts
// In CI:
//   bun test packages/analytics/test/duckdb-bun-compat.ts

async function main() {
  console.log("Testing @duckdb/node-api under Bun...");
  try {
    const mod = await import("@duckdb/node-api");
    const conn = new mod.DuckDBConnection(":memory:");
    await conn.run("CREATE TABLE t(x INTEGER);");
    await conn.run("INSERT INTO t VALUES (42);");
    const res = await conn.run("SELECT x FROM t");
    console.log("PASS: duckdb under bun");
    await conn.close();
    process.exit(0);
  } catch (err) {
    console.error("FAIL: duckdb under bun");
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }
}

main();
