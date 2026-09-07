import assert from "node:assert/strict";
import { beforeEach, afterEach, test } from "node:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import PizZip from "pizzip";
import { MemoryWorkflowStore, setWorkflowStore } from "../src/workflows/store.js";
import { attachmentPrompt, deleteAttachment, getAttachment, listAttachments, purgeExpiredAttachments, readAttachment, uploadAttachment, validateDocxArchive, type WorkflowAttachment } from "../src/workflows/documents-attachments.js";
import { generateNdaDraft, ndaConfigSchema, renderNdaDocx, saveEmailDraft, updateNdaIntake, validateNdaFacts, type NdaFact } from "../src/workflows/documents.js";

const context = { workspaceId: "test-workspace", actorId: "test-workspace", conversationId: "test-conversation" };
const mime = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
let directory: string;
let store: MemoryWorkflowStore;
let oldEnv: NodeJS.ProcessEnv;
let originalFetch: typeof globalThis.fetch;

function docx(text: string) {
  const zip = new PizZip();
  zip.file("[Content_Types].xml", '<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>');
  zip.file("_rels/.rels", '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>');
  zip.file("word/document.xml", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${text.split("\n").map((line) => `<w:p><w:r><w:t xml:space="preserve">${line.replaceAll("&", "&amp;").replaceAll("<", "&lt;")}</w:t></w:r></w:p>`).join("")}<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440"/></w:sectPr></w:body></w:document>`);
  return zip.generate({ type: "nodebuffer", compression: "DEFLATE" });
}
const config = ndaConfigSchema.parse({ version: "test-v1", templatePath: "template.docx", requiredDocuments: [
  { category: "party", label: "party identification", minimum: 1 }, { category: "transaction", label: "transaction details", minimum: 1 },
], fields: [
  { key: "party_name", label: "party name", source: "party" },
  { key: "transaction", label: "transaction purpose", source: "transaction" },
  { key: "language", label: "agreement language", source: "agreement", allowedValues: ["English", "Portuguese"] },
] });

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "bonte-document-test-"));
  oldEnv = { ...process.env };
  originalFetch = globalThis.fetch;
  process.env.BONTE_ATTACHMENT_DIR = join(directory, "private");
  delete process.env.BONTE_NDA_CONFIG_PATH;
  store = new MemoryWorkflowStore(); setWorkflowStore(store);
});
afterEach(async () => {
  globalThis.fetch = originalFetch;
  for (const name of Object.keys(process.env)) if (!(name in oldEnv)) delete process.env[name];
  Object.assign(process.env, oldEnv);
  await rm(directory, { recursive: true, force: true });
});

async function configure() {
  await writeFile(join(directory, "template.docx"), docx("Bonte agreement\nParty: {party_name}\nPurpose: {transaction}\nLanguage: {language}\nThe original confidentiality clause remains unchanged.\nSignature ____________________"));
  await writeFile(join(directory, "config.json"), JSON.stringify(config));
  process.env.BONTE_NDA_CONFIG_PATH = join(directory, "config.json");
}
async function evidence() {
  const party = await uploadAttachment(context, { fileName: "party.docx", mimeType: mime, bytes: docx("Party legal name: Example Holdings Ltd"), category: "party" });
  const transaction = await uploadAttachment(context, { fileName: "transaction.docx", mimeType: mime, bytes: docx("Transaction purpose: Purchase of property TEST123"), category: "transaction" });
  const facts: NdaFact[] = [
    { key: "party_name", value: "Example Holdings Ltd", source: { type: "document", attachmentId: party.id, page: 1, quote: "Party legal name: Example Holdings Ltd" } },
    { key: "transaction", value: "Purchase of property TEST123", source: { type: "document", attachmentId: transaction.id, page: 1, quote: "Transaction purpose: Purchase of property TEST123" } },
    { key: "language", value: "English", source: { type: "agreement", userStatement: "Please draft the agreement in English." } },
  ];
  return { party, transaction, facts };
}

test("uploads retain readable document evidence and enforce workspace, actor and conversation access", async () => {
  const { party } = await evidence();
  assert.equal(party.pages[0].locator, "text-block");
  assert.match(party.pages[0].text, /Example Holdings/);
  assert.equal((await readAttachment(context, party.id)).bytes.length, party.size);
  await assert.rejects(() => getAttachment({ ...context, workspaceId: "other-user" }, party.id), /not found/);
  await assert.rejects(() => getAttachment({ ...context, actorId: "other-actor" }, party.id), /not found/);
  await assert.rejects(() => getAttachment({ ...context, conversationId: "other-chat" }, party.id, true), /not found/);
  assert.equal((await listAttachments({ ...context, conversationId: "other-chat" })).length, 0);
  const prompt = await attachmentPrompt(context, [party.id]);
  assert.ok(prompt.includes(party.id));
  assert.ok(!prompt.includes("Example Holdings"), "The prompt contains metadata only, not private extracted text.");
});

test("invalid file names, spoofed PDFs and expanded DOCX bombs are rejected", async () => {
  await assert.rejects(() => uploadAttachment(context, { fileName: "../party.docx", mimeType: mime, bytes: docx("Safe sample"), category: "party" }), /file name/);
  await assert.rejects(() => uploadAttachment(context, { fileName: "fake.pdf", mimeType: "application/pdf", bytes: Buffer.from("not actually a PDF document"), category: "party" }), /contents/);
  const archive = docx("Safe sample");
  const central = archive.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
  archive.writeUInt32LE(60 * 1024 * 1024, central + 24);
  assert.throws(() => validateDocxArchive(archive), /Expanded DOCX/);
});

test("deletion and retention remove document bytes and extracted evidence", async () => {
  const { party, transaction } = await evidence();
  await deleteAttachment(context, party.id);
  assert.equal(await store.get(context.workspaceId, "attachment", party.id), null);
  await assert.rejects(() => readAttachment(context, party.id), /not found/);
  await store.put(context.workspaceId, "attachment", transaction.id, { ...transaction, expiresAt: "2000-01-01T00:00:00.000Z" });
  await store.put(context.workspaceId, "nda-intake", context.conversationId, { facts: [{ value: "private" }], expiresAt: "2000-01-01T00:00:00.000Z" });
  assert.equal(await purgeExpiredAttachments(context.workspaceId), 1);
  assert.equal(await store.get(context.workspaceId, "attachment", transaction.id), null);
  assert.equal(await store.get(context.workspaceId, "nda-intake", context.conversationId), null);
});

test("NDA creation requires Bonte configuration and both supporting document categories", async () => {
  assert.equal((await updateNdaIntake(context)).status, "setup_required");
  await configure();
  const check = await updateNdaIntake(context);
  assert.equal(check.status, "needs_input");
  assert.ok("issues" in check && check.issues?.some((issue) => issue.includes("party identification")));
  assert.ok("issues" in check && check.issues?.some((issue) => issue.includes("transaction details")));
  assert.equal((await listAttachments(context)).length, 0);
});

test("NDA facts need exact source quotations and explicit agreement choices", async () => {
  const { party, transaction, facts } = await evidence();
  assert.deepEqual(validateNdaFacts(config, facts, [party, transaction]), []);
  const invented = structuredClone(facts); invented[0].value = "Invented Company Ltd";
  assert.match(validateNdaFacts(config, invented, [party, transaction]).join(" "), /not supported/);
  const missingChoice = structuredClone(facts); missingChoice[2].source = { type: "agreement", userStatement: "Please prepare the NDA." };
  assert.match(validateNdaFacts(config, missingChoice, [party, transaction]).join(" "), /explicit user choice/);
  const unreadable: WorkflowAttachment = { ...party, pages: [{ ...party.pages[0], readable: false, text: "" }] };
  assert.match(validateNdaFacts(config, facts, [unreadable, transaction]).join(" "), /readable/);
});

test("conflicting NDA facts persist across turns until explicitly resolved", async () => {
  await configure();
  const { facts } = await evidence();
  assert.equal((await updateNdaIntake(context, { facts })).status, "ready_to_draft");
  const conflict: NdaFact = { key: "language", value: "Portuguese", source: { type: "agreement", userStatement: "Use Portuguese." } };
  const check = await updateNdaIntake(context, { facts: [conflict] });
  assert.equal(check.status, "needs_input");
  assert.ok("issues" in check && check.issues?.some((issue) => issue.includes("Conflicting")));
  assert.equal((await updateNdaIntake(context)).status, "needs_input");
  assert.equal((await updateNdaIntake(context, { facts: [conflict], resolveFields: ["language"] })).status, "ready_to_draft");
});

test("template substitution keeps legal clauses and signature block and rejects unconfigured placeholders", async () => {
  await configure();
  const { facts } = await evidence();
  const template = await readFile(join(directory, "template.docx"));
  const output = renderNdaDocx(template, config, facts);
  const xml = new PizZip(output).file("word/document.xml")!.asText();
  assert.match(xml, /Example Holdings Ltd/);
  assert.match(xml, /The original confidentiality clause remains unchanged\./);
  assert.match(xml, /Signature ____________________/);
  assert.ok(!xml.includes("{party_name}"));
  assert.throws(() => renderNdaDocx(docx("{unapproved_clause}"), config, facts), /unconfigured placeholders/);
});

test("an unavailable NDA renderer does not publish a completed draft or generated files", async () => {
  await configure();
  const { facts } = await evidence();
  await updateNdaIntake(context, { facts });
  process.env.BONTE_LIBREOFFICE_PATH = join(directory, "missing-renderer");
  await assert.rejects(() => generateNdaDraft(context), /No completed NDA draft/);
  assert.equal((await listAttachments(context)).filter((attachment) => attachment.generated).length, 0);
  assert.equal((await store.list(context.workspaceId, "nda-draft")).length, 0);
});

test("email revisions retain recipient and attachments, preserve previous versions and never send", async () => {
  const { party } = await evidence();
  const original = await saveEmailDraft(context, { recipient: "buyer@example.invalid", subject: "Your enquiry", body: "Thank you for your enquiry.", attachmentIds: [party.id] });
  const revised = await saveEmailDraft(context, { previousDraftId: original.id, body: "Thank you for sharing your plans with us." });
  assert.equal(revised.recipient, "buyer@example.invalid");
  assert.deepEqual(revised.attachmentIds, [party.id]);
  assert.equal(revised.revision, 2);
  assert.equal(revised.sent, false);
  assert.equal(revised.rootDraftId, original.id);
  const originalFile = await readAttachment(context, original.downloadAttachmentId);
  assert.match(originalFile.bytes.toString(), /Thank you for your enquiry\./);
  await assert.rejects(() => saveEmailDraft({ ...context, workspaceId: "another-workspace" }, { previousDraftId: original.id, body: "Attempt" }), /not found/);
});

test("property email uses exact identity, verified URLs and keeps source snapshots across edits", async () => {
  process.env.CRM_LISTING_URLS_JSON = JSON.stringify([{ propertyId: 77, reference: "TEST123", url: "https://example.invalid/listing/verified", verifiedAt: "2026-09-07T00:00:00Z" }]);
  globalThis.fetch = async () => new Response(JSON.stringify({ Success: true, PropertyList: [{ id: 77, reference: "TEST123", price: 1_000_000 }], TotalPages: 1, TotalRecords: 1 }), { status: 200, headers: { "content-type": "application/json" } });
  const draft = await saveEmailDraft(context, { subject: "Your property shortlist", body: "TEST123: https://example.invalid/listing/verified", properties: [{ reference: "TEST123" }] });
  assert.equal(draft.properties[0].propertyId, 77);
  await assert.rejects(() => saveEmailDraft(context, { previousDraftId: draft.id, body: "TEST123: https://example.invalid/invented-slug" }), /unverified link/);
  await assert.rejects(() => saveEmailDraft(context, { previousDraftId: draft.id, body: "Here is a completely different house." }), /exact reference/);
  const revised = await saveEmailDraft(context, { previousDraftId: draft.id, body: "I thought TEST123 would suit your plans: https://example.invalid/listing/verified" });
  assert.deepEqual(revised.properties, draft.properties);
});
