import { randomUUID, createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile, mkdir } from "node:fs/promises";
import { dirname, resolve, join } from "node:path";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import PizZip from "pizzip";
import Docxtemplater from "docxtemplater";
import { z } from "zod";
import { getWorkflowStore } from "./store.js";
import { resolveExactProperty } from "./crm-properties.js";
import {
  attachmentSummary, deleteAttachment, documentExpiry, DocumentWorkflowError, getAttachment, listAttachments, purgeExpiredAttachments,
  saveGeneratedAttachment, validateDocxArchive, type DocumentContext, type WorkflowAttachment,
} from "./documents-attachments.js";

const exec = promisify(execFile);
const docxMime = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
const safeKey = z.string().regex(/^[a-z][a-z0-9_]{0,79}$/);
export const ndaConfigSchema = z.object({
  version: z.string().min(1), templatePath: z.string().min(1),
  title: z.string().min(1).default("Bonte NDA draft"),
  requiredDocuments: z.array(z.object({ category: z.enum(["party", "transaction"]), label: z.string().min(1), minimum: z.number().int().min(1).max(20).default(1) }))
    .refine((items) => ["party", "transaction"].every((category) => items.some((item) => item.category === category)), "Both party and transaction documents are mandatory."),
  fields: z.array(z.object({ key: safeKey, label: z.string().min(1), required: z.boolean().default(true), source: z.enum(["party", "transaction", "agreement"]),
    allowedValues: z.array(z.string().min(1)).optional(), maxLength: z.number().int().positive().max(4000).default(500) })).min(1),
}).refine((config) => new Set(config.fields.map((field) => field.key)).size === config.fields.length, "NDA field keys must be unique.");
export type NdaConfig = z.infer<typeof ndaConfigSchema>;
export const ndaFactSchema = z.object({
  key: safeKey, value: z.string().trim().min(1).max(4000),
  source: z.discriminatedUnion("type", [
    z.object({ type: z.literal("document"), attachmentId: z.string().uuid(), page: z.number().int().positive(), quote: z.string().min(1).max(8000) }),
    z.object({ type: z.literal("agreement"), userStatement: z.string().min(1).max(4000) }),
  ]),
});
export type NdaFact = z.infer<typeof ndaFactSchema>;
interface NdaIntake { conversationId: string; actorId: string; templateVersion: string; templateSha256: string; facts: NdaFact[]; conflicts: string[]; attachmentIds: string[]; expiresAt: string }
const normalize = (value: string) => value.normalize("NFKC").replace(/\s+/g, " ").trim().toLowerCase();

export async function loadNdaConfig(): Promise<{ config: NdaConfig; template: Buffer; sha256: string } | null> {
  const configPath = process.env.BONTE_NDA_CONFIG_PATH;
  if (!configPath) return null;
  try {
    const config = ndaConfigSchema.parse(JSON.parse(await readFile(resolve(configPath), "utf8")));
    config.templatePath = resolve(dirname(resolve(configPath)), config.templatePath);
    const template = await readFile(config.templatePath);
    validateDocxArchive(template);
    return { config, template, sha256: createHash("sha256").update(template).digest("hex") };
  } catch { throw new DocumentWorkflowError("Bonte's NDA configuration or DOCX template is invalid. Ask an administrator to check BONTE_NDA_CONFIG_PATH.", 503); }
}
export async function documentCapabilities() {
  const template = await loadNdaConfig();
  return { uploads: { formats: ["PDF", "DOCX", "PNG", "JPEG"], maxMegabytes: 15, maxPdfPages: 40 },
    nda: template ? { status: "configured", templateVersion: template.config.version, requiredDocuments: template.config.requiredDocuments, fields: template.config.fields }
      : { status: "setup_required", missing: "Bonte's approved DOCX NDA template and required field/document configuration (BONTE_NDA_CONFIG_PATH)." },
    email: { drafting: true, sending: false },
    runtime: "PDF text/OCR needs Poppler and Tesseract. NDA PDF output needs LibreOffice and Poppler; availability is checked when used." };
}

export function validateNdaFacts(config: NdaConfig, facts: NdaFact[], attachments: WorkflowAttachment[]): string[] {
  const issues: string[] = [];
  const documents = new Map(attachments.map((attachment) => [attachment.id, attachment]));
  for (const requirement of config.requiredDocuments) {
    const eligible = attachments.filter((attachment) => !attachment.generated && attachment.category === requirement.category && attachment.pages.some((page) => page.readable));
    if (eligible.length < requirement.minimum) issues.push(`Provide ${requirement.minimum} readable ${requirement.label} document(s); ${eligible.length} available.`);
  }
  for (const field of config.fields) {
    const values = facts.filter((fact) => fact.key === field.key);
    if (!values.length) { if (field.required) issues.push(`Missing ${field.label}.`); continue; }
    if (new Set(values.map((fact) => normalize(fact.value))).size > 1) { issues.push(`Conflicting values for ${field.label}; identify the correct value and its evidence.`); continue; }
    for (const fact of values) {
      if (fact.value.length > field.maxLength) issues.push(`${field.label} exceeds its ${field.maxLength}-character template limit.`);
      if (field.allowedValues && !field.allowedValues.includes(fact.value)) issues.push(`${field.label} must be one of: ${field.allowedValues.join(", ")}.`);
      if (field.source === "agreement") {
        if (fact.source.type !== "agreement" || !normalize(fact.source.userStatement).includes(normalize(fact.value))) {
          issues.push(`${field.label} requires an explicit user choice containing the supplied value.`);
        }
        continue;
      }
      if (fact.source.type !== "document") { issues.push(`${field.label} must be supported by a ${field.source} document.`); continue; }
      const evidence = documents.get(fact.source.attachmentId);
      const sourcePage = evidence?.pages.find((page) => page.page === (fact.source as { page: number }).page);
      if (!evidence || evidence.generated || evidence.category !== field.source || !sourcePage?.readable) {
        issues.push(`${field.label} has no readable ${field.source} document at its cited location.`);
      } else if (!normalize(sourcePage.text).includes(normalize(fact.source.quote)) || !normalize(fact.source.quote).includes(normalize(fact.value))) {
        issues.push(`${field.label} is not supported by its exact source quotation. Keep the value as written in the document.`);
      }
    }
  }
  for (const fact of facts) if (!config.fields.some((field) => field.key === fact.key)) issues.push(`Unknown NDA field: ${fact.key}.`);
  return [...new Set(issues)];
}

async function scopedIntake(context: DocumentContext) {
  await purgeExpiredAttachments(context.workspaceId);
  const record = await getWorkflowStore().get<NdaIntake>(context.workspaceId, "nda-intake", context.conversationId);
  return record && record.data.actorId === context.actorId ? record.data : undefined;
}
export async function updateNdaIntake(context: DocumentContext, input: { facts?: NdaFact[]; attachmentIds?: string[]; resolveFields?: string[] } = {}) {
  const loaded = await loadNdaConfig();
  if (!loaded) return { status: "setup_required", message: "Bonte's approved NDA template and intake configuration must be configured once by an administrator. The user must also supply party and transaction documents." };
  const prior = await scopedIntake(context);
  const freshTemplate = prior?.templateSha256 !== loaded.sha256 || prior?.templateVersion !== loaded.config.version;
  const current = freshTemplate ? [] : prior?.facts ?? [];
  const incoming = (input.facts ?? []).map((fact) => ndaFactSchema.parse(fact));
  const resolving = new Set(input.resolveFields ?? []);
  const facts = current.filter((fact) => !resolving.has(fact.key));
  for (const fact of incoming) {
    if (!facts.some((existing) => JSON.stringify(existing) === JSON.stringify(fact))) facts.push(fact);
  }
  const attachments = input.attachmentIds
    ? await Promise.all(input.attachmentIds.map((id) => getAttachment(context, id, true)))
    : (await listAttachments(context)).filter((attachment) => !attachment.generated);
  const issues = validateNdaFacts(loaded.config, facts, attachments);
  const intake: NdaIntake = { conversationId: context.conversationId, actorId: context.actorId, templateVersion: loaded.config.version, templateSha256: loaded.sha256,
    facts, conflicts: issues, attachmentIds: attachments.map((attachment) => attachment.id), expiresAt: documentExpiry() };
  await getWorkflowStore().put(context.workspaceId, "nda-intake", context.conversationId, intake);
  return { status: issues.length ? "needs_input" : "ready_to_draft", templateVersion: loaded.config.version, issues,
    fields: loaded.config.fields, facts, attachments: attachments.map(attachmentSummary),
    warnings: [...(freshTemplate && prior ? ["Template changed; prior intake values were cleared for revalidation."] : []), ...attachments.flatMap((attachment) => attachment.warnings)] };
}

export function renderNdaDocx(template: Buffer, config: NdaConfig, facts: NdaFact[]): Buffer {
  const values: Record<string, string> = Object.create(null);
  for (const field of config.fields) values[field.key] = facts.find((fact) => fact.key === field.key)?.value ?? "";
  try {
  const doc = new Docxtemplater(new PizZip(template), {
    paragraphLoop: false, linebreaks: true, errorLogging: false,
    parser(tag: string) {
      if (!/^[a-z][a-z0-9_]{0,79}$/.test(tag) || !config.fields.some((field) => field.key === tag)) throw new Error(`Unconfigured NDA template placeholder: ${tag}`);
      return { get(scope: Record<string, string>) { return scope[tag]; } };
    },
    nullGetter() { throw new Error("NDA template contains an unresolved field."); },
  });
  doc.render(values);
  return doc.getZip().generate({ type: "nodebuffer", compression: "DEFLATE" });
  } catch { throw new DocumentWorkflowError("Bonte's NDA template contains invalid or unconfigured placeholders. Ask the administrator to align its placeholders with the approved intake fields.", 503); }
}

export async function renderNdaPdf(docx: Buffer): Promise<{ bytes: Buffer; pages: number }> {
  const temporary = await mkdtemp(join(tmpdir(), "bonte-nda-"));
  try {
    const input = join(temporary, "nda.docx");
    const output = join(temporary, "rendered");
    await mkdir(output);
    await writeFile(input, docx, { mode: 0o600 });
    await exec(process.env.BONTE_LIBREOFFICE_PATH || "libreoffice", [
      `-env:UserInstallation=${pathToFileURL(join(temporary, "profile")).href}`,
      "--headless", "--convert-to", "pdf", "--outdir", output, input,
    ], { timeout: 90_000, maxBuffer: 1_000_000 });
    const pdfPath = join(output, "nda.pdf");
    const bytes = await readFile(pdfPath);
    const { stdout } = await exec(process.env.BONTE_PDFINFO_PATH || "pdfinfo", [pdfPath], { timeout: 15_000, maxBuffer: 100_000 });
    const pages = Number(/^Pages:\s+(\d+)/m.exec(stdout)?.[1]);
    if (!bytes.subarray(0, 5).equals(Buffer.from("%PDF-")) || !Number.isFinite(pages) || pages < 1 || pages > 80) throw new Error("Invalid rendered PDF.");
    return { bytes, pages };
  } catch { throw new DocumentWorkflowError("NDA PDF rendering failed. Ask the administrator to check LibreOffice and Poppler. No completed NDA draft was published.", 503); }
  finally { await rm(temporary, { recursive: true, force: true }); }
}

export async function generateNdaDraft(context: DocumentContext) {
  const check = await updateNdaIntake(context);
  if (check.status !== "ready_to_draft") return check;
  const loaded = await loadNdaConfig();
  const intake = await scopedIntake(context);
  if (!loaded || !intake || loaded.sha256 !== intake.templateSha256) throw new DocumentWorkflowError("The NDA template changed; recheck the intake before drafting.");
  const bytes = renderNdaDocx(loaded.template, loaded.config, intake.facts);
  const pdf = await renderNdaPdf(bytes);
  const id = randomUUID();
  const previous = (await getWorkflowStore().list<{ conversationId: string; revision: number }>(context.workspaceId, "nda-draft", 10_000))
    .filter((record) => record.data.conversationId === context.conversationId);
  const revision = 1 + Math.max(0, ...previous.map((record) => record.data.revision));
  const docx = await saveGeneratedAttachment(context, { bytes, fileName: `Bonte-NDA-draft-v${revision}.docx`, mimeType: docxMime });
  let rendered: WorkflowAttachment | undefined;
  try {
  rendered = await saveGeneratedAttachment(context, { bytes: pdf.bytes, fileName: `Bonte-NDA-draft-v${revision}.pdf`, mimeType: "application/pdf" });
  const result = { id, conversationId: context.conversationId, actorId: context.actorId, revision, status: "draft", templateVersion: loaded.config.version,
    templateSha256: loaded.sha256, facts: intake.facts, sourceAttachmentIds: intake.attachmentIds, docxAttachmentId: docx.id, pdfAttachmentId: rendered.id,
    pageCount: pdf.pages, createdAt: new Date().toISOString(), expiresAt: documentExpiry(), review: "Review pagination and signature blocks in the rendered PDF before using this draft." };
  await getWorkflowStore().put(context.workspaceId, "nda-draft", id, result);
  return { ...result, downloads: [attachmentSummary(docx), attachmentSummary(rendered)] };
  } catch (error) {
    await Promise.allSettled([deleteAttachment(context, docx.id), ...(rendered ? [deleteAttachment(context, rendered.id)] : [])]);
    throw error;
  }
}

export const emailDraftSchema = z.object({
  previousDraftId: z.string().uuid().optional(), recipient: z.string().max(500).optional(),
  subject: z.string().min(1).max(300).optional(), body: z.string().min(1).max(30_000).optional(),
  language: z.string().max(40).optional(), tone: z.string().max(150).optional(),
  properties: z.array(z.object({ propertyId: z.number().int().positive().optional(), reference: z.string().min(1).optional() })
    .refine((property) => property.propertyId || property.reference, "Provide a property identifier.")).max(20).optional(),
  attachmentIds: z.array(z.string().uuid()).max(20).optional(),
});
interface EmailDraft {
  id: string; rootDraftId: string; previousDraftId?: string; revision: number; actorId: string; conversationId: string;
  recipient?: string; subject: string; body: string; language: string; tone: string;
  properties: Awaited<ReturnType<typeof resolveExactProperty>>[]; attachmentIds: string[]; downloadAttachmentId: string;
  status: "draft"; createdAt: string; expiresAt: string;
}
export async function saveEmailDraft(context: DocumentContext, raw: z.infer<typeof emailDraftSchema>) {
  await purgeExpiredAttachments(context.workspaceId);
  const input = emailDraftSchema.parse(raw);
  const existing = input.previousDraftId ? await getWorkflowStore().get<EmailDraft>(context.workspaceId, "email-draft", input.previousDraftId) : null;
  if (input.previousDraftId && (!existing || existing.data.actorId !== context.actorId || existing.data.conversationId !== context.conversationId)) throw new DocumentWorkflowError("Email draft not found.", 404);
  const previous = existing?.data;
  const subject = input.subject ?? previous?.subject;
  const body = input.body ?? previous?.body;
  if (!subject || !body) throw new DocumentWorkflowError("Provide the email subject and body.");
  const properties = input.properties ? await Promise.all(input.properties.map((property) => resolveExactProperty(property))) : previous?.properties ?? [];
  const attachmentIds = input.attachmentIds ?? previous?.attachmentIds ?? [];
  const attachments = await Promise.all(attachmentIds.map((id) => getAttachment(context, id)));
  const urls = body.match(/https?:\/\/[^\s<>"\])]+/g) ?? [];
  const verifiedUrls = new Set(properties.flatMap((property) => property.listingUrl ? [property.listingUrl] : []));
  const unverifiedLinks = properties.length ? urls.filter((url) => !verifiedUrls.has(url)) : [];
  if (unverifiedLinks.length) throw new DocumentWorkflowError("The property email contains an unverified link. Use the verified listing URLs returned by property lookup, or omit unavailable links.");
  for (const property of properties) if (!body.includes(property.reference)) throw new DocumentWorkflowError(`Keep the selected property's exact reference ${property.reference} in the email body.`);
  const id = randomUUID();
  const revision = (previous?.revision ?? 0) + 1;
  const recipient = input.recipient ?? previous?.recipient;
  const text = `${recipient ? `To: ${recipient}\n` : ""}Subject: ${subject}\n\n${body}${attachments.length ? `\n\nAttachments:\n${attachments.map((attachment) => attachment.fileName).join("\n")}` : ""}\n`;
  const download = await saveGeneratedAttachment(context, { bytes: Buffer.from(text), fileName: `Bonte-email-draft-v${revision}.txt`, mimeType: "text/plain; charset=utf-8" });
  const draft: EmailDraft = { id, rootDraftId: previous?.rootDraftId ?? id, previousDraftId: previous?.id, revision, actorId: context.actorId, conversationId: context.conversationId,
    recipient, subject, body, language: input.language ?? previous?.language ?? "en", tone: input.tone ?? previous?.tone ?? "professional",
    properties, attachmentIds, downloadAttachmentId: download.id, status: "draft", createdAt: new Date().toISOString(), expiresAt: documentExpiry() };
  try { await getWorkflowStore().put(context.workspaceId, "email-draft", id, draft); }
  catch (error) { await deleteAttachment(context, download.id).catch(() => undefined); throw error; }
  return { ...draft, download: attachmentSummary(download), sent: false, warnings: properties.filter((property) => !property.listingUrl).map((property) => `No verified public listing link is available for ${property.reference}.`) };
}

export async function listDocumentDrafts(context: DocumentContext) {
  await purgeExpiredAttachments(context.workspaceId);
  const kinds = ["email-draft", "nda-draft"];
  return (await Promise.all(kinds.map(async (kind) => {
    const records = await getWorkflowStore().list<{ actorId: string; conversationId: string }>(context.workspaceId, kind, 1000);
    return records.filter((record) => record.data.actorId === context.actorId && record.data.conversationId === context.conversationId)
      .map((record) => ({ kind, ...record.data }));
  }))).flat();
}
