import type { PropertyListView } from "./chat-types";
import { isVerboseLeadListing } from "./lead-message";

const countFormatter = new Intl.NumberFormat("en-GB");

/** Replaces duplicated property rows while retaining concise analysis text. */
export function compactPropertyMessageText(
  value: string,
  data: PropertyListView,
): string {
  if (!isVerboseLeadListing(value)) return value;

  const returnedRecords = data.returnedRecords || data.properties.length;
  const totalRecords = Math.max(returnedRecords, data.totalRecords);
  const propertyLabel = returnedRecords === 1 ? "property" : "properties";
  const totalLabel = totalRecords > returnedRecords
    ? ` out of ${countFormatter.format(totalRecords)} total`
    : "";

  return (
    `I found ${countFormatter.format(returnedRecords)} ${propertyLabel}${totalLabel}. ` +
    "Select a property below to view its details."
  );
}
