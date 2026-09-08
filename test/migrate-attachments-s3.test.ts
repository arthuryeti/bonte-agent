import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import { MemoryWorkflowStore, setWorkflowStore } from "../src/workflows/store.js";
import {
  deleteAttachment,
  deleteAttachmentBytes,
  getAttachmentBytes,
  purgeExpiredAttachments,
  putAttachmentBytes,
  saveGeneratedAttachment,
  type WorkflowAttachment,
} from "../src/workflows/documents-attachments.js";
import { migrateAttachmentsToS3, migrationFailed, type BrochureProof } from "../src/workflows/migrate-attachments-s3.js";
import { applyTestS3Env, ensureTestS3 } from "./s3-harness.js";

const now = Date.parse("2026-09-08T12:00:00.000Z");
const liveExp = "2026-10-01T00:00:00.000Z";
const oldEnv = { ...process.env };

afterEach(() => {
  for (const name of Object.keys(process.env)) if (!(name in oldEnv)) delete process.env[name];
  Object.assign(process.env, oldEnv);
});

function sha256(bytes: Buffer) {
  return createHash("sha256").update(bytes).digest("hex");
}

function id(n: string) {
  return `00000000-0000-4000-8000-${n.padStart(12, "0")}`;
}

function row(workspaceId: string, attachmentId: string, bytes: Buffer, extra: Partial<WorkflowAttachment> = {}): WorkflowAttachment {
  return {
    id: attachmentId, conversationId: `${workspaceId}_chat`, actorId: workspaceId, fileName: "note.pdf",
    mimeType: "application/pdf", category: "generated", size: bytes.length, sha256: sha256(bytes),
    createdAt: "2026-08-01T00:00:00.000Z", expiresAt: liveExp, pages: [], warnings: [], generated: true, ...extra,
  };
}

async function localFile(root: string, workspaceId: string, attachmentId: string, bytes: Buffer) {
  const dir = join(root, createHash("sha256").update(workspaceId).digest("hex"));
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, attachmentId), bytes);
}

async function listen(): Promise<{ port: number; close: () => void }> {
  const server = createServer((_req, res) => { res.writeHead(500).end("no"); });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("listen");
  return { port: address.port, close: () => server.close() };
}

test("test S3 env ignores production credentials and rejects non-loopback endpoints", () => {
  process.env.BONTE_S3_ENDPOINT = "https://s3.amazonaws.com";
  process.env.BONTE_S3_BUCKET = "production-bucket";
  process.env.BONTE_S3_REGION = "eu-west-1";
  process.env.AWS_ACCESS_KEY_ID = "AKIAPRODUCTION";
  process.env.AWS_SECRET_ACCESS_KEY = "production-secret";
  process.env.AWS_SESSION_TOKEN = "production-token";
  process.env.AWS_PROFILE = "prod";
  const applied = applyTestS3Env();
  assert.equal(applied.endpoint, "http://127.0.0.1:19000");
  assert.equal(applied.bucket, "bonte-test-attachments");
  assert.equal(process.env.BONTE_S3_BUCKET, "bonte-test-attachments");
  assert.equal(process.env.AWS_ACCESS_KEY_ID, "minioadmin");
  assert.equal(process.env.AWS_SESSION_TOKEN, undefined);
  process.env.BONTE_TEST_S3_ENDPOINT = "https://s3.amazonaws.com";
  assert.throws(() => applyTestS3Env(), /loopback/);
});

test("dry-run, apply and rerun copy only live matching bytes and leave failures in place", async () => {
  await ensureTestS3();
  const store = new MemoryWorkflowStore();
  setWorkflowStore(store);
  const root = await mkdtemp(join(tmpdir(), "bonte-mig-"));
  const live = Buffer.from("%PDF-1.4 live");
  const mismatch = Buffer.from("%PDF-1.4 local-mismatch");
  const remoteWrong = Buffer.from("%PDF-1.4 remote-wrong");
  const already = Buffer.from("%PDF-1.4 already");
  const ws = "ws-a";
  await store.put(ws, "attachment", id("1"), row(ws, id("1"), live));
  await localFile(root, ws, id("1"), live);
  await store.put(ws, "attachment", id("2"), row(ws, id("2"), live, { expiresAt: "2026-01-01T00:00:00.000Z" }));
  await localFile(root, ws, id("2"), live);
  await store.put(ws, "attachment", id("3"), row(ws, id("3"), live, { expiresAt: "not-a-date" }));
  await store.put(ws, "attachment", id("4"), row(ws, id("4"), live));
  await store.put(ws, "attachment", id("5"), row(ws, id("5"), mismatch));
  await localFile(root, ws, id("5"), Buffer.from("%PDF-1.4 corrupt"));
  await store.put(ws, "attachment", id("6"), row(ws, id("6"), live));
  await localFile(root, ws, id("6"), live);
  await putAttachmentBytes(ws, id("6"), remoteWrong);
  await store.put(ws, "attachment", id("7"), row(ws, id("7"), already));
  await putAttachmentBytes(ws, id("7"), already);
  try {
    const dry = await migrateAttachmentsToS3({ store, apply: false, now, localRoot: root });
    assert.equal(dry.scanned, 7);
    assert.equal(dry.wouldCopy, 1);
    assert.equal(dry.copied, 0);
    assert.equal(dry.skippedExpired, 1);
    assert.equal(dry.invalidExpiry, 1);
    assert.equal(dry.missingLocal, 1);
    assert.equal(dry.hashMismatch, 1);
    assert.equal(dry.remoteMismatch, 1);
    assert.equal(dry.alreadyOnS3, 1);
    await assert.rejects(() => getAttachmentBytes(ws, id("1")), /not found/);
    assert.equal(migrationFailed(dry), true);
    const applied = await migrateAttachmentsToS3({ store, apply: true, now, localRoot: root });
    assert.equal(applied.copied, 1);
    assert.equal(applied.wouldCopy, 0);
    assert.deepEqual(await getAttachmentBytes(ws, id("1")), live);
    assert.deepEqual(await getAttachmentBytes(ws, id("6")), remoteWrong);
    assert.deepEqual(await getAttachmentBytes(ws, id("7")), already);
    assert.ok(await store.get(ws, "attachment", id("2")));
    assert.ok(await store.get(ws, "attachment", id("3")));
    const rerun = await migrateAttachmentsToS3({ store, apply: true, now, localRoot: root });
    assert.equal(rerun.copied, 0);
    assert.equal(rerun.alreadyOnS3, 2);
    assert.equal(rerun.wouldCopy, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
    for (const n of ["1", "6", "7"]) await deleteAttachmentBytes(ws, id(n)).catch(() => undefined);
  }
});

test("remote access errors skip copy and do not delete locators", async () => {
  await ensureTestS3();
  const store = new MemoryWorkflowStore();
  setWorkflowStore(store);
  const root = await mkdtemp(join(tmpdir(), "bonte-mig-err-"));
  const live = Buffer.from("%PDF-1.4 remote-error");
  const ws = "ws-err";
  await store.put(ws, "attachment", id("1"), row(ws, id("1"), live));
  await localFile(root, ws, id("1"), live);
  const server = await listen();
  const saved = process.env.BONTE_TEST_S3_ENDPOINT;
  try {
    process.env.BONTE_TEST_S3_ENDPOINT = `http://127.0.0.1:${server.port}`;
    applyTestS3Env();
    const summary = await migrateAttachmentsToS3({ store, apply: true, now, localRoot: root });
    assert.equal(summary.remoteError, 1);
    assert.equal(summary.copied, 0);
    assert.ok(await store.get(ws, "attachment", id("1")));
    assert.equal(migrationFailed(summary), true);
  } finally {
    if (saved === undefined) delete process.env.BONTE_TEST_S3_ENDPOINT;
    else process.env.BONTE_TEST_S3_ENDPOINT = saved;
    applyTestS3Env();
    server.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("legacy brochures use oldest proof, skip unproven/foreign/expired, and do not revive deletions", async () => {
  await ensureTestS3();
  const store = new MemoryWorkflowStore();
  setWorkflowStore(store);
  const pdfDir = await mkdtemp(join(tmpdir(), "bonte-pdf-"));
  const bytes = Buffer.from("%PDF-1.4 owned-brochure");
  const owned = "property-owned.pdf";
  const expiredName = "property-expired.pdf";
  const unproven = "property-unproven.pdf";
  await writeFile(join(pdfDir, owned), bytes);
  await writeFile(join(pdfDir, expiredName), bytes);
  await writeFile(join(pdfDir, unproven), bytes);
  await writeFile(join(pdfDir, "property-missing.pdf"), Buffer.from("not-a-pdf"));
  process.env.BONTE_ATTACHMENT_RETENTION_DAYS = "30";
  const oldest = new Date(now - 10 * 86_400_000);
  const recent = new Date(now - 2 * 86_400_000);
  const proofs: BrochureProof[] = [
    { workspaceId: "owner", fileName: owned, chatId: "owner_historical", timestamp: oldest },
    { workspaceId: "owner", fileName: expiredName, chatId: "owner_old", timestamp: new Date(now - 40 * 86_400_000) },
    { workspaceId: "other", fileName: owned, chatId: "other_chat", timestamp: oldest },
    { workspaceId: "owner", fileName: "property-missing.pdf", chatId: "owner_missing", timestamp: oldest },
  ];
  const withDuplicate: BrochureProof[] = [
    ...proofs,
    { workspaceId: "owner", fileName: owned, chatId: "owner_later", timestamp: recent },
  ];
  try {
    const dry = await migrateAttachmentsToS3({ store, apply: false, now, pdfDir, proofs });
    assert.equal(dry.brochuresScanned, 4);
    assert.equal(dry.brochuresWouldCopy, 2);
    assert.equal(dry.brochuresCopied, 0);
    const applied = await migrateAttachmentsToS3({ store, apply: true, now, pdfDir, proofs: withDuplicate });
    assert.equal(applied.brochuresCopied, 2);
    const mapping = await store.get("owner", "generated_file", owned);
    assert.equal(mapping?.data.migratedFromHistory, true);
    const attachmentId = String(mapping?.data.attachmentId);
    const record = await store.get<WorkflowAttachment>("owner", "attachment", attachmentId);
    assert.equal(record?.data.createdAt, oldest.toISOString());
    assert.ok(Math.abs(Date.parse(String(record?.data.expiresAt)) - oldest.getTime() - 30 * 86_400_000) < 2000);
    assert.deepEqual(await getAttachmentBytes("owner", attachmentId), bytes);
    assert.equal(await store.get("owner", "generated_file", unproven), null);
    assert.equal(await store.get("owner", "generated_file", expiredName), null);
    await deleteAttachment({ workspaceId: "owner", actorId: "owner", conversationId: "owner_historical" }, attachmentId);
    const rerun = await migrateAttachmentsToS3({ store, apply: true, now, pdfDir, proofs: withDuplicate });
    assert.equal(rerun.brochuresCopied, 0);
    assert.equal(String((await store.get("owner", "generated_file", owned))?.data.attachmentId), attachmentId);
    await assert.rejects(() => getAttachmentBytes("owner", attachmentId), /not found/);
  } finally {
    await rm(pdfDir, { recursive: true, force: true });
  }
});

test("failed mapping publish rolls back new S3 writes", async () => {
  await ensureTestS3();
  const store = new MemoryWorkflowStore();
  setWorkflowStore(store);
  const pdfDir = await mkdtemp(join(tmpdir(), "bonte-pdf-rb-"));
  const fileName = "property-rollback.pdf";
  await writeFile(join(pdfDir, fileName), Buffer.from("%PDF-1.4 rollback"));
  const create = store.create.bind(store);
  store.create = async (scope, kind, idValue, data) => {
    if (kind === "generated_file") throw new Error("mapping publish failed");
    return create(scope, kind, idValue, data);
  };
  try {
    const summary = await migrateAttachmentsToS3({
      store, apply: true, now, pdfDir,
      proofs: [{ workspaceId: "owner", fileName, chatId: "owner_chat", timestamp: new Date(now - 86_400_000) }],
    });
    assert.equal(summary.errors, 1);
    assert.equal(summary.brochuresCopied, 0);
    assert.equal(await store.get("owner", "generated_file", fileName), null);
    assert.equal((await store.scan("attachment", 10, undefined, "owner")).length, 0);
  } finally {
    store.create = create;
    await rm(pdfDir, { recursive: true, force: true });
  }
});

test("metadata publish failure deletes the new S3 object", async () => {
  await ensureTestS3();
  const store = new MemoryWorkflowStore();
  setWorkflowStore(store);
  const put = store.put.bind(store);
  const seen: string[] = [];
  store.put = async (scope, kind, idValue, data) => {
    if (kind === "attachment") {
      seen.push(idValue);
      throw new Error("metadata publish failed");
    }
    return put(scope, kind, idValue, data);
  };
  await assert.rejects(
    () => saveGeneratedAttachment(
      { workspaceId: "ws-rb", actorId: "ws-rb", conversationId: "ws-rb_chat" },
      { fileName: "note.txt", mimeType: "text/plain; charset=utf-8", bytes: Buffer.from("hi") },
    ),
    /metadata publish failed/,
  );
  assert.equal(seen.length, 1);
  await assert.rejects(() => getAttachmentBytes("ws-rb", seen[0]), /not found/);
});

test("failed remote deletion keeps locator metadata", async () => {
  await ensureTestS3();
  const store = new MemoryWorkflowStore();
  setWorkflowStore(store);
  const ctx = { workspaceId: "ws-keep", actorId: "ws-keep", conversationId: "ws-keep_chat" };
  const saved = await saveGeneratedAttachment(ctx, { fileName: "keep.txt", mimeType: "text/plain; charset=utf-8", bytes: Buffer.from("keep") });
  await store.put(ctx.workspaceId, "attachment", saved.id, { ...saved, expiresAt: "2000-01-01T00:00:00.000Z" });
  const server = await listen();
  const savedEndpoint = process.env.BONTE_TEST_S3_ENDPOINT;
  try {
    process.env.BONTE_TEST_S3_ENDPOINT = `http://127.0.0.1:${server.port}`;
    applyTestS3Env();
    assert.equal(await purgeExpiredAttachments(ctx.workspaceId), 0);
    assert.ok(await store.get(ctx.workspaceId, "attachment", saved.id));
  } finally {
    if (savedEndpoint === undefined) delete process.env.BONTE_TEST_S3_ENDPOINT;
    else process.env.BONTE_TEST_S3_ENDPOINT = savedEndpoint;
    applyTestS3Env();
    server.close();
    await deleteAttachmentBytes(ctx.workspaceId, saved.id).catch(() => undefined);
  }
});
