import type { PropertyListView } from "./chat-types";
import { isVerboseLeadListing } from "./lead-message";

const countFormatter = new Intl.NumberFormat("en-GB");
const PROPERTY_LIST_INTRO_PATTERN = /\b(?:here (?:are|is)|showing|found)\b[^\n]{0,100}\b(?:latest|matching|available)?\s*propert(?:y|ies)\b/iu;
const PROPERTY_CARD_ONLY_MESSAGE_PATTERN = /\b(?:cards?\s+(?:above|below)|select\s+(?:a\s+)?property)\b/iu;

function propertyBusinessGroup(value?: string): "sale" | "rent" | undefined {
  if (!value) return undefined;
  if (/\b(?:sale|sell|venda)\b/iu.test(value)) return "sale";
  if (/\b(?:rent|rental|arrend)\w*/iu.test(value)) return "rent";
  return undefined;
}

function formatPrice(value: number, currency: string): string {
  try {
    return new Intl.NumberFormat("en-GB", {
      style: "currency",
      currency,
      maximumFractionDigits: 0,
    }).format(value);
  } catch {
    return `${currency} ${countFormatter.format(value)}`;
  }
}

function priceSummary(
  data: PropertyListView,
  group: "sale" | "rent",
): string | undefined {
  const priced = data.properties
    .filter(
      (property) =>
        property.priceVisible !== false &&
        propertyBusinessGroup(property.businessType) === group,
    )
    .map((property) => ({
      currency: property.currency || "EUR",
      value: Number(property.price?.replace(/[^0-9.-]/g, "")),
    }))
    .filter((price) => Number.isFinite(price.value) && price.value > 0);
  if (priced.length === 0) return undefined;

  const currency = priced[0]!.currency;
  const sameCurrency = priced.filter((price) => price.currency === currency);
  const values = sameCurrency.map((price) => price.value);
  const minimum = Math.min(...values);
  const maximum = Math.max(...values);
  const label = group === "sale" ? "Sale prices" : "Rental prices";
  return minimum === maximum
    ? `${label} start at ${formatPrice(minimum, currency)}.`
    : `${label} range from ${formatPrice(minimum, currency)} to ${formatPrice(maximum, currency)}.`;
}

function resultSummary(data: PropertyListView): string {
  const returnedRecords = data.returnedRecords || data.properties.length;
  const totalRecords = Math.max(returnedRecords, data.totalRecords);
  const propertyLabel = returnedRecords === 1 ? "property" : "properties";
  const totalLabel = totalRecords > returnedRecords
    ? ` out of ${countFormatter.format(totalRecords)} total`
    : "";
  const sentences = [
    `I found ${countFormatter.format(returnedRecords)} ${propertyLabel}${totalLabel}.`,
  ];

  const saleCount = data.properties.filter(
    (property) => propertyBusinessGroup(property.businessType) === "sale",
  ).length;
  const rentCount = data.properties.filter(
    (property) => propertyBusinessGroup(property.businessType) === "rent",
  ).length;
  const typeCounts = new Map<string, number>();
  for (const property of data.properties) {
    if (!property.propertyType) continue;
    typeCounts.set(
      property.propertyType,
      (typeCounts.get(property.propertyType) ?? 0) + 1,
    );
  }
  const topType = [...typeCounts.entries()].sort((left, right) => right[1] - left[1])[0];
  const bedrooms = new Set(
    data.properties
      .map((property) => property.bedrooms)
      .filter((value): value is number => value !== undefined),
  );
  const mix: string[] = [];
  if (saleCount > 0 || rentCount > 0) {
    mix.push(
      [
        saleCount > 0 ? `${saleCount} for sale` : "",
        rentCount > 0 ? `${rentCount} for rent` : "",
      ].filter(Boolean).join(" and "),
    );
  }
  if (topType && topType[1] === data.properties.length) {
    mix.push(`all ${topType[0].toLocaleLowerCase("en-GB")} listings`);
  } else if (topType && topType[1] > 1) {
    mix.push(`mostly ${topType[0].toLocaleLowerCase("en-GB")} listings`);
  }
  if (bedrooms.size === 1 && data.properties.length > 0) {
    const bedroomCount = [...bedrooms][0]!;
    mix.push(`all with ${bedroomCount} ${bedroomCount === 1 ? "bedroom" : "bedrooms"}`);
  }
  if (mix.length > 0) sentences.push(`The results are ${mix.join(", ")}.`);

  const locations = new Map<string, number>();
  for (const property of data.properties) {
    const location = property.location?.trim();
    if (!location) continue;
    locations.set(location, (locations.get(location) ?? 0) + 1);
  }
  const topLocations = [...locations.entries()]
    .sort((left, right) => right[1] - left[1])
    .slice(0, 3);
  if (topLocations.length === 1 && topLocations[0]![1] === data.properties.length) {
    sentences.push(`All listings are in ${topLocations[0]![0]}.`);
  } else if (topLocations.length > 0) {
    sentences.push(`Locations include ${topLocations.map(([location]) => location).join(", ")}.`);
  }

  const prices = [priceSummary(data, "sale"), priceSummary(data, "rent")]
    .filter((value): value is string => Boolean(value));
  if (prices.length > 0) sentences.push(prices.join(" "));
  sentences.push("Select a property below to view its details.");
  return sentences.join(" ");
}

/** Replaces duplicated property rows while retaining concise analysis text. */
export function compactPropertyMessageText(
  value: string,
  data: PropertyListView,
): string {
  const shouldReplace =
    PROPERTY_LIST_INTRO_PATTERN.test(value) &&
    (isVerboseLeadListing(value) || PROPERTY_CARD_ONLY_MESSAGE_PATTERN.test(value));
  if (!shouldReplace) {
    return value;
  }
  return resultSummary(data);
}
