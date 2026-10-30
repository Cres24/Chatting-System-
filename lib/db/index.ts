import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { env } from "@/lib/env";
import * as schema from "./schema";

type Database = NodePgDatabase<typeof schema>;

const globalForDb = globalThis as unknown as {
  chatPool?: Pool;
  chatDb?: Database;
};

function createPool(): Pool {
  if (!env.databaseUrl) {
    throw new Error(
      "DATABASE_URL is not set. Copy .env.example to .env.local and point it at a Postgres database.",
    );
  }
  const pool = new Pool({
    connectionString: env.databaseUrl,
    max: env.production ? 5 : 3,
    idleTimeoutMillis: 10_000,
    connectionTimeoutMillis: 10_000,
  });
  return pool;
}

export function getPool(): Pool {
  if (!globalForDb.chatPool) {
    globalForDb.chatPool = createPool();
  }
  return globalForDb.chatPool;
}

export function getDb(): Database {
  if (!globalForDb.chatDb) {
    globalForDb.chatDb = drizzle(getPool(), { schema });
  }
  return globalForDb.chatDb;
}

export { schema };
