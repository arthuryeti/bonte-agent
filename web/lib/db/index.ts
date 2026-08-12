import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import * as schema from "./schema";

const globalDatabase = globalThis as typeof globalThis & {
  bonteDatabasePool?: Pool;
};

function positiveInteger(value: string | undefined, fallback: number): number {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.floor(number) : fallback;
}

function createPool(): Pool {
  const connectionString = process.env.DATABASE_URL;
  const ssl = process.env.DATABASE_SSL === "true";
  const pool = new Pool({
    ...(connectionString
      ? { connectionString }
      : {
          host: process.env.DATABASE_HOST || "127.0.0.1",
          port: positiveInteger(process.env.DATABASE_PORT, 5432),
          database:
            process.env.DATABASE_NAME || process.env.POSTGRES_DB || "crm_agent",
          user:
            process.env.DATABASE_USER || process.env.POSTGRES_USER || "crm_agent",
          password:
            process.env.DATABASE_PASSWORD || process.env.POSTGRES_PASSWORD || "",
        }),
    max: positiveInteger(process.env.DATABASE_POOL_MAX, 10),
    ssl: ssl
      ? {
          rejectUnauthorized:
            process.env.DATABASE_SSL_REJECT_UNAUTHORIZED !== "false",
        }
      : undefined,
  });

  pool.on("error", (error) => {
    console.error("[Web] PostgreSQL pool error:", error);
  });

  return pool;
}

export const pool = globalDatabase.bonteDatabasePool ?? createPool();

if (process.env.NODE_ENV !== "production") {
  globalDatabase.bonteDatabasePool = pool;
}

export const db = drizzle({ client: pool, schema });
