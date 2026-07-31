import {
  callCrmApi,
  type CrmResponse,
} from "../client/crm-client.js";

export interface PropertyPdfRequest {
  reference?: string;
  propertyId?: number;
  language?: string;
}

export interface PropertyPhoto {
  url: string;
  description?: string;
  sortOrder: number;
}

export interface PropertyAgent {
  name?: string;
  email?: string;
  phone?: string;
  photo?: string;
}

export interface PropertyPdfData {
  reference: string;
  propertyId?: number;
  title: string;
  description?: string;
  shortDescription?: string;
  location: string;
  type?: string;
  businessType?: string;
  price?: number;
  currency?: string;
  priceVisible: boolean;
  bedrooms?: number;
  bathrooms?: number;
  livingArea?: number;
  totalArea?: number;
  plotArea?: number;
  energyRating?: string;
  features: string[];
  categorizedFeatures: Array<{ category: string; values: string[] }>;
  photos: PropertyPhoto[];
  agent?: PropertyAgent;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function asNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function asBoolean(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

function stripHtml(value: string | undefined): string | undefined {
  if (!value) return undefined;

  return value
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>/gi, "\n\n")
    .replace(/<[^>]*>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function firstString(...values: unknown[]): string | undefined {
  for (const value of values) {
    const stringValue = asString(value);
    if (stringValue) return stringValue;
  }

  return undefined;
}

function pickLocale(
  property: Record<string, unknown>,
  language: string
): Record<string, unknown> | undefined {
  const locales = asArray(property.locale).filter(isRecord);
  if (locales.length === 0) return undefined;

  const normalized = language.toLowerCase();
  return (
    locales.find(
      (locale) => asString(locale.language)?.toLowerCase() === normalized
    ) ?? locales[0]
  );
}

function buildLocation(property: Record<string, unknown>): string {
  const location = isRecord(property.location) ? property.location : {};
  const parts = [
    firstString(location.Locality, location.localityName),
    firstString(location.City, location.cityName),
    firstString(location.Region, location.regionName),
    firstString(location.Country),
  ];

  return parts.filter(Boolean).join(", ") || "Location on request";
}

function buildPhotos(property: Record<string, unknown>): PropertyPhoto[] {
  const rawPhotos = [
    ...asArray(property.photosWithoutWatermark),
    ...asArray(property.photos),
  ];
  const seen = new Set<string>();

  return rawPhotos
    .filter(isRecord)
    .map((photo) => ({
      url: asString(photo.Url) ?? "",
      description: asString(photo.Description),
      sortOrder: asNumber(photo.SortOrder) ?? 999,
    }))
    .filter((photo) => {
      if (!photo.url || seen.has(photo.url)) return false;
      seen.add(photo.url);
      return true;
    })
    .sort((a, b) => a.sortOrder - b.sortOrder);
}

function buildAgent(property: Record<string, unknown>): PropertyAgent | undefined {
  const agent = asArray(property.listing_agent).filter(isRecord)[0];
  if (!agent) return undefined;

  return {
    name: asString(agent.Name),
    email: asString(agent.Email),
    phone: firstString(agent.Cellphone, agent.Phone),
    photo: asString(agent.Photo),
  };
}

function buildFeatures(property: Record<string, unknown>): string[] {
  return asArray(property.features_list)
    .map(asString)
    .filter((value): value is string => Boolean(value))
    .slice(0, 18);
}

function buildCategorizedFeatures(
  property: Record<string, unknown>
): Array<{ category: string; values: string[] }> {
  return asArray(property.features_list_categorized)
    .filter(isRecord)
    .map((feature) => ({
      category: asString(feature.CategoryInnerText) ?? "Features",
      values: asArray(feature.Name)
        .map(asString)
        .filter((value): value is string => Boolean(value)),
    }))
    .filter((feature) => feature.values.length > 0)
    .slice(0, 6);
}

function normalizeProperty(
  property: Record<string, unknown>,
  language: string
): PropertyPdfData {
  const locale = pickLocale(property, language);
  const reference = firstString(property.reference, property.Reference);
  const type = firstString(property.typeLocale, property.type);
  const location = buildLocation(property);
  const title =
    firstString(locale?.title) ??
    [type, location].filter(Boolean).join(" in ") ??
    reference ??
    "Property";

  return {
    reference: reference ?? String(property.propertyId ?? "property"),
    propertyId: asNumber(property.propertyId),
    title,
    description: stripHtml(firstString(locale?.description)),
    shortDescription: stripHtml(firstString(locale?.short)),
    location,
    type,
    businessType: firstString(property.businessTypeLocale, property.businessType),
    price: asNumber(property.price),
    currency: firstString(property.currency, property.priceprefixhelper) ?? "EUR",
    priceVisible: asBoolean(property.price_visible, true),
    bedrooms: asNumber(property.bedrooms),
    bathrooms: asNumber(property.bathrooms),
    livingArea: asNumber(property.living_area),
    totalArea: asNumber(property.total_area),
    plotArea: asNumber(property.plot_area),
    energyRating: firstString(property.energy_rating),
    features: buildFeatures(property),
    categorizedFeatures: buildCategorizedFeatures(property),
    photos: buildPhotos(property),
    agent: buildAgent(property),
  };
}

function getPropertyList(response: CrmResponse): Record<string, unknown>[] {
  if (!isRecord(response.data)) return [];

  return asArray(response.data.PropertyList).filter(isRecord);
}

export async function fetchPropertyForPdf(
  request: PropertyPdfRequest
): Promise<PropertyPdfData> {
  if (!request.reference && !request.propertyId) {
    throw new Error("Provide either a property reference or propertyId.");
  }

  const language = request.language ?? "en";
  const response = await callCrmApi({
    endpoint: "/api/Property/ListProperties",
    method: "POST",
    body: {
      ...(request.reference ? { Reference: request.reference } : {}),
      ...(request.propertyId ? { PropertyId: request.propertyId } : {}),
      PropertyIncludes: {
        IncludeFeatures: true,
        IncludeBrokers: true,
        IncludeAgency: true,
        UseHtmlDescription: true,
        IncludeFeaturesByCategory: true,
      },
      Lang: language,
      SequenceNmbr: 1,
      MaxResponses: 1,
    },
  });

  const [property] = getPropertyList(response);
  if (!property) {
    throw new Error(
      `No property found for ${
        request.reference ? `reference ${request.reference}` : `ID ${request.propertyId}`
      }.`
    );
  }

  return normalizeProperty(property, language);
}
