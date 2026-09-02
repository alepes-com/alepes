// Simple migration runner for the Alepes PostgreSQL schema.
// Applies .sql files in lexicographic order, idempotently.

import { readFileSync, readdirSync } from "fs";
import { resolve } from "path";

export async function runMigrations(connectionString: string): Promise<void> {
  const migrationsDir = resolve(process.cwd(), "packages/persistence/migrations");
  const files = readdirSync(migrationsDir)
    .filter((f) => f.endsWith(".sql"))
    .sort();

  const { Pool } = await import("pg");
  const pool = new Pool({ connectionString });

  try {
    for (const file of files) {
      const sql = readFileSync(resolve(migrationsDir, file), "utf-8");
      await pool.query(sql);
    }
  } finally {
    await pool.end();
  }
}