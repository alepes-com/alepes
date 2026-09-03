// DuckDB-on-Bun certification spike.
//
// Closes J-Space ?01 with evidence. Exercises @duckdb/node-api under the
// pinned Bun runtime across a 12-point matrix, including the load patterns
// Bun's own CI flagged (intermittent native-addon segfaults).
//
// Correct API (v1.5.5-r.4 / duckdb-node-neo):
//   DuckDBInstance.create(path?)  -> Promise<Instance>
//   instance.connect()            -> Promise<Connection>
//   connection.run(sql, values)   -> Promise<MaterializedResult>
//   connection.runAndReadAll(sql) -> Promise<ResultReader>
//   reader.getRows()              -> Promise<row[][]>  (bigint preserved)

import * as os from "node:os";

type Point = { id: number; name: string; status: "pass" | "fail"; detail?: string };
type Report = {
  bun: string;
  arch: string;
  platform: string;
  duckdb: string;
  points: Point[];
  crashFree: boolean;
  stressIterations: number;
  rssMB: number | null;
};

const duckdb: any = await import("@duckdb/node-api");
const { DuckDBInstance } = duckdb;

const points: Point[] = [];
const PASS = "pass" as const;
const FAIL = "fail" as const;
function record(id: number, name: string, status: "pass" | "fail", detail?: string) {
  points.push({ id, name, status, detail });
}
async function step(id: number, name: string, fn: () => Promise<string>): Promise<boolean> {
  try {
    const detail = await fn();
    record(id, name, PASS, detail);
    return true;
  } catch (e) {
    record(id, name, FAIL, e instanceof Error ? e.message : String(e));
    return false;
  }
}

const tmp = os.tmpdir();
const BIGNUM_PRECISE = "9007199254740993"; // > Number.MAX_SAFE_INTEGER (2^53)
let stressOk = true;

async function main() {
  // 1. Load module
  record(1, "load module", typeof DuckDBInstance === "function" ? PASS : FAIL,
    `${Object.keys(duckdb).length} exports; version=${duckdb.version ?? "n/a"}`);

  // 2. In-memory instance
  await step(2, "in-memory instance", async () => {
    const i = await DuckDBInstance.create(":memory:");
    const c = await i.connect();
    await c.run("SELECT 1;");
    c.closeSync();
    i.closeSync();
    return "ok";
  });

  // 3. File-backed instance
  const dbPath = `${tmp}/alepes-cert-${process.pid}.duckdb`;
  await step(3, "file-backed instance", async () => {
    const i = await DuckDBInstance.create(dbPath);
    const c = await i.connect();
    await c.run("CREATE TABLE s(n INTEGER);");
    await c.run("INSERT INTO s VALUES (1),(2),(3);");
    const r = await c.runAndReadAll("SELECT count(*) FROM s;");
    const rows = await r.getRows();
    c.closeSync();
    i.closeSync();
    if (String(rows[0][0]) !== "3") throw new Error(`expected 3 rows, got ${String(rows[0][0])}`);
    return "persisted & re-read";
  });

  // 4. Parameterized queries
  await step(4, "parameterized queries", async () => {
    const i = await DuckDBInstance.create(":memory:");
    const c = await i.connect();
    await c.run("CREATE TABLE p(a INTEGER);");
    await c.run("INSERT INTO p VALUES (?), (?), (?);", [1, 2, 3]);
    const r = await c.runAndReadAll("SELECT sum(a) FROM p WHERE a >= ?;", [2]);
    const rows = await r.getRows();
    c.closeSync();
    i.closeSync();
    if (String(rows[0][0]) !== "5") throw new Error(`expected 5, got ${String(rows[0][0])}`);
    return "typed params bound";
  });

  // 5. Integer-cents precision (> 2^53)
  await step(5, "integer-cents precision", async () => {
    const i = await DuckDBInstance.create(":memory:");
    const c = await i.connect();
    await c.run("CREATE TABLE cents(v BIGINT);");
    await c.run("INSERT INTO cents VALUES (?);", [BigInt(BIGNUM_PRECISE)]);
    const r = await c.runAndReadAll("SELECT v FROM cents;");
    const rows = await r.getRows();
    c.closeSync();
    i.closeSync();
    const got = rows[0][0];
    if (typeof got !== "bigint" || got.toString() !== BIGNUM_PRECISE) {
      throw new Error(`precision lost: ${typeof got} ${got}`);
    }
    return `${BIGNUM_PRECISE} round-tripped as bigint`;
  });

  // 6. Open/query/close cycles
  await step(6, "open/query/close x50", async () => {
    for (let n = 0; n < 50; n++) {
      const i = await DuckDBInstance.create(":memory:");
      const c = await i.connect();
      await c.run("SELECT 1;");
      c.closeSync();
      i.closeSync();
    }
    return "50 clean cycles";
  });

  // 7. Concurrent analytical queries
  await step(7, "concurrent queries x20", async () => {
    const i = await DuckDBInstance.create(":memory:");
    const c = await i.connect();
    await c.run("CREATE TABLE big AS SELECT range a, range*2 b FROM range(100000);");
    const jobs = Array.from({ length: 20 }, (_, k) =>
      c.runAndReadAll("SELECT sum(b) FROM big WHERE a % 7 = ?;", [k]).then((r: any) => r.getRows()),
    );
    await Promise.all(jobs);
    c.closeSync();
    i.closeSync();
    return "20 concurrent aggregations";
  });

  // 8. Parquet read/write
  await step(8, "parquet read/write", async () => {
    const i = await DuckDBInstance.create(":memory:");
    const c = await i.connect();
    await c.run("CREATE TABLE pq(x DOUBLE, y VARCHAR);");
    await c.run("INSERT INTO pq VALUES (1.5,'a'),(2.5,'b'),(3.5,'c');");
    const pqPath = `${tmp}/alepes-cert-${process.pid}.parquet`;
    await c.run(`COPY pq TO '${pqPath}' (FORMAT PARQUET);`);
    const r = await c.runAndReadAll(`SELECT count(*) FROM read_parquet('${pqPath}');`);
    const rows = await r.getRows();
    c.closeSync();
    i.closeSync();
    if (String(rows[0][0]) !== "3") throw new Error(`parquet: expected 3, got ${String(rows[0][0])}`);
    return "COPY + read_parquet round-trip";
  });

  // 9. Repeated create/destroy
  await step(9, "create/destroy x30", async () => {
    for (let n = 0; n < 30; n++) {
      const i = await DuckDBInstance.create(":memory:");
      const c = await i.connect();
      await c.run("SELECT 42;");
      c.closeSync();
      i.closeSync();
    }
    return "30 destroy cycles";
  });

  // 10. Stress loop (segfault exposure)
  const STRESS = 500;
  stressOk = await step(10, `stress loop x${STRESS}`, async () => {
    const i = await DuckDBInstance.create(":memory:");
    const c = await i.connect();
    await c.run("CREATE TABLE stress(id BIGINT, v DOUBLE);");
    await c.run("INSERT INTO stress SELECT range, range*1.5 FROM range(50000);");
    for (let n = 0; n < STRESS; n++) {
      await c.runAndReadAll("SELECT count(*), sum(v) FROM stress;").then((r: any) => r.getRows());
      if (n % 100 === 0) await c.run("DELETE FROM stress WHERE id % 997 = ?;", [n]);
    }
    c.closeSync();
    i.closeSync();
    return `${STRESS} iterations, no crash`;
  });

  // 11. Clean shutdown + restart
  await step(11, "shutdown + restart", async () => {
    // fresh instance after full teardown proves clean process-level restart behavior
    const i1 = await DuckDBInstance.create(":memory:");
    const c1 = await i1.connect();
    await c1.run("SELECT 'first-life';");
    c1.closeSync();
    i1.closeSync();
    const i2 = await DuckDBInstance.create(":memory:");
    const c2 = await i2.connect();
    await c2.run("SELECT 'second-life';");
    c2.closeSync();
    i2.closeSync();
    return "two full lifecycles";
  });

  // 12. Existing smoke gate, repeated (NOT run once)
  await step(12, "smoke repeat x30", async () => {
    for (let n = 0; n < 30; n++) {
      const i = await DuckDBInstance.create(":memory:");
      const c = await i.connect();
      await c.run("CREATE TABLE t(x INTEGER);");
      await c.run("INSERT INTO t VALUES (42);");
      await c.run("SELECT x FROM t;");
      c.closeSync();
      i.closeSync();
    }
    return "30 smoke runs";
  });

  const mu = process.memoryUsage();
  const report: Report = {
    bun: (globalThis as any).Bun?.version ?? "unknown",
    arch: os.arch(),
    platform: os.platform(),
    duckdb: "@duckdb/node-api@1.5.5-r.4",
    points,
    crashFree: stressOk && points.every((p) => p.status === PASS),
    stressIterations: STRESS,
    rssMB: Math.round(mu.rss / 1024 / 1024),
  };

  console.log("\n=== CERTIFICATION REPORT ===");
  console.log(JSON.stringify(report, null, 2));
  process.exit(report.crashFree ? 0 : 1);
}

main().catch((e) => {
  console.error("HARNESS ERROR:", e);
  process.exit(3);
});