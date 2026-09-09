import { randomUUID, createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile, mkdir } from "node:fs/promises";
import { dirname, resolve, join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import PizZip from "pizzip";
import Docxtemplater from "docxtemplater";
import { PDFDocument, PDFHexString, PDFName, StandardFonts, rgb } from "pdf-lib";
import { z } from "zod";
import { getWorkflowStore } from "./store.js";
import { resolveExactProperty } from "./crm-properties.js";
import {
  attachmentCategories, attachmentSummary, deleteAttachment, documentExpiry, documentStorageStatus, DocumentWorkflowError, getAttachment, listAttachments, purgeExpiredAttachments,
  saveGeneratedAttachment, validateDocxArchive, type DocumentContext, type WorkflowAttachment,
} from "./documents-attachments.js";

const exec = promisify(execFile);
const docxMime = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
const safeKey = z.string().regex(/^[a-z][a-z0-9_]{0,79}$/);
export type ContractKind = "nda" | "cmi";
const pdfBoxSchema = z.object({ page: z.number().int().positive(), x: z.number().nonnegative(), y: z.number().nonnegative(),
  width: z.number().positive(), height: z.number().positive(), coverBackground: z.boolean().default(false),
  option: z.string().optional(), valueMap: z.record(z.string()).optional() });
export const ndaConfigSchema = z.object({
  version: z.string().min(1), templatePath: z.string().min(1),
  format: z.enum(["docx", "pdf"]).default("docx"),
  templateSha256: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  reviewNotes: z.array(z.string()).default([]),
  title: z.string().min(1).default("Bonte NDA draft"),
  requiredDocuments: z.array(z.object({ category: z.enum(["party", "transaction"]), label: z.string().min(1), minimum: z.number().int().min(1).max(20).default(1) }))
    .refine((items) => items.some((item) => item.category === "party"), "Party identification documents are mandatory."),
  fields: z.array(z.object({ key: safeKey, label: z.string().min(1), required: z.boolean().default(true), source: z.enum(["party", "transaction", "agreement"]),
    alignment: z.union([z.literal(0), z.literal(1), z.literal(2)]).default(0),
    allowedValues: z.array(z.string().min(1)).optional(), maxLength: z.number().int().positive().max(4000).default(500),
    pdf: pdfBoxSchema.optional(), pdfCopies: z.array(pdfBoxSchema).optional(),
    requiredWhen: z.object({ key: safeKey, values: z.array(z.string()).min(1) }).optional(),
  })).min(1),
}).refine((config) => new Set(config.fields.map((field) => field.key)).size === config.fields.length, "NDA field keys must be unique.")
  .refine((config) => config.format !== "pdf" || (config.templateSha256 && config.fields.every((field) => field.pdf)), "PDF templates require a source checksum and a position for every field.");
export type NdaConfig = z.infer<typeof ndaConfigSchema>;
export const ndaFactSchema = z.object({
  key: safeKey, value: z.string().trim().min(1).max(4000),
  source: z.discriminatedUnion("type", [
    z.object({ type: z.literal("document"), attachmentId: z.string().uuid(), page: z.number().int().positive(), quote: z.string().min(1).max(8000) }),
    z.object({ type: z.literal("agreement"), userStatement: z.string().min(1).max(4000) }),
    z.object({ type: z.literal("current_date") }),
  ]),
});
export type NdaFact = z.infer<typeof ndaFactSchema>;
interface NdaIntake { conversationId: string; actorId: string; templateVersion: string; templateSha256: string; facts: NdaFact[]; conflicts: string[]; attachmentIds: string[]; expiresAt: string }
const normalize = (value: string) => value.normalize("NFKC").replace(/\s+/g, " ").trim().toLowerCase();
const currentNdaDate = () => new Date().toLocaleDateString("pt-PT", { timeZone: "Europe/Lisbon", day: "numeric", month: "long", year: "numeric" });

export async function loadNdaConfig(kind: ContractKind = "nda"): Promise<{ config: NdaConfig; template: Buffer; sha256: string } | null> {
  const configPath = process.env[`BONTE_${kind.toUpperCase()}_CONFIG_PATH`] || fileURLToPath(new URL(`../../templates/${kind}/${kind}.json`, import.meta.url));
  try {
    const config = ndaConfigSchema.parse(JSON.parse(await readFile(resolve(configPath), "utf8")));
    config.templatePath = resolve(dirname(resolve(configPath)), config.templatePath);
    const template = await readFile(config.templatePath);
    const sha256 = createHash("sha256").update(template).digest("hex");
    if (config.templateSha256 && config.templateSha256 !== sha256) throw new Error("Template checksum mismatch.");
    if (config.format === "docx") validateDocxArchive(template);
    else if (!template.subarray(0, 5).equals(Buffer.from("%PDF-"))) throw new Error("Invalid PDF template.");
    return { config, template, sha256 };
  } catch { throw new DocumentWorkflowError(`Bonte's ${kind.toUpperCase()} configuration or template is invalid. Ask an administrator to check BONTE_${kind.toUpperCase()}_CONFIG_PATH and the approved template checksum.`, 503); }
}
export async function documentCapabilities() {
  const template = await loadNdaConfig();
  const cmi = await loadNdaConfig("cmi");
  return { uploads: { formats: ["PDF", "DOCX", "PNG", "JPEG", "WebP"], maxMegabytes: 15, maxPdfPages: 40 },
    nda: template ? { status: "configured", templateVersion: template.config.version, requiredDocuments: template.config.requiredDocuments, fields: template.config.fields,
      outputFormats: template.config.format === "pdf" ? ["editable PDF"] : ["DOCX", "PDF"], reviewNotes: template.config.reviewNotes }
      : { status: "setup_required", missing: "Bonte's approved NDA template and required field/document configuration (BONTE_NDA_CONFIG_PATH)." },
    email: { drafting: true, sending: false },
    storage: documentStorageStatus(),
    cmi: cmi && { status: "configured", templateVersion: cmi.config.version, requiredDocuments: cmi.config.requiredDocuments,
      fields: cmi.config.fields, outputFormats: ["editable PDF"], reviewNotes: cmi.config.reviewNotes },
    runtime: "PDF text/OCR needs Poppler and Tesseract. Bundled PDF contracts are filled directly; DOCX templates need LibreOffice and Poppler for PDF output. Document bytes require S3 (BONTE_S3_BUCKET and BONTE_S3_REGION)." };
}

export function validateNdaFacts(config: NdaConfig, facts: NdaFact[], attachments: WorkflowAttachment[], kind: ContractKind = "nda"): string[] {
  const issues: string[] = [];
  const documents = new Map(attachments.map((attachment) => [attachment.id, attachment]));
  for (const requirement of config.requiredDocuments) {
    const eligible = attachments.filter((attachment) => !attachment.generated && attachmentCategories(attachment).includes(requirement.category) && attachment.pages.some((page) => page.readable));
    if (eligible.length < requirement.minimum) issues.push(`Provide ${requirement.minimum} readable ${requirement.label} document(s); ${eligible.length} available.`);
  }
  for (const field of config.fields) {
    const values = facts.filter((fact) => fact.key === field.key);
    const applicable = !field.requiredWhen || facts.some((fact) => fact.key === field.requiredWhen!.key && field.requiredWhen!.values.includes(fact.value));
    if (!values.length) { if (field.required && applicable) issues.push(`Missing ${field.label}.`); continue; }
    if (!applicable) issues.push(`${field.label} does not apply to the selected terms; clear it with resolveFields.`);
    if (new Set(values.map((fact) => normalize(fact.value))).size > 1) { issues.push(`Conflicting values for ${field.label}; identify the correct value and its evidence.`); continue; }
    for (const fact of values) {
      if (fact.value.length > field.maxLength) issues.push(`${field.label} exceeds its ${field.maxLength}-character template limit.`);
      if (field.allowedValues && !field.allowedValues.includes(fact.value)) issues.push(`${field.label} must be one of: ${field.allowedValues.join(", ")}.`);
      if (field.source === "agreement") {
        if (kind === "nda" && field.key === "agreement_date" && fact.source.type === "current_date" && fact.value === currentNdaDate()) continue;
        if (fact.source.type !== "agreement" || !normalize(fact.source.userStatement).includes(normalize(fact.value))) {
          issues.push(`${field.label} requires an explicit user choice containing the supplied value.`);
        }
        continue;
      }
      if (fact.source.type !== "document") { issues.push(`${field.label} must be supported by a ${field.source} document.`); continue; }
      const evidence = documents.get(fact.source.attachmentId);
      const sourcePage = evidence?.pages.find((page) => page.page === (fact.source as { page: number }).page);
      if (!evidence || evidence.generated || !attachmentCategories(evidence).includes(field.source) || !sourcePage?.readable) {
        issues.push(`${field.label} has no readable ${field.source} document at its cited location.`);
      } else if (!normalize(sourcePage.text).includes(normalize(fact.source.quote)) || !normalize(fact.source.quote).includes(normalize(fact.value))) {
        issues.push(`${field.label} is not supported by its exact source quotation. Keep the value as written in the document.`);
      }
    }
  }
  for (const fact of facts) if (!config.fields.some((field) => field.key === fact.key)) issues.push(`Unknown contract field: ${fact.key}.`);
  return [...new Set(issues)];
}

function validateCmiTerms(facts: NdaFact[]): string[] {
  const values = Object.fromEntries(facts.map((fact) => [fact.key, fact.value]));
  const issues: string[] = [];
  for (const key of ["agreement_date", "license_date", "energy_expiry"]) {
    if (!values[key]) continue;
    const match = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(values[key]);
    const date = match && new Date(Date.UTC(+match[3], +match[2] - 1, +match[1]));
    if (!match || !date || date.getUTCFullYear() !== +match[3] || date.getUTCMonth() !== +match[2] - 1 || date.getUTCDate() !== +match[1] || (key === "agreement_date" && +match[3] !== 2026)) {
      issues.push(`${key} needs a real D/M/YYYY date${key === "agreement_date" ? " in 2026 for this exact template" : ""}.`);
    }
  }
  const percentages = ["fee_percentage", "fee_percentage_vat", "fee_amount_vat", "payment_initial_percentage", "payment_remaining_percentage"];
  const numbers: Record<string, number> = {};
  for (const key of ["price", "liens_amount", "fee_amount", "area", "rooms", ...percentages]) {
    if (!values[key]) continue;
    // Explicit Portuguese numeric format; do not guess whether a dot is a decimal separator.
    const value = values[key];
    const number = /^(?:\d+|\d{1,3}(?:\.\d{3})+)(?:,\d{1,2})?$/.test(value) ? Number(value.replaceAll(".", "").replace(",", ".")) : NaN;
    numbers[key] = number;
    if (!Number.isFinite(number) || number < 0 || (["price", "fee_amount", "area", "fee_percentage"].includes(key) && number === 0) || (percentages.includes(key) && number > 100) || (key === "rooms" && !Number.isInteger(number))) {
      issues.push(`${key} needs a valid Portuguese-format ${percentages.includes(key) ? "percentage (0–100)" : "number"}.`);
    }
  }
  if (values.payment_terms === "Repartido" && Number.isFinite(numbers.payment_initial_percentage) && Number.isFinite(numbers.payment_remaining_percentage) &&
      (numbers.payment_initial_percentage <= 0 || numbers.payment_remaining_percentage <= 0 || Math.abs(numbers.payment_initial_percentage + numbers.payment_remaining_percentage - 100) > 0.000001)) {
    issues.push("Split payment percentages must both be positive and total 100%.");
  }
  return issues;
}

async function scopedIntake(context: DocumentContext, kind: ContractKind = "nda") {
  await purgeExpiredAttachments(context.workspaceId);
  const record = await getWorkflowStore().get<NdaIntake>(context.workspaceId, `${kind}-intake`, context.conversationId);
  return record && record.data.actorId === context.actorId ? record.data : undefined;
}
export async function updateNdaIntake(context: DocumentContext, input: { facts?: NdaFact[]; attachmentIds?: string[]; resolveFields?: string[] } = {}, kind: ContractKind = "nda") {
  const loaded = await loadNdaConfig(kind);
  if (!loaded) return { status: "setup_required", message: `Bonte's approved ${kind.toUpperCase()} template and intake must be configured.` };
  const prior = await scopedIntake(context, kind);
  const freshTemplate = prior?.templateSha256 !== loaded.sha256 || prior?.templateVersion !== loaded.config.version;
  const current = freshTemplate ? [] : prior?.facts ?? [];
  const incoming = (input.facts ?? []).map((fact) => ndaFactSchema.parse(fact));
  const resolving = new Set(input.resolveFields ?? []);
  const facts = current.filter((fact) => !resolving.has(fact.key) && !(kind === "nda" && fact.key === "agreement_date" && fact.source.type === "current_date"));
  for (const fact of incoming) {
    if (!facts.some((existing) => JSON.stringify(existing) === JSON.stringify(fact))) facts.push(fact);
  }
  if (kind === "nda" && loaded.config.fields.some((field) => field.key === "agreement_date" && field.source === "agreement") && !facts.some((fact) => fact.key === "agreement_date")) {
    facts.push({ key: "agreement_date", value: currentNdaDate(), source: { type: "current_date" } });
  }
  const attachments = input.attachmentIds
    ? await Promise.all(input.attachmentIds.map((id) => getAttachment(context, id, true)))
    : (await listAttachments(context)).filter((attachment) => !attachment.generated);
  const issues = [...validateNdaFacts(loaded.config, facts, attachments, kind), ...(kind === "cmi" ? validateCmiTerms(facts) : [])];
  const intake: NdaIntake = { conversationId: context.conversationId, actorId: context.actorId, templateVersion: loaded.config.version, templateSha256: loaded.sha256,
    facts, conflicts: issues, attachmentIds: attachments.map((attachment) => attachment.id), expiresAt: documentExpiry() };
  await getWorkflowStore().put(context.workspaceId, `${kind}-intake`, context.conversationId, intake);
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

/** Add editable fields to the approved PDF; preserve the original page content. */
export async function renderNdaPdfForm(template: Buffer, config: NdaConfig, facts: NdaFact[]): Promise<{ bytes: Buffer; pages: number }> {
  const pdf = await PDFDocument.load(template, { updateMetadata: false });
  const form = pdf.getForm();
  if (form.getFields().length) throw new DocumentWorkflowError("The approved PDF must not already contain form fields.", 503);
  // ponytail: WinAnsi covers Portuguese; embed a Unicode font if other scripts are required.
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  // Readers need the font in the form's default resources when users edit a value.
  form.acroForm.dict.set(PDFName.of("DR"), pdf.context.obj({ Font: { [font.name]: font.ref } }));
  for (const field of config.fields) {
    const boxes = [field.pdf, ...(field.pdfCopies ?? [])];
    const rawValue = facts.find((fact) => fact.key === field.key)?.value ?? "";
    const applicable = !field.requiredWhen || facts.some((fact) => fact.key === field.requiredWhen!.key && field.requiredWhen!.values.includes(fact.value));
    if ((field.required && applicable && !rawValue) || rawValue.length > field.maxLength || /[\x00-\x1f\x7f]/.test(rawValue)) {
      throw new DocumentWorkflowError(`${field.label} needs a single-line value within its ${field.maxLength}-character limit.`);
    }
    const radio = field.pdf?.option ? form.createRadioGroup(field.key) : undefined;
    radio?.disableMutualExclusion(); // Matching PT/EN options select together.
    if (radio) radio.acroField.dict.set(PDFName.of("TU"), PDFHexString.fromText(field.label));
    let input: ReturnType<typeof form.createTextField> | undefined;
    let size = 9;
    for (const [index, box] of boxes.entries()) {
      const page = box && pdf.getPages()[box.page - 1];
      if (!box || !page || box.x + box.width > page.getWidth() || box.y + box.height > page.getHeight()) {
        throw new DocumentWorkflowError(`Invalid PDF position for ${field.label}.`, 503);
      }
      if (radio) {
        if (!box.option || !field.allowedValues?.includes(box.option)) throw new DocumentWorkflowError(`Invalid PDF choice for ${field.label}.`, 503);
        radio.addOptionToPage(box.option, page, { ...box, width: Math.min(9, box.width), height: 9, borderWidth: 0.5 });
        continue;
      }
      const value = box.valueMap && rawValue ? box.valueMap[rawValue] : rawValue;
      if (value === undefined) throw new DocumentWorkflowError(`No approved translation for ${field.label}: ${rawValue}.`);
      let width: number;
      try { width = font.widthOfTextAtSize(value, 1); }
      catch { throw new DocumentWorkflowError(`${field.label} contains characters the template font cannot display. Use an approved spelling or an updated template.`); }
      const boxSize = Math.min(9, (box.width - 4) / (width || 1));
      if (boxSize < 7 || font.heightAtSize(boxSize) > box.height - 2) {
        throw new DocumentWorkflowError(`${field.label} is too long for the template's line. Provide a shorter approved value or use an updated template; the text was not clipped.`);
      }
      const translated = box.valueMap ? form.createTextField(`${field.key}_translation_${index}`) : undefined;
      input ??= form.createTextField(field.key);
      const widgetField = translated ?? input;
      widgetField.acroField.dict.set(PDFName.of("TU"), PDFHexString.fromText(field.label));
      widgetField.setMaxLength(field.maxLength);
      widgetField.setText(value);
      widgetField.setAlignment(field.alignment);
      widgetField.disableScrolling();
      if (field.required && applicable) widgetField.enableRequired();
      widgetField.addToPage(page, { ...box, borderWidth: 0, borderColor: undefined, backgroundColor: box.coverBackground ? rgb(1, 1, 1) : undefined, textColor: rgb(0, 0, 0), font });
      if (translated) translated.setFontSize(boxSize);
      else size = Math.min(size, boxSize);
    }
    input?.setFontSize(size);
    if (radio && rawValue) {
      if (!field.allowedValues?.includes(rawValue)) throw new DocumentWorkflowError(`Invalid choice for ${field.label}.`);
      radio.select(rawValue);
    }
  }
  form.updateFieldAppearances(font);
  return { bytes: Buffer.from(await pdf.save()), pages: pdf.getPageCount() };
}

export async function generateNdaDraft(context: DocumentContext, kind: ContractKind = "nda") {
  const check = await updateNdaIntake(context, {}, kind);
  if (check.status !== "ready_to_draft") return check;
  const loaded = await loadNdaConfig(kind);
  const intake = await scopedIntake(context, kind);
  if (!loaded || !intake || loaded.sha256 !== intake.templateSha256) throw new DocumentWorkflowError("The contract template changed; recheck the intake before drafting.");
  const bytes = loaded.config.format === "docx" ? renderNdaDocx(loaded.template, loaded.config, intake.facts) : undefined;
  const pdf = bytes ? await renderNdaPdf(bytes) : await renderNdaPdfForm(loaded.template, loaded.config, intake.facts);
  const id = randomUUID();
  const previous = (await getWorkflowStore().list<{ conversationId: string; revision: number }>(context.workspaceId, `${kind}-draft`, 10_000))
    .filter((record) => record.data.conversationId === context.conversationId);
  const revision = 1 + Math.max(0, ...previous.map((record) => record.data.revision));
  const docx = bytes ? await saveGeneratedAttachment(context, { bytes, fileName: `Bonte-${kind.toUpperCase()}-draft-v${revision}.docx`, mimeType: docxMime }) : undefined;
  let rendered: WorkflowAttachment | undefined;
  try {
  rendered = await saveGeneratedAttachment(context, { bytes: pdf.bytes, fileName: `Bonte-${kind.toUpperCase()}-draft-v${revision}.pdf`, mimeType: "application/pdf" });
  const result = { id, conversationId: context.conversationId, actorId: context.actorId, revision, status: "draft", templateVersion: loaded.config.version,
    templateSha256: loaded.sha256, facts: intake.facts, sourceAttachmentIds: intake.attachmentIds, docxAttachmentId: docx?.id, pdfAttachmentId: rendered.id,
    editableFields: loaded.config.format === "pdf" ? loaded.config.fields.map((field) => field.key) : undefined,
    pageCount: pdf.pages, createdAt: new Date().toISOString(), expiresAt: documentExpiry(), reviewNotes: loaded.config.reviewNotes,
    review: loaded.config.format === "pdf" ? "Open the PDF in a form-capable reader to edit the completed details and save a copy. Ask in chat to correct sourced facts and generate another revision. Review all fields before signing; signatures remain blank. Downloaded edits do not update the saved intake."
      : "Review pagination and signature blocks in the rendered PDF before using this draft." };
  await getWorkflowStore().put(context.workspaceId, `${kind}-draft`, id, result);
  return { ...result, downloads: [...(docx ? [attachmentSummary(docx)] : []), attachmentSummary(rendered)] };
  } catch (error) {
    await Promise.allSettled([...(docx ? [deleteAttachment(context, docx.id)] : []), ...(rendered ? [deleteAttachment(context, rendered.id)] : [])]);
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
  if (recipient && /[\x00-\x1f\x7f]/.test(recipient)) throw new DocumentWorkflowError("Recipient cannot contain control characters.");
  if (/[\x00-\x1f\x7f]/.test(subject)) throw new DocumentWorkflowError("Subject cannot contain control characters.");
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
  const kinds = ["email-draft", "nda-draft", "cmi-draft"];
  return (await Promise.all(kinds.map(async (kind) => {
    const records = await getWorkflowStore().list<{ actorId: string; conversationId: string }>(context.workspaceId, kind, 1000);
    return records.filter((record) => record.data.actorId === context.actorId && record.data.conversationId === context.conversationId)
      .map((record) => ({ kind, ...record.data }));
  }))).flat();
}
