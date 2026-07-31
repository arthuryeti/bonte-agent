import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import {
  extractMediaDelivery,
  mimeTypeForDocument,
} from "../src/media-delivery.js";

let tempDir = "";
let pdfPath = "";

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "crm-media-delivery-"));
  pdfPath = path.join(tempDir, "property-A444.pdf");
  fs.writeFileSync(pdfPath, "%PDF-1.4 test");
});

afterEach(() => {
  fs.rmSync(tempDir, { recursive: true, force: true });
});

describe("media delivery", () => {
  it("extracts a standalone MEDIA marker and hides its path", () => {
    const delivery = extractMediaDelivery(
      `The brochure is ready.\nMEDIA:${pdfPath}`
    );

    assert.equal(delivery.text, "The brochure is ready.");
    assert.deepEqual(delivery.documents, [pdfPath]);
  });

  it("extracts a MEDIA marker embedded in JSON tool output", () => {
    const delivery = extractMediaDelivery(
      JSON.stringify({ success: true, mediaTag: `MEDIA:${pdfPath}` })
    );

    assert.deepEqual(delivery.documents, [pdfPath]);
  });

  it("ignores missing files", () => {
    const delivery = extractMediaDelivery(
      "MEDIA:/tmp/does-not-exist/property.pdf"
    );

    assert.deepEqual(delivery.documents, []);
  });

  it("returns the PDF MIME type", () => {
    assert.equal(mimeTypeForDocument(pdfPath), "application/pdf");
  });
});
