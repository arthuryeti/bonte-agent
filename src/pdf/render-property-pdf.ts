import { randomBytes } from "node:crypto";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import PDFDocument from "pdfkit";
import sharp from "sharp";
import type { PropertyBrochureCopy } from "./property-copy.js";
import type { PropertyPdfData, PropertyPhoto } from "./property-data.js";

export interface PropertyPdfRenderOptions {
  template?: "standard" | "one_page";
  includePrice?: boolean;
  maxPhotos?: number;
  copy?: PropertyBrochureCopy;
}

export interface PropertyPdfRenderResult {
  bytes: Buffer;
  fileName: string;
  downloadName: string;
  pageCount: number;
  warnings: string[];
}

interface BrandConfig {
  name: string;
  logoPath?: string;
  primaryColor: string;
  accentColor: string;
  textColor: string;
  mutedColor: string;
}

const PAGE_WIDTH = 595.28;
const PAGE_HEIGHT = 841.89;
const MARGIN = 44;
const CONTENT_WIDTH = PAGE_WIDTH - MARGIN * 2;
const ASSETS = new URL("../../templates/brochure/", import.meta.url);
const SERIF = "Berlingske";
const SANS = "Gotham";
const SCRIPT = "Julietta";
const RULE_COLOR = "#d9d5d0";

function getBrandConfig(): BrandConfig {
  return {
    name: process.env.PROPERTY_PDF_BRAND_NAME || "Bonte Filipidis",
    logoPath: process.env.PROPERTY_PDF_LOGO_PATH,
    primaryColor: process.env.PROPERTY_PDF_PRIMARY_COLOR || "#373434",
    accentColor: process.env.PROPERTY_PDF_ACCENT_COLOR || "#8b8178",
    textColor: "#373434",
    mutedColor: "#726b65",
  };
}

function sanitizeFilePart(value: string): string {
  return value
    .trim()
    .replace(/[^a-z0-9_-]+/gi, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
}

const CURRENCY_SYMBOL_TO_CODE: Record<string, string> = {
  "€": "EUR",
  "$": "USD",
  "£": "GBP",
  "¥": "JPY",
  "₣": "CHF",
  "₽": "RUB",
  "zł": "PLN",
};

function normalizeCurrencyCode(currency: string | undefined): string | undefined {
  if (!currency) return undefined;

  const normalized = currency.trim();
  const upper = normalized.toUpperCase();
  if (/^[A-Z]{3}$/.test(upper)) return upper;

  return CURRENCY_SYMBOL_TO_CODE[normalized];
}

function formatPrice(
  price: number | undefined,
  currency: string | undefined,
  visible: boolean
): string {
  if (!visible || !price) return "Price on request";

  const currencyCode = normalizeCurrencyCode(currency) ?? "EUR";

  try {
    return new Intl.NumberFormat("en-US", {
      style: "currency",
      currency: currencyCode,
      maximumFractionDigits: 0,
    }).format(price);
  } catch {
    return `${currency ?? currencyCode} ${new Intl.NumberFormat("en-US", {
      maximumFractionDigits: 0,
    }).format(price)}`;
  }
}

function formatArea(value: number | undefined): string | undefined {
  return value ? `${Math.round(value)} sqm` : undefined;
}

function truncate(value: string, maxLength: number): string {
  return value.length > maxLength ? `${value.slice(0, maxLength - 1).trim()}...` : value;
}

function firstLocationPart(location: string): string {
  return location.split(",")[0]?.trim() || location;
}

function bedroomLabel(bedrooms: number | undefined): string | undefined {
  if (!bedrooms) return undefined;
  return bedrooms === 1 ? "one-bedroom" : `${bedrooms}-bedroom`;
}

function normalizeType(type: string | undefined): string {
  return type?.toLowerCase() || "property";
}

function indefiniteArticle(value: string): "A" | "An" {
  return /^[aeiou]/i.test(value.trim()) ? "An" : "A";
}

function businessPhrase(businessType: string | undefined): string {
  const normalized = businessType?.toLowerCase() || "";
  if (normalized.includes("rentweekly")) return "for easy weekly stays";
  if (normalized.includes("rent")) return "for comfortable everyday living";
  if (normalized.includes("sale")) return "with room to make it your own";
  return "with a practical, welcoming layout";
}

function firstSentence(value: string | undefined): string | undefined {
  if (!value) return undefined;

  const compact = value.replace(/\s+/g, " ").trim();
  const match = compact.match(/^(.{40,220}?[.!?])\s/);
  return match?.[1] ?? truncate(compact, 190);
}

function buildHook(property: PropertyPdfData): string {
  const location = firstLocationPart(property.location);
  const type = normalizeType(property.type);
  const beds = bedroomLabel(property.bedrooms);
  const propertyLabel = [beds, type].filter(Boolean).join(" ");

  return `${indefiniteArticle(propertyLabel)} ${propertyLabel} in ${location}, ${businessPhrase(property.businessType)}.`;
}

function buildIntro(property: PropertyPdfData): string {
  const location = firstLocationPart(property.location);
  const type = normalizeType(property.type);
  const facts = [
    property.livingArea ? `${Math.round(property.livingArea)} sqm of living area` : undefined,
    property.bedrooms ? `${property.bedrooms} bedrooms` : undefined,
    property.bathrooms ? `${property.bathrooms} bathrooms` : undefined,
    property.energyRating ? `energy rating ${property.energyRating}` : undefined,
  ].filter(Boolean);
  const sourceSentence = firstSentence(property.shortDescription ?? property.description);
  const opening =
    sourceSentence ??
    `This ${type} brings together a clear layout, useful proportions, and a location in ${location}.`;
  const factsSentence =
    facts.length > 0
      ? `Key details include ${facts.slice(0, 3).join(", ")}.`
      : `The brochure highlights the main spaces, location, and practical details at a glance.`;

  return truncate(`${opening} ${factsSentence}`, 420);
}

async function fetchImage(photo: PropertyPhoto): Promise<Buffer | undefined> {
  const response = await fetch(photo.url);
  if (!response.ok) return undefined;

  const input = Buffer.from(await response.arrayBuffer());
  return sharp(input)
    .rotate()
    .resize({ width: 1800, height: 1400, fit: "inside", withoutEnlargement: true })
    .jpeg({ quality: 86 })
    .toBuffer();
}

async function loadImages(
  photos: PropertyPhoto[],
  maxPhotos: number,
  warnings: string[]
): Promise<Buffer[]> {
  const images: Buffer[] = [];

  for (const photo of photos.slice(0, maxPhotos)) {
    try {
      const image = await fetchImage(photo);
      if (image) {
        images.push(image);
      } else {
        warnings.push(`Could not download image: ${photo.url}`);
      }
    } catch (error) {
      warnings.push(
        `Could not process image ${photo.url}: ${
          error instanceof Error ? error.message : "unknown error"
        }`
      );
    }
  }

  return images;
}

function drawLogo(doc: PDFKit.PDFDocument, brand: BrandConfig, white = false): void {
  const logo = brand.logoPath || (brand.name === "Bonte Filipidis"
    ? fileURLToPath(new URL(white ? "logo-white.png" : "logo.png", ASSETS))
    : undefined);
  if (logo && fs.existsSync(logo)) {
    try {
      doc.image(logo, MARGIN, 32, { fit: [170, 34] });
      return;
    } catch {
      // Preserve the text fallback for an invalid custom logo.
    }
  }
  doc.font(SERIF).fontSize(23).fillColor(white ? "#ffffff" : brand.primaryColor)
    .text(brand.name, MARGIN, 32, { width: 310, height: 40, ellipsis: true });
}

function drawHeader(doc: PDFKit.PDFDocument, brand: BrandConfig, reference: string, white = false): void {
  drawLogo(doc, brand, white);
  doc.font(SANS).fontSize(7).fillColor(white ? "#ffffff" : brand.mutedColor)
    .text(`REF. ${reference}`, PAGE_WIDTH - MARGIN - 140, 43, {
      width: 140, height: 24, align: "right", characterSpacing: 0.8, ellipsis: true,
    });
  if (!white) {
    doc.moveTo(MARGIN, 82).lineTo(PAGE_WIDTH - MARGIN, 82)
      .lineWidth(0.5).strokeColor(RULE_COLOR).stroke();
  }
}

function drawFooter(doc: PDFKit.PDFDocument, brand: BrandConfig, pageNumber: number, totalPages: number): void {
  const y = PAGE_HEIGHT - 38;
  doc.moveTo(MARGIN, y - 14).lineTo(PAGE_WIDTH - MARGIN, y - 14)
    .strokeColor(RULE_COLOR).lineWidth(0.5).stroke();
  const branded = brand.name === "Bonte Filipidis";
  doc.font(SANS).fontSize(7).fillColor(brand.mutedColor)
    .text(branded ? "bontefilipidis.com" : brand.name, MARGIN, y, {
      width: 340, height: 14, ellipsis: true,
      ...(branded ? { link: "https://bontefilipidis.com/" } : {}),
    })
    .text(`${String(pageNumber).padStart(2, "0")} / ${String(totalPages).padStart(2, "0")}`,
      PAGE_WIDTH - MARGIN - 60, y, { width: 60, align: "right" });
}

function imageCover(doc: PDFKit.PDFDocument, image: Buffer, x: number, y: number, width: number, height: number): void {
  // PDFKit scales a cover image beyond its box; clip every placement to its frame.
  doc.save().rect(x, y, width, height).clip();
  doc.image(image, x, y, { cover: [width, height], align: "center", valign: "center" });
  doc.restore();
}

function drawImageOrPlaceholder(doc: PDFKit.PDFDocument, brand: BrandConfig, image: Buffer | undefined,
  x: number, y: number, width: number, height: number): void {
  if (image) imageCover(doc, image, x, y, width, height);
  else doc.rect(x, y, width, height).fill(brand.primaryColor);
}

function fittedText(doc: PDFKit.PDFDocument, text: string, x: number, y: number,
  width: number, height: number, size: number, options: PDFKit.Mixins.TextOptions = {}): void {
  const layout = { width, lineGap: 3, ...options };
  doc.fontSize(size);
  while (size > 9 && doc.heightOfString(text, layout) > height) doc.fontSize(--size);
  doc.text(text, x, y, { ...layout, height, ellipsis: true });
}

function drawSectionTitle(doc: PDFKit.PDFDocument, brand: BrandConfig, title: string, y: number): number {
  doc.font(SERIF).fontSize(30).fillColor(brand.primaryColor)
    .text(title, MARGIN, y, { width: CONTENT_WIDTH });
  return doc.y + 24;
}

function drawContact(doc: PDFKit.PDFDocument, brand: BrandConfig, property: PropertyPdfData, y: number): void {
  const agent = property.agent;
  if (!agent?.name && !agent?.email && !agent?.phone) return;
  doc.moveTo(MARGIN, y).lineTo(PAGE_WIDTH - MARGIN, y)
    .lineWidth(0.5).strokeColor(RULE_COLOR).stroke();
  doc.font(SERIF).fontSize(20).fillColor(brand.primaryColor)
    .text("Arrange a viewing", MARGIN, y + 15, { width: 225 });
  const x = MARGIN + 260;
  doc.font(SANS).fontSize(8.5).fillColor(brand.textColor);
  let contactY = y + 15;
  for (const value of [agent.name, agent.email, agent.phone].filter((v): v is string => Boolean(v))) {
    const link = value === agent.email ? `mailto:${value}` : value === agent.phone ? `tel:${value}` : undefined;
    doc.text(value, x, contactY, { width: CONTENT_WIDTH - 260, lineGap: 2, link });
    contactY = doc.y + 4;
  }
}

function propertyFacts(property: PropertyPdfData, includePrice: boolean): Array<[string, string]> {
  return [
    ["Price", includePrice ? formatPrice(property.price, property.currency, property.priceVisible) : "Price on request"],
    ["Type", property.type],
    ["Bedrooms", property.bedrooms?.toString()],
    ["Bathrooms", property.bathrooms?.toString()],
    ["Living area", formatArea(property.livingArea)],
    ["Total area", formatArea(property.totalArea)],
    ["Plot area", formatArea(property.plotArea)],
    ["Energy", property.energyRating],
    ["Business", property.businessType],
    ["Reference", property.reference],
  ].filter((entry): entry is [string, string] => Boolean(entry[1]));
}

function drawFactRows(doc: PDFKit.PDFDocument, brand: BrandConfig, facts: Array<[string, string]>,
  x: number, y: number, width: number): number {
  for (const [label, value] of facts) {
    doc.font(SANS).fontSize(7).fillColor(brand.mutedColor)
      .text(label.toUpperCase(), x, y + 10, { width: 85, characterSpacing: 0.5 });
    doc.font(SANS).fontSize(9).fillColor(brand.textColor)
      .text(value, x + 92, y + 9, { width: width - 92, lineGap: 2 });
    y = Math.max(y + 32, doc.y + 10);
    doc.moveTo(x, y).lineTo(x + width, y).lineWidth(0.4).strokeColor(RULE_COLOR).stroke();
  }
  return y;
}

function drawCoverPage(doc: PDFKit.PDFDocument, brand: BrandConfig, property: PropertyPdfData,
  images: Buffer[], includePrice: boolean, copy?: PropertyBrochureCopy, compact = false): void {
  const heroHeight = compact ? 416 : 548;
  drawImageOrPlaceholder(doc, brand, images[0], 0, 0, PAGE_WIDTH, heroHeight);
  doc.save().rect(0, 0, PAGE_WIDTH, heroHeight).fillOpacity(0.36).fill("#000000").restore();
  drawHeader(doc, brand, property.reference, true);

  doc.font(SCRIPT).fillColor("#ffffff");
  fittedText(doc, "Exceptional Properties", MARGIN, compact ? 138 : 218, CONTENT_WIDTH, 90, 54, { align: "center" });
  doc.font(SANS).fontSize(7).fillColor("#ffffff")
    .text("PROPERTY COLLECTION", MARGIN, compact ? 227 : 313,
      { width: CONTENT_WIDTH, align: "center", characterSpacing: 2 });
  doc.font(SERIF).fillColor("#ffffff");
  fittedText(doc, copy?.hook ?? buildHook(property), MARGIN + 12, compact ? 265 : 358,
    CONTENT_WIDTH - 24, compact ? 120 : 142, 30, { align: "center" });

  const y = heroHeight + 30;
  doc.font(SANS).fillColor(brand.mutedColor);
  fittedText(doc, property.location.toUpperCase(), MARGIN, y, CONTENT_WIDTH, 28, 8, { characterSpacing: 0.8 });
  doc.font(SERIF).fillColor(brand.primaryColor);
  fittedText(doc, includePrice ? formatPrice(property.price, property.currency, property.priceVisible) : "Price on request",
    MARGIN, y + 38, compact ? CONTENT_WIDTH : 225, 46, 27);

  doc.font(SANS).fillColor(brand.textColor);
  fittedText(doc, copy?.intro ?? buildIntro(property), compact ? MARGIN : MARGIN + 260,
    compact ? y + 94 : y + 40, compact ? CONTENT_WIDTH : CONTENT_WIDTH - 260,
    compact ? 104 : 154, 9.5);

  if (compact) {
    const facts = propertyFacts(property, includePrice).filter(([label]) => ["Bedrooms", "Bathrooms", "Living area"].includes(label));
    facts.forEach(([label, value], index) => {
      const x = MARGIN + index * CONTENT_WIDTH / 3;
      doc.font(SANS).fontSize(6.5).fillColor(brand.mutedColor)
        .text(label.toUpperCase(), x, 662, { width: CONTENT_WIDTH / 3 - 14, characterSpacing: 0.7 });
      doc.font(SERIF).fontSize(20).fillColor(brand.primaryColor)
        .text(value, x, 678, { width: CONTENT_WIDTH / 3 - 14 });
    });
    drawContact(doc, brand, property, 718);
  }
}

function drawStoryPage(doc: PDFKit.PDFDocument, brand: BrandConfig, property: PropertyPdfData,
  images: Buffer[], includePrice: boolean, copy?: PropertyBrochureCopy): void {
  drawHeader(doc, brand, property.reference);
  drawSectionTitle(doc, brand, "The property", 116);
  const leftW = 225;
  const rightX = MARGIN + 260;
  const rightW = CONTENT_WIDTH - 260;
  doc.font(SANS).fillColor(brand.textColor);
  fittedText(doc, copy?.intro ?? buildIntro(property), MARGIN, 181, leftW, 228, 10.5);
  drawFactRows(doc, brand, propertyFacts(property, includePrice).slice(0, 6), MARGIN, 432, leftW);
  drawImageOrPlaceholder(doc, brand, images[1] ?? images[0], rightX, 116, rightW, 310);
  drawImageOrPlaceholder(doc, brand, images[2] ?? images[0], rightX, 440, rightW, 184);
  drawContact(doc, brand, property, 686);
}

function drawDetailsAndAmenitiesPage(doc: PDFKit.PDFDocument, brand: BrandConfig,
  property: PropertyPdfData, includePrice: boolean): void {
  drawHeader(doc, brand, property.reference);
  const detailsY = drawSectionTitle(doc, brand, "At a glance", 116);
  const facts = propertyFacts(property, includePrice);
  const gap = 32;
  const colW = (CONTENT_WIDTH - gap) / 2;
  const leftEnd = drawFactRows(doc, brand, facts.filter((_, index) => index % 2 === 0), MARGIN, detailsY, colW);
  const rightEnd = drawFactRows(doc, brand, facts.filter((_, index) => index % 2 === 1), MARGIN + colW + gap, detailsY, colW);
  let y = drawSectionTitle(doc, brand, "Amenities", Math.max(leftEnd, rightEnd) + 42);
  const features = Array.from(new Set([...property.features, ...property.categorizedFeatures.flatMap(item => item.values)]));
  if (!features.length) {
    doc.font(SANS).fontSize(10).fillColor(brand.mutedColor)
      .text("Amenities available on request.", MARGIN, y, { width: CONTENT_WIDTH });
  }
  for (let i = 0; i < features.length; i += 2) {
    const row = features.slice(i, i + 2);
    doc.font(SANS).fontSize(9);
    const height = Math.max(21, ...row.map(value => doc.heightOfString(value, { width: colW - 16, lineGap: 3 }) + 6));
    if (y + height > PAGE_HEIGHT - 90) {
      doc.addPage();
      drawHeader(doc, brand, property.reference);
      y = drawSectionTitle(doc, brand, "Amenities / continued", 116);
    }
    row.forEach((value, col) => {
      const x = MARGIN + col * (colW + gap);
      doc.moveTo(x, y + 6).lineTo(x + 5, y + 6).lineWidth(0.7).strokeColor(brand.accentColor).stroke();
      doc.font(SANS).fontSize(9).fillColor(brand.textColor)
        .text(value, x + 16, y, { width: colW - 16, lineGap: 3 });
    });
    y += height;
  }
}

function drawGalleryPages(doc: PDFKit.PDFDocument, brand: BrandConfig, property: PropertyPdfData, images: Buffer[]): void {
  const gallery = images.length > 3 ? images.slice(3) : images;
  const gap = 14;
  const colW = (CONTENT_WIDTH - gap) / 2;
  for (let start = 0; start < gallery.length; start += 3) {
    doc.addPage();
    drawHeader(doc, brand, property.reference);
    drawSectionTitle(doc, brand, "A closer look", 116);
    const batch = gallery.slice(start, start + 3);
    imageCover(doc, batch[0], MARGIN, 184, CONTENT_WIDTH, batch.length === 1 ? 520 : 302);
    batch.slice(1).forEach((image, index) => {
      imageCover(doc, image, MARGIN + index * (colW + gap), 500, batch.length === 2 ? CONTENT_WIDTH : colW, 220);
    });
  }
}

export async function renderPropertyPdf(
  property: PropertyPdfData,
  options: PropertyPdfRenderOptions = {}
): Promise<PropertyPdfRenderResult> {
  const brand = getBrandConfig();
  const warnings: string[] = [];
  const includePrice = options.includePrice ?? true;
  const maxPhotos = Math.max(1, Math.min(options.maxPhotos ?? 8, 12));
  const downloadName = `property-${sanitizeFilePart(property.reference)}.pdf`;
  const fileName = `property-${sanitizeFilePart(property.reference)}-${randomBytes(4).toString("hex")}.pdf`;
  const images = await loadImages(property.photos, maxPhotos, warnings);

  const doc = new PDFDocument({
    size: "A4",
    margin: 0,
    bufferPages: true,
    info: {
      Title: property.title,
      Subject: `Property ${property.reference}`,
      Author: brand.name,
    },
  });

  const chunks: Buffer[] = [];
  doc.on("data", (chunk: Buffer) => chunks.push(chunk));
  const done = new Promise<void>((resolve, reject) => {
    doc.on("end", resolve);
    doc.on("error", reject);
  });

  doc.registerFont(SERIF, fileURLToPath(new URL("Berlingske-Serif.ttf", ASSETS)));
  doc.registerFont(SANS, fileURLToPath(new URL("GothamSSm-Book.ttf", ASSETS)));
  doc.registerFont(SCRIPT, fileURLToPath(new URL("Julietta.ttf", ASSETS)));

  drawCoverPage(doc, brand, property, images, includePrice, options.copy, options.template === "one_page");

  if (options.template !== "one_page") {
    doc.addPage();
    drawStoryPage(doc, brand, property, images, includePrice, options.copy);
    doc.addPage();
    drawDetailsAndAmenitiesPage(doc, brand, property, includePrice);
    drawGalleryPages(doc, brand, property, images);
  }

  const range = doc.bufferedPageRange();
  const totalPages = range.count;
  for (let i = range.start; i < range.start + range.count; i += 1) {
    doc.switchToPage(i);
    drawFooter(doc, brand, i + 1, totalPages);
  }

  doc.end();
  await done;

  return {
    bytes: Buffer.concat(chunks),
    fileName,
    downloadName,
    pageCount: range.count,
    warnings,
  };
}
