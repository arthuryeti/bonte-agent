/**
 * Explicit administrator invocation only:
 *   node --import tsx scripts/sync-listing-links.ts
 *
 * CRM_LISTING_SOURCE_URL: trusted HTTPS JSON feed, sitemap or sitemap index.
 * CRM_LISTING_ALLOWED_HOSTS: comma-separated exact allowed hostnames.
 * CRM_LISTING_URLS_PATH: mapping file consumed by the deployed agent.
 * CRM_LISTING_SYNC_MAX_PAGES: optional bounded page cap (default 1000).
 *
 * Feed format: [{"reference":"A-42","propertyId":42,"url":"https://..."}]
 * Each page must expose an exact reference label (Reference:/Referência:/Ref:),
 * property-reference meta field, or casafari-property-id meta field. No slugs
 * are guessed, and mismatched/ambiguous identities are withheld.
 */
import "dotenv/config";
import { resolve } from "node:path";
import { searchProperties } from "../src/workflows/crm-properties.js";
import { buildVerifiedListingMappings, writeVerifiedListingMappings } from "../src/workflows/crm-listing-links.js";

async function main() {
  const sourceUrl = process.env.CRM_LISTING_SOURCE_URL?.trim();
  const allowedHosts = (process.env.CRM_LISTING_ALLOWED_HOSTS ?? "").split(",").map((host) => host.trim()).filter(Boolean);
  if (!sourceUrl || !allowedHosts.length) throw new Error("Configure CRM_LISTING_SOURCE_URL and CRM_LISTING_ALLOWED_HOSTS before running listing sync.");
  const maxPages = Number(process.env.CRM_LISTING_SYNC_MAX_PAGES?.trim() || 1000);
  if (!Number.isInteger(maxPages) || maxPages < 1 || maxPages > 10_000) throw new Error("CRM_LISTING_SYNC_MAX_PAGES must be an integer from 1 to 10000.");
  const inventory = await searchProperties({ criteria: {}, complete: true, pageSize: 100, maxPages: 100 });
  if (!inventory.coverage.complete) throw new Error("CRM inventory coverage is incomplete; existing listing mapping was not replaced.");
  const result = await buildVerifiedListingMappings({ sourceUrl, allowedHosts, maxPages }, inventory.properties);
  if (result.coverage.truncated) throw new Error(`Listing source or page limit reached (checked ${result.coverage.checkedPages} of ${result.coverage.candidatePages} candidates from ${result.coverage.sourceDocuments} source documents); existing mapping was not replaced.`);
  if (!result.mappings.length) throw new Error(`No listing pages passed exact identity verification (${result.rejected.length} rejected); existing mapping was not replaced.`);
  const outputPath = resolve(process.env.CRM_LISTING_URLS_PATH?.trim() || "output/verified-listing-links.json");
  await writeVerifiedListingMappings(outputPath, result.mappings);
  console.log(JSON.stringify({ outputPath, verifiedMappings: result.mappings.length, rejectedPages: result.rejected.length, coverage: result.coverage, warnings: result.warnings,
    nextStep: "Set CRM_LISTING_URLS_PATH to this file in the deployed application. Re-run after website inventory changes." }, null, 2));
}

main().catch((error: unknown) => { console.error(error instanceof Error ? error.message : "Listing mapping sync failed"); process.exitCode = 1; });
