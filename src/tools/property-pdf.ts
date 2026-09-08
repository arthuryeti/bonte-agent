import { tool } from "@langchain/core/tools";
import * as z from "zod";
import { generatePropertyBrochureCopy } from "../pdf/property-copy.js";
import { fetchPropertyForPdf } from "../pdf/property-data.js";
import { renderPropertyPdf } from "../pdf/render-property-pdf.js";
import { getWorkflowContext } from "../workflows/context.js";
import { getWorkflowStore } from "../workflows/store.js";
import { saveGeneratedAttachment, attachmentSummary, deleteAttachment, documentStorageStatus } from "../workflows/documents-attachments.js";

export const generatePropertyPdfTool = tool(
  async ({
    reference,
    propertyId,
    language,
    template,
    includePrice,
    maxPhotos,
  }) => {
    try {
      const ready = documentStorageStatus();
      if (ready.status !== "configured") throw new Error(ready.missing);
      const property = await fetchPropertyForPdf({
        reference,
        propertyId,
        language,
      });
      const copy = await generatePropertyBrochureCopy(property, language ?? "en");
      const pdf = await renderPropertyPdf(property, {
        template,
        includePrice,
        maxPhotos,
        copy,
      });
      const context = getWorkflowContext();
      const attachment = await saveGeneratedAttachment(context, { fileName: pdf.fileName, mimeType: "application/pdf", bytes: pdf.bytes });
      try {
        await getWorkflowStore().put(context.workspaceId, "generated_file", pdf.fileName, { conversationId: context.conversationId, attachmentId: attachment.id, expiresAt: attachment.expiresAt });
      } catch (error) {
        await deleteAttachment(context, attachment.id).catch(() => undefined);
        throw error;
      }
      return JSON.stringify({
        success: true,
        reference: property.reference,
        propertyId: property.propertyId,
        title: property.title,
        fileName: pdf.fileName,
        downloadName: pdf.downloadName,
        pageCount: pdf.pageCount,
        attachmentId: attachment.id,
        download: attachmentSummary(attachment),
        copy,
        warnings: pdf.warnings,
        userMessage: "The property PDF is ready. Share the protected download link. Do not show storage paths.",
      });
    } catch (error) {
      return JSON.stringify({
        success: false,
        message:
          error instanceof Error
            ? error.message
            : "Unknown property PDF generation error",
      });
    }
  },
  {
    name: "generate_property_pdf",
    description:
      "Generate a branded PDF brochure for a property listing. " +
      "Use this when the user asks to create, export, share, or send a property PDF. " +
      "Provide either a property reference or propertyId. " +
      "The tool returns a protected attachment download URL. Include that link for web users. " +
      "Do not mention filesystem paths or MEDIA tags.",
    schema: z
      .object({
        reference: z
          .string()
          .optional()
          .describe("Property reference, e.g. ABC123."),
        propertyId: z
          .number()
          .int()
          .positive()
          .optional()
          .describe("CRM property ID."),
        language: z
          .enum(["en", "pt", "es", "fr", "it", "de", "nl", "sv", "da", "no", "pl", "zh", "ru", "fi"])
          .optional()
          .describe("Listing language. Defaults to en."),
        template: z
          .enum(["standard", "one_page"])
          .optional()
          .describe("PDF layout template. Defaults to standard."),
        includePrice: z
          .boolean()
          .optional()
          .describe(
            "Whether to show the property price when CRM marks it visible. Defaults to true."
          ),
        maxPhotos: z
          .number()
          .int()
          .positive()
          .max(12)
          .optional()
          .describe("Maximum number of listing photos to include. Defaults to 8."),
      })
      .refine((value) => value.reference || value.propertyId, {
        message: "Provide either reference or propertyId.",
      }),
  }
);
