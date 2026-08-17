import { extractAllMessageText } from "../agent-response.js";
import type {
  LeadAgentView,
  LeadEventView,
  LeadListView,
  LeadPropertyView,
  LeadView,
  PropertyAgentView,
  PropertyListView,
  PropertyView,
} from "./crm-ui-types.js";

export type {
  LeadAgentView,
  LeadContactView,
  LeadEventView,
  LeadListView,
  LeadPropertyView,
  LeadView,
  PropertyAgentView,
  PropertyListView,
  PropertyView,
} from "./crm-ui-types.js";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asString(value: unknown): string | undefined {
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed || undefined;
  }
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  if (typeof value === "boolean") return value ? "Yes" : "No";
  return undefined;
}

function firstString(...values: unknown[]): string | undefined {
  for (const value of values) {
    const direct = asString(value);
    if (direct) return direct;
    if (!isRecord(value)) continue;
    for (const key of ["Name", "Title", "Description", "Value", "Code", "Label"]) {
      const nested = asString(value[key]);
      if (nested) return nested;
    }
  }
  return undefined;
}

function asCount(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.max(0, Math.floor(value))
    : fallback;
}

function asNumber(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value !== "string" || !value.trim()) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function asBoolean(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function asSafeUrl(...values: unknown[]): string | undefined {
  const candidate = firstString(...values);
  if (!candidate) return undefined;
  try {
    const url = new URL(candidate);
    return url.protocol === "https:" || url.protocol === "http:"
      ? url.toString()
      : undefined;
  } catch {
    return undefined;
  }
}

function parseToolOutput(output: unknown): unknown {
  if (
    isRecord(output) &&
    (Array.isArray(output.Opportunities) || Array.isArray(output.PropertyList))
  ) {
    return output;
  }

  const text =
    typeof output === "string"
      ? output
      : extractAllMessageText(output) || serialize(output);
  if (!text) return undefined;

  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

/** Returns a handled CRM tool failure that LangChain reports via tool-end. */
export function extractCrmToolError(output: unknown): string | undefined {
  const parsed = parseToolOutput(output);
  if (!isRecord(parsed) || parsed._error !== true) return undefined;
  return asString(parsed.message) || "CRM request failed.";
}

function serialize(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return "";
  }
}

function normalizeAgent(value: unknown): LeadAgentView | undefined {
  if (!isRecord(value)) return undefined;
  const name = firstString(value.AgentName, value.Name, value.Title);
  if (!name) return undefined;
  return {
    id: firstString(value.AgentID, value.AgentId, value.Id),
    name,
  };
}

function normalizeProperty(value: unknown): LeadPropertyView | undefined {
  if (!isRecord(value)) return undefined;
  const id = firstString(value.PropertyID, value.PropertyId, value.Id);
  const reference = firstString(value.Reference);
  const address = firstString(value.Address, value.Location);
  if (!id && !reference && !address) return undefined;
  return {
    id,
    reference,
    address,
    price: firstString(value.Price),
    updatedAt: firstString(value.LastUpdate),
  };
}

function normalizePropertyAgent(value: unknown): PropertyAgentView | undefined {
  if (!isRecord(value)) return undefined;
  const agent = {
    id: firstString(value.id, value.Id, value.AgentID, value.AgentId),
    name: firstString(value.Name, value.name, value.AgentName),
    email: firstString(value.Email, value.email),
    phone: firstString(value.Cellphone, value.Phone, value.phone),
  };
  return Object.values(agent).some(Boolean) ? agent : undefined;
}

function normalizePropertyLocation(value: unknown): {
  address?: string;
  location?: string;
} {
  if (!isRecord(value)) return {};
  const address = firstString(value.address, value.Address);
  const parts = [
    firstString(value.zone, value.Zonename),
    firstString(value.localityName, value.Locality),
    firstString(value.cityName, value.City),
    firstString(value.regionName, value.Region),
    firstString(value.Country),
  ].filter((part): part is string => Boolean(part));
  return {
    address,
    location: [...new Set(parts)].join(", ") || address,
  };
}

function normalizePropertyPhoto(value: unknown): string | undefined {
  if (!isRecord(value)) return undefined;
  return asSafeUrl(value.Url, value.URL, value.url);
}

function normalizeListedProperty(
  value: unknown,
  index: number
): PropertyView | undefined {
  if (!isRecord(value)) return undefined;
  const id = firstString(value.propertyId, value.PropertyID, value.PropertyId, value.id);
  const reference = firstString(value.reference, value.Reference);
  if (!id && !reference) return undefined;

  const locales = Array.isArray(value.locale) ? value.locale.filter(isRecord) : [];
  const preferredLocale =
    locales.find((locale) => /^(?:en|eng)$/i.test(firstString(locale.language) ?? "")) ??
    locales[0];
  const location = normalizePropertyLocation(value.location);
  const propertyType = firstString(value.typeLocale, value.type, value.PropertyType);
  const title = firstString(preferredLocale?.title, propertyType, reference) ||
    `Property ${index + 1}`;
  const photos = (Array.isArray(value.photos) ? value.photos : [])
    .filter(isRecord)
    .sort((left, right) =>
      (asNumber(left.SortOrder) ?? Number.MAX_SAFE_INTEGER) -
      (asNumber(right.SortOrder) ?? Number.MAX_SAFE_INTEGER)
    );
  const photoUrl = photos
    .map(normalizePropertyPhoto)
    .find((url): url is string => Boolean(url));
  const agents = compact(
    Array.isArray(value.listing_agent) ? value.listing_agent : [value.listing_agent],
    normalizePropertyAgent
  );
  const rawFeatures = Array.isArray(value.features_list)
    ? value.features_list
    : Array.isArray(value.features_list_enum)
      ? value.features_list_enum
      : [];
  const features = rawFeatures
    .map(asString)
    .filter((feature): feature is string => Boolean(feature))
    .slice(0, 12);

  return {
    id: id || reference || `property-${index + 1}`,
    internalId: firstString(value.internalId, value.InternalId),
    reference: reference || id || `Property ${index + 1}`,
    title,
    status: firstString(value.status, value.Status),
    businessType: firstString(
      value.businessTypeLocale,
      value.businessType,
      value.BusinessType
    ),
    propertyType,
    condition: firstString(value.conditionTypeLocale, value.condition_type),
    typology: firstString(value.typology),
    bedrooms: asNumber(value.bedrooms),
    bathrooms: asNumber(value.bathrooms),
    price: firstString(value.price, value.Price),
    currency: firstString(value.currency, value.priceprefixhelper),
    priceVisible: asBoolean(value.price_visible),
    sold: asBoolean(value.sold),
    visibleOnWebsite: asBoolean(value.visibleOnWebsite),
    livingArea: firstString(value.living_area),
    totalArea: firstString(value.total_area),
    plotArea: firstString(value.plot_area),
    address: location.address,
    location: location.location,
    description: firstString(preferredLocale?.short, preferredLocale?.description)?.slice(0, 600),
    energyRating: firstString(value.energy_rating),
    photoUrl,
    agent: agents[0],
    features,
    createdAt: firstString(value.createDate),
    updatedAt: firstString(value.lastChangeDate, value.LastUpdate),
  };
}

function normalizeEvent(value: unknown): LeadEventView | undefined {
  if (!isRecord(value)) return undefined;
  const type = firstString(value.EventType, value.Type);
  const title = firstString(value.Title, type, "CRM activity");
  if (!title) return undefined;
  return {
    id: firstString(value.EventID, value.EventId, value.Id),
    type,
    title,
    location: firstString(value.Location),
    startsAt: firstString(value.StartDate),
    endsAt: firstString(value.EndDate),
  };
}

function compact<T>(values: unknown[], normalize: (value: unknown) => T | undefined): T[] {
  const result: T[] = [];
  for (const value of values) {
    const normalized = normalize(value);
    if (normalized) result.push(normalized);
  }
  return result;
}

function normalizeLead(value: unknown, index: number): LeadView | undefined {
  if (!isRecord(value)) return undefined;
  const id = firstString(value.Id, value.LeadID, value.LeadId);
  if (!id) return undefined;

  const customer = isRecord(value.Customer) ? value.Customer : undefined;
  const contact = customer
    ? {
        name: firstString(customer.Name, customer.FullName),
        email: firstString(customer.EmailAddress, customer.Email),
        phone: firstString(customer.PhoneNumber, customer.Phone, customer.MobilePhone),
        language: firstString(customer.Language),
      }
    : undefined;
  const agents = compact(
    Array.isArray(value.Agents) ? value.Agents.slice(0, 5) : [],
    normalizeAgent
  );
  const properties = compact(
    Array.isArray(value.Properties) ? value.Properties.slice(0, 5) : [],
    normalizeProperty
  );
  const events = compact(
    Array.isArray(value.Events) ? value.Events.slice(0, 5) : [],
    normalizeEvent
  );

  return {
    id,
    title:
      firstString(value.Title, contact?.name) || `Lead ${index + 1}`,
    status: firstString(value.CurrentStatus, value.Status),
    origin: firstString(value.Origin),
    outcome: firstString(value.Outcome),
    priority: firstString(value.EventPriority, value.Priority),
    createdAt: firstString(value.CreateDate),
    updatedAt: firstString(value.LastUpdate),
    salePrice: firstString(value.SalePrice),
    crmUrl: asSafeUrl(value.Url, value.URL, value.WebUrl, value.LeadUrl),
    contact:
      contact && Object.values(contact).some(Boolean) ? contact : undefined,
    agents,
    properties,
    events,
    agentCount: asCount(value.AgentCount, agents.length),
    propertyCount: asCount(value.PropertyCount, properties.length),
    eventCount: asCount(value.EventCount, events.length),
  };
}

/** Converts a CRM lead-list tool result into the only shape exposed to the web UI. */
export function normalizeLeadListToolOutput(output: unknown): LeadListView | undefined {
  const parsed = parseToolOutput(output);
  if (!isRecord(parsed) || !Array.isArray(parsed.Opportunities)) return undefined;

  const opportunities = parsed.Opportunities.slice(0, 100);
  const leads: LeadView[] = [];
  for (const [index, opportunity] of opportunities.entries()) {
    const lead = normalizeLead(opportunity, index);
    if (lead) leads.push(lead);
  }
  const metadata = isRecord(parsed._result) ? parsed._result : {};
  const totalRecords = asCount(metadata.totalRecords, leads.length);

  return {
    id: `lead-list-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    leads,
    totalRecords,
    returnedRecords: asCount(metadata.returnedRecords, leads.length),
    truncated:
      typeof metadata.truncated === "boolean"
        ? metadata.truncated
        : totalRecords > leads.length,
    generatedAt: new Date().toISOString(),
  };
}

/** Converts a CRM property-list tool result into a compact, safe web payload. */
export function normalizePropertyListToolOutput(
  output: unknown
): PropertyListView | undefined {
  const parsed = parseToolOutput(output);
  if (!isRecord(parsed) || !Array.isArray(parsed.PropertyList)) return undefined;

  const sourceProperties = parsed.PropertyList;
  const properties: PropertyView[] = [];
  for (const [index, propertyValue] of sourceProperties.slice(0, 100).entries()) {
    const property = normalizeListedProperty(propertyValue, index);
    if (property) properties.push(property);
  }
  const pagination = isRecord(parsed._pagination) ? parsed._pagination : {};
  const totalRecords = asCount(
    pagination.totalRecords ?? parsed.Count,
    sourceProperties.length
  );

  return {
    id: `property-list-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    properties,
    totalRecords,
    returnedRecords: properties.length,
    truncated:
      pagination.truncated === true ||
      sourceProperties.length > properties.length ||
      totalRecords > properties.length,
    generatedAt: new Date().toISOString(),
  };
}
