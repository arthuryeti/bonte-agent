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
let imagePath = "";
let voicePath = "";
let mp3Path = "";

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "crm-media-delivery-"));
  pdfPath = path.join(tempDir, "property-A444.pdf");
  fs.writeFileSync(pdfPath, "%PDF-1.4 test");
  imagePath = path.join(tempDir, "property.jpg");
  voicePath = path.join(tempDir, "summary.ogg");
  mp3Path = path.join(tempDir, "summary.mp3");
  fs.writeFileSync(imagePath, "jpg");
  fs.writeFileSync(voicePath, "ogg");
  fs.writeFileSync(mp3Path, "mp3");
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

  it("classifies images and voice notes for native delivery", () => {
    const delivery = extractMediaDelivery(
      `MEDIA:${imagePath}\nMEDIA:${voicePath}`
    );

    assert.deepEqual(
      delivery.media.map(({ type, mimeType, voice }) => ({
        type,
        mimeType,
        voice,
      })),
      [
        { type: "image", mimeType: "image/jpeg", voice: false },
        { type: "audio", mimeType: "audio/ogg; codecs=opus", voice: true },
      ]
    );
  });

  it("forces non-Opus audio into voice-note delivery with VOICE", () => {
    const delivery = extractMediaDelivery(`VOICE:${mp3Path}`);

    assert.equal(delivery.media[0].type, "audio");
    assert.equal(delivery.media[0].voice, true);
  });

  it("extracts a native location marker", () => {
    const delivery = extractMediaDelivery(
      "Here it is.\nLOCATION:38.7223,-9.1393 | Lisbon | Portugal"
    );

    assert.equal(delivery.text, "Here it is.");
    assert.deepEqual(delivery.locations, [
      {
        latitude: 38.7223,
        longitude: -9.1393,
        name: "Lisbon",
        address: "Portugal",
      },
    ]);
  });
});
