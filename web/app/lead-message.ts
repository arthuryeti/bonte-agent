import type { LeadListView } from "./chat-types";

const countFormatter = new Intl.NumberFormat("en-GB");
const NUMBERED_ITEM_PATTERN = /(?:^|\s)\d{1,3}[.)]\s+(?=[\p{L}*])/gmu;
const BULLET_ITEM_PATTERN = /(?:^|\n)\s*[-*•]\s+/gm;
const LEAD_LIST_INTRO_PATTERN = /\b(?:here (?:are|is)|showing|found)\b[^\n]{0,100}\b(?:latest|matching)?\s*leads?\b/iu;

function matchCount(value: string, pattern: RegExp): number {
  return value.match(pattern)?.length ?? 0;
}

function looksLikeMarkdownTable(value: string): boolean {
  const tableLines = value
    .split("\n")
    .filter((line) => /^\s*\|.*\|\s*$/.test(line));
  return tableLines.length >= 4;
}

/** Detects prose that duplicates a structured lead-list result. */
export function isVerboseLeadListing(value: string): boolean {
  const normalized = value.replaceAll("**", "");
  return (
    matchCount(normalized, NUMBERED_ITEM_PATTERN) >= 3 ||
    matchCount(normalized, BULLET_ITEM_PATTERN) >= 3 ||
    looksLikeMarkdownTable(normalized)
  );
}

/** Replaces duplicated raw lead rows while retaining ordinary analysis text. */
export function compactLeadMessageText(
  value: string,
  data: LeadListView,
): string {
  if (!isVerboseLeadListing(value) || !LEAD_LIST_INTRO_PATTERN.test(value)) {
    return value;
  }

  const returnedRecords = data.returnedRecords || data.leads.length;
  const totalRecords = Math.max(returnedRecords, data.totalRecords);
  const leadLabel = returnedRecords === 1 ? "lead" : "leads";
  const totalLabel = totalRecords > returnedRecords
    ? ` out of ${countFormatter.format(totalRecords)} total`
    : "";

  return (
    `I found ${countFormatter.format(returnedRecords)} ${leadLabel}${totalLabel}. ` +
    "Select a lead below to view its details."
  );
}
