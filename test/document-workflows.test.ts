import assert from "node:assert/strict";
import { beforeEach, afterEach, test } from "node:test";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import PizZip from "pizzip";
import { decodePDFRawStream, PDFArray, PDFDict, PDFDocument, PDFName, PDFRawStream, StandardFonts } from "pdf-lib";
import { MemoryWorkflowStore, setWorkflowStore } from "../src/workflows/store.js";
import { attachmentCategories, attachmentPrompt, classifyAttachment, deleteAttachment, getAttachment, listAttachments, purgeExpiredAttachments, readAttachment, saveGeneratedAttachment, uploadAttachment, validateDocxArchive, type WorkflowAttachment } from "../src/workflows/documents-attachments.js";
import { documentWorkflowTools } from "../src/tools/document-workflows.js";
import { runWithWorkflowContext } from "../src/workflows/context.js";
import { documentCapabilities, generateNdaDraft, listDocumentDrafts, loadNdaConfig, ndaConfigSchema, renderNdaDocx, renderNdaPdfForm, saveEmailDraft, updateNdaIntake, validateNdaFacts, type NdaFact } from "../src/workflows/documents.js";
import { ensureTestS3 } from "./s3-harness.js";

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
  await ensureTestS3();
  delete process.env.BONTE_NDA_CONFIG_PATH;
  delete process.env.BONTE_CMI_CONFIG_PATH;
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


test("uncategorized uploads can be classified from evidence while intake still asks for missing choices", async () => {
  await configure();
  const partyQuote = "Party legal name: Example Holdings Ltd";
  const transactionQuote = "Transaction purpose: Purchase of property TEST123";
  const uploaded = await uploadAttachment(context, { fileName: "scan.docx", mimeType: mime, bytes: docx(`${partyQuote}\n${transactionQuote}`) });
  assert.equal(uploaded.category, "other");
  assert.deepEqual(attachmentCategories(uploaded), []);
  const partyPage = uploaded.pages.find((page) => page.text.includes(partyQuote))!.page;
  const transactionPage = uploaded.pages.find((page) => page.text.includes(transactionQuote))!.page;
  const input = { attachmentId: uploaded.id, classifications: [
    { category: "party" as const, page: partyPage, quote: partyQuote },
    { category: "party" as const, page: partyPage, quote: "Example Holdings Ltd" },
    { category: "transaction" as const, page: transactionPage, quote: transactionQuote },
  ] };
  const facts: NdaFact[] = [
    { key: "party_name", value: "Example Holdings Ltd", source: { type: "document", attachmentId: uploaded.id, page: partyPage, quote: partyQuote } },
    { key: "transaction", value: "Purchase of property TEST123", source: { type: "document", attachmentId: uploaded.id, page: transactionPage, quote: transactionQuote } },
  ];
  assert.ok(validateNdaFacts(config, facts, [uploaded]).some((issue) => issue.includes("party identification")));
  const classify = documentWorkflowTools.find((tool) => tool.name === "classify_workflow_document")!;
  const result = JSON.parse(await runWithWorkflowContext(context, () => classify.invoke(input)) as string);
  assert.deepEqual(result.categories, ["party", "transaction"]);
  assert.ok(!("classifications" in result), "Metadata summaries must not expose source quotations.");
  const retained = await getAttachment(context, uploaded.id, true);
  assert.deepEqual(retained.classifications, input.classifications);
  const intake = await updateNdaIntake(context, { facts });
  assert.equal(intake.status, "needs_input");
  assert.deepEqual("issues" in intake && intake.issues, ["Missing agreement language."]);
  const ready = await updateNdaIntake(context, { facts: [{ key: "language", value: "English", source: { type: "agreement", userStatement: "Please use English." } }] });
  assert.equal(ready.status, "ready_to_draft");
  assert.ok(!(await attachmentPrompt(context, [uploaded.id])).includes("Example Holdings"));
  await classifyAttachment(context, { attachmentId: uploaded.id, classifications: [] });
  assert.deepEqual(attachmentCategories(await getAttachment(context, uploaded.id)), []);
  assert.equal((await updateNdaIntake(context)).status, "needs_input");
});

test("classification accepts repeated roles and validates every quote before saving", async () => {
  const uploaded = await uploadAttachment(context, { fileName: "scan.docx", mimeType: mime, bytes: docx("PASSEPORT TEST-PASSPORT-123") });
  const classifications = ["PASSEPORT", "TEST-PASSPORT-123"].map((quote) => ({
    category: "party" as const, page: uploaded.pages.find((page) => page.text.includes(quote))!.page, quote,
  }));
  const classify = documentWorkflowTools.find((tool) => tool.name === "classify_workflow_document")!;
  const invoke = (items: typeof classifications) => runWithWorkflowContext(context, async () =>
    JSON.parse(await classify.invoke({ attachmentId: uploaded.id, classifications: items }) as string));
  const result = await invoke(classifications);
  assert.deepEqual(result.categories, ["party"]);
  assert.deepEqual((await getAttachment(context, uploaded.id)).classifications, classifications);
  for (const invalid of [{ ...classifications[1], quote: "Invented evidence" }, { ...classifications[1], page: 999 }]) {
    const rejected = await invoke([classifications[0], invalid]);
    assert.equal(rejected.success, false);
    assert.match(rejected.message, /exact quote/);
    assert.deepEqual((await getAttachment(context, uploaded.id)).classifications, classifications);
  }
  const retained = await getAttachment(context, uploaded.id);
  const requiresTwo = { ...config, requiredDocuments: [{ category: "party" as const, label: "party identification", minimum: 2 }] };
  assert.ok(validateNdaFacts(requiresTwo, [], [retained]).some((issue) => issue.includes("2 readable party identification document(s); 1 available")));
});

test("classification rejects unsupported evidence, foreign documents, generated drafts and stale writes", async (t) => {
  const { party } = await evidence();
  const input = { attachmentId: party.id, classifications: [{ category: "party" as const, page: 1, quote: "Party legal name: Example Holdings Ltd" }] };
  await assert.rejects(() => classifyAttachment(context, { ...input, classifications: [{ ...input.classifications[0], quote: "Invented evidence" }] }), /exact quote/);
  await assert.rejects(() => classifyAttachment(context, { ...input, classifications: [{ ...input.classifications[0], page: 999 }] }), /readable/);
  for (const foreign of [{ workspaceId: "other" }, { actorId: "other" }, { conversationId: "other" }]) {
    await assert.rejects(() => classifyAttachment({ ...context, ...foreign }, input), /not found/);
  }
  const generated = await saveGeneratedAttachment(context, { fileName: "draft.txt", mimeType: "text/plain", bytes: Buffer.from("Party legal name: Example Holdings Ltd") });
  await assert.rejects(() => classifyAttachment(context, { ...input, attachmentId: generated.id }), /Generated documents/);
  assert.equal((await getAttachment(context, party.id)).classifications, undefined);
  t.mock.method(store, "compareAndSet", async () => false);
  await assert.rejects(() => classifyAttachment(context, input), /document changed/);
  assert.equal((await getAttachment(context, party.id)).classifications, undefined);
});

test("missing S3 configuration is a setup error and does not write local files", async () => {
  delete process.env.BONTE_S3_BUCKET;
  await assert.rejects(
    () => saveGeneratedAttachment(context, { fileName: "note.txt", mimeType: "text/plain; charset=utf-8", bytes: Buffer.from("hi") }),
    /not configured/,
  );
});
test("invalid file names, spoofed PDFs and expanded DOCX bombs are rejected", async () => {
  await assert.rejects(() => uploadAttachment(context, { fileName: "../party.docx", mimeType: mime, bytes: docx("Safe sample"), category: "party" }), /file name/);
  await assert.rejects(() => uploadAttachment(context, { fileName: "fake.pdf", mimeType: "application/pdf", bytes: Buffer.from("not actually a PDF document"), category: "party" }), /contents/);
  await assert.rejects(() => uploadAttachment(context, { fileName: "fake.webp", mimeType: "image/webp", bytes: Buffer.from("RIFFxxxxNOTW"), category: "party" }), /contents/);
  const archive = docx("Safe sample");
  const central = archive.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
  archive.writeUInt32LE(60 * 1024 * 1024, central + 24);
  assert.throws(() => validateDocxArchive(archive), /Expanded DOCX/);
});

test("PDF runtime failure is not a blank page and recovers from stored bytes", async () => {
  const pdf = Buffer.from("%PDF-1.4 test");
  const missing = join(directory, "missing-tool");
  process.env.BONTE_PDFINFO_PATH = missing;
  process.env.BONTE_PDFTOTEXT_PATH = missing;
  process.env.BONTE_PDFTOPPM_PATH = missing;
  process.env.BONTE_TESSERACT_PATH = missing;
  const uploaded = await uploadAttachment(context, { fileName: "documento.pdf", mimeType: "application/pdf", bytes: pdf, category: "other" });
  assert.equal(uploaded.pages.length, 0);
  assert.match(uploaded.warnings.join("\n"), /Poppler/);
  assert.doesNotMatch(uploaded.warnings.join("\n"), /clearer scan|insufficient text/);
  await store.put(context.workspaceId, "attachment", uploaded.id, {
    ...uploaded,
    pages: [{ page: 1, text: "", method: "text", readable: false, locator: "page" }],
    warnings: ["Text extraction is unavailable or this document is unreadable. Supply a readable document or ask the administrator to check the document runtime."],
  });
  const log = join(directory, "tool.log");
  process.env.TOOL_LOG = log;
  const script = async (name: string, body: string) => {
    const file = join(directory, name);
    await writeFile(file, `#!/usr/bin/env node\n${body}\n`, { mode: 0o755 });
    await chmod(file, 0o755);
    return file;
  };
  process.env.BONTE_PDFINFO_PATH = await script("pdfinfo", 'require("fs").appendFileSync(process.env.TOOL_LOG, "pdfinfo\\n"); process.stdout.write("Pages:         " + (process.env.FAKE_PDF_PAGES || "2") + "\\n");');
  process.env.BONTE_PDFTOTEXT_PATH = await script("pdftotext", 'require("fs").appendFileSync(process.env.TOOL_LOG, "pdftotext\\n"); if (process.env.FAKE_PDFTOTEXT === "fail") process.exit(1); process.stdout.write(process.env.FAKE_PDFTOTEXT_TEXT || "");');
  process.env.BONTE_PDFTOPPM_PATH = await script("pdftoppm", 'require("fs").appendFileSync(process.env.TOOL_LOG, "pdftoppm\\n"); require("fs").writeFileSync(process.argv.at(-1) + ".png", "x");');
  process.env.BONTE_TESSERACT_PATH = await script("tesseract", 'require("fs").appendFileSync(process.env.TOOL_LOG, "tesseract\\n"); process.stdout.write(process.env.FAKE_OCR_TEXT || "");');
  process.env.FAKE_PDFTOTEXT = "fail";
  process.env.FAKE_OCR_TEXT = "Recovered source text from scan.";
  const skipped = await getAttachment(context, uploaded.id);
  assert.equal(skipped.pages.length, 1);
  assert.equal(skipped.pages[0].text, "");
  const recovered = await getAttachment(context, uploaded.id, true);
  assert.equal(recovered.pages.length, 2);
  assert.ok(recovered.pages.every((page) => page.method === "ocr" && page.readable));
  assert.match(recovered.pages.map((page) => page.text).join(" "), /Recovered source text from scan/);
  assert.doesNotMatch(recovered.warnings.join("\n"), /administrator to install|Text extraction is unavailable|clearer scan/);
  process.env.FAKE_PDF_PAGES = "1";
  delete process.env.FAKE_PDFTOTEXT;
  process.env.FAKE_PDFTOTEXT_TEXT = "";
  process.env.FAKE_OCR_TEXT = "";
  await writeFile(log, "");
  const blank = await uploadAttachment(context, { fileName: "blank.pdf", mimeType: "application/pdf", bytes: pdf, category: "other" });
  assert.equal(blank.pages.length, 1);
  assert.equal(blank.pages[0].readable, false);
  assert.match(blank.warnings.join("\n"), /insufficient text/);
  assert.doesNotMatch(blank.warnings.join("\n"), /administrator to install|Text extraction is unavailable/);
  const before = await readFile(log, "utf8");
  await getAttachment(context, blank.id, true);
  assert.equal(await readFile(log, "utf8"), before);
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

test("NDA requires party evidence by default and follows custom template document requirements", async () => {
  const capabilities = await documentCapabilities();
  assert.equal(capabilities.nda.status, "configured");
  assert.deepEqual(capabilities.nda.outputFormats, ["editable PDF"]);
  assert.deepEqual(capabilities.nda.requiredDocuments?.map((item) => item.category), ["party"]);
  assert.deepEqual(capabilities.cmi?.requiredDocuments.map((item) => item.category), ["party", "transaction"]);
  const missing = await updateNdaIntake(context);
  assert.equal(missing.status, "needs_input");
  assert.match(missing.issues!.join(" "), /party identification/);
  assert.doesNotMatch(missing.issues!.join(" "), /transaction/);
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
  const automaticChoice = structuredClone(facts); automaticChoice[2].source = { type: "current_date" };
  assert.match(validateNdaFacts(config, automaticChoice, [party, transaction]).join(" "), /explicit user choice/);
  const unreadable: WorkflowAttachment = { ...party, pages: [{ ...party.pages[0], readable: false, text: "" }] };
  assert.match(validateNdaFacts(config, facts, [unreadable, transaction]).join(" "), /readable/);
});

test("NDA defaults to today's Lisbon date, refreshes automatic dates and preserves explicit choices", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: new Date("2026-09-09T22:59:00Z") });
  const first = await updateNdaIntake(context);
  assert.deepEqual(first.facts!.find((fact) => fact.key === "agreement_date"), {
    key: "agreement_date", value: "9 de setembro de 2026", source: { type: "current_date" },
  });
  t.mock.timers.setTime(new Date("2026-09-09T23:01:00Z").getTime());
  const next = await updateNdaIntake(context);
  assert.equal(next.facts!.find((fact) => fact.key === "agreement_date")!.value, "10 de setembro de 2026");
  assert.doesNotMatch(next.issues!.join(" "), /Data completa/);
  const chosen: NdaFact = { key: "agreement_date", value: "15 de setembro de 2026", source: { type: "agreement", userStatement: "Use 15 de setembro de 2026." } };
  const changed = await updateNdaIntake(context, { facts: [chosen] });
  assert.deepEqual(changed.facts!.filter((fact) => fact.key === "agreement_date"), [chosen]);
  assert.deepEqual((await updateNdaIntake(context)).facts!.filter((fact) => fact.key === "agreement_date"), [chosen]);
  const cmi = await updateNdaIntake(context, {}, "cmi");
  assert.ok(!cmi.facts!.some((fact) => fact.key === "agreement_date"));
  assert.match(cmi.issues!.join(" "), /Missing Data acordada/);
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

test("exact NDA PDF: party-only evidence, Portuguese examples, revision and editable save/reopen", async () => {
  const loaded = (await loadNdaConfig())!;
  const original = await PDFDocument.load(loaded.template);
  const content = (pdf: PDFDocument, page: number) => {
    const streams = pdf.getPage(page).node.Contents();
    const items = streams instanceof PDFArray ? streams.asArray().map((ref) => pdf.context.lookup(ref, PDFRawStream)) : [streams as PDFRawStream];
    return Buffer.concat(items.map((stream) => Buffer.from(decodePDFRawStream(stream).decode())));
  };
  assert.equal(original.getPageCount(), 4);
  assert.equal(original.getForm().getFields().length, 0);
  const examples = [
    { agreement_date: new Date().toLocaleDateString("pt-PT", { timeZone: "Europe/Lisbon", day: "numeric", month: "long", year: "numeric" }), receiving_party: "Exemplo Imóveis, Lda.", receiving_address: "Rua de Teste, 25, 1200-001 Lisboa",
      receiving_entity: "Exemplo Imóveis, Lda.", signatory_name: "João Gonçalves", signatory_title: "Sócio-Gerente" },
    { agreement_date: "30 de setembro de 2026", receiving_party: "Sociedade Exemplo de Investimentos Imobiliários e Gestão, Lda.",
      receiving_address: "Avenida de Teste, n.º 123, 4.º Esq., 2750-001 Cascais, Portugal",
      receiving_entity: "Sociedade Exemplo, Lda.", signatory_name: "Maria da Conceição Gonçalves", signatory_title: "Procuradora com poderes" },
  ];
  for (const [index, values] of examples.entries()) {
    const ctx = { ...context, conversationId: `pdf-example-${index}` };
    const party = await uploadAttachment(ctx, { fileName: "fictional-party.docx", mimeType: mime, category: "party", bytes: docx(Object.values(values).join("; ")) });
    const facts: NdaFact[] = Object.entries(values).filter(([key]) => index !== 0 || key !== "agreement_date").map(([key, value]) => ({ key, value, source: key === "agreement_date"
      ? { type: "agreement", userStatement: `Use ${value}.` }
      : { type: "document", attachmentId: party.id, page: 1, quote: party.pages[0].text } }));
    assert.equal((await updateNdaIntake(ctx, { facts })).status, "ready_to_draft");
    process.env.BONTE_LIBREOFFICE_PATH = join(directory, "not-needed-for-exact-pdf");
    const draft = await generateNdaDraft(ctx);
    assert.ok("downloads" in draft);
    assert.deepEqual(draft.sourceAttachmentIds, [party.id]);
    assert.equal(draft.downloads.length, 1);
    assert.equal(draft.docxAttachmentId, undefined);
    assert.equal(draft.pageCount, 4);
    assert.deepEqual(draft.editableFields, Object.keys(values));
    const { bytes } = await readAttachment(ctx, draft.pdfAttachmentId);
    const output = await PDFDocument.load(bytes);
    const form = output.getForm();
    assert.ok(form.acroForm.dict.lookup(PDFName.of("DR"), PDFDict).lookup(PDFName.of("Font"), PDFDict).has(PDFName.of("Helvetica")), "PDF readers need the form font resource to save edits.");
    assert.equal(form.getFields().length, 6);
    for (const [key, value] of Object.entries(values)) {
      const field = form.getTextField(key);
      assert.equal(field.getText(), value);
      assert.equal(field.isReadOnly(), false);
      assert.equal(field.acroField.getWidgets().length, 1);
      assert.ok(field.acroField.getWidgets()[0].getNormalAppearance(), "Saved widget needs an appearance, not just a logical value.");
    }
    for (let p = 0; p < 4; p++) {
      assert.deepEqual(output.getPage(p).getSize(), original.getPage(p).getSize());
      // Original clause/signature drawing streams are preserved; only annotations/resources are added.
      assert.ok(content(output, p).includes(content(original, p)), `Original content on page ${p + 1} must remain intact.`);
    }
    assert.ok(!form.getFields().some((field) => /signature|assinatura/.test(field.getName())));
    const exportDir = process.env.BONTE_NDA_TEST_OUTPUT_DIR;
    if (exportDir) {
      await mkdir(exportDir, { recursive: true });
      await writeFile(join(exportDir, `nda-test-${index + 1}.pdf`), bytes);
    }
    if (index === 0) {
      form.getTextField("signatory_name").setText("Ana Cláudia Simões");
      form.updateFieldAppearances(await output.embedFont(StandardFonts.Helvetica));
      const edited = Buffer.from(await output.save());
      const reopened = await PDFDocument.load(edited);
      assert.equal(reopened.getForm().getTextField("signatory_name").getText(), "Ana Cláudia Simões");
      assert.equal(reopened.getForm().getTextField("receiving_party").getText(), values.receiving_party);
      assert.ok(reopened.getForm().getTextField("signatory_name").acroField.getWidgets()[0].getNormalAppearance());
      if (exportDir) await writeFile(join(exportDir, "nda-test-edited.pdf"), edited);
      const correction: NdaFact = { key: "agreement_date", value: "8 de setembro de 2026", source: { type: "agreement", userStatement: "Change the date to 8 de setembro de 2026." } };
      assert.equal((await updateNdaIntake(ctx, { facts: [correction] })).status, "ready_to_draft");
      assert.equal((await updateNdaIntake(ctx, { facts: [correction], resolveFields: ["agreement_date"] })).status, "ready_to_draft");
      const revision = await generateNdaDraft(ctx);
      assert.ok("downloads" in revision);
      assert.equal(revision.revision, 2);
      const savedRevision = await PDFDocument.load((await readAttachment(ctx, revision.pdfAttachmentId)).bytes);
      assert.equal(savedRevision.getForm().getTextField("agreement_date").getText(), correction.value);
      assert.equal((await PDFDocument.load((await readAttachment(ctx, draft.pdfAttachmentId)).bytes)).getForm().getTextField("agreement_date").getText(), values.agreement_date);
    }
  }
});

test("exact NDA PDF rejects overflow, unsupported characters and changed source without publishing", async () => {
  const loaded = (await loadNdaConfig())!;
  const values = { agreement_date: "7 de setembro de 2026", receiving_party: "Exemplo Imóveis, Lda.", receiving_address: "Rua de Teste, 25, Lisboa",
    receiving_entity: "Exemplo Imóveis, Lda.", signatory_name: "João Gonçalves", signatory_title: "Sócio-Gerente" };
  const party = await uploadAttachment(context, { fileName: "fictional-party.docx", mimeType: mime, category: "party", bytes: docx(Object.values(values).join("; ") + "; " + "W".repeat(80)) });
  const facts: NdaFact[] = Object.entries(values).map(([key, value]) => ({ key, value: key === "receiving_entity" ? "W".repeat(80) : value, source: key === "agreement_date"
    ? { type: "agreement", userStatement: `Use ${value}.` }
    : { type: "document", attachmentId: party.id, page: 1, quote: party.pages[0].text } }));
  assert.equal((await updateNdaIntake(context, { facts })).status, "ready_to_draft");
  await assert.rejects(() => generateNdaDraft(context), /too long.*not clipped/);
  assert.equal((await listAttachments(context)).filter((attachment) => attachment.generated).length, 0);
  assert.equal((await store.list(context.workspaceId, "nda-draft")).length, 0);
  facts.find((fact) => fact.key === "receiving_entity")!.value = "测试";
  await assert.rejects(() => renderNdaPdfForm(loaded.template, loaded.config, facts), /cannot display/);
  facts.find((fact) => fact.key === "receiving_entity")!.value = "Name\nSecond line";
  await assert.rejects(() => renderNdaPdfForm(loaded.template, loaded.config, facts), /single-line/);
  const changed = await PDFDocument.load(loaded.template);
  changed.setTitle("A changed template");
  await writeFile(join(directory, "changed.pdf"), await changed.save());
  await writeFile(join(directory, "changed.json"), JSON.stringify({ ...loaded.config, templatePath: "changed.pdf" }));
  process.env.BONTE_NDA_CONFIG_PATH = join(directory, "changed.json");
  await assert.rejects(() => loadNdaConfig(), /checksum/);
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
  await assert.rejects(() => saveEmailDraft(context, { recipient: "buyer@example.invalid\nBcc: hidden", subject: "Your enquiry", body: "Thanks" }), /control characters/);
  await assert.rejects(() => saveEmailDraft(context, { recipient: "buyer@example.invalid", subject: "Your enquiry\tBcc: hidden", body: "Thanks" }), /control characters/);
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

const cmiSale = {
  agreement_date: "7/9/2026", contract_number: "001", client_name: "João Silva", marital_status: "Solteiro",
  client_address: "Rua Azul, 1", client_city: "Lisboa", client_id: "12345678", client_tax_id: "123456789",
  client_capacity: "Proprietário", property_use: "Habitação", rooms: "4", area: "120", property_address: "Rua de Teste, 25",
  property_city: "Cascais", property_parish: "Cascais", property_municipality: "Cascais", registry_office: "Cascais",
  registry_number: "1234", license_number: "123/2001", license_municipality: "Cascais", license_date: "1/1/2001",
  tax_article: "1234", tax_parish: "Cascais", energy_certificate: "SCE123456", energy_expiry: "1/1/2036",
  business_type: "Compra", price: "500.000,00", price_words_pt: "quinhentos", price_words_pt_continued: "mil euros",
  price_words_en: "five hundred", price_words_en_continued: "thousand euros", liens_pt: "Nenhum", liens_en: "None", liens_amount: "0",
  exclusivity: "Exclusivo", fee_type: "Percentagem", fee_percentage: "5", fee_percentage_vat: "23",
  payment_terms: "Repartido", payment_initial_percentage: "50", payment_remaining_percentage: "50",
  agent_name: "Ana Martins", agent_id: "87654321", agent_tax_id: "987654321",
};

async function cmiEvidence(ctx = context, values: Record<string, string> = cmiSale) {
  const loaded = (await loadNdaConfig("cmi"))!;
  const sources = new Map<string, WorkflowAttachment>();
  for (const category of ["party", "transaction"] as const) {
    const text = loaded.config.fields.filter((field) => field.source === category && values[field.key])
      .map((field) => `${field.label}: ${values[field.key]}`).join("; ");
    sources.set(category, await uploadAttachment(ctx, { fileName: `FICTIONAL-CMI-${category}.docx`, mimeType: mime, category,
      bytes: docx(`FICTIONAL TEST DATA ONLY. ${text}`) }));
  }
  const facts: NdaFact[] = Object.entries(values).map(([key, value]) => {
    const field = loaded.config.fields.find((field) => field.key === key)!;
    const attachment = sources.get(field.source);
    return { key, value, source: attachment ? { type: "document", attachmentId: attachment.id, page: 1, quote: attachment.pages[0].text }
      : { type: "agreement", userStatement: `For this fictional test, use ${value}.` } };
  });
  return { ...loaded, sources, facts };
}

test("exact CMI: sale and lease from uploaded evidence, linked bilingual fields, edit/reopen and revisions", async () => {
  const lease: Record<string, string> = { ...cmiSale, contract_number: "002", client_name: "José Silva", marital_status: "Casado",
    property_regime: "Separação", spouse_name: "Ana", spouse_name_continued: "Silva", spouse_id: "23456789", spouse_tax_id: "234567890",
    client_capacity: "Senhorio", business_type: "Arrendamento", price: "2.000,00", price_words_pt: "dois mil euros",
    price_words_en: "two thousand", price_words_en_continued: "euros", exclusivity: "Não exclusivo", fee_type: "Montante fixo",
    fee_amount: "2.000,00", fee_words_pt: "dois mil euros", fee_words_en: "two", fee_words_en_continued: "thousand euros", fee_amount_vat: "23",
    payment_terms: "Escritura" };
  for (const key of ["fee_percentage", "fee_percentage_vat", "payment_initial_percentage", "payment_remaining_percentage", "price_words_pt_continued"]) delete lease[key];
  const exportDir = process.env.BONTE_CMI_TEST_OUTPUT_DIR;
  const content = (pdf: PDFDocument, page: number) => {
    const streams = pdf.getPage(page).node.Contents();
    const items = streams instanceof PDFArray ? streams.asArray().map((ref) => pdf.context.lookup(ref, PDFRawStream)) : [streams as PDFRawStream];
    return Buffer.concat(items.map((stream) => Buffer.from(decodePDFRawStream(stream).decode())));
  };
  for (const [index, values] of [cmiSale, lease].entries()) {
    const ctx = { ...context, conversationId: `cmi-example-${index}` };
    const { config: templateConfig, template, facts } = await cmiEvidence(ctx, values);
    const check = await updateNdaIntake(ctx, { facts }, "cmi");
    assert.equal(check.status, "ready_to_draft", JSON.stringify(check.issues));
    assert.equal((await updateNdaIntake(ctx)).status, "needs_input", "CMI and NDA intakes must be isolated.");
    const draft = await generateNdaDraft(ctx, "cmi");
    assert.ok("downloads" in draft);
    assert.equal(draft.pageCount, 10);
    assert.equal(draft.revision, 1);
    assert.equal(draft.downloads.length, 1);
    const { bytes } = await readAttachment(ctx, draft.pdfAttachmentId);
    const output = await PDFDocument.load(bytes);
    const original = await PDFDocument.load(template);
    const form = output.getForm();
    assert.equal(original.getForm().getFields().length, 0);
    for (const field of templateConfig.fields) {
      const value = (values as Record<string, string>)[field.key] ?? "";
      const saved = field.pdf!.option ? form.getRadioGroup(field.key) : form.getTextField(field.key);
      assert.equal(saved.isReadOnly(), false);
      if (field.pdf!.option) {
        const group = form.getRadioGroup(field.key);
        assert.equal(group.getSelected(), value);
        assert.equal(group.acroField.getWidgets().filter((widget) => widget.getAppearanceState()?.toString() !== "/Off").length, 2, "Both language markers select together.");
      } else {
        assert.equal(form.getTextField(field.key).getText() ?? "", value);
        for (const [i, box] of [field.pdf!, ...(field.pdfCopies ?? [])].entries()) if (box.valueMap) {
          assert.equal(form.getTextField(`${field.key}_translation_${i}`).getText() ?? "", value ? box.valueMap[value] : "");
        }
      }
      for (const widget of saved.acroField.getWidgets()) assert.ok(widget.getNormalAppearance());
    }
    for (let p = 0; p < 10; p++) {
      assert.deepEqual(output.getPage(p).getSize(), original.getPage(p).getSize());
      assert.ok(content(output, p).includes(content(original, p)), `Original CMI page ${p + 1} content must remain intact.`);
    }
    assert.equal(output.getPage(9).node.Annots()?.size() ?? 0, 0, "Signature page stays untouched.");
    assert.equal((await listDocumentDrafts(ctx)).filter((item) => item.kind === "cmi-draft").length, 1);
    assert.equal((await listDocumentDrafts({ ...ctx, actorId: "other" })).length, 0);
    if (exportDir) {
      await mkdir(exportDir, { recursive: true });
      await writeFile(join(exportDir, `cmi-test-${index + 1}.pdf`), bytes);
    }
    if (index === 0) {
      form.getTextField("client_name").setText("Maria Simões");
      form.getRadioGroup("exclusivity").select("Não exclusivo");
      form.updateFieldAppearances(await output.embedFont(StandardFonts.Helvetica));
      const edited = Buffer.from(await output.save());
      const reopened = (await PDFDocument.load(edited)).getForm();
      assert.equal(reopened.getTextField("client_name").getText(), "Maria Simões");
      assert.equal(reopened.getTextField("client_name").acroField.getWidgets().length, 3);
      assert.equal(reopened.getRadioGroup("exclusivity").getSelected(), "Não exclusivo");
      if (exportDir) await writeFile(join(exportDir, "cmi-test-edited.pdf"), edited);
      const change: NdaFact = { key: "agreement_date", value: "8/9/2026", source: { type: "agreement", userStatement: "Change date to 8/9/2026." } };
      assert.equal((await updateNdaIntake(ctx, { facts: [change] }, "cmi")).status, "needs_input");
      assert.equal((await updateNdaIntake(ctx, { facts: [change], resolveFields: [change.key] }, "cmi")).status, "ready_to_draft");
      const revised = await generateNdaDraft(ctx, "cmi");
      assert.ok("downloads" in revised);
      assert.equal(revised.revision, 2);
      assert.equal((await PDFDocument.load((await readAttachment(ctx, revised.pdfAttachmentId)).bytes)).getForm().getTextField("agreement_date").getText(), "8/9/2026");
      assert.equal((await PDFDocument.load((await readAttachment(ctx, draft.pdfAttachmentId)).bytes)).getForm().getTextField("agreement_date").getText(), "7/9/2026");
    }
  }
});

test("CMI blocks missing/conflicting evidence, inapplicable fees, bad dates/payments and overflow without publishing", async () => {
  assert.equal((await generateNdaDraft(context, "cmi")).status, "needs_input");
  const { config: templateConfig, template, sources, facts } = await cmiEvidence();
  const property = sources.get("transaction")!;
  const bad = structuredClone(facts); bad.find((fact) => fact.key === "energy_certificate")!.value = "invented";
  assert.match(validateNdaFacts(templateConfig, bad, [...sources.values()]).join(" "), /not supported/);
  assert.match(validateNdaFacts(templateConfig, facts, [sources.get("party")!]).join(" "), /readable.*transaction|readable.*property/);
  const incomplete = facts.filter((fact) => fact.key !== "energy_certificate");
  assert.match(validateNdaFacts(templateConfig, incomplete, [...sources.values()]).join(" "), /Missing Número do certificado/);
  const invalidTerms: NdaFact[] = [
    { key: "agreement_date", value: "31/2/2026", source: { type: "agreement", userStatement: "31/2/2026" } },
    { key: "payment_remaining_percentage", value: "60", source: { type: "agreement", userStatement: "60" } },
    { key: "fee_amount", value: "2000", source: { type: "agreement", userStatement: "2000" } },
  ];
  const check = await updateNdaIntake(context, { facts: [...facts.filter((fact) => !invalidTerms.some((term) => term.key === fact.key)), ...invalidTerms] }, "cmi");
  assert.match(check.issues!.join(" "), /real D\/M\/YYYY/);
  assert.match(check.issues!.join(" "), /total 100%/);
  assert.match(check.issues!.join(" "), /does not apply/);
  const overflow = "Avenida de um Nome Demasiado Comprido, 123, 4.º Esq.";
  const party = sources.get("party")!;
  await store.put(context.workspaceId, "attachment", party.id, { ...party, pages: [{ ...party.pages[0], text: `${party.pages[0].text}; ${overflow}` }] });
  const longFacts = facts.map((fact) => fact.key === "client_address" ? { ...fact, value: overflow, source: { type: "document" as const, attachmentId: party.id, page: 1, quote: overflow } } : fact);
  assert.equal((await updateNdaIntake(context, { facts: longFacts, resolveFields: [...new Set([...facts, ...invalidTerms].map((fact) => fact.key))] }, "cmi")).status, "ready_to_draft");
  await assert.rejects(() => generateNdaDraft(context, "cmi"), /Morada do cliente.*not clipped/);
  await assert.rejects(() => renderNdaPdfForm(template, templateConfig, facts.map((fact) => fact.key === "client_name" ? { ...fact, value: "测试" } : fact)), /cannot display/);
  assert.equal((await listAttachments(context)).filter((file) => file.generated).length, 0);
  assert.equal((await store.list(context.workspaceId, "cmi-draft")).length, 0);
  await writeFile(join(directory, "changed-cmi.json"), JSON.stringify({ ...templateConfig, templatePath: join(directory, "changed-cmi.pdf"), templateSha256: "0".repeat(64) }));
  await writeFile(join(directory, "changed-cmi.pdf"), template);
  process.env.BONTE_CMI_CONFIG_PATH = join(directory, "changed-cmi.json");
  await assert.rejects(() => loadNdaConfig("cmi"), /checksum/);
  await store.put(context.workspaceId, "cmi-intake", context.conversationId, { expiresAt: "2000-01-01T00:00:00Z", facts });
  await store.put(context.workspaceId, "cmi-draft", "expired", { expiresAt: "2000-01-01T00:00:00Z", sourceAttachmentIds: [property.id] });
  await purgeExpiredAttachments(context.workspaceId);
  assert.equal(await store.get(context.workspaceId, "cmi-intake", context.conversationId), null);
  assert.equal(await store.get(context.workspaceId, "cmi-draft", "expired"), null);
});
