import { tool } from "@langchain/core/tools";
import * as z from "zod";
import { generatePropertyBrochureCopy } from "../pdf/property-copy.js";
import { fetchPropertyForPdf } from "../pdf/property-data.js";
import { renderPropertyPdf } from "../pdf/render-property-pdf.js";

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

      return JSON.stringify({
        success: true,
        reference: property.reference,
        propertyId: property.propertyId,
        title: property.title,
        fileName: pdf.fileName,
        pageCount: pdf.pageCount,
        copy,
        warnings: pdf.warnings,
        mediaTag: `MEDIA:${pdf.filePath}`,
        userMessage:
          "The property PDF has been generated and should be sent as an attached document. Do not show the local file path to the user.",
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
      "The tool fetches listing data and photos from the CRM, renders the PDF under output/pdf, " +
      "and returns an internal MEDIA:/absolute/path tag that should be included exactly once in the final response so messaging gateways can send the PDF as a document. " +
      "Do not display or explain the local file path to the user.",
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
          .enum(["standard", "one_page", "luxury"])
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
