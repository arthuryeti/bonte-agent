import assert from "node:assert/strict";
import { test } from "node:test";
import PDFDocument from "pdfkit";
import { PDFDocument as PdfReader } from "pdf-lib";
import sharp from "sharp";
import { renderPropertyPdf } from "../src/pdf/render-property-pdf.js";
import type { PropertyPdfData } from "../src/pdf/property-data.js";

test("brochures embed brand fonts, keep fixed layouts, and preserve content and price privacy", async (t) => {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => key.startsWith("PROPERTY_PDF_")));
  for (const key of Object.keys(env)) delete process.env[key];
  t.after(() => {
    for (const key of Object.keys(process.env).filter(key => key.startsWith("PROPERTY_PDF_"))) delete process.env[key];
    Object.assign(process.env, env);
  });
  const drawn: string[] = [];
  const originalText = PDFDocument.prototype.text;
  t.mock.method(PDFDocument.prototype, "text", function (this: PDFKit.PDFDocument, ...args: Parameters<typeof originalText>) {
    drawn.push(args[0]);
    return originalText.apply(this, args);
  });
  const image = await sharp({ create: { width: 1200, height: 800, channels: 3, background: "#b8aea0" } }).jpeg().toBuffer();
  const property: PropertyPdfData = {
    reference: "BF/21956", title: "Penthouse in Estoril", location: "Estoril, Cascais, Portugal",
    type: "Penthouse", businessType: "For sale", price: 7500000, currency: "€", priceVisible: true,
    bedrooms: 4, bathrooms: 6, livingArea: 548, totalArea: 767, energyRating: "A",
    features: Array.from({ length: 28 }, (_, i) => `Property amenity ${i + 1}`), categorizedFeatures: [],
    photos: Array.from({ length: 8 }, (_, sortOrder) => ({ url: `data:image/jpeg;base64,${image.toString("base64")}`, sortOrder })),
    agent: { name: "André Freire", email: "andrew@bontefilipidis.com", phone: "+351 913 383 013" },
  };
  const copy = {
    hook: "Two penthouses, one extraordinary home: a private Atlantic-facing rooftop above Estoril",
    intro: "In one of Estoril's established residential areas, two penthouses form a duplex residence with four en-suite bedrooms, terraces, a rooftop pool and views of the Atlantic. ".repeat(3),
  };
  const standard = await renderPropertyPdf(property, { copy });
  const parsed = await PdfReader.load(standard.bytes);
  assert.equal(standard.pageCount, 5);
  assert.equal(parsed.getPageCount(), standard.pageCount);
  assert.equal(parsed.getAuthor(), "Bonte Filipidis");
  assert.equal(standard.downloadName, "property-BF-21956.pdf");
  assert.deepEqual(standard.warnings, []);
  assert.ok(drawn.includes("€7,500,000"));
  assert.ok(drawn.includes(property.features.at(-1)!));
  assert.ok(drawn.includes(property.agent!.email!));
  for (const page of parsed.getPages()) {
    assert.ok(Math.abs(page.getWidth() - 595.28) < 0.01);
    assert.ok(Math.abs(page.getHeight() - 841.89) < 0.01);
  }
  for (const options of [{ template: "one_page" as const, includePrice: false }, { template: "standard" as const }]) {
    drawn.length = 0;
    const pdf = await renderPropertyPdf({ ...property, priceVisible: options.includePrice === false, photos: [] }, { ...options, copy });
    assert.equal(pdf.pageCount, options.template === "one_page" ? 1 : 3);
    assert.equal((await PdfReader.load(pdf.bytes)).getPageCount(), pdf.pageCount);
    assert.ok(drawn.includes("Price on request"));
    assert.ok(!drawn.some(text => text.includes("7,500,000")));
    assert.ok(drawn.includes(property.agent!.email!));
  }
  drawn.length = 0;
  const features = Array.from({ length: 60 }, (_, i) => `Amenity ${i}: a deliberately long description that must wrap and continue without dropping the final item.`);
  const overflow = await renderPropertyPdf({ ...property, features, photos: [{ url: "data:image/jpeg;base64,bm90LWFuLWltYWdl", sortOrder: 0 }], agent: undefined }, { copy });
  assert.ok(overflow.pageCount > 3);
  assert.equal((await PdfReader.load(overflow.bytes)).getPageCount(), overflow.pageCount);
  assert.equal(overflow.warnings.length, 1);
  assert.ok(drawn.includes(features.at(-1)!));
  assert.ok(!drawn.includes("Arrange a viewing"));

  process.env.PROPERTY_PDF_BRAND_NAME = "Custom Agency";
  process.env.PROPERTY_PDF_LOGO_PATH = "/missing/logo.png";
  const custom = await renderPropertyPdf({ ...property, photos: [] }, { template: "one_page", copy });
  assert.equal((await PdfReader.load(custom.bytes)).getAuthor(), "Custom Agency");
  assert.ok(drawn.includes("Custom Agency"));
});
