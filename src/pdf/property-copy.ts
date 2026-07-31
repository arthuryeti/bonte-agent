import { createModel } from "../providers/factory.js";
import type { PropertyPdfData } from "./property-data.js";

export interface PropertyBrochureCopy {
  hook: string;
  intro: string;
}

function compactText(value: string | undefined, maxLength: number): string | undefined {
  if (!value) return undefined;
  const compact = value.replace(/\s+/g, " ").trim();
  return compact.length > maxLength
    ? `${compact.slice(0, maxLength - 1).trim()}...`
    : compact;
}

function plainTextFromModelResponse(response: unknown): string {
  if (typeof response === "string") return response;
  if (!response || typeof response !== "object") return "";

  const record = response as Record<string, unknown>;
  if (typeof record.content === "string") return record.content;

  if (Array.isArray(record.content)) {
    return record.content
      .map((part) => {
        if (typeof part === "string") return part;
        if (part && typeof part === "object") {
          const block = part as Record<string, unknown>;
          return typeof block.text === "string" ? block.text : "";
        }
        return "";
      })
      .join("");
  }

  return "";
}

function extractJsonObject(text: string): Record<string, unknown> {
  const trimmed = text.trim();
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1];
  const candidate = fenced ?? trimmed;
  const start = candidate.indexOf("{");
  const end = candidate.lastIndexOf("}");

  if (start === -1 || end === -1 || end <= start) {
    throw new Error("AI copy response did not contain a JSON object.");
  }

  const parsed = JSON.parse(candidate.slice(start, end + 1));
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("AI copy response JSON was not an object.");
  }

  return parsed as Record<string, unknown>;
}

function sanitizeCopy(value: unknown, maxLength: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const cleaned = value
    .replace(/[\r\n]+/g, " ")
    .replace(/\s+/g, " ")
    .replace(/^["'“”]+|["'“”]+$/g, "")
    .trim();

  if (!cleaned) return undefined;
  return cleaned.length > maxLength
    ? `${cleaned.slice(0, maxLength - 1).trim()}...`
    : cleaned;
}

function fallbackCopy(property: PropertyPdfData): PropertyBrochureCopy {
  const location = property.location.split(",")[0]?.trim() || property.location;
  const bedrooms = property.bedrooms ? `${property.bedrooms}-bedroom ` : "";
  const type = property.type?.toLowerCase() || "property";
  const hook = `A ${bedrooms}${type} in ${location}, ready to explore.`;
  const intro =
    compactText(property.shortDescription ?? property.description, 360) ??
    `A concise look at this ${type}, its key spaces, location, and practical details.`;

  return { hook, intro };
}

export async function generatePropertyBrochureCopy(
  property: PropertyPdfData,
  language = "en"
): Promise<PropertyBrochureCopy> {
  const model = createModel() as {
    invoke(input: unknown): Promise<unknown>;
  };

  const source = {
    reference: property.reference,
    title: property.title,
    location: property.location,
    propertyType: property.type,
    businessType: property.businessType,
    price: property.price,
    currency: property.currency,
    bedrooms: property.bedrooms,
    bathrooms: property.bathrooms,
    livingArea: property.livingArea,
    totalArea: property.totalArea,
    plotArea: property.plotArea,
    energyRating: property.energyRating,
    features: property.features.slice(0, 12),
    description: compactText(property.description, 1200),
    shortDescription: compactText(property.shortDescription, 500),
  };

  try {
    const response = await model.invoke([
      {
        role: "system",
        content:
          "You write premium real estate brochure copy. " +
          "Use only the facts provided. Do not invent amenities, views, renovation status, distances, investment claims, or neighborhood claims. " +
          "Return valid JSON only, with no markdown.",
      },
      {
        role: "user",
        content:
          `Write brochure copy in ${language}. ` +
          "Return exactly this JSON shape: " +
          '{"hook":"one compelling cover headline, max 18 words","intro":"one polished paragraph, 45-75 words"}. ' +
          "The hook should sell the property, not restate every field. " +
          "The intro should be warm, specific, and concise.\n\n" +
          JSON.stringify(source, null, 2),
      },
    ]);

    const parsed = extractJsonObject(plainTextFromModelResponse(response));
    const hook = sanitizeCopy(parsed.hook, 140);
    const intro = sanitizeCopy(parsed.intro, 520);

    if (!hook || !intro) {
      throw new Error("AI copy response was missing hook or intro.");
    }

    return { hook, intro };
  } catch (error) {
    console.warn(
      "[PropertyPDF] AI copy generation failed, using fallback copy:",
      error
    );
    return fallbackCopy(property);
  }
}
