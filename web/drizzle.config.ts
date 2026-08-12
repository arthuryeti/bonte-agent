import { config } from "dotenv";
import { defineConfig } from "drizzle-kit";
import path from "node:path";
import { fileURLToPath } from "node:url";

const webDirectory = path.dirname(fileURLToPath(import.meta.url));
config({ path: path.resolve(webDirectory, "../.env") });

function databaseUrl(): string {
  if (process.env.DATABASE_URL) return process.env.DATABASE_URL;

  const host = process.env.DATABASE_HOST || "127.0.0.1";
  const port = process.env.DATABASE_PORT || "5432";
  const database = process.env.DATABASE_NAME || process.env.POSTGRES_DB || "crm_agent";
  const user = process.env.DATABASE_USER || process.env.POSTGRES_USER || "crm_agent";
  const password = process.env.DATABASE_PASSWORD || process.env.POSTGRES_PASSWORD || "";

  return `postgresql://${encodeURIComponent(user)}:${encodeURIComponent(password)}` +
    `@${host}:${port}/${encodeURIComponent(database)}`;
}

export default defineConfig({
  dialect: "postgresql",
  schema: "./lib/db/schema",
  out: "./drizzle",
  dbCredentials: {
    url: databaseUrl(),
    ssl: process.env.DATABASE_SSL === "true"
      ? {
          rejectUnauthorized:
            process.env.DATABASE_SSL_REJECT_UNAUTHORIZED !== "false",
        }
      : false,
  },
});
