/**
 * Copy live attachment bytes and eligible historical brochures to S3.
 *   node --import tsx scripts/migrate-attachments-to-s3.ts
 *   node --import tsx scripts/migrate-attachments-to-s3.ts --apply
 *
 * --apply requires BONTE_S3_MIGRATE_CONFIRM=<bucket>. Does not delete output/.
 */
import "dotenv/config";
import { initializeWorkflowStore, type WorkflowStore } from "../src/workflows/store.js";
import { SessionStore } from "../src/gateway/session.js";
import { attachmentObjectKey } from "../src/workflows/documents-attachments.js";
import { migrateAttachmentsToS3, migrationFailed } from "../src/workflows/migrate-attachments-s3.js";

const apply = process.argv.includes("--apply");

async function main() {
  const bucket = process.env.BONTE_S3_BUCKET?.trim();
  if (!bucket || !(process.env.BONTE_S3_REGION?.trim() || process.env.AWS_REGION?.trim())) {
    throw new Error("Set BONTE_S3_BUCKET and BONTE_S3_REGION before migrating.");
  }
  if (apply && process.env.BONTE_S3_MIGRATE_CONFIRM !== bucket) {
    throw new Error("Refusing --apply without BONTE_S3_MIGRATE_CONFIRM set to the destination bucket name.");
  }
  let store: WorkflowStore | undefined;
  let sessions: SessionStore | undefined;
  try {
    store = await initializeWorkflowStore();
    sessions = new SessionStore({
      databaseUrl: process.env.DATABASE_URL,
      databaseHost: process.env.DATABASE_HOST,
      databasePort: process.env.DATABASE_PORT ? Number(process.env.DATABASE_PORT) : undefined,
      databaseName: process.env.DATABASE_NAME,
      databaseUser: process.env.DATABASE_USER,
      databasePassword: process.env.DATABASE_PASSWORD,
      allowInMemory: false,
    });
    if (process.env.DATABASE_URL || process.env.DATABASE_HOST) await sessions.connect();
    const proofs = await sessions.listLegacyBrochureProofs();
    const summary = await migrateAttachmentsToS3({ store, apply, proofs });
    console.log(JSON.stringify({
      apply,
      bucket,
      objectKeyExample: attachmentObjectKey("workspace-id", "00000000-0000-4000-8000-000000000000"),
      summary,
      note: "Rerun is safe. Local output/ (listing maps) is not deleted. Crash between PutObject and DB publish can leave S3 orphans until bucket lifecycle. Versioned buckets need version deletion to erase objects.",
    }, null, 2));
    if (migrationFailed(summary)) process.exitCode = 1;
  } finally {
    await Promise.allSettled([store?.close(), sessions?.close()]);
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : "Migration failed");
  process.exitCode = 1;
});
