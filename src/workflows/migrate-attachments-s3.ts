import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { WorkflowStore } from "./store.js";
import {
  deleteAttachmentBytes,
  documentExpiry,
  DocumentWorkflowError,
  getAttachmentBytes,
  MAX_ATTACHMENT_BYTES,
  putAttachmentBytes,
  type WorkflowAttachment,
} from "./documents-attachments.js";

export interface BrochureProof {
  workspaceId: string;
  fileName: string;
  chatId: string;
  timestamp: Date;
}

export interface MigrationSummary {
  scanned: number;
  skippedExpired: number;
  invalidExpiry: number;
  alreadyOnS3: number;
  wouldCopy: number;
  copied: number;
  missingLocal: number;
  hashMismatch: number;
  remoteMismatch: number;
  remoteError: number;
  brochuresScanned: number;
  brochuresWouldCopy: number;
  brochuresCopied: number;
  brochuresSkipped: number;
  errors: number;
}

function sha256(bytes: Buffer) {
  return createHash("sha256").update(bytes).digest("hex");
}
function matchesRecord(bytes: Buffer, size: number, digest: string) {
  return bytes.length === size && sha256(bytes) === digest;
}

async function readLocalFile(path: string) {
  try {
    const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const stat = await file.stat();
      if (!stat.isFile() || stat.size < 1 || stat.size > MAX_ATTACHMENT_BYTES) return;
      return await file.readFile();
    } finally {
      await file.close();
    }
  } catch (error) {
    const code = error && typeof error === "object" && "code" in error ? String(error.code) : "";
    if (code === "ENOENT") return;
    throw error;
  }
}

async function discardPublished(store: WorkflowStore, workspaceId: string, id: string) {
  try {
    await deleteAttachmentBytes(workspaceId, id);
  } catch {
    return;
  }
  await store.remove(workspaceId, "attachment", id).catch(() => undefined);
}

export async function migrateAttachmentsToS3(options: {
  store: WorkflowStore;
  apply: boolean;
  now?: number;
  localRoot?: string;
  pdfDir?: string;
  proofs?: BrochureProof[];
}): Promise<MigrationSummary> {
  const now = options.now ?? Date.now();
  const localRoot = resolve(options.localRoot ?? (process.env.BONTE_ATTACHMENT_DIR || "output/private/attachments"));
  const pdfDir = resolve(options.pdfDir ?? "output/pdf");
  const summary: MigrationSummary = {
    scanned: 0, skippedExpired: 0, invalidExpiry: 0, alreadyOnS3: 0, wouldCopy: 0, copied: 0,
    missingLocal: 0, hashMismatch: 0, remoteMismatch: 0, remoteError: 0,
    brochuresScanned: 0, brochuresWouldCopy: 0, brochuresCopied: 0, brochuresSkipped: 0, errors: 0,
  };
  let after: { workspaceId: string; id: string } | undefined;
  for (;;) {
    const batch = await options.store.scan<WorkflowAttachment>("attachment", 500, after);
    if (!batch.length) break;
    after = { workspaceId: batch[batch.length - 1].workspaceId, id: batch[batch.length - 1].id };
    for (const row of batch) {
      summary.scanned++;
      try {
        const expires = Date.parse(row.data.expiresAt);
        if (!Number.isFinite(expires)) {
          summary.invalidExpiry++;
          continue;
        }
        if (expires <= now) {
          summary.skippedExpired++;
          continue;
        }
        let remote: Buffer | undefined;
        try {
          remote = await getAttachmentBytes(row.workspaceId, row.id);
        } catch (error) {
          if (!(error instanceof DocumentWorkflowError && error.status === 404)) {
            summary.remoteError++;
            continue;
          }
        }
        if (remote) {
          if (matchesRecord(remote, row.data.size, row.data.sha256)) summary.alreadyOnS3++;
          else summary.remoteMismatch++;
          continue;
        }
        const bytes = await readLocalFile(join(localRoot, createHash("sha256").update(row.workspaceId).digest("hex"), row.id));
        if (!bytes) {
          summary.missingLocal++;
          continue;
        }
        if (!matchesRecord(bytes, row.data.size, row.data.sha256)) {
          summary.hashMismatch++;
          continue;
        }
        if (!options.apply) {
          summary.wouldCopy++;
          continue;
        }
        await putAttachmentBytes(row.workspaceId, row.id, bytes);
        const check = await getAttachmentBytes(row.workspaceId, row.id);
        if (!matchesRecord(check, row.data.size, row.data.sha256)) throw new Error(`Verify failed for ${row.id}`);
        summary.copied++;
      } catch (error) {
        summary.errors++;
        console.error(row.workspaceId, row.id, error instanceof Error ? error.message : error);
      }
    }
  }

  for (const proof of options.proofs ?? []) {
    summary.brochuresScanned++;
    try {
      if (!/^property-[A-Za-z0-9][A-Za-z0-9._-]*\.pdf$/.test(proof.fileName) ||
          !/^[a-zA-Z0-9-]{1,128}$/.test(proof.workspaceId) ||
          !proof.chatId.startsWith(`${proof.workspaceId}_`)) {
        summary.brochuresSkipped++;
        continue;
      }
      const mapped = await options.store.get(proof.workspaceId, "generated_file", proof.fileName);
      if (mapped) {
        summary.brochuresSkipped++;
        continue;
      }
      const expiresAt = new Date(proof.timestamp.getTime() + Date.parse(documentExpiry()) - Date.now());
      if (!Number.isFinite(expiresAt.getTime()) || proof.timestamp.getTime() > now || expiresAt.getTime() <= now) {
        summary.brochuresSkipped++;
        continue;
      }
      const bytes = await readLocalFile(join(pdfDir, proof.fileName));
      if (!bytes || bytes.subarray(0, 5).toString() !== "%PDF-") {
        summary.missingLocal++;
        continue;
      }
      if (!options.apply) {
        summary.brochuresWouldCopy++;
        continue;
      }
      const id = randomUUID();
      const digest = sha256(bytes);
      const attachment: WorkflowAttachment = {
        id, conversationId: proof.chatId, actorId: proof.workspaceId, fileName: proof.fileName, mimeType: "application/pdf",
        category: "generated", size: bytes.length, sha256: digest, createdAt: proof.timestamp.toISOString(),
        expiresAt: expiresAt.toISOString(), pages: [], warnings: [], generated: true,
      };
      await putAttachmentBytes(proof.workspaceId, id, bytes);
      try {
        const check = await getAttachmentBytes(proof.workspaceId, id);
        if (!matchesRecord(check, bytes.length, digest)) throw new Error(`Verify failed for ${proof.fileName}`);
        await options.store.put(proof.workspaceId, "attachment", id, attachment);
      } catch (error) {
        await deleteAttachmentBytes(proof.workspaceId, id).catch(() => undefined);
        throw error;
      }
      try {
        const inserted = await options.store.create(proof.workspaceId, "generated_file", proof.fileName, {
          conversationId: proof.chatId, attachmentId: id, expiresAt: attachment.expiresAt, migratedFromHistory: true,
        });
        if (!inserted) {
          await discardPublished(options.store, proof.workspaceId, id);
          summary.brochuresSkipped++;
        } else summary.brochuresCopied++;
      } catch (error) {
        await discardPublished(options.store, proof.workspaceId, id);
        throw error;
      }
    } catch (error) {
      summary.errors++;
      console.error(proof.workspaceId, proof.fileName, error instanceof Error ? error.message : error);
    }
  }
  return summary;
}

export function migrationFailed(summary: MigrationSummary) {
  return summary.errors + summary.remoteError + summary.hashMismatch + summary.missingLocal + summary.remoteMismatch + summary.invalidExpiry > 0;
}
