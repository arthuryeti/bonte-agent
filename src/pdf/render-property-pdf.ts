import fs from "node:fs";
import path from "node:path";
import PDFDocument from "pdfkit";
import sharp from "sharp";
import type { PropertyBrochureCopy } from "./property-copy.js";
import type { PropertyPdfData, PropertyPhoto } from "./property-data.js";

export interface PropertyPdfRenderOptions {
  template?: "standard" | "one_page" | "luxury";
  includePrice?: boolean;
  maxPhotos?: number;
  outputDir?: string;
  copy?: PropertyBrochureCopy;
}

export interface PropertyPdfRenderResult {
  filePath: string;
  fileName: string;
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

function getBrandConfig(): BrandConfig {
  return {
    name: process.env.PROPERTY_PDF_BRAND_NAME || "Bonte",
    logoPath: process.env.PROPERTY_PDF_LOGO_PATH,
    primaryColor: process.env.PROPERTY_PDF_PRIMARY_COLOR || "#173f38",
    accentColor: process.env.PROPERTY_PDF_ACCENT_COLOR || "#c7a76c",
    textColor: "#1f2933",
    mutedColor: "#69737d",
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

function drawLogo(doc: PDFKit.PDFDocument, brand: BrandConfig, x: number, y: number): void {
  if (brand.logoPath && fs.existsSync(brand.logoPath)) {
    try {
      doc.image(brand.logoPath, x, y, { fit: [110, 36] });
      return;
    } catch {
      // Fall back to text brand if the configured logo cannot be embedded.
    }
  }

  doc
    .font("Helvetica-Bold")
    .fontSize(18)
    .fillColor(brand.primaryColor)
    .text(brand.name, x, y + 6, { width: 130 });
}

function drawHeader(doc: PDFKit.PDFDocument, brand: BrandConfig, reference: string): void {
  drawLogo(doc, brand, MARGIN, 26);
  doc
    .font("Helvetica")
    .fontSize(8)
    .fillColor(brand.mutedColor)
    .text(`Ref. ${reference}`, PAGE_WIDTH - MARGIN - 160, 34, {
      width: 160,
      align: "right",
    });
}

function drawFooter(
  doc: PDFKit.PDFDocument,
  brand: BrandConfig,
  pageNumber: number,
  totalPages: number
): void {
  const y = PAGE_HEIGHT - 36;
  doc
    .moveTo(MARGIN, y - 10)
    .lineTo(PAGE_WIDTH - MARGIN, y - 10)
    .strokeColor("#d6dadd")
    .lineWidth(0.5)
    .stroke();
  doc
    .font("Helvetica")
    .fontSize(8)
    .fillColor(brand.mutedColor)
    .text(brand.name, MARGIN, y, { width: 180 })
    .text(`Page ${pageNumber} of ${totalPages}`, PAGE_WIDTH - MARGIN - 100, y, {
      width: 80,
      align: "right",
    });
}

function imageCover(
  doc: PDFKit.PDFDocument,
  image: Buffer,
  x: number,
  y: number,
  width: number,
  height: number
): void {
  doc.image(image, x, y, {
    cover: [width, height],
    align: "center",
    valign: "center",
  } as PDFKit.Mixins.ImageOption);
}

function drawPlaceholder(
  doc: PDFKit.PDFDocument,
  brand: BrandConfig,
  x: number,
  y: number,
  width: number,
  height: number
): void {
  doc.rect(x, y, width, height).fill(brand.primaryColor);
}

function drawHero(
  doc: PDFKit.PDFDocument,
  brand: BrandConfig,
  property: PropertyPdfData,
  images: Buffer[],
  includePrice: boolean,
  copy?: PropertyBrochureCopy
): void {
  const heroHeight = 350;
  if (images[0]) {
    imageCover(doc, images[0], 0, 0, PAGE_WIDTH, heroHeight);
    doc.rect(0, 0, PAGE_WIDTH, heroHeight).fillOpacity(0.34).fill("#000000").fillOpacity(1);
  } else {
    drawPlaceholder(doc, brand, 0, 0, PAGE_WIDTH, heroHeight);
  }

  doc
    .font("Helvetica-Bold")
    .fontSize(9)
    .fillColor(brand.accentColor)
    .text("PROPERTY BROCHURE", MARGIN, 154, {
      width: 200,
      characterSpacing: 0.6,
    });

  doc
    .font("Helvetica-Bold")
    .fontSize(31)
    .fillColor("#ffffff")
    .text(truncate(copy?.hook ?? buildHook(property), 105), MARGIN, 172, {
      width: PAGE_WIDTH - MARGIN * 2,
      lineGap: 2,
    });
  const locationY = Math.min(doc.y + 24, 292);

  doc
    .font("Helvetica")
    .fontSize(12)
    .fillColor("#ffffff")
    .text(property.location, MARGIN, locationY, { width: 300 });

  doc
    .font("Helvetica-Bold")
    .fontSize(18)
    .fillColor(brand.accentColor)
    .text(
      includePrice
        ? formatPrice(property.price, property.currency, property.priceVisible)
        : "Price on request",
      PAGE_WIDTH - MARGIN - 210,
      275,
      { width: 210, align: "right" }
    );
}

function drawFacts(
  doc: PDFKit.PDFDocument,
  brand: BrandConfig,
  property: PropertyPdfData,
  y: number
): number {
  const facts = [
    ["Type", property.type],
    ["Bedrooms", property.bedrooms?.toString()],
    ["Bathrooms", property.bathrooms?.toString()],
    ["Living area", formatArea(property.livingArea)],
    ["Total area", formatArea(property.totalArea)],
    ["Energy", property.energyRating],
  ].filter((entry): entry is [string, string] => Boolean(entry[1]));

  const colWidth = (PAGE_WIDTH - MARGIN * 2) / 3;
  facts.slice(0, 6).forEach(([label, value], index) => {
    const col = index % 3;
    const row = Math.floor(index / 3);
    const x = MARGIN + col * colWidth;
    const itemY = y + row * 52;
    doc
      .font("Helvetica")
      .fontSize(8)
      .fillColor(brand.mutedColor)
      .text(label.toUpperCase(), x, itemY, { width: colWidth - 12 });
    doc
      .font("Helvetica-Bold")
      .fontSize(13)
      .fillColor(brand.textColor)
      .text(value ?? "", x, itemY + 14, { width: colWidth - 12 });
  });

  return y + Math.ceil(facts.length / 3) * 52 + 8;
}

function drawSectionTitle(
  doc: PDFKit.PDFDocument,
  brand: BrandConfig,
  title: string,
  y: number
): number {
  doc
    .font("Helvetica-Bold")
    .fontSize(16)
    .fillColor(brand.primaryColor)
    .text(title, MARGIN, y, { width: PAGE_WIDTH - MARGIN * 2 });
  doc
    .moveTo(MARGIN, y + 24)
    .lineTo(MARGIN + 42, y + 24)
    .strokeColor(brand.accentColor)
    .lineWidth(2)
    .stroke();

  return y + 38;
}

function drawDescription(
  doc: PDFKit.PDFDocument,
  brand: BrandConfig,
  property: PropertyPdfData,
  y: number,
  copy?: PropertyBrochureCopy
): number {
  const text = copy?.intro ?? buildIntro(property);

  y = drawSectionTitle(doc, brand, "Why this property", y);
  doc
    .font("Helvetica")
    .fontSize(11.5)
    .fillColor(brand.textColor)
    .text(text, MARGIN, y, {
      width: PAGE_WIDTH - MARGIN * 2,
      lineGap: 5,
      align: "left",
    });

  return doc.y + 24;
}

function drawContact(
  doc: PDFKit.PDFDocument,
  brand: BrandConfig,
  property: PropertyPdfData,
  y: number
): void {
  const agent = property.agent;
  if (!agent?.name && !agent?.email && !agent?.phone) return;

  doc.roundedRect(MARGIN, y, PAGE_WIDTH - MARGIN * 2, 70, 4).fill("#f5f6f5");
  doc
    .font("Helvetica-Bold")
    .fontSize(11)
    .fillColor(brand.primaryColor)
    .text("Contact", MARGIN + 18, y + 15, { width: 140 });
  doc
    .font("Helvetica")
    .fontSize(10)
    .fillColor(brand.textColor)
    .text([agent.name, agent.email, agent.phone].filter(Boolean).join("  |  "), MARGIN + 18, y + 36, {
      width: PAGE_WIDTH - MARGIN * 2 - 36,
    });
}

function drawGallery(
  doc: PDFKit.PDFDocument,
  brand: BrandConfig,
  images: Buffer[],
  y: number
): number {
  y = drawSectionTitle(doc, brand, "Gallery", y);
  const gap = 10;
  const width = (PAGE_WIDTH - MARGIN * 2 - gap) / 2;
  const height = 146;

  images.slice(1, 7).forEach((image, index) => {
    const col = index % 2;
    const row = Math.floor(index / 2);
    imageCover(doc, image, MARGIN + col * (width + gap), y + row * (height + gap), width, height);
  });

  return y + Math.ceil(Math.min(Math.max(images.length - 1, 0), 6) / 2) * (height + gap) + 8;
}

function drawFeatureList(
  doc: PDFKit.PDFDocument,
  brand: BrandConfig,
  title: string,
  features: string[],
  y: number
): number {
  if (features.length === 0) return y;

  y = drawSectionTitle(doc, brand, title, y);
  const colWidth = (PAGE_WIDTH - MARGIN * 2) / 2;
  features.slice(0, 18).forEach((feature, index) => {
    const col = index % 2;
    const row = Math.floor(index / 2);
    const x = MARGIN + col * colWidth;
    const itemY = y + row * 22;
    doc.circle(x + 3, itemY + 6, 2).fill(brand.accentColor);
    doc
      .font("Helvetica")
      .fontSize(9.5)
      .fillColor(brand.textColor)
      .text(feature, x + 12, itemY, { width: colWidth - 18 });
  });

  return y + Math.ceil(features.length / 2) * 22 + 18;
}

function drawDetails(
  doc: PDFKit.PDFDocument,
  brand: BrandConfig,
  property: PropertyPdfData,
  y: number
): void {
  const details = [
    ["Reference", property.reference],
    ["Business", property.businessType],
    ["Plot area", formatArea(property.plotArea)],
    ["Price visibility", property.priceVisible ? "Visible" : "Hidden"],
  ].filter((entry): entry is [string, string] => Boolean(entry[1]));

  y = drawSectionTitle(doc, brand, "Details", y);
  details.forEach(([label, value], index) => {
    const itemY = y + index * 24;
    doc
      .font("Helvetica")
      .fontSize(9)
      .fillColor(brand.mutedColor)
      .text(label, MARGIN, itemY, { width: 120 });
    doc
      .font("Helvetica-Bold")
      .fontSize(9.5)
      .fillColor(brand.textColor)
      .text(value ?? "", MARGIN + 130, itemY, { width: 320 });
  });
}

function collectFeatures(property: PropertyPdfData): string[] {
  const categorized = property.categorizedFeatures.flatMap((item) => item.values);
  return Array.from(new Set([...property.features, ...categorized]));
}

function drawCoverPage(
  doc: PDFKit.PDFDocument,
  brand: BrandConfig,
  property: PropertyPdfData,
  images: Buffer[],
  includePrice: boolean,
  copy?: PropertyBrochureCopy
): void {
  if (images[0]) {
    imageCover(doc, images[0], 0, 0, PAGE_WIDTH, PAGE_HEIGHT);
  } else {
    drawPlaceholder(doc, brand, 0, 0, PAGE_WIDTH, PAGE_HEIGHT);
  }

  doc.rect(0, 0, PAGE_WIDTH, PAGE_HEIGHT).fillOpacity(0.42).fill("#000000").fillOpacity(1);
  drawLogo(doc, { ...brand, primaryColor: "#ffffff" }, MARGIN, 38);

  doc
    .font("Helvetica")
    .fontSize(8)
    .fillColor("#ffffff")
    .text(`REF. ${property.reference}`, MARGIN, 122, { width: 120 });

  doc
    .font("Helvetica")
    .fontSize(8)
    .fillColor("#ffffff")
    .text(property.location.toUpperCase(), PAGE_WIDTH - MARGIN - 190, 122, {
      width: 190,
      align: "right",
    });

  doc
    .font("Helvetica-Bold")
    .fontSize(46)
    .fillColor("#ffffff")
    .text(truncate(copy?.hook ?? buildHook(property), 95), MARGIN, 265, {
      width: PAGE_WIDTH - MARGIN * 2,
      lineGap: 1,
    });

  const price = includePrice
    ? formatPrice(property.price, property.currency, property.priceVisible)
    : "Price on request";

  doc
    .font("Helvetica-Bold")
    .fontSize(18)
    .fillColor(brand.accentColor)
    .text(price, MARGIN, PAGE_HEIGHT - 138, { width: 180 });

  doc
    .font("Helvetica")
    .fontSize(13)
    .fillColor("#ffffff")
    .text(truncate(copy?.intro ?? buildIntro(property), 230), PAGE_WIDTH - MARGIN - 250, PAGE_HEIGHT - 166, {
      width: 250,
      lineGap: 4,
    });
}

function drawImageOrPlaceholder(
  doc: PDFKit.PDFDocument,
  brand: BrandConfig,
  image: Buffer | undefined,
  x: number,
  y: number,
  width: number,
  height: number
): void {
  if (image) {
    imageCover(doc, image, x, y, width, height);
  } else {
    drawPlaceholder(doc, brand, x, y, width, height);
  }
}

function drawFactRows(
  doc: PDFKit.PDFDocument,
  brand: BrandConfig,
  facts: Array<[string, string]>,
  x: number,
  y: number,
  width: number
): number {
  facts.forEach(([label, value], index) => {
    const itemY = y + index * 28;
    doc
      .font("Helvetica")
      .fontSize(8)
      .fillColor(brand.mutedColor)
      .text(label.toUpperCase(), x, itemY, { width: 90 });
    doc
      .font("Helvetica-Bold")
      .fontSize(10)
      .fillColor(brand.textColor)
      .text(value, x + 104, itemY, { width: width - 104 });
  });

  return y + facts.length * 28;
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

function drawStoryPage(
  doc: PDFKit.PDFDocument,
  brand: BrandConfig,
  property: PropertyPdfData,
  images: Buffer[],
  includePrice: boolean,
  copy?: PropertyBrochureCopy
): void {
  drawHeader(doc, brand, property.reference);

  const leftX = MARGIN;
  const leftW = 240;
  const rightX = 318;
  const rightW = PAGE_WIDTH - rightX - MARGIN;

  doc
    .font("Helvetica-Bold")
    .fontSize(24)
    .fillColor(brand.primaryColor)
    .text("The property", leftX, 96, { width: leftW });

  doc
    .moveTo(leftX, 132)
    .lineTo(leftX + 48, 132)
    .strokeColor(brand.accentColor)
    .lineWidth(2)
    .stroke();

  doc
    .font("Helvetica")
    .fontSize(11.5)
    .fillColor(brand.textColor)
    .text(truncate(copy?.intro ?? buildIntro(property), 700), leftX, 158, {
      width: leftW,
      lineGap: 5,
    });

  const factsY = Math.max(doc.y + 34, 392);
  drawFactRows(
    doc,
    brand,
    propertyFacts(property, includePrice).slice(0, 6),
    leftX,
    factsY,
    leftW
  );

  drawImageOrPlaceholder(doc, brand, images[1] ?? images[0], rightX, 96, rightW, 315);
  drawImageOrPlaceholder(doc, brand, images[2] ?? images[0], rightX, 426, rightW, 160);

  drawContact(doc, brand, property, 648);
}

function drawDetailsAndAmenitiesPage(
  doc: PDFKit.PDFDocument,
  brand: BrandConfig,
  property: PropertyPdfData,
  includePrice: boolean
): void {
  drawHeader(doc, brand, property.reference);

  doc
    .font("Helvetica-Bold")
    .fontSize(24)
    .fillColor(brand.primaryColor)
    .text("Details", MARGIN, 96, { width: PAGE_WIDTH - MARGIN * 2 });

  const facts = propertyFacts(property, includePrice);
  const colGap = 28;
  const colW = (PAGE_WIDTH - MARGIN * 2 - colGap) / 2;
  const firstCol = facts.filter((_, index) => index % 2 === 0);
  const secondCol = facts.filter((_, index) => index % 2 === 1);
  const detailsY = 150;
  drawFactRows(doc, brand, firstCol, MARGIN, detailsY, colW);
  drawFactRows(doc, brand, secondCol, MARGIN + colW + colGap, detailsY, colW);

  const features = collectFeatures(property).slice(0, 28);
  const amenitiesY = 392;
  doc
    .font("Helvetica-Bold")
    .fontSize(20)
    .fillColor(brand.primaryColor)
    .text("Amenities", MARGIN, amenitiesY, { width: PAGE_WIDTH - MARGIN * 2 });

  doc
    .moveTo(MARGIN, amenitiesY + 30)
    .lineTo(MARGIN + 48, amenitiesY + 30)
    .strokeColor(brand.accentColor)
    .lineWidth(2)
    .stroke();

  if (features.length === 0) {
    doc
      .font("Helvetica")
      .fontSize(11)
      .fillColor(brand.textColor)
      .text("Amenities available on request.", MARGIN, amenitiesY + 54, {
        width: PAGE_WIDTH - MARGIN * 2,
      });
    return;
  }

  const featureColW = (PAGE_WIDTH - MARGIN * 2 - colGap) / 2;
  features.forEach((feature, index) => {
    const col = index % 2;
    const row = Math.floor(index / 2);
    const x = MARGIN + col * (featureColW + colGap);
    const y = amenitiesY + 58 + row * 24;
    doc.circle(x + 3, y + 6, 2).fill(brand.accentColor);
    doc
      .font("Helvetica")
      .fontSize(10)
      .fillColor(brand.textColor)
      .text(feature, x + 14, y, { width: featureColW - 18, height: 18 });
  });
}

function drawGalleryPages(
  doc: PDFKit.PDFDocument,
  brand: BrandConfig,
  property: PropertyPdfData,
  images: Buffer[]
): void {
  const galleryImages = images.length > 3 ? images.slice(3) : images;
  if (galleryImages.length === 0) return;

  const gap = 12;
  const imageW = (PAGE_WIDTH - MARGIN * 2 - gap) / 2;
  const imageH = 235;
  const gridY = 176;

  for (let start = 0; start < galleryImages.length; start += 4) {
    doc.addPage();
    drawHeader(doc, brand, property.reference);
    doc
      .font("Helvetica-Bold")
      .fontSize(24)
      .fillColor(brand.primaryColor)
      .text("Gallery", MARGIN, 96, { width: PAGE_WIDTH - MARGIN * 2 });

    galleryImages.slice(start, start + 4).forEach((image, index) => {
      const col = index % 2;
      const row = Math.floor(index / 2);
      const x = MARGIN + col * (imageW + gap);
      const y = gridY + row * (imageH + gap);
      imageCover(doc, image, x, y, imageW, imageH);
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
  const outputDir = path.resolve(options.outputDir ?? "output/pdf");
  fs.mkdirSync(outputDir, { recursive: true });

  const fileName = `property-${sanitizeFilePart(property.reference)}.pdf`;
  const filePath = path.join(outputDir, fileName);
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

  const stream = fs.createWriteStream(filePath);
  doc.pipe(stream);

  drawCoverPage(doc, brand, property, images, includePrice, options.copy);

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
    if (i !== range.start) {
      drawFooter(doc, brand, i + 1, totalPages);
    }
  }

  doc.end();

  await new Promise<void>((resolve, reject) => {
    stream.on("finish", resolve);
    stream.on("error", reject);
  });

  return {
    filePath,
    fileName,
    pageCount: range.count,
    warnings,
  };
}
