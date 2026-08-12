import path from "node:path";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { db } from ".";

const globalDatabase = globalThis as typeof globalThis & {
  bonteDatabaseMigration?: Promise<void>;
};

/** Applies committed Drizzle migrations once per application process. */
export function ensureDatabaseSchema(): Promise<void> {
  if (!globalDatabase.bonteDatabaseMigration) {
    globalDatabase.bonteDatabaseMigration = migrate(db, {
      migrationsFolder: path.join(process.cwd(), "drizzle"),
    }).catch((error) => {
      globalDatabase.bonteDatabaseMigration = undefined;
      throw error;
    });
  }

  return globalDatabase.bonteDatabaseMigration;
}
